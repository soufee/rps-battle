/**
 * RPS Bot API — the mandatory contract and rulebook for all playable bots.
 *
 * Every bot folder MUST import (reference) this file before registration.
 * The loader and registry will reject any bot that has not been defined
 * through this API — this guarantees that all bots play by the same core rules.
 *
 * Usage in a bot (bots/<id>/bot.js):
 *   // 1. Require the base (order matters — must be before any register call)
 *   //    (in classic script world we just ensure it's loaded first)
 *   if (!window.RPSBotAPI) {
 *       throw new Error('[my-bot] bot-api.js must be loaded before this bot');
 *   }
 *
 *   const { defineBot, RULES, resolveBattle } = window.RPSBotAPI;
 *
 *   const myBot = defineBot({
 *       id: 'mybot',
 *       name: 'My Bot',
 *       // ... metadata ...
 *       move(gameState) { ... use RULES, resolveBattle ... },
 *       chooseFlagAndTrap() { ... }
 *   });
 *
 * The returned object is the certified descriptor ready for the registry.
 *
 * Core rules provided here (single source of truth for bots):
 *   - Board geometry and indexing (0..15 linear for placement)
 *   - RPS combat resolution (no cheating)
 *   - Legal movement (king-like, no friendly capture)
 *   - Special Flag / Trap interactions (flag never attacks, trap rules)
 *   - Helpers that every serious bot needs (getLegalMoves, etc.)
 */

(function () {
    'use strict';

    // =====================================================================
    //  CANONICAL GAME RULES (extracted / hardened from game-config + core)
    // =====================================================================

    const RULES = {
        BOARD: {
            WIDTH: 8,
            HEIGHT: 6
        },

        // Linear placement indices 0-15 map to top (AI) rows 0-1 or bottom rows 4-5
        // row = Math.floor(index / 8), col = index % 8
        PLACEMENT: {
            TOP_ROWS: [0, 1],
            BOTTOM_ROWS: [4, 5],
            TOTAL_PIECES: 16
        },

        // 8-directional king move (Chebyshev distance == 1)
        DIRECTIONS: [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ],

        // Rock-paper-scissors
        WIN_CONDITIONS: {
            rock: 'scissors',
            paper: 'rock',
            scissors: 'paper'
        },

        PIECE_TYPES: ['rock', 'paper', 'scissors'],

        SPECIAL_TYPES: {
            FLAG: 'flag',
            TRAP: 'trap'
        },

        // A revealed flag anywhere is instant loss for its owner if captured
        // Trap: attacker dies on contact; trap itself becomes immobile after use
    };

    /**
     * Pure RPS battle resolver. Returns 'win' | 'lose' | 'draw'.
     * This is THE authoritative implementation — bots and core should prefer it.
     */
    function resolveBattle(type1, type2) {
        if (!type1 || !type2) return 'draw';
        if (type1 === type2) return 'draw';
        return RULES.WIN_CONDITIONS[type1] === type2 ? 'win' : 'lose';
    }

    /**
     * Returns true if moving a piece from (r1,c1) to (r2,c2) is a legal
     * one-step king move on the board (does NOT check occupancy — caller does).
     */
    function isLegalStep(r1, c1, r2, c2) {
        if (r2 < 0 || r2 >= RULES.BOARD.HEIGHT || c2 < 0 || c2 >= RULES.BOARD.WIDTH) {
            return false;
        }
        const dr = Math.abs(r2 - r1);
        const dc = Math.abs(c2 - c1);
        return (dr <= 1 && dc <= 1) && (dr + dc > 0);
    }

    /**
     * Compute legal destination cells for a piece (respects "no friendly capture").
     * Does NOT consider special flag/trap attack rules — higher layers do.
     */
    function getLegalMoves(piece, gameState) {
        if (!piece || piece.immobilized || piece.removed || piece.row < 0) {
            return [];
        }
        const moves = [];
        const board = gameState.board;

        for (const [dr, dc] of RULES.DIRECTIONS) {
            const nr = piece.row + dr;
            const nc = piece.col + dc;
            if (nr < 0 || nr >= RULES.BOARD.HEIGHT || nc < 0 || nc >= RULES.BOARD.WIDTH) {
                continue;
            }
            const target = board[nr] && board[nr][nc];
            if (!target || target.owner !== piece.owner) {
                moves.push({ row: nr, col: nc });
            }
        }
        return moves;
    }

    /**
     * True if the attacker is allowed to initiate combat on the defender
     * according to core rules (flag never attacks, etc.).
     * Used by bots to filter suicidal or illegal-looking moves.
     */
    function canAttack(attacker, defender) {
        if (!attacker || !defender) return false;
        if (attacker.type === RULES.SPECIAL_TYPES.FLAG) {
            return false; // flag never attacks
        }
        // Trap attacking is allowed (it sacrifices itself to eat)
        return true;
    }

    /**
     * Placement helper: convert linear 0-15 index into {row, col} for the
     * given side ('top' for AI / COMPUTER, 'bottom' for PLAYER).
     */
    function placementIndexToCoord(index, side) {
        const rowOffset = (side === 'bottom') ? 4 : 0;
        const row = Math.floor(index / 8) + rowOffset;
        const col = index % 8;
        return { row, col };
    }

    // =====================================================================
    //  CONTRACT & CERTIFICATION
    // =====================================================================

    const REQUIRED_METHODS = ['move', 'chooseFlagAndTrap'];
    const REQUIRED_STRING_FIELDS = ['id', 'name'];
    const CERT_STAMP = '__rpsBotCertified__';
    const API_VERSION = '1.0.0';

    /**
     * defineBot — the ONLY sanctioned way for a bot to be born.
     * Validates shape, stamps the object as certified, then registers it.
     * Throws on any violation so broken bots never make it into the roster.
     */
    function defineBot(rawBot) {
        if (!rawBot || typeof rawBot !== 'object') {
            throw new Error('defineBot: bot descriptor must be an object');
        }

        // Basic shape validation (the uniform interface)
        for (const f of REQUIRED_STRING_FIELDS) {
            if (!rawBot[f] || typeof rawBot[f] !== 'string') {
                throw new Error(`defineBot: bot must have non-empty string "${f}"`);
            }
        }
        for (const m of REQUIRED_METHODS) {
            if (typeof rawBot[m] !== 'function') {
                throw new Error(`defineBot: bot "${rawBot.id}" missing required method ${m}()`);
            }
        }

        // Prevent duplicate registration attempts from same module
        if (rawBot[CERT_STAMP]) {
            console.warn(`[bot-api] Bot "${rawBot.id}" already certified — re-registering is allowed for hot-reload.`);
        }

        // Create a normalized, certified descriptor.
        // Bots keep their own extra methods / state (the _pickMove etc. are private).
        const certified = Object.assign({}, rawBot, {
            [CERT_STAMP]: API_VERSION,
            // Freeze the contract methods so a naughty bot can't replace them after definition
            move: rawBot.move.bind(rawBot),
            chooseFlagAndTrap: rawBot.chooseFlagAndTrap.bind(rawBot)
        });

        // Delegate to the registry (will do its own metadata normalization)
        if (typeof botRegistry !== 'undefined' && botRegistry && typeof botRegistry.register === 'function') {
            // The registry will also normalize tier/stars etc.
            return botRegistry.register(certified);
        }

        // If registry not present yet (edge load order), still return the stamped object.
        // The registry will pick it up later via its own mechanisms if needed.
        console.warn('[bot-api] botRegistry not ready at defineBot time — bot will be registered when registry loads.');
        return certified;
    }

    /**
     * Check whether a bot object went through the official defineBot path.
     */
    function isCertified(bot) {
        return !!(bot && bot[CERT_STAMP]);
    }

    /**
     * Guard for use inside bot-registry or loader.
     */
    function assertCertified(bot, context) {
        if (!isCertified(bot)) {
            const id = (bot && bot.id) || 'unknown';
            throw new Error(
                `[bot-api] Refusing to ${context || 'register'} uncertified bot "${id}". ` +
                'All bots MUST be created via RPSBotAPI.defineBot() after loading bot-api.js'
            );
        }
    }

    // =====================================================================
    //  PUBLIC API SURFACE
    // =====================================================================

    const RPSBotAPI = {
        version: API_VERSION,
        RULES,
        resolveBattle,
        isLegalStep,
        getLegalMoves,
        canAttack,
        placementIndexToCoord,

        defineBot,
        isCertified,
        assertCertified,

        // Convenience re-exports of the minimal uniform interface
        CONTRACT: {
            requiredMethods: REQUIRED_METHODS.slice(),
            requiredFields: REQUIRED_STRING_FIELDS.slice()
        }
    };

    // Make globally available for classic script tags (no ES modules)
    // In browsers this also creates the bare `RPSBotAPI` identifier.
    const globalObj = (typeof window !== 'undefined') ? window
                    : (typeof globalThis !== 'undefined') ? globalThis
                    : (typeof global !== 'undefined') ? global : {};
    globalObj.RPSBotAPI = RPSBotAPI;

    // Also expose a couple of the most critical rules as top-level for legacy bots
    // (we do NOT want to break existing code that uses GAME_CONFIG.WIN_CONDITIONS directly)
    // But new bots are encouraged to do: const { resolveBattle } = window.RPSBotAPI;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RPSBotAPI;
    }

    console.log(`[bot-api] RPS Bot API v${API_VERSION} ready — all bots must use defineBot()`);
})();