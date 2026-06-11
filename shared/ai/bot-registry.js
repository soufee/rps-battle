/**
 * Bot registry — canonical catalog of playable opponents.
 *
 * Every bot is a self-contained AI module that registers itself here via
 * `RPSBotAPI.defineBot(...)`. The registry ENFORCES at registration time
 * that every bot went through the bot-api contract (see bot-api.js).
 *
 * Certification is checked only once — during register(). After that we
 * trust the objects stored in the registry (normalization would otherwise
 * drop the internal stamp).
 *
 * Bot descriptor shape (the uniform interface):
 *   { id, name, ..., move(gameState), chooseFlagAndTrap() }
 *
 * Memory reset for shared AI state is handled centrally by aiEngine.
 */

/** Map of centralized baby animal name, emoji, and description overrides for all 20 bots. */
const BOT_METADATA_OVERRIDES = {
    // Easy (Зелёные)
    rabbit: { name: 'Зайчик', emoji: '🐰', shortDescription: 'Реактивная эвристика', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    kimi_2_5: { name: 'Хомячок', emoji: '🐹', shortDescription: 'Случайные шаги и простая защита', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    gemini_3_1_pro: { name: 'Утёнок', emoji: '🦆', shortDescription: 'Базовый эвристический поиск', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    haiku_4_5: { name: 'Голубёнок', emoji: '🐦', shortDescription: 'Пассивные защитные маневры', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    grok_apex: { name: 'Обезьянка', emoji: '🐵', shortDescription: 'Агрессивная тактика без глубины', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    grok_build_0_1: { name: 'Ленивчик', emoji: '🦥', shortDescription: 'Медленная реактивная стратегия', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },
    sonnet_4_6_medium: { name: 'Капибарыш', emoji: '🦦', shortDescription: 'Миролюбивый оборонительный стиль', difficultyLabel: 'Лёгкий', tier: 'easy', stars: 1 },

    // Medium (Жёлтые)
    raccoon: { name: 'Енотик', emoji: '🦝', shortDescription: 'Паттерн-анализ и хитрый расчёт', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    fox: { name: 'Лисёнок', emoji: '🦊', shortDescription: 'Коварные уловки и фланговые обходы', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    hedgehog: { name: 'Ёжик', emoji: '🦔', shortDescription: 'Крепкая глухая оборона', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    raven: { name: 'Воронёнок', emoji: '🐦‍⬛', shortDescription: 'Стратегический подрыв капканами', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    wolf: { name: 'Волчонок', emoji: '🐺', shortDescription: 'Агрессивное стайное наступление', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    lion: { name: 'Львёнок', emoji: '🦁', shortDescription: 'Королевский баланс атаки и защиты', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },
    codex_5_3_medium: { name: 'Бобрёнок', emoji: '🦫', shortDescription: 'Строит оборонительные редуты', difficultyLabel: 'Средний', tier: 'medium', stars: 2 },

    // Hard (Красные)
    owl: { name: 'Совёнок', emoji: '🦉', shortDescription: 'Глубокий минимакс поиск (3-4 шага)', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    composer_2_5: { name: 'Лосёнок', emoji: '🫎', shortDescription: 'Многозадачное позиционное планирование', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    gemini_3_5_flash: { name: 'Леопардик', emoji: '🐆', shortDescription: 'Молниеносные контратаки и обман', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    opus_4_8_high: { name: 'Орлёнок', emoji: '🦅', shortDescription: 'Абсолютный позиционный контроль', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    gpt_5_5: { name: 'Медвежонок', emoji: '🐻', shortDescription: 'Тяжёлое доминирующее давление', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 },
    opus_4_7_flash: { name: 'Акулёнок', emoji: '🦈', shortDescription: 'Хищные неожиданные выпады', difficultyLabel: 'Сложный', tier: 'hard', stars: 3 }
};

const MODEL_BOT_IDS = new Set([]);

const BOT_MODEL_AUTHORS = {};

function resolveModelAuthor(bot) {
    return null;
}

const botRegistry = {
    _bots: [],
    _byId: new Map(),
    
    register(bot) {
        if (!bot || typeof bot !== 'object') {
            throw new Error('botRegistry.register: bot must be an object');
        }

        // === CERTIFICATION GATE (enforced by bot-api.js) ===
        if (typeof window !== 'undefined' && window.RPSBotAPI && typeof window.RPSBotAPI.assertCertified === 'function') {
            window.RPSBotAPI.assertCertified(bot, 'register');
        } else if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.assertCertified === 'function') {
            RPSBotAPI.assertCertified(bot, 'register');
        } else {
            console.warn(`[bot-registry] register("${bot.id || '?' }"): RPSBotAPI not yet loaded. Bot will not be properly certified.`);
        }

        if (!bot.id || typeof bot.id !== 'string') {
            throw new Error('botRegistry.register: bot.id must be a non-empty string');
        }
        if (typeof bot.move !== 'function') {
            throw new Error(`botRegistry.register: bot "${bot.id}" missing move()`);
        }
        if (typeof bot.chooseFlagAndTrap !== 'function') {
            throw new Error(`botRegistry.register: bot "${bot.id}" missing chooseFlagAndTrap()`);
        }
        
        const override = BOT_METADATA_OVERRIDES[bot.id] || {};
        
        const allowedTiers = ['easy', 'medium', 'hard'];
        const normalizedTier = override.tier || (allowedTiers.indexOf(bot.tier) >= 0 ? bot.tier : 'medium');
        const normalizedStars = override.stars || ((typeof bot.stars === 'number' && bot.stars >= 1 && bot.stars <= 3)
            ? Math.round(bot.stars)
            : ({ easy: 1, medium: 2, hard: 3 })[normalizedTier]);
        const defaultDifficultyLabel = { easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный' }[normalizedTier];
        
        const normalized = {
            id: bot.id,
            name: override.name || bot.name || bot.id,
            emoji: override.emoji || bot.emoji || '🤖',
            avatar: bot.avatar || null,
            shortDescription: override.shortDescription || bot.shortDescription || '',
            longDescription: override.shortDescription || bot.shortDescription || '',
            algorithmLabel: override.shortDescription || bot.algorithmLabel || '',
            tier: normalizedTier,
            stars: normalizedStars,
            difficultyLabel: override.difficultyLabel || bot.difficultyLabel || defaultDifficultyLabel,
            modelAuthor: null,
            tags: Array.isArray(bot.tags) ? bot.tags.slice() : [],
            move: bot.move.bind(bot),
            chooseFlagAndTrap: bot.chooseFlagAndTrap.bind(bot)
        };

        if (typeof bot.getSmartTieChoice === 'function') {
            normalized.getSmartTieChoice = bot.getSmartTieChoice.bind(bot);
        }

        // Preserve the certification stamp that defineBot() attached.
        // Without this, the stamp is lost during normalization and later
        // "late checks" in get() would incorrectly reject perfectly valid bots.
        if (bot && bot.__rpsBotCertified__) {
            normalized.__rpsBotCertified__ = bot.__rpsBotCertified__;
        }
        
        if (this._byId.has(bot.id)) {
            const existingIdx = this._bots.findIndex(b => b.id === bot.id);
            if (existingIdx >= 0) {
                this._bots[existingIdx] = normalized;
            }
            this._byId.set(bot.id, normalized);
            return normalized;
        }
        
        this._bots.push(normalized);
        this._byId.set(bot.id, normalized);
        return normalized;
    },
    
    has(id) {
        return this._byId.has(id);
    },
    
    get(id) {
        const bot = this._byId.get(id);
        if (bot) {
            return bot;
        }
        const fallback = this._byId.get('rabbit') || this._bots[0] || null;
        if (fallback && id) {
            console.warn(`botRegistry.get: unknown bot "${id}", falling back to "${fallback.id}"`);
        }
        return fallback;
    },
    
    list() {
        const tierOrder = { easy: 1, medium: 2, hard: 3 };
        return this._bots.slice().sort((a, b) => {
            const starsDiff = (a.stars || 0) - (b.stars || 0);
            if (starsDiff !== 0) {
                return starsDiff;
            }
            const tierDiff = (tierOrder[a.tier] || 2) - (tierOrder[b.tier] || 2);
            if (tierDiff !== 0) {
                return tierDiff;
            }
            return String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru');
        });
    },
    
    getDefaultId() {
        return this._bots.length > 0 ? this._bots[0].id : null;
    },
    
    /**
     * Fallback id used when a caller passes something unknown.
     * Picked deliberately so that a broken save, outdated query string
     * or legacy code always ends up on the easiest bot.
     */
    getFallbackId() {
        return this.has('rabbit') ? 'rabbit' : this.getDefaultId();
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.botRegistry = botRegistry;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = botRegistry;
}

