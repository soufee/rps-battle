# RPS Battle — инструкция по релизу

Пошаговый план вывода игры на все целевые платформы: **Web, VK Mini Apps, Facebook Instant Games, Яндекс Игры, iOS (App Store), Android (Google Play)**.

---

## 0. Что уже готово в коде

| Возможность | Статус |
|---|---|
| Игровое ядро (PvE с 20 ботами, Башня, PvP-арена с комнатами и MMR) | ✅ работает |
| Экран загрузки (брендированный сплэш с прогресс-баром) | ✅ |
| Современный UI (лобби с тайлами режимов, единый мультяшный скин фигур) | ✅ режим эмодзи удалён |
| Гостевой вход (анонимный аккаунт по deviceId) — для мобильных и web | ✅ `/api/v2/auth/guest` |
| Google OAuth (web) | ✅ нужны ключи |
| VK Mini Apps: авторизация по подписи запуска + vk-bridge в сборке | ✅ нужен ключ |
| Facebook Instant: авторизация по signedRequest + SDK + fbapp-config.json | ✅ нужен ключ |
| Яндекс Игры: SDK, авторизация игрока, LoadingAPI.ready() | ✅ нужен ключ |
| Сборки под платформы: `npm run build` / `build:yandex` / `build:fb` | ✅ |
| Конфигурация iOS/Android: `app.json` (bundle id `com.rpsbattle.game`), `eas.json` | ✅ |
| Иконки и сплэш | ⚠️ сгенерированы программно — для сторов рекомендую заказать профессиональный арт 1024×1024 |

---

## 1. Сервер (общая инфраструктура для всех платформ)

Бэкенд один на все платформы: `https://rps-battles.com` (Node.js + MySQL + Redis).

### 1.1. Деплой обновлённого кода
```bash
# на сервере
cd /root/www            # ваш путь к проекту
git pull                # или залейте исходники
cd backend
npm install
npx prisma migrate deploy   # применит новые миграции (добавлена платформа yandex)
# перезапуск (pm2/systemd — как у вас настроено)
```

### 1.2. Сборка клиента на сервере
```bash
cd client
npm install              # требуется Node.js >= 20.19 (Expo SDK 56)
npm run build            # соберёт dist/ для web + VK
```
`backend` раздаёт `client/dist` статикой — как и раньше.

> ℹ️ Актуальный клиент — каталог `client` (бывший `client-new`: скины, звуки,
> переводы). Старый клиент сохранён в `client-legacy` и нигде не используется —
> можно удалить, когда убедитесь, что ничего из него не нужно.

### 1.3. Переменные окружения backend/.env
Добавьте к существующим (см. `.env.example`):
```
VK_APP_SECRET=...        # из VK (шаг 3)
VK_APP_ID=...            # ID приложения VK (шаг 3)
FB_APP_SECRET=...        # из Facebook (шаг 4)
YANDEX_APP_SECRET=...    # из Яндекса (шаг 5)
NODE_ENV=production      # обязательно: отключает dev-login
```
⚠️ Пока секреты не заданы, подписи VK/FB/Яндекс **не проверяются** (вход работает, но его можно подделать). Для продакшена задать обязательно.

---

## 2. Web (rps-battles.com)

Уже работает. Чек-лист перед релизом:
- [ ] `NODE_ENV=production` в `.env` (dev-login закрыт).
- [ ] Google OAuth: в [Google Cloud Console](https://console.cloud.google.com) → Credentials → OAuth Client добавлен redirect URI `https://rps-battles.com/auth/google/callback` (уже был для v1), ключи в `.env`.
- [ ] HTTPS работает (для VK iframe обязателен).

---

## 3. VK Mini Apps

➡️ **Подробная пошаговая инструкция: [docs/VK-INTEGRATION.md](docs/VK-INTEGRATION.md)** (создание приложения, ключи, проверка, модерация, диагностика).

Кратко:
1. [dev.vk.com](https://dev.vk.com) → «Создать приложение» → **Мини-приложение (VK Mini Apps)**, категория «Игры».
2. Адрес iframe и мобильный адрес: `https://rps-battles.com/`.
3. **«Защищённый ключ»** → `VK_APP_SECRET`, **ID приложения** → `VK_APP_ID` в `backend/.env`, затем `systemctl restart rps-v2-backend`.
4. Открыть `vk.com/app<ID>` — игра должна автоматически залогинить VK-игрока (без экрана входа).
5. Заполнить карточку (иконка 1024×1024, скриншоты, описание) и отправить на модерацию.

Технически: vk-bridge хостится у нас (`dist/vk-bridge.min.js`, добавляет скрипт сборки `client/scripts/patch-web-html.js`), клиент шлёт параметры запуска на `/api/v2/auth/vk`, бэкенд проверяет подпись `sign` (HMAC-SHA256 → base64url) и `vk_app_id`. Заголовки nginx разрешают iframe с vk.com/vk.ru/vk.me.

---

## 4. Facebook Instant Games

**Что завести:** аккаунт разработчика на [developers.facebook.com](https://developers.facebook.com) → Create App → тип **Instant Games**.

1. Соберите архив:
   ```bash
   cd client && npm run build:fb
   # получите client/rps-battle-fb.zip (внутри уже есть fbapp-config.json)
   ```
2. В консоли FB: **Instant Games → Web Hosting** → загрузите zip → пометьте «In production».
3. Settings → Basic: скопируйте **App Secret** → `FB_APP_SECRET` в `backend/.env`.
4. CORS: игра хостится на `*.fbcdn.net`, а API на `rps-battles.com` — бэкенд уже разрешает любые origins.
5. Прогресс загрузки и `startGameAsync()` уже вызываются в клиенте.
6. Пройдите проверку приложения (App Review) и опубликуйте.

⚠️ FB Instant Games периодически меняет условия программы для новых приложений — проверьте актуальную доступность Instant Games для новых разработчиков в вашем регионе.

---

## 5. Яндекс Игры

**Что завести:** аккаунт в [консоли разработчика Яндекс Игр](https://games.yandex.ru/console/).

1. Создайте черновик игры → «Загрузить архив»:
   ```bash
   cd client && npm run build:yandex
   # получите client/rps-battle-yandex.zip
   ```
2. В настройках игры получите **секретный ключ** → `YANDEX_APP_SECRET` в `backend/.env`.
3. В разделе «Внешние запросы» добавьте домен `rps-battles.com` (игра ходит на ваш API и Socket.IO).
4. Клиент уже: инициализирует `YaGames.init()`, авторизует игрока через `/api/v2/auth/yandex` (с проверкой подписи `getPlayer({signed: true})`), вызывает `LoadingAPI.ready()`. Неавторизованные в Яндексе игроки получают анонимный профиль.
5. Заполните карточку игры (иконка 512×512, скриншоты, описание) и отправьте на модерацию.

Требования модерации, которые стоит знать:
- Игра должна работать по HTTPS и не содержать внешних ссылок/упоминаний других платформ.
- Перед показом рекламы (если добавите) использовать Advertising API из `window.__YSDK__` (объект уже сохраняется клиентом).

---

## 6. iOS (App Store) и Android (Google Play)

Мобильные сборки делаются через **EAS Build** (Expo Application Services) — конфигурация `client/eas.json` готова.

### 6.1. Что завести
- **Apple Developer Program** — $99/год, [developer.apple.com](https://developer.apple.com).
- **Google Play Console** — $25 однократно, [play.google.com/console](https://play.google.com/console).
- **Expo аккаунт** (бесплатно): [expo.dev](https://expo.dev).

### 6.2. Сборка
```bash
cd client
npm install -g eas-cli
eas login
eas init                      # привяжет проект к вашему аккаунту Expo (запишет projectId в app.json)

# Android (.aab для Google Play)
eas build -p android --profile production

# iOS (.ipa для App Store) — нужен активный Apple Developer аккаунт,
# EAS сам создаст сертификаты и provisioning profile
eas build -p ios --profile production
```
Идентификаторы уже заданы: `com.rpsbattle.game` (поменяйте в `app.json`, если хотите свой домен-нейминг, **до** первой публикации).

### 6.3. Публикация
```bash
eas submit -p android --latest   # потребует service account key из Play Console
eas submit -p ios --latest       # потребует App Store Connect API key
```
Либо вручную: загрузить `.aab` в Play Console и `.ipa` через Transporter.

### 6.4. Что нужно знать про мобильную версию
- Вход на мобильных — **гостевой** («Играть без регистрации», аккаунт привязан к устройству). Google OAuth на нативных платформах отключён, т.к. требует нативного SDK — это осознанное упрощение для первого релиза. Если захотите Google/Apple вход — добавляется через `expo-auth-session` + бэкенд-эндпоинт `google-native` (заготовка уже есть).
- Клиент в production ходит на `https://rps-battles.com` (захардкожено в `getBaseUrl()` в `client/App.js`).
- Для магазинов подготовьте: скриншоты (6.7" и 6.5" для iOS, телефон+планшет для Android), описание, политику конфиденциальности (обязательна в обоих сторах — разместите на `https://rps-battles.com/privacy`).
- ⚠️ Иконки сгенерированы программно как плейсхолдер. Для сторов закажите/нарисуйте арт 1024×1024 и положите в `client/assets/` (icon.png, splash-icon.png, android-icon-*.png), имена файлов не меняйте.

### 6.5. Локальный запуск на эмуляторе/устройстве
```bash
cd client
npx expo start          # QR-код для Expo Go
# бэкенд для эмулятора Android доступен по 10.0.2.2:3001 (уже учтено в коде)
```

---

## 7. Локальная разработка (как запустить у себя)

```bash
# 1. БД и Redis (если нет локальных):
docker compose up -d            # поднимет MySQL :3306 и Redis :6379

# 2. Бэкенд (Node 18+):
cd backend
cp .env.example .env            # поправьте DATABASE_URL/REDIS_URL под себя
npm install
npx prisma migrate dev
npm run dev                     # http://localhost:3001

# 3. Клиент (Node >= 20.19!):
cd ../client
npm install
npm run web                     # http://localhost:8081
```
В dev-режиме на localhost доступна кнопка «Войти как DevTester (Admin)» и автологин. Если клиент запущен на :8081, добавьте в `backend/.env`: `CLIENT_URL=http://localhost:8081`.

---

## 8. Сводный чек-лист доступов

| Платформа | Где регистрироваться | Что взять | Куда положить |
|---|---|---|---|
| Google OAuth | console.cloud.google.com | Client ID + Secret | `backend/.env` |
| VK Mini Apps | dev.vk.com | Защищённый ключ | `VK_APP_SECRET` |
| FB Instant | developers.facebook.com | App Secret | `FB_APP_SECRET` |
| Яндекс Игры | games.yandex.ru/console | Секретный ключ | `YANDEX_APP_SECRET` |
| App Store | developer.apple.com ($99/год) | Apple ID team | `eas build/submit` спросит |
| Google Play | play.google.com/console ($25) | Service account JSON | `eas submit` спросит |
| Expo (EAS) | expo.dev (бесплатно) | аккаунт | `eas login` |

---

## 9. Что осталось сделать руками (не код)

1. Залить обновлённый код на сервер + `prisma migrate deploy` + `NODE_ENV=production`.
2. Завести аккаунты из таблицы выше, прописать секреты в `.env`.
3. Заказать иконку/сплэш у дизайнера (или оставить сгенерированные для web-платформ, где требования мягче).
4. Написать политику конфиденциальности и разместить на сайте (обязательно для iOS/Android/FB).
5. Сделать скриншоты для карточек магазинов.
6. Прогнать партию на каждой платформе перед отправкой на модерацию.
