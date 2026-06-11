#!/usr/bin/env node
/**
 * Patches dist/index.html after expo export for mobile-friendly viewport/CSS.
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '../dist');
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
    <title>RPS Battle v2</title>
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
    <link rel="icon" href="/favicon.ico" />
  </head>
  <body>
    <noscript>Для игры нужен JavaScript.</noscript>
    <div id="root"></div>
    <script src="/_expo/static/js/web/${bundle}" defer></script>
  </body>
</html>
`;

fs.writeFileSync(indexPath, html);
console.log('Patched', indexPath, '→', bundle);