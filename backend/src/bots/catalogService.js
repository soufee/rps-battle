/**
 * Bot catalog service.
 *
 * Builds the roster the client fetches at runtime (GET /api/v2/bots). For every
 * enabled bot whose code exists on disk it returns display metadata plus a
 * short content hash used to cache-bust the bot code request. Bot LOGIC is
 * served separately as static files under /js/bots/<id>/bot.js.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
    BOT_CATALOG,
    ENABLED_ORDER,
    BOT_BASE_PATH,
    BOT_ENTRY_FILE,
    BOT_AVATAR_FILE
} from '../../../shared/ai/bots/catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOTS_DIR = path.resolve(__dirname, '../../../shared/ai/bots');

// Cache of file path -> { mtimeMs, hash } so we only re-hash a bot.js when it
// actually changes on disk.
const hashCache = new Map();

function computeVersion(botFile) {
    try {
        const stat = fs.statSync(botFile);
        const cached = hashCache.get(botFile);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.hash;
        }
        const content = fs.readFileSync(botFile);
        const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
        hashCache.set(botFile, { mtimeMs: stat.mtimeMs, hash });
        return hash;
    } catch (e) {
        return null;
    }
}

function parseFallbackMeta(id) {
    const meta = { name: id, emoji: '🤖' };
    try {
        const content = fs.readFileSync(path.join(BOTS_DIR, id, BOT_ENTRY_FILE), 'utf8');
        const nameMatch = content.match(/\bname:\s*(['"`])([^'"`]+)\1/);
        if (nameMatch) {
            meta.name = nameMatch[2].trim();
        }
        const emojiMatch = content.match(/\bemoji:\s*(['"`])([^'"`]+)\1/);
        if (emojiMatch) {
            meta.emoji = emojiMatch[2].trim();
        }
    } catch (e) {
        // Keep defaults.
    }
    return meta;
}

// Accept only simple ids and make sure the resolved path stays inside BOTS_DIR
// (defence against path traversal via the :id route param).
function safeBotFile(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
        return null;
    }
    const botFile = path.join(BOTS_DIR, id, BOT_ENTRY_FILE);
    const rel = path.relative(BOTS_DIR, botFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
    }
    return botFile;
}

/**
 * Hash-validated resolution of a bot's code for client-side caching.
 *   - not_found : no such bot on disk
 *   - up_to_date: the client's cached hash matches the server → reuse cache
 *   - updated   : hashes differ (or client had none) → returns fresh code
 */
export function resolveBotCode(id, haveHash) {
    const botFile = safeBotFile(id);
    if (!botFile || !fs.existsSync(botFile)) {
        return { status: 'not_found' };
    }
    const version = computeVersion(botFile);
    if (haveHash && haveHash === version) {
        return { status: 'up_to_date', version };
    }
    let code;
    try {
        code = fs.readFileSync(botFile, 'utf8');
    } catch (e) {
        return { status: 'not_found' };
    }
    return { status: 'updated', version, code };
}

/**
 * Assemble the catalog: enabled bots that actually have a bot.js on disk,
 * enriched with display metadata and a version hash.
 */
export function buildBotCatalog() {
    const list = [];
    for (const id of ENABLED_ORDER) {
        const botFile = path.join(BOTS_DIR, id, BOT_ENTRY_FILE);
        if (!fs.existsSync(botFile)) {
            continue;
        }
        const version = computeVersion(botFile);
        const meta = BOT_CATALOG[id] || parseFallbackMeta(id);
        const tier = meta.tier || 'medium';
        const stars = meta.stars || ({ easy: 1, medium: 2, hard: 3 })[tier] || 2;
        const difficultyLabel = meta.difficultyLabel
            || ({ easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный' })[tier];
        list.push({
            id,
            name: meta.name || id,
            emoji: meta.emoji || '🤖',
            avatar: `${BOT_BASE_PATH}${id}/${BOT_AVATAR_FILE}`,
            tier,
            stars,
            difficultyLabel,
            shortDescription: meta.shortDescription || '',
            version
        });
    }
    return list;
}
