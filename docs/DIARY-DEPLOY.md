# Diary — как собрать и запустить

Дневниковая социальная сеть: лента, дневники, фото, живой чат.
Код: **https://github.com/soufee/demoinit** (репозиторий `demoinit`).

> ⚠️ Продакшен-код на момент снятия с сервера жил в ветке
> **`feature/cozy-improvements`** (коммит `ca7aa8c`), а не в `master`.
> Разворачивайте именно её (или смёржите в master).

## Стек

| Часть | Технологии |
|---|---|
| Backend | Java 17, Spring Boot (REST + WebSocket/STOMP), сборка Maven **внутри Docker** |
| Frontend | React + TypeScript + Vite (SPA, base-путь `/diary/`) |
| БД | PostgreSQL 15 (Docker) |
| Оркестрация | docker compose (`diary-db` + `diary-backend` на 127.0.0.1:8080) |
| Хранение фото | локально в контейнере или Google Drive (DIARY-007) |

Локально Java/Maven не нужны — backend собирается многоступенчатым
Dockerfile (`maven:3.9-eclipse-temurin-17` → `eclipse-temurin:17-jre`).
Для пересборки фронтенда нужен Node.js 20+.

## 1. Клонирование

```bash
git clone git@github.com:soufee/demoinit.git diary
cd diary
git checkout feature/cozy-improvements
```

## 2. Переменные окружения

```bash
cp .env.example .env
nano .env
```

| Переменная | Что это |
|---|---|
| `DIARY_DB_NAME` / `DIARY_DB_USER` / `DIARY_DB_PASSWORD` | Реквизиты Postgres (создаются контейнером при первом старте) |
| `JWT_SECRET` | Случайная строка для подписи JWT (`openssl rand -hex 32`) |
| `JASYPT_ENCRYPTOR_PASSWORD` | Пароль шифрования Jasypt (случайная строка) |
| `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` | Google OAuth: [console.cloud.google.com](https://console.cloud.google.com) → Credentials → OAuth Client (Web). Redirect URI: `<APP_BASE_URL>/api/v0/auth/oauth/google/callback` — проверьте точный путь в коде, если меняли |
| `APP_BASE_URL` | Публичный URL приложения, например `https://ваш-домен/diary` |
| `GOOGLE_DRIVE_ENABLED` + `GOOGLE_DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN/PICTURES_FOLDER_ID` | Хранение фото в Google Drive (иначе `DOCSTORE_DEFAULT=FILE` — файлы в контейнере, пропадают при пересоздании!) |
| `GOOGLE_DRIVE_LOGS_FOLDER_ID`, `LOG_SHIPPING_ENABLED`, `LOGSHIPPING_*` | Отгрузка логов в Drive (DIARY-008), можно выключить |

## 3. Запуск backend + БД

```bash
docker compose up -d --build
docker compose ps                      # оба контейнера должны стать healthy
curl -s http://127.0.0.1:8080/actuator/health   # или любой /api/v0/* эндпоинт
```

Backend слушает **127.0.0.1:8080**. Схема БД накатывается миграциями при старте.

## 4. Frontend

Готовая сборка лежит в репозитории в `frontend-dist/` — её можно раздавать
nginx как есть. Пересборка после изменений:

```bash
cd frontend
npm ci
npm run build          # tsc -b && vite build; base '/diary/' задан в vite.config.ts
cp -r dist/* ../frontend-dist/
```

## 5. Nginx (точная конфигурация с прежнего сервера)

```nginx
# WebSocket (STOMP) для живого чата — должен идти ПЕРЕД /diary/api/
location ^~ /diary/api/v0/ws {
    proxy_pass http://127.0.0.1:8080/api/v0/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location ^~ /diary/api/ {
    proxy_pass http://127.0.0.1:8080/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    # Загрузка фото: до 25 МБ на запрос (совпадает с multipart max-request-size бэкенда).
    # Дефолт nginx — 1 МБ, из-за чего фото >1 МБ отбивались 413 ещё до бэкенда.
    client_max_body_size 25m;
}

location /diary/ {
    alias /путь/к/diary/frontend-dist/;
    try_files $uri $uri/ /diary/index.html;
    index index.html;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Content-Security-Policy "frame-ancestors 'self'" always;
}

location = /diary {
    return 301 /diary/;
}
```

## 6. Проверка

1. `https://ваш-домен/diary/` — открывается SPA.
2. Регистрация/вход (Google OAuth — если ключи заданы).
3. Создание записи с фото >1 МБ (проверка `client_max_body_size`).
4. Чат между двумя пользователями (проверка WebSocket-локации).

## 7. Эксплуатация

```bash
docker logs -f diary-backend                          # логи
docker exec diary-db pg_dump -U $DIARY_DB_USER $DIARY_DB_NAME > diary-backup.sql   # бэкап БД
docker compose down        # остановка (данные БД сохраняются в volume diary-pgdata)
docker compose down -v     # остановка С УДАЛЕНИЕМ данных БД
```

## Известные грабли

- **SMTP**: на прежнем сервере исходящий порт 465 (SSL) был заблокирован
  провайдером — использовать 587 + STARTTLS.
- В `agent-testers/` живут Playwright-тесты (`npm ci && npx playwright test`);
  при последовательных прогонах dev-сервер Vite на :5173 иногда флейкает
  с ERR_CONNECTION_REFUSED — прогонять против docker-compose-развёртывания.
- Фото при `DOCSTORE_DEFAULT=FILE` хранятся внутри контейнера (`/tmp/diary-files`)
  и не переживают пересоздание контейнера — для продакшена включайте Google Drive
  (DIARY-007) или прикрутите volume.
