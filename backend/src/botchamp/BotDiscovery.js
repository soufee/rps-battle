import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// BOTS_DIR points to shared/ai/bots
const BOTS_DIR = path.resolve(__dirname, '../../../shared/ai/bots');
const MANIFEST_PATH = path.join(BOTS_DIR, 'manifest.js');

// Official display names for the bots as shown on the main platform.
const OFFICIAL_NAMES = {
  rabbit: 'Зайчик',
  raccoon: 'Енотик',
  fox: 'Лисёнок',
  owl: 'Совёнок',
  lion: 'Львёнок',
  wolf: 'Волчонок',
  hedgehog: 'Ёжик',
  raven: 'Воронёнок',
  homyachok: 'Хомячок',
  bobrenok: 'Бобрёнок',
  losenok: 'Лосёнок',
  utenok: 'Утёнок',
  leopardik: 'Леопардик',
  medvezhonok: 'Медвежонок',
  obezyanka: 'Обезьянка',
  lenivchik: 'Ленивчик',
  golubenok: 'Голубёнок',
  akulenok: 'Акулёнок',
  orlenok: 'Орлёнок',
  kapibarysh: 'Капибарыш',
  strategist: 'Стратег'
};

// Cache of id -> { name, emoji } parsed from each bot's bot.js.
let _botMetaCache = null;

export function extractEnabledBots() {
  try {
    const content = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const match = content.match(/ENABLED_BOTS:\s*\[([\s\S]*?)\]/);
    if (!match) {
      return [];
    }

    const ids = [];
    const lines = match[1].split('\n');
    for (const rawLine of lines) {
      const codePart = rawLine.split('//')[0];
      const idMatch = codePart.match(/['"`]([A-Za-z0-9_-]+)['"`]/);
      if (idMatch) {
        ids.push(idMatch[1]);
      }
    }
    return ids;
  } catch (e) {
    console.warn('[BotDiscovery] Could not parse manifest, using fallback list', e);
    return ['rabbit', 'raccoon', 'fox', 'owl', 'lion', 'wolf', 'hedgehog', 'raven'];
  }
}

export function parseBotMeta(id) {
  const meta = { name: null, emoji: null };
  const botFile = path.join(BOTS_DIR, id, 'bot.js');

  let content;
  try {
    content = fs.readFileSync(botFile, 'utf8');
  } catch (e) {
    return meta;
  }

  const nameMatch = content.match(/\bname:\s*(['"`])([^'"`]+)\1/);
  if (nameMatch) {
    meta.name = nameMatch[2].trim();
  }

  const emojiMatch = content.match(/\bemoji:\s*(['"`])([^'"`]+)\1/);
  if (emojiMatch) {
    meta.emoji = emojiMatch[2].trim();
  }

  return meta;
}

export function buildMetaCache() {
  if (_botMetaCache) {
    return _botMetaCache;
  }
  _botMetaCache = {};
  for (const id of extractEnabledBots()) {
    _botMetaCache[id] = parseBotMeta(id);
  }
  return _botMetaCache;
}

export function refresh() {
  _botMetaCache = null;
  return buildMetaCache();
}

export function getBotDisplayName(id) {
  if (OFFICIAL_NAMES[id]) {
    return OFFICIAL_NAMES[id];
  }
  const cache = buildMetaCache();
  if (cache[id] && cache[id].name) {
    return cache[id].name;
  }
  const meta = parseBotMeta(id);
  if (meta.name) {
    return meta.name;
  }
  return id;
}

export function getBotEmoji(id) {
  const cache = buildMetaCache();
  if (cache[id] && cache[id].emoji) {
    return cache[id].emoji;
  }
  const meta = parseBotMeta(id);
  return meta.emoji || '🤖';
}

export function getAllBots() {
  const ids = extractEnabledBots();
  return ids.map(id => ({
    id,
    name: getBotDisplayName(id),
    emoji: getBotEmoji(id)
  }));
}
