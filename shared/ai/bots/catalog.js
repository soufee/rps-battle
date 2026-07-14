/**
 * Bot catalog — the single source of truth for the playable roster and its
 * display metadata (name, emoji, difficulty, short description).
 *
 * This module is intentionally free of browser or Node specifics so it can be
 * imported by BOTH:
 *   - the client bundle (bot-registry.js) — to normalize loaded bots, and
 *   - the backend (the /api/v2/bots endpoint) — to advertise the roster.
 *
 * Bot LOGIC lives in each `bots/<id>/bot.js` and is fetched at runtime, so
 * editing a bot never requires a client rebuild. Editing THIS file (roster or
 * display metadata) only requires a backend redeploy — the client reads the
 * catalog from the backend at startup.
 */

// Display metadata keyed by bot id. Order is defined separately in ENABLED_ORDER.
export const BOT_CATALOG = {
    // Easy (green tier)
    rabbit: { name: 'Зайчик', emoji: '🐰', shortDescription: 'Реактивная эвристика', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    homyachok: { name: 'Хомячок', emoji: '🐹', shortDescription: 'Случайные шаги и простая защита', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    utenok: { name: 'Утёнок', emoji: '🦆', shortDescription: 'Базовый эвристический поиск', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    golubenok: { name: 'Голубёнок', emoji: '🐦', shortDescription: 'Пассивные защитные маневры', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    obezyanka: { name: 'Обезьянка', emoji: '🐵', shortDescription: 'Агрессивная тактика без глубины', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    lenivchik: { name: 'Ленивчик', emoji: '🦥', shortDescription: 'Медленная реактивная стратегия', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    kapibarysh: { name: 'Капибарыш', emoji: '🦦', shortDescription: 'Миролюбивый оборонительный стиль', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },

    // Medium (yellow tier)
    raccoon: { name: 'Енотик', emoji: '🦝', shortDescription: 'Паттерн-анализ и хитрый расчёт', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    fox: { name: 'Лисёнок', emoji: '🦊', shortDescription: 'Коварные уловки и фланговые обходы', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    hedgehog: { name: 'Ёжик', emoji: '🦔', shortDescription: 'Крепкая глухая оборона', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    raven: { name: 'Воронёнок', emoji: '🐦‍⬛', shortDescription: 'Стратегический подрыв капканами', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    wolf: { name: 'Волчонок', emoji: '🐺', shortDescription: 'Агрессивное стайное наступление', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    lion: { name: 'Львёнок', emoji: '🦁', shortDescription: 'Королевский баланс атаки и защиты', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    bobrenok: { name: 'Бобрёнок', emoji: '🦫', shortDescription: 'Строит оборонительные редуты', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },

    // Hard (red tier)
    owl: { name: 'Совёнок', emoji: '🦉', shortDescription: 'Глубокий минимакс поиск (3-4 шага)', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    losenok: { name: 'Лосёнок', emoji: '🫎', shortDescription: 'Многозадачное позиционное планирование', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    leopardik: { name: 'Леопардик', emoji: '🐆', shortDescription: 'Молниеносные контратаки и обман', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    orlenok: { name: 'Орлёнок', emoji: '🦅', shortDescription: 'Абсолютный позиционный контроль', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    medvezhonok: { name: 'Медвежонок', emoji: '🐻', shortDescription: 'Тяжёлое доминирующее давление', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    akulenok: { name: 'Акулёнок', emoji: '🦈', shortDescription: 'Хищные неожиданные выпады', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    strategist: { name: 'Стратег', emoji: '🧠', shortDescription: 'Продвинутое стратегическое планирование', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 }
};

// The roster order as it should appear on the selection screen.
export const ENABLED_ORDER = [
    'rabbit',
    'raccoon',
    'fox',
    'owl',
    'lion',
    'wolf',
    'hedgehog',
    'raven',
    'homyachok',
    'bobrenok',
    'losenok',
    'utenok',
    'leopardik',
    'medvezhonok',
    'obezyanka',
    'lenivchik',
    'golubenok',
    'akulenok',
    'orlenok',
    'kapibarysh',
    'strategist'
];

// Where each bot folder lives, relative to the site root that serves it.
export const BOT_BASE_PATH = 'js/bots/';
export const BOT_ENTRY_FILE = 'bot.js';
export const BOT_AVATAR_FILE = 'avatar-min.png';
