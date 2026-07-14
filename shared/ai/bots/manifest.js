/**
 * Bot Manifest — the ONLY file you edit when adding/removing bots.
 *
 * To add a brand new bot:
 *   1. mkdir bots/yourbot/
 *   2. Put your logic in bots/yourbot/bot.js
 *      - At the very top (after JSDoc) add the mandatory guard:
 *          if (typeof window !== 'undefined' && !window.RPSBotAPI) {
 *              console.error('[yourbot] bot-api.js must be loaded first');
 *          }
 *      - Define your bot object (id, name, move, chooseFlagAndTrap, metadata...)
 *      - At the BOTTOM call:
 *          if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
 *              RPSBotAPI.defineBot(yourBotObject);
 *          }
 *   3. Put avatar-min.png inside the bot folder.
 *      Reference it as 'js/bots/yourbot/avatar-min.png' relative to index.html.
 *   4. Add the string 'yourbot' to the ENABLED_BOTS array below.
 *   5. Refresh the page. The loader will pick it up automatically.
 *
 * Removing a bot: just delete its id from this array (folder can stay).
 *
 * This gives us "drop a folder + one-line manifest entry = fully integrated bot"
 * without needing a build system or directory scanning in the browser.
 */

window.RPS_BOT_MANIFEST = {
    // Order here controls the order cards appear on the splash screen.
    ENABLED_BOTS: [
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
    ],

    // Base path under which every bot folder lives (relative to index.html).
    BASE_PATH: 'js/bots/',

    // The filename inside each folder that contains the defineBot() call.
    BOT_ENTRY: 'bot.js'
};