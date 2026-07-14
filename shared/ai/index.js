import './globals.js';
import './bot-api.js';
import './bot-registry.js';
import './ai-beliefs.js';
import './ai-tactical-core.js';
import './ai-strategy.js';
import './ai-expert.js';
import './ai-engine.js';

// Bot LOGIC is no longer bundled. The engine above stays in the bundle, while
// each bot's code is fetched from the backend at runtime (see bot-loader.js).
// This lets bots be edited or added without rebuilding the client.

import './dev-mode.js';

// Export everything cleanly
const g = globalThis;
export const RPSBotAPI = g.RPSBotAPI;
export const botRegistry = g.botRegistry;
export const aiBeliefs = g.aiBeliefs;
export const aiTacticalCore = g.aiTacticalCore;
export const aiStrategy = g.aiStrategy;
export const aiExpert = g.aiExpert;
export const aiEngine = g.aiEngine;
export const devMode = g.devMode;

// Runtime bot loading (catalog + on-demand code fetch).
export {
    configureBotLoader,
    loadBotCatalog,
    ensureBotLoaded,
    ensureBotsLoaded
} from './bot-loader.js';

