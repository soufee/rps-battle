export const GAME_CONFIG = {
    DEBUG: false,

    BOARD: {
        WIDTH: 8,
        HEIGHT: 6,
        CELL_SIZE: 60,
        GAP: 2,
        PLAYER_ROWS: [4, 5], // Bottom for player p1
        OPPONENT_ROWS: [0, 1] // Top for player p2
    },
    
    TIMING: {
        AI_THINK_DELAY: 1000,
        ANIMATION_DURATION: 500,
        BATTLE_ANIMATION: 300,
        MOVE_ANIMATION: 500,
        PARTICLE_DURATION: 1000,
        SETUP_ANIMATION: 100
    },

    SCORING: {
        FLAG_CAPTURE: 10000,
        FLAG_ATTACK_PENALTY: -10000,
        TRAP_PENALTY: -500,
        GUARANTEED_WIN: 500,
        PROBABLE_WIN: 300,
        DRAW_BATTLE: 100,
        LOSE_BATTLE: -100,
        SAFE_ATTACK: 100,
        RISKY_ATTACK: 50,
        EXPLORATION: 15,
        POSITION_CENTER: 8,
        POSITION_EDGE: -5,
        FLAG_SAFETY_DISTANCE: 50,
        FLAG_DEFENDER_BONUS: 80,
        GANG_BONUS: 40,
        ALLY_SUPPORT: 15,
        THREAT_LEVEL: -30,
        ESCAPE_BONUS: 200
    },

    GAME: {
        TOTAL_PIECES: 16,
        MAX_MINIMAX_DEPTH: 3,
        POSITION_CACHE_SIZE: 1000,
        /** Ходов без взятий до автоматической ничьей (счётчик сбрасывается при съедании фигуры). */
        DRAW_NO_CAPTURE_LIMIT: 20
    },
    
    PIECE_TYPES: {
        FLAG: 'flag',
        TRAP: 'trap',
        ROCK: 'rock',
        PAPER: 'paper',
        SCISSORS: 'scissors'
    },
    
    PIECE_SYMBOLS: {
        flag: '🏴',
        trap: '💥',
        rock: '🗿',
        paper: '📄',
        scissors: '✂️',
        unknown: '?'
    },
    
    PLAYERS: {
        PLAYER: 'player',
        COMPUTER: 'computer'
    },
    
    PHASES: {
        SETUP: 'setup',
        PLAYING: 'playing',
        FINISHED: 'finished'
    },
    
    SETUP_PHASES: {
        FLAG: 'flag',
        TRAP: 'trap',
        DONE: 'done'
    },
    
    BATTLE_RESULTS: {
        WIN: 'win',
        LOSE: 'lose',
        DRAW: 'draw'
    },
    
    DIRECTIONS: [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1],           [0, 1],
        [1, -1],  [1, 0],  [1, 1]
    ],
    
    WIN_CONDITIONS: {
        rock: 'scissors',
        paper: 'rock',
        scissors: 'paper'
    },

    PLAYER_PATTERNS: {
        AGGRESSIVE: 'aggressive',
        DEFENSIVE: 'defensive',
        BALANCED: 'balanced',
        RANDOM: 'random'
    },

    AI_TACTICS: {
        FALSE_WEAKNESS: 'false_weakness',
        DEATH_CORRIDOR: 'death_corridor',
        PAWN_SACRIFICE: 'pawn_sacrifice'
    },

    PARTICLE_COLORS: {
        victory: ['#4CAF50', '#8BC34A', '#CDDC39'],
        defeat: ['#F44336', '#E91E63', '#FF5722'],
        battle: ['#FFC107', '#FF9800', '#FF5722'],
        move: ['#2196F3', '#03A9F4', '#00BCD4']
    }
};

export const BOARD_WIDTH = GAME_CONFIG.BOARD.WIDTH;
export const BOARD_HEIGHT = GAME_CONFIG.BOARD.HEIGHT;
export const PLAYER_ROWS = GAME_CONFIG.BOARD.PLAYER_ROWS;
export const OPPONENT_ROWS = GAME_CONFIG.BOARD.OPPONENT_ROWS;
export const FLAG = GAME_CONFIG.PIECE_TYPES.FLAG;
export const TRAP = GAME_CONFIG.PIECE_TYPES.TRAP;
export const PIECE_TYPES = ['rock', 'paper', 'scissors'];
export const PIECE_SYMBOLS = GAME_CONFIG.PIECE_SYMBOLS;
export const PLAYER = GAME_CONFIG.PLAYERS.PLAYER;
export const COMPUTER = GAME_CONFIG.PLAYERS.COMPUTER;

export function formatBoardCoord(row, col) {
    const rank = BOARD_HEIGHT - row;
    return `${String.fromCharCode(65 + col)}${rank}`;
}

