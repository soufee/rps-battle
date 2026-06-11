const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {}));

if (typeof g.window === 'undefined') {
    g.window = g;
}

// Import game configuration and rules
import { GAME_CONFIG, PLAYER, COMPUTER, FLAG, TRAP, PIECE_TYPES, PIECE_SYMBOLS, BOARD_WIDTH, BOARD_HEIGHT } from '../game-config.js';
import { resolveBattle } from '../game-rules.js';

// Populate globals for legacy modules/bots
g.GAME_CONFIG = GAME_CONFIG;
g.PLAYER = PLAYER;
g.COMPUTER = COMPUTER;
g.FLAG = FLAG;
g.TRAP = TRAP;
g.PIECE_TYPES = PIECE_TYPES;
g.PIECE_SYMBOLS = PIECE_SYMBOLS;
g.BOARD_WIDTH = BOARD_WIDTH;
g.BOARD_HEIGHT = BOARD_HEIGHT;
g.resolveBattle = resolveBattle;
