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

import { isValidBotId } from '../bot-guard.js';
import { BOT_CATALOG } from './bots/catalog.js';

/**
 * Centralized display metadata (name, emoji, difficulty, description) for the
 * whole roster. Shared with the backend via bots/catalog.js so the selection
 * screen and the gameplay descriptor never disagree.
 */
const BOT_METADATA_OVERRIDES = BOT_CATALOG;

const MODEL_BOT_IDS = new Set([]);

const BOT_MODEL_AUTHORS = {};

function resolveModelAuthor(bot) {
    return null;
}

const botRegistry = {
    _bots: [],
    _byId: new Map(),
    _sealed: false,
    // Lightweight roster metadata fetched from the backend. Populates the
    // selection screen WITHOUT loading each bot's code. Entries have the same
    // display shape as registered bots but no move()/chooseFlagAndTrap().
    _catalog: [],
    _catalogById: new Map(),

    /**
     * Publish the roster metadata received from the backend. Each entry:
     *   { id, name, emoji, avatar, tier, stars, difficultyLabel,
     *     shortDescription, version }
     * `version` is used for cache-busting when the bot code is fetched.
     */
    setCatalog(list) {
        const arr = Array.isArray(list) ? list : [];
        this._catalog = arr.slice();
        this._catalogById = new Map();
        for (const meta of arr) {
            if (meta && meta.id) {
                this._catalogById.set(meta.id, meta);
            }
        }
        return this._catalog;
    },

    /**
     * Display metadata for a bot id: prefers the loaded descriptor, falls back
     * to catalog metadata (available before the code is fetched).
     */
    getMeta(id) {
        return this._byId.get(id) || this._catalogById.get(id) || null;
    },

    /** Version tag for a bot id (for cache-busting the code request). */
    getVersion(id) {
        const meta = this._catalogById.get(id);
        return meta && meta.version ? meta.version : null;
    },

    /**
     * Lock the registry after the official roster is loaded. Once sealed, no bot
     * can overwrite an already-registered id (anti-impersonation) — a malicious
     * bot cannot hijack an opponent's slot by re-declaring its id.
     */
    seal() {
        this._sealed = true;
    },

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
        // Reject structurally unsafe ids (prototype-pollution keys, weird chars).
        if (!isValidBotId(bot.id)) {
            throw new Error(`botRegistry.register: invalid bot id "${bot.id}"`);
        }
        // Anti-impersonation: a sealed registry never lets an existing slot be
        // overwritten by another bot re-declaring the same id.
        if (this._sealed && this._byId.has(bot.id)) {
            throw new Error(`botRegistry.register: registry is sealed, cannot overwrite "${bot.id}"`);
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

        // Freeze the stored descriptor so no later code can swap a bot's
        // move()/chooseFlagAndTrap() through the registry reference.
        Object.freeze(normalized);

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
        // Before a bot's code is fetched, expose its catalog metadata so UI
        // lookups (name/emoji/avatar) work. Callers that need gameplay methods
        // must ensure the code is loaded first (see ensureBotLoaded).
        const meta = this._catalogById.get(id);
        if (meta) {
            return meta;
        }
        const fallback = this._byId.get('rabbit') || this._bots[0] || null;
        if (fallback && id) {
            console.warn(`botRegistry.get: unknown bot "${id}", falling back to "${fallback.id}"`);
        }
        return fallback;
    },

    list() {
        const tierOrder = { easy: 1, medium: 2, hard: 3 };
        const sorter = (a, b) => {
            const starsDiff = (a.stars || 0) - (b.stars || 0);
            if (starsDiff !== 0) {
                return starsDiff;
            }
            const tierDiff = (tierOrder[a.tier] || 2) - (tierOrder[b.tier] || 2);
            if (tierDiff !== 0) {
                return tierDiff;
            }
            return String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru');
        };
        // Prefer the backend catalog (drives the selection screen without loading
        // any bot code); fall back to the registered bots when no catalog is set.
        const source = this._catalog.length > 0 ? this._catalog : this._bots;
        return source.slice().sort(sorter);
    },
    
    getDefaultId() {
        if (this._bots.length > 0) {
            return this._bots[0].id;
        }
        return this._catalog.length > 0 ? this._catalog[0].id : null;
    },
    
    /**
     * Fallback id used when a caller passes something unknown.
     * Picked deliberately so that a broken save, outdated query string
     * or legacy code always ends up on the easiest bot.
     */
    getFallbackId() {
        if (this.has('rabbit') || this._catalogById.has('rabbit')) {
            return 'rabbit';
        }
        return this.getDefaultId();
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.botRegistry = botRegistry;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = botRegistry;
}

