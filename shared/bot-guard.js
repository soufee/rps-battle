import { GAME_CONFIG, PIECE_TYPES } from './game-config.js';

/**
 * Output guards for untrusted bot code (anti-cheat).
 *
 * A bot is arbitrary code and its return values cannot be trusted. Everything a
 * bot returns MUST be validated and reduced to safe primitives before the engine
 * acts on it. These helpers never throw on bad bot output — they fall back to a
 * legal default so a malicious or buggy bot forfeits the advantage instead of
 * corrupting the game state.
 */

const TOTAL_CELLS = GAME_CONFIG.GAME.TOTAL_PIECES;

/** Safe placement used whenever a bot returns an invalid setup. */
const DEFAULT_SETUP = { flagIndex: 3, trapIndex: 12 };

/** Bot ids that must never be registered (prototype pollution / reserved). */
export const RESERVED_BOT_IDS = new Set([
    '__proto__',
    'prototype',
    'constructor',
    'hasownproperty',
    'toString',
    'valueof'
]);

/**
 * Must start with a lowercase letter, then lowercase letters, digits, hyphens
 * or underscores; total length 2..40. This blocks whitespace, dots, slashes and
 * prototype keys like `__proto__` (they don't start with a letter).
 */
const BOT_ID_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/;

function isSafeCellIndex(value) {
    return Number.isInteger(value)
        && value >= 0
        && value < TOTAL_CELLS;
}

/**
 * Validate the {flagIndex, trapIndex} a bot returns from chooseFlagAndTrap().
 *
 * Guarantees the returned setup places EXACTLY one flag and one trap in two
 * distinct, on-board cells. Any deviation (missing flag, duplicate index,
 * out-of-range, non-integer, extra fields) collapses to a legal default so a
 * bot can never field an army without a flag or with duplicate specials.
 */
export function sanitizeSetup(raw) {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_SETUP };
    }
    const flagIndex = raw.flagIndex;
    const trapIndex = raw.trapIndex;
    const valid = isSafeCellIndex(flagIndex)
        && isSafeCellIndex(trapIndex)
        && flagIndex !== trapIndex;
    if (!valid) {
        return { ...DEFAULT_SETUP };
    }
    return { flagIndex, trapIndex };
}

/**
 * Validate a tie-break choice. Only the three real weapons are accepted; any
 * other value (null, object, extra type, non-string) falls back to 'rock'.
 */
export function sanitizeTieChoice(raw) {
    if (raw === PIECE_TYPES[0]
        || raw === PIECE_TYPES[1]
        || raw === PIECE_TYPES[2]) {
        return raw;
    }
    return PIECE_TYPES[0];
}

/**
 * Reduce a bot's move to safe primitives. Returns null when the shape is not a
 * plausible move; the caller still re-validates legality against the real board.
 */
export function sanitizeMove(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const piece = raw.piece;
    if (!piece || typeof piece !== 'object' || typeof piece.id !== 'string') {
        return null;
    }
    if (!Number.isInteger(raw.row) || !Number.isInteger(raw.col)) {
        return null;
    }
    return { pieceId: piece.id, row: raw.row, col: raw.col };
}

/**
 * Whether a bot id is structurally safe to register.
 */
export function isValidBotId(id) {
    if (typeof id !== 'string') {
        return false;
    }
    if (RESERVED_BOT_IDS.has(id.toLowerCase())) {
        return false;
    }
    return BOT_ID_PATTERN.test(id);
}
