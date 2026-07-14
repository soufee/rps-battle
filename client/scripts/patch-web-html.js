#!/usr/bin/env node
/**
 * Patches dist/index.html after `expo export` for mobile-friendly viewport/CSS
 * and per-platform SDK scripts.
 *
 * Usage:
 *   node scripts/patch-web-html.js            # web + VK Mini Apps (hosted on rps-battles.com)
 *   PLATFORM=yandex node scripts/patch-web-html.js   # archive for Yandex Games hosting
 *   PLATFORM=fb node scripts/patch-web-html.js       # archive for Facebook Instant Games hosting
 *   PLATFORM=itch ITCH_CLIENT_ID=xxx node scripts/patch-web-html.js  # archive for itch.io hosting
 */
const fs = require('fs');
const path = require('path');

/**
 * itch client_id is NOT a secret in the OAuth implicit flow (it ships inside the
 * public bundle), but we keep it out of the repo for hygiene. Priority:
 * ITCH_CLIENT_ID env var, then a git-ignored client/.env.itch file.
 */
function readItchClientId() {
  if (process.env.ITCH_CLIENT_ID) {
    return process.env.ITCH_CLIENT_ID.trim();
  }
  try {
    const envPath = path.join(__dirname, '..', '.env.itch');
    if (!fs.existsSync(envPath)) {
      return '';
    }
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^\s*ITCH_CLIENT_ID\s*=\s*(.+?)\s*$/m);
    return match ? match[1].replace(/^["']|["']$/g, '').trim() : '';
  } catch (_) {
    return '';
  }
}

const PLATFORM = process.env.PLATFORM || 'web';
const API_URL = process.env.API_URL || 'https://rps-battles.com';
const DIST_DIR = process.env.DIST_DIR || 'dist';

const distDir = path.join(__dirname, '..', DIST_DIR);
const indexPath = path.join(distDir, 'index.html');
const bundleDir = path.join(distDir, '_expo/static/js/web');

if (!fs.existsSync(indexPath)) {
  console.error('dist/index.html not found — run expo export first');
  process.exit(1);
}

const bundles = fs.readdirSync(bundleDir).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
const bundle = bundles.sort().pop();
if (!bundle) {
  console.error('No web bundle in dist');
  process.exit(1);
}

// Сборки для чужого хостинга (Яндекс, FB, itch) должны грузить бандл по относительному
// пути — на itch игра запускается в iframe со случайного поддомена без корня '/'.
const externalHosting = PLATFORM === 'yandex'
  || PLATFORM === 'fb'
  || PLATFORM === 'itch';
const bundleSrc = externalHosting
  ? `./_expo/static/js/web/${bundle}`
  : `/_expo/static/js/web/${bundle}`;

let sdkScripts = '';
let platformGlobals = '';

if (PLATFORM === 'web') {
  // VK Mini Apps открывает наш URL в iframe — vk-bridge нужен в обычной web-сборке.
  // Хостим копию из node_modules сами, чтобы вход через VK не зависел от unpkg.
  const bridgeSrc = path.join(__dirname, '../node_modules/@vkontakte/vk-bridge/dist/browser.min.js');
  fs.copyFileSync(bridgeSrc, path.join(distDir, 'vk-bridge.min.js'));
  sdkScripts = `
    <!-- VK Mini Apps SDK (self-hosted) -->
    <script src="/vk-bridge.min.js"></script>`;
}

if (PLATFORM === 'yandex') {
  sdkScripts = `
    <!-- Yandex Games SDK -->
    <script src="/sdk.js"></script>`;
  platformGlobals = `
    <script>
      window.__RPS_PLATFORM__ = 'yandex';
      window.__RPS_API_URL__ = '${API_URL}';
    </script>`;
}

if (PLATFORM === 'fb') {
  sdkScripts = `
    <!-- Facebook Instant Games SDK -->
    <script src="https://connect.facebook.net/en_US/fbinstant.8.0.js"></script>`;
  platformGlobals = `
    <script>
      window.__RPS_PLATFORM__ = 'fb';
      window.__RPS_API_URL__ = '${API_URL}';
    </script>`;
}

if (PLATFORM === 'itch') {
  // itch.io не даёт SDK — авторизация идёт через itch OAuth (popup + backend).
  // client_id берётся из ITCH_CLIENT_ID или из git-ignored client/.env.itch.
  const ITCH_CLIENT_ID = readItchClientId();
  if (!ITCH_CLIENT_ID) {
    console.warn('WARNING: ITCH_CLIENT_ID is empty — set it in client/.env.itch or as env var, then rebuild.');
  }
  platformGlobals = `
    <script>
      window.__RPS_PLATFORM__ = 'itch';
      window.__RPS_API_URL__ = '${API_URL}';
      window.__ITCH_CLIENT_ID__ = '${ITCH_CLIENT_ID}';
    </script>`;
}

// itch.io: игра горизонтальная — на телефоне в портрете показываем подсказку повернуть.
// Чистый CSS/HTML, без завязки на React, работает только в itch-сборке.
let rotateHintCss = '';
let rotateHintHtml = '';
if (PLATFORM === 'itch') {
  rotateHintCss = `
      #rotate-hint {
        display: none;
      }
      @media (orientation: portrait) and (pointer: coarse) {
        #rotate-hint {
          display: flex;
          position: fixed;
          inset: 0;
          z-index: 99999;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          background: #e8e2d8;
          color: #333;
          font-family: sans-serif;
          text-align: center;
          padding: 24px;
        }
        #rotate-hint .rot-emoji {
          font-size: 56px;
          animation: rot-turn 1.6s ease-in-out infinite;
        }
        @keyframes rot-turn {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(90deg); }
        }
      }`;
  rotateHintHtml = `
    <div id="rotate-hint">
      <div class="rot-emoji">📱</div>
      <div>Поверните устройство горизонтально<br/>Please rotate your device to landscape</div>
    </div>`;
}

const html = `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
    />
    <meta name="theme-color" content="#e8e2d8" />
    <title>RPS Battle — тактика «камень-ножницы-бумага»</title>${platformGlobals}${sdkScripts}
    <style id="expo-reset">
      html,
      body {
        height: 100%;
      }
      body {
        overflow: hidden;
        margin: 0;
        -webkit-text-size-adjust: 100%;
      }
      #root {
        display: flex;
        height: 100%;
        flex: 1;
      }
      @media (max-width: 767px) {
        html,
        body,
        #root {
          height: auto;
          min-height: 100%;
          min-height: 100dvh;
        }
        body {
          overflow: auto;
        }
      }${rotateHintCss}
    </style>
    <link rel="icon" href="${externalHosting ? './favicon.ico' : '/favicon.ico'}" />
  </head>
  <body>
    <noscript>Для игры нужен JavaScript.</noscript>
    <div id="root"></div>${rotateHintHtml}
    <script src="${bundleSrc}" defer></script>
  </body>
</html>
`;

fs.writeFileSync(indexPath, html);

// Expo вшивает ассеты абсолютным путём ("/assets/..."). На чужом хостинге (itch/Yandex/FB)
// игра лежит в подпапке/iframe без корня '/', поэтому такие пути дают 404 (пустые картинки).
// Переводим их в относительные — так же, как уже сделали для самого бандла.
if (externalHosting) {
  const jsFiles = fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js'));
  let rewrittenFiles = 0;
  for (const file of jsFiles) {
    const filePath = path.join(bundleDir, file);
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = original.split('"/assets/').join('"./assets/');
    if (patched !== original) {
      fs.writeFileSync(filePath, patched);
      rewrittenFiles += 1;
    }
  }
  console.log(`Rewrote absolute /assets/ paths to relative in ${rewrittenFiles} bundle file(s)`);
}

// Facebook Instant Games требует fbapp-config.json в корне загружаемого архива
if (PLATFORM === 'fb') {
  const fbConfig = {
    instant_games: {
      platform_version: 'RICH_GAMEPLAY',
      orientation: 'PORTRAIT',
      override_web_orientation: 'PORTRAIT',
      navigation_menu_version: 'NAV_FLOATING'
    }
  };
  fs.writeFileSync(path.join(distDir, 'fbapp-config.json'), JSON.stringify(fbConfig, null, 2));
  console.log('Wrote dist/fbapp-config.json');
}

// Copy static legal documents to dist
const webDir = path.join(__dirname, '../web');
const privacySrc = path.join(webDir, 'privacy.html');
const termsSrc = path.join(webDir, 'terms.html');

if (fs.existsSync(privacySrc)) {
  fs.copyFileSync(privacySrc, path.join(distDir, 'privacy.html'));
  console.log('Copied privacy.html to dist');
}
if (fs.existsSync(termsSrc)) {
  fs.copyFileSync(termsSrc, path.join(distDir, 'terms.html'));
  console.log('Copied terms.html to dist');
}
console.log(`Patched ${indexPath} → ${bundle} (platform: ${PLATFORM})`);
