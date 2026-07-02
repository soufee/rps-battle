# LanguageFlash («Зубрилка») — как собрать и запустить

Программа для заучивания иностранных слов (карточки, интервальные повторения).
Код: **https://github.com/soufee/languageflash** (ветка `master`).

## Стек

| Часть | Технологии |
|---|---|
| Backend | Java 17, Spring Boot, сборка Maven **внутри Docker** (Dockerfile в корне) |
| Frontend | React + TypeScript + Vite (SPA, собирается с base `/languageflash/`) |
| БД | PostgreSQL 15 (Docker) |
| Оркестрация | docker compose (`lf-db` + `lf-backend` на 127.0.0.1:8087) |
| Почта | SMTP (Яндекс), подтверждение регистрации и т.п. |

Локально Java/Maven не нужны — всё собирает Docker. Для пересборки
фронтенда нужен Node.js 20+.

## 1. Клонирование

```bash
git clone git@github.com:soufee/languageflash.git
cd languageflash
```

## 2. Переменные окружения

```bash
cp .env.example .env
nano .env
```

| Переменная | Что это |
|---|---|
| `LF_DB_NAME` / `LF_DB_USER` / `LF_DB_PASSWORD` | Реквизиты Postgres (создаются контейнером при первом старте) |
| `JWT_SECRET` | Случайная строка (`openssl rand -hex 32`) |
| `SPRING_MAIL_HOST` | `smtp.yandex.ru` |
| `SPRING_MAIL_PORT` | **587** (⚠️ не 465: на многих хостингах, включая прежний сервер, исходящий 465 заблокирован; приложение настроено на STARTTLS) |
| `SPRING_MAIL_USERNAME` / `SPRING_MAIL_PASSWORD` | Почта и **пароль приложения** Яндекса (не основной пароль) |
| `SUPPORT_EMAIL` | Адрес поддержки в письмах |
| `APP_CORS_ORIGINS` | Домены фронтенда через запятую, напр. `https://ваш-домен` |
| `APP_BASE_URL` | Публичный URL, напр. `https://ваш-домен/languageflash` |
| `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` | Google OAuth ([console.cloud.google.com](https://console.cloud.google.com) → Credentials); пустые значения = вход через Google выключен |

## 3. Запуск backend + БД

```bash
docker compose up -d --build
docker compose ps                                # оба healthy
curl -s http://127.0.0.1:8087/api/health 2>/dev/null || curl -sI http://127.0.0.1:8087/api/
```

Backend слушает **127.0.0.1:8087**. Схема БД накатывается при старте.

## 4. Frontend

Готовая сборка лежит в репозитории в `frontend-dist/`. Пересборка:

```bash
cd frontend
npm ci
npx tsc -b && npx vite build --base=/languageflash/
cp -r dist/* ../frontend-dist/
```

(база `/languageflash/` передаётся флагом — в `vite.config.ts` она не задана;
проверьте после сборки, что в `frontend-dist/index.html` пути начинаются
с `/languageflash/assets/`).

## 5. Nginx (точная конфигурация с прежнего сервера)

```nginx
location ^~ /languageflash/api/ {
    proxy_pass http://127.0.0.1:8087/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}

location /languageflash/ {
    alias /путь/к/languageflash/frontend-dist/;
    try_files $uri $uri/ /languageflash/index.html;
    index index.html;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Content-Security-Policy "frame-ancestors 'self'" always;
}

location = /languageflash {
    return 301 /languageflash/;
}
```

## 6. Проверка

1. `https://ваш-домен/languageflash/` — открывается SPA.
2. Регистрация: письмо с подтверждением должно дойти (если нет — смотрите
   логи `docker logs lf-backend`; чаще всего проблема в SMTP-порте 465 → 587).
3. Создание набора слов и тренировка.

## 7. Эксплуатация

```bash
docker logs -f lf-backend
docker exec lf-db pg_dump -U $LF_DB_USER $LF_DB_NAME > lf-backup.sql   # бэкап БД
docker compose down        # остановка (данные в volume lf-pgdata сохраняются)
docker compose down -v     # остановка С УДАЛЕНИЕМ данных БД
```
