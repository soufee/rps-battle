---
name: FB — альбомная ориентация
about: Перевести Facebook Instant Games сборку в landscape
title: "[FB] Альбомная ориентация для Facebook Instant Games"
labels: enhancement, facebook
assignees: ''
---

## Контекст

Сейчас FB-сборка (`npm run build:fb` → `rps-battle-fb.zip`) жёстко задана как **вертикальная (PORTRAIT)**:

- `client/scripts/patch-web-html.js` → `fbapp-config.json`: `orientation: PORTRAIT`, `override_web_orientation: PORTRAIT`
- `client/app.json` → `"orientation": "portrait"`

При загрузке архива в Facebook Console **приоритет у `fbapp-config.json` внутри zip**, а не у настройки хоста в UI. Поэтому даже если в консоли выбрана альбомная ориентация, игра на FB открывается вертикально.

**Не ломать:** web (`rps-battles.com`), VK Mini Apps, отдельные `dist/` и `dist-fb/`.

---

## Цель

Сделать **Facebook Instant Games** версию в **альбомной (landscape)** ориентации — на десктопном FB Web и в мобильном клиенте Facebook игра должна занимать широкий горизонтальный кадр, без «высокой колонны» и лишнего вертикального скролла.

---

## Видение UX (как должно выглядеть)

### Общий принцип

Игровое поле — **в центре**, панели игроков — **по бокам**, управление — **внизу или в боковых зонах**. Всё умещается в один экран по высоте (типичное соотношение ~16:9).

```
┌──────────────────────────────────────────────────────────────┐
│  [лого]                    Ход: 1:45                         │
├──────────┬──────────────────────────────────────┬────────────┤
│          │                                      │            │
│  Игрок   │         Игровое поле 8×6             │  Соперник  │
│  аватар  │         (доска по центру)            │  аватар    │
│  HP/флаги│                                      │  HP/флаги  │
│          │                                      │            │
├──────────┴──────────────────────────────────────┴────────────┤
│  [камень] [ножницы] [бумага] [ловушка]     Подсказка хода   │
└──────────────────────────────────────────────────────────────┘
```

### Экраны

| Экран | Landscape-поведение |
|-------|---------------------|
| **Splash / авторизация** | Логотип слева (~35%), арт/бренд справа; индикатор загрузки по центру снизу; без вертикального скролла |
| **Лобби / меню** | Кнопки в 2 колонки или горизонтальная панель; шапка компактная |
| **Бой** | Доска максимально широкая (`boardMaxWidth` до ~900px при достаточной ширине); панели игроков слева/справа от поля, не над/под ним |
| **Победа / поражение** | Оверлей по центру; confetti на весь viewport |

### Адаптивность

- **Широкий landscape** (≥900px): боковые панели + широкая доска (текущий `gameWide` breakpoint)
- **Узкий landscape** (560–900px): панели компактнее, доска чуть меньше, но всё ещё горизонтальная компоновка
- **Очень узкий** (<560px): допустим кратковременный stack, но приоритет — удержать landscape-логику для FB iframe

### FB-специфика

- Учесть **плавающее меню FB** (`navigation_menu_version: NAV_FLOATING`) — отступы `safe-area` снизу/сбоку
- На **platform=WEB** (NEZP) нет имён/аватаров из SDK — UI не должен ломаться при `playerName=null`
- `body { overflow: hidden }` в FB-сборке, фиксированный viewport без «дёрганья» страницы

---

## Технические шаги

### 1. Конфиг FB (обязательно)

В `client/scripts/patch-web-html.js` для `PLATFORM=fb`:

```json
{
  "instant_games": {
    "platform_version": "RICH_GAMEPLAY",
    "orientation": "LANDSCAPE",
    "override_web_orientation": "LANDSCAPE",
    "navigation_menu_version": "NAV_FLOATING"
  }
}
```

Пересобрать: `npm run build:fb` → загрузить `rps-battle-fb.zip` в **Web Hosting → In production**.

### 2. Layout-код (по необходимости)

`App.js` уже использует `useWindowDimensions()` и breakpoints (`wide`, `gameWide`, `stackPanels`). Проверить/доработать:

- [ ] При `window.__RPS_PLATFORM__ === 'fb'` и `width > height` — форсировать горизонтальную раскладку боя
- [ ] `stackPanels` не срабатывает слишком рано в landscape (порог 560px может быть ок)
- [ ] Splash/login — горизонтальная компоновка для FB
- [ ] `getLayoutMetrics`: отдельная ветка `isFbLandscape` если нужно

**Не менять** `app.json` orientation глобально (иначе затронет web/VK) — landscape только в FB-сборке через `fbapp-config.json` + условный layout.

### 3. CSS в `patch-web-html.js` (FB)

Для `PLATFORM=fb` рассмотреть:

```css
html, body, #root {
  height: 100%;
  overflow: hidden;
}
```

Убрать mobile `overflow: auto` для FB-сборки (сейчас в общем шаблоне есть `@media (max-width: 767px)` с scroll).

### 4. QA / приёмка

- [ ] FB Web (desktop): игра landscape, без вертикального скролла в бою
- [ ] FB mobile app: landscape, доска и кнопки доступны
- [ ] Авторизация NEZP по-прежнему работает после смены ориентации
- [ ] `rps-battles.com` и VK — без регрессий (отдельные сборки)
- [ ] В DevTools / диагностике: `sdk=8.0`, корректный bootstrap

---

## Файлы

| Файл | Изменение |
|------|-----------|
| `client/scripts/patch-web-html.js` | `LANDSCAPE` в `fbapp-config.json`, FB-specific CSS |
| `client/App.js` | Условный landscape layout для `__RPS_PLATFORM__ === 'fb'` |
| `client/dist-fb/fbapp-config.json` | Генерируется при сборке |

---

## Примечание

Выбор ориентации в Facebook Console **не переопределяет** `fbapp-config.json` из загруженного zip. После правок обязательна перезагрузка архива в production.