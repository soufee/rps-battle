#!/usr/bin/env node
/**
 * Patches dist/index.html after `expo export` for mobile-friendly viewport/CSS
 * and per-platform SDK scripts.
 *
 * Usage:
 *   node scripts/patch-web-html.js            # web + VK Mini Apps (hosted on rps-battles.com)
 *   PLATFORM=yandex node scripts/patch-web-html.js   # archive for Yandex Games hosting
 *   PLATFORM=fb node scripts/patch-web-html.js       # archive for Facebook Instant Games hosting
 */
const fs = require('fs');
const path = require('path');

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

// Сборки для чужого хостинга (Яндекс, FB) должны грузить бандл по относительному пути
const externalHosting = PLATFORM === 'yandex' || PLATFORM === 'fb';
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
      }
    </style>
    <link rel="icon" href="${externalHosting ? './favicon.ico' : '/favicon.ico'}" />
  </head>
  <body>
    <noscript>Для игры нужен JavaScript.</noscript>
    <div id="root"></div>
    <script src="${bundleSrc}" defer></script>
  </body>
</html>
`;

fs.writeFileSync(indexPath, html);

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
