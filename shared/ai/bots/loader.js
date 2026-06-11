/**
 * Bot Loader — consumes bots/manifest.js and dynamically loads every
 * enabled bot's bot.js file.
 *
 * It MUST be included in index.html AFTER bot-api.js and bot-registry.js
 * but BEFORE game-core.js (and before the inline renderBotCards call).
 *
 * This is what makes "add folder + edit manifest = bot appears" work.
 *
 * We use synchronous script injection (document.write or create+append + wait)
 * to preserve the classic global-polluting script semantics the rest of the
 * game relies on. After all bots are injected we dispatch a small event so
 * late code can react if needed.
 */

(function () {
    'use strict';

    function loadBotScripts() {
        const manifest = (typeof window !== 'undefined' && window.RPS_BOT_MANIFEST)
            ? window.RPS_BOT_MANIFEST
            : { ENABLED_BOTS: [], BASE_PATH: 'js/bots/', BOT_ENTRY: 'bot.js' };

        const bots = Array.isArray(manifest.ENABLED_BOTS) ? manifest.ENABLED_BOTS : [];
        const base = manifest.BASE_PATH || 'js/bots/';
        const entry = manifest.BOT_ENTRY || 'bot.js';

        if (bots.length === 0) {
            console.warn('[bot-loader] No bots listed in manifest. Registry will be empty.');
            return Promise.resolve([]);
        }

        // We load them sequentially to keep registration order predictable.
        // Each bot script, when executed, will call RPSBotAPI.defineBot(...)
        // which in turn calls botRegistry.register (after stamping).
        return new Promise((resolve) => {
            let i = 0;
            const loaded = [];

            function next() {
                if (i >= bots.length) {
                    // All done — notify anyone who cares
                    try {
                        window.dispatchEvent(new CustomEvent('rps-bots-loaded', {
                            detail: { bots: loaded }
                        }));
                    } catch (_) {}
                    console.log(`[bot-loader] Loaded ${loaded.length} certified bots:`, loaded.map(b => b.id || b));
                    resolve(loaded);
                    return;
                }

                const id = bots[i++];
                const src = `${base}${id}/${entry}`;

                const script = document.createElement('script');
                script.src = src;
                script.async = false; // keep execution order

                script.onload = () => {
                    loaded.push(id);
                    next();
                };
                script.onerror = (e) => {
                    console.error(`[bot-loader] Failed to load bot "${id}" from ${src}`, e);
                    // Continue with the rest — one broken bot shouldn't kill the whole roster
                    next();
                };

                document.head.appendChild(script);
            }

            next();
        });
    }

    // Expose a manual trigger in case someone wants to reload bots at runtime
    window.RPSBotLoader = {
        load: loadBotScripts,
        manifest: () => window.RPS_BOT_MANIFEST
    };

    // Auto-start loading as soon as this file runs.
    // We return the promise on window so index.html inline code can await if it wants.
    window.__rpsBotLoadPromise = loadBotScripts();
})();