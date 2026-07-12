import './globals.js';
import './bot-api.js';
import './bot-registry.js';
import './ai-beliefs.js';
import './ai-tactical-core.js';
import './ai-strategy.js';
import './ai-expert.js';
import './ai-engine.js';

// Statically import all bots so they call defineBot and register
import './bots/rabbit/bot.js';
import './bots/raccoon/bot.js';
import './bots/fox/bot.js';
import './bots/owl/bot.js';
import './bots/lion/bot.js';
import './bots/wolf/bot.js';
import './bots/hedgehog/bot.js';
import './bots/raven/bot.js';
import './bots/homyachok/bot.js';
import './bots/bobrenok/bot.js';
import './bots/losenok/bot.js';
import './bots/utenok/bot.js';
import './bots/leopardik/bot.js';
import './bots/medvezhonok/bot.js';
import './bots/obezyanka/bot.js';
import './bots/lenivchik/bot.js';
import './bots/golubenok/bot.js';
import './bots/akulenok/bot.js';
import './bots/orlenok/bot.js';
import './bots/kapibarysh/bot.js';

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

