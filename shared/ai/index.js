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
import './bots/kimi_2_5/bot.js';
import './bots/codex_5_3_medium/bot.js';
import './bots/composer_2_5/bot.js';
import './bots/gemini_3_1_pro/bot.js';
import './bots/gemini_3_5_flash/bot.js';
import './bots/gpt_5_5/bot.js';
import './bots/grok_apex/bot.js';
import './bots/grok_build_0_1/bot.js';
import './bots/haiku_4_5/bot.js';
import './bots/opus_4_7_flash/bot.js';
import './bots/opus_4_8_high/bot.js';
import './bots/sonnet_4_6_medium/bot.js';

// Export everything cleanly
const g = globalThis;
export const RPSBotAPI = g.RPSBotAPI;
export const botRegistry = g.botRegistry;
export const aiBeliefs = g.aiBeliefs;
export const aiTacticalCore = g.aiTacticalCore;
export const aiStrategy = g.aiStrategy;
export const aiExpert = g.aiExpert;
export const aiEngine = g.aiEngine;
