/**
 * Runtime bot loader.
 *
 * Bot LOGIC is no longer bundled into the client. Instead:
 *   - the roster metadata is fetched from the backend (GET /api/v2/bots), and
 *   - each bot's code is fetched on demand from /js/bots/<id>/bot.js when a
 *     match against it starts.
 *
 * This means editing or adding a bot only needs a backend redeploy — the
 * client never has to be rebuilt.
 *
 * The engine (bot-api, bot-registry, ai-*, game-core) stays in the bundle; a
 * fetched bot self-registers through the global RPSBotAPI.defineBot() contract,
 * exactly like the classic <script>-tag roster did.
 */

import { BOT_CATALOG, ENABLED_ORDER, BOT_BASE_PATH, BOT_AVATAR_FILE } from './bots/catalog.js';

// Base URL of the backend that serves bot code + metadata. Empty string means
// same-origin (production website); on itch/Yandex/FB it points to the API host.
let BASE_URL = '';

// Cross-platform persistent cache adapter ({ getItem, setItem }). Provided by
// the client (localStorage on web, AsyncStorage on native). Absent in Node.
let CACHE = null;

const CACHE_PREFIX = 'rps_bot_code_';

// Per-id load promises so concurrent/duplicate requests share one fetch.
const inflight = new Map();

/**
 * @param {string} baseUrl backend origin serving bot code + metadata
 * @param {{getItem:Function,setItem:Function}} [cache] persistent code cache
 */
export function configureBotLoader(baseUrl, cache) {
    BASE_URL = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
    CACHE = cache && typeof cache.getItem === 'function' ? cache : null;
}

async function readCachedBot(id) {
    if (!CACHE) {
        return null;
    }
    try {
        const raw = await CACHE.getItem(CACHE_PREFIX + id);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version && typeof parsed.code === 'string') {
            return parsed;
        }
    } catch (e) {
        // Corrupt entry — ignore and re-fetch.
    }
    return null;
}

async function writeCachedBot(id, version, code) {
    if (!CACHE || typeof CACHE.setItem !== 'function') {
        return;
    }
    try {
        await CACHE.setItem(CACHE_PREFIX + id, JSON.stringify({ version, code }));
    } catch (e) {
        // Cache is best-effort (e.g. storage quota) — never fatal.
    }
}

function registry() {
    return (typeof globalThis !== 'undefined' && globalThis.botRegistry)
        ? globalThis.botRegistry
        : null;
}

// A local roster assembled purely from the bundled catalog. Used when the
// backend is unreachable so the selection screen still shows something.
function bundledCatalog() {
    const list = [];
    for (const id of ENABLED_ORDER) {
        const meta = BOT_CATALOG[id];
        if (!meta) {
            continue;
        }
        list.push({
            id,
            name: meta.name,
            emoji: meta.emoji,
            avatar: `${BOT_BASE_PATH}${id}/${BOT_AVATAR_FILE}`,
            tier: meta.tier,
            stars: meta.stars,
            difficultyLabel: meta.difficultyLabel,
            shortDescription: meta.shortDescription,
            version: null
        });
    }
    return list;
}

/**
 * Fetch the playable roster from the backend and publish it to the registry.
 * Falls back to the bundled catalog if the request fails.
 */
export async function loadBotCatalog() {
    const reg = registry();
    let list = null;
    try {
        const res = await fetch(`${BASE_URL}/api/v2/bots`, {
            headers: { Accept: 'application/json' }
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                list = data;
            }
        }
    } catch (err) {
        console.warn('[bot-loader] catalog fetch failed, using bundled catalog:', err);
    }
    if (!list) {
        list = bundledCatalog();
    }
    if (reg && typeof reg.setCatalog === 'function') {
        reg.setCatalog(list);
    }
    return list;
}

// Execute a bot's source so it self-registers via the global
// RPSBotAPI.defineBot(). We run it as an inline <script> in the global scope,
// exactly like the classic roster, so the bot's bare `RPSBotAPI`/`botRegistry`
// references resolve. Works for both freshly-fetched and cached code.
function execBotCode(code) {
    if (typeof document === 'undefined') {
        throw new Error('bot-loader: document is not available (non-web runtime)');
    }
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.text = code;
    document.head.appendChild(script);
}

// Ask the server whether the client's cached hash is still current. Returns the
// code to execute (from cache when up to date, freshly downloaded otherwise).
async function resolveBotCode(id, cached) {
    const have = cached && cached.version ? cached.version : '';
    const url = `${BASE_URL}/api/v2/bots/${encodeURIComponent(id)}/code`
        + `?have=${encodeURIComponent(have)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
        throw new Error(`bot-loader: code request for "${id}" failed (${res.status})`);
    }
    const data = await res.json();
    if (data.status === 'up_to_date' && cached && cached.code) {
        return { code: cached.code, version: cached.version, fromCache: true };
    }
    if (data.status === 'updated' && typeof data.code === 'string') {
        return { code: data.code, version: data.version, fromCache: false };
    }
    // up_to_date but the cached body was lost, or an unexpected shape: force a
    // full download by asking again without a hash.
    const res2 = await fetch(`${BASE_URL}/api/v2/bots/${encodeURIComponent(id)}/code`, {
        headers: { Accept: 'application/json' }
    });
    const data2 = await res2.json();
    if (data2 && typeof data2.code === 'string') {
        return { code: data2.code, version: data2.version, fromCache: false };
    }
    throw new Error(`bot-loader: could not resolve code for "${id}"`);
}

async function loadBot(id) {
    const reg = registry();
    const cached = await readCachedBot(id);

    let resolved;
    try {
        resolved = await resolveBotCode(id, cached);
    } catch (err) {
        // Offline / server unreachable: fall back to the cached copy if we have
        // one, so a previously played bot still works without a connection.
        if (cached && cached.code) {
            resolved = { code: cached.code, version: cached.version, fromCache: true };
        } else {
            throw err;
        }
    }

    execBotCode(resolved.code);
    if (!reg || typeof reg.has !== 'function' || !reg.has(id)) {
        throw new Error(`bot-loader: "${id}" did not register after load`);
    }
    if (!resolved.fromCache) {
        await writeCachedBot(id, resolved.version, resolved.code);
    }
    return id;
}

/**
 * Guarantee that a bot's code is loaded and registered before it is used in a
 * match. Resolves immediately if the bot is already registered. The code is
 * cached client-side and only re-downloaded when its server hash changes.
 * Concurrent calls for the same id share a single request.
 */
export function ensureBotLoaded(id) {
    const reg = registry();
    if (!id) {
        return Promise.reject(new Error('bot-loader: missing bot id'));
    }
    if (reg && typeof reg.has === 'function' && reg.has(id)) {
        return Promise.resolve(id);
    }
    if (inflight.has(id)) {
        return inflight.get(id);
    }

    const promise = loadBot(id).catch((err) => {
        // Allow a later retry after a transient failure.
        inflight.delete(id);
        throw err;
    });

    inflight.set(id, promise);
    return promise;
}

/** Load several bots at once (e.g. both sides of a championship match). */
export function ensureBotsLoaded(ids) {
    const unique = Array.from(new Set((ids || []).filter(Boolean)));
    return Promise.all(unique.map(ensureBotLoaded));
}
