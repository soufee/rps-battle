import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';
import vm from 'node:vm';

import {
    aiBeliefs,
    aiEngine,
    botRegistry,
    devMode
} from '../../shared/ai/index.js';
import { sanitizeMove, sanitizeSetup } from '../../shared/bot-guard.js';
import { createBotView } from '../../shared/bot-view.js';
import {
    initGame,
    makeBotMove,
    makeBottomBotMove,
    resolveDevModeTie,
    startDevMatch,
    startGame
} from '../../shared/game-core.js';
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    COMPUTER,
    FLAG,
    GAME_CONFIG,
    PLAYER
} from '../../shared/game-config.js';
import { getValidMoves } from '../../shared/game-rules.js';
import { ENABLED_ORDER } from '../../shared/ai/bots/catalog.js';

async function loadBot(id) {
    const url = new URL(
        `../../shared/ai/bots/${id}/bot.js`,
        import.meta.url
    );
    const code = await readFile(url, 'utf8');
    vm.runInThisContext(
        `(function () {\n${code}\n})();`,
        { filename: fileURLToPath(url) }
    );
}

function movePieceOnBoard(state, current, row, col) {
    state.board[current.row][current.col] = null;
    current.row = row;
    current.col = col;
    state.board[row][col] = current;
}

function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value
            + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function makeForcedFlagState(id) {
    const state = initGame(id);
    state.flagPosition = [5, 0];
    state.trapPosition = [5, 1];
    state.setupPhase = GAME_CONFIG.SETUP_PHASES.DONE;
    startGame(state);

    const attacker = state.aiPieces.find(current => {
        return current.type === 'piece'
            && !current.removed;
    });
    const enemyFlag = state.playerPieces.find(current => {
        return current.type === FLAG
            && !current.removed;
    });
    movePieceOnBoard(state, attacker, 2, 2);
    movePieceOnBoard(state, enemyFlag, 3, 2);
    enemyFlag.revealed = true;
    state.currentPlayer = COMPUTER;
    aiBeliefs.onBattle(enemyFlag.id, FLAG, 'revealed', 0);
    return state;
}

function makeQuietFogState(botId = 'owl') {
    const board = Array.from(
        { length: BOARD_HEIGHT },
        () => new Array(BOARD_WIDTH).fill(null)
    );
    const aiPieces = [
        {
            id: 'own-flag',
            type: FLAG,
            pieceType: null,
            owner: COMPUTER,
            row: 0,
            col: 0,
            revealed: false,
            immobilized: false,
            removed: false
        },
        {
            id: 'own-rock',
            type: 'piece',
            pieceType: 'rock',
            owner: COMPUTER,
            row: 2,
            col: 2,
            revealed: false,
            immobilized: false,
            removed: false
        }
    ];
    const playerPieces = [
        {
            id: 'enemy-flag',
            type: FLAG,
            pieceType: null,
            owner: PLAYER,
            row: 5,
            col: 7,
            revealed: false,
            immobilized: false,
            removed: false
        },
        {
            id: 'enemy-paper',
            type: 'piece',
            pieceType: 'paper',
            owner: PLAYER,
            row: 3,
            col: 4,
            revealed: false,
            immobilized: false,
            removed: false
        }
    ];
    for (const current of aiPieces.concat(playerPieces)) {
        board[current.row][current.col] = current;
    }
    return {
        phase: GAME_CONFIG.PHASES.PLAYING,
        currentPlayer: COMPUTER,
        board,
        aiPieces,
        playerPieces,
        selectedPiece: null,
        battleState: null,
        botId,
        topBotId: botId,
        bottomBotId: 'rabbit',
        gameOver: false,
        lastMove: null,
        movesWithoutCapture: 0,
        devMode: false
    };
}

function makeStateFromPieces(aiPieces, playerPieces, options = {}) {
    const board = Array.from(
        { length: BOARD_HEIGHT },
        () => new Array(BOARD_WIDTH).fill(null)
    );
    for (const current of aiPieces.concat(playerPieces)) {
        board[current.row][current.col] = current;
    }
    return {
        phase: GAME_CONFIG.PHASES.PLAYING,
        currentPlayer: COMPUTER,
        board,
        aiPieces,
        playerPieces,
        selectedPiece: null,
        battleState: null,
        botId: 'owl',
        topBotId: 'owl',
        bottomBotId: 'rabbit',
        gameOver: false,
        lastMove: options.lastMove || null,
        movesWithoutCapture: options.movesWithoutCapture || 0,
        devMode: false
    };
}

function makePiece(data) {
    return {
        pieceType: null,
        revealed: false,
        immobilized: false,
        removed: false,
        ...data
    };
}

function assertLegalMove(view, rawMove, id) {
    const move = sanitizeMove(rawMove);
    assert.ok(move, `${id} returned an invalid move shape`);
    const actor = view.aiPieces.find(current => current.id === move.pieceId);
    assert.ok(actor, `${id} returned an unknown piece`);
    const legal = getValidMoves(
        actor.row,
        actor.col,
        view.board,
        COMPUTER
    );
    assert.equal(
        legal.some(([row, col]) => row === move.row && col === move.col),
        true,
        `${id} returned an illegal move`
    );
}

before(async () => {
    for (const id of ENABLED_ORDER) {
        await loadBot(id);
    }
});

test('all enabled bots register with valid setup contracts', () => {
    assert.equal(botRegistry._byId.size, ENABLED_ORDER.length);
    for (const id of ENABLED_ORDER) {
        const bot = botRegistry.get(id);
        assert.equal(typeof bot.move, 'function');
        assert.equal(typeof bot.chooseFlagAndTrap, 'function');
        const setup = sanitizeSetup(bot.chooseFlagAndTrap());
        assert.notEqual(setup.flagIndex, setup.trapIndex);
        assert.ok(setup.flagIndex >= 0 && setup.flagIndex < 16);
        assert.ok(setup.trapIndex >= 0 && setup.trapIndex < 16);
    }
});

test('all enabled bots return legal moves without mutating fog views', () => {
    for (const id of ENABLED_ORDER) {
        const state = makeForcedFlagState(id);
        const view = createBotView(state);
        const snapshot = JSON.stringify(view);
        const startedAt = Date.now();
        const errors = [];
        const originalError = console.error;
        console.error = (...args) => {
            errors.push(args.map(String).join(' '));
        };
        let move;
        try {
            move = botRegistry.get(id).move(view);
        } finally {
            console.error = originalError;
        }
        const elapsed = Date.now() - startedAt;

        assertLegalMove(view, move, id);
        assert.equal(JSON.stringify(view), snapshot, `${id} mutated its input view`);
        assert.deepEqual(errors, [], `${id} swallowed an internal error`);
        assert.ok(elapsed < 8500, `${id} exceeded the move timeout: ${elapsed}ms`);
    }
});

test('owl searches a masked-flag position and returns a legal move', () => {
    aiEngine.resetMemory();
    const state = makeQuietFogState();
    aiBeliefs.init(state);
    const view = createBotView(state);
    const snapshot = JSON.stringify(view);
    const move = botRegistry.get('owl').move(view);

    assert.equal(aiEngine.isGameOver(view), false);
    assertLegalMove(view, move, 'owl');
    assert.equal(JSON.stringify(view), snapshot);
});

test('owl treats hidden enemy flags as guesses while reinforcing its own flag', () => {
    aiEngine.resetMemory();
    const state = makeQuietFogState();
    aiBeliefs.init(state);
    const view = createBotView(state);
    const hiddenEnemyFlag = view.playerPieces.find(current => {
        return current.id === 'enemy-flag';
    });
    const ownFlag = view.aiPieces.find(current => {
        return current.id === 'own-flag';
    });
    const move = botRegistry.get('owl').move(view);
    const safeMove = sanitizeMove(move);
    const actor = view.aiPieces.find(current => {
        return current.id === safeMove.pieceId;
    });
    const before = Math.max(
        Math.abs(actor.row - ownFlag.row),
        Math.abs(actor.col - ownFlag.col)
    );
    const after = Math.max(
        Math.abs(safeMove.row - ownFlag.row),
        Math.abs(safeMove.col - ownFlag.col)
    );

    assert.equal(hiddenEnemyFlag.type, 'piece');
    assert.equal(hiddenEnemyFlag.pieceType, null);
    assert.equal(actor.pieceType, 'rock');
    assert.ok(after < before);
    assertLegalMove(view, move, 'owl');
});

test('owl prefers a revealed attacker for a guaranteed kill', () => {
    aiEngine.resetMemory();
    const state = makeStateFromPieces(
        [
            makePiece({ id: 'own-flag', type: FLAG, owner: COMPUTER, row: 0, col: 0 }),
            makePiece({
                id: 'own-open-paper',
                type: 'piece',
                pieceType: 'paper',
                owner: COMPUTER,
                row: 2,
                col: 2,
                revealed: true
            }),
            makePiece({
                id: 'own-hidden-paper',
                type: 'piece',
                pieceType: 'paper',
                owner: COMPUTER,
                row: 2,
                col: 4
            }),
            makePiece({ id: 'own-trap', type: 'trap', owner: COMPUTER, row: 0, col: 1 })
        ],
        [
            makePiece({ id: 'enemy-flag', type: FLAG, owner: PLAYER, row: 5, col: 7 }),
            makePiece({
                id: 'enemy-rock',
                type: 'piece',
                pieceType: 'rock',
                owner: PLAYER,
                row: 2,
                col: 3,
                revealed: true
            })
        ]
    );
    aiBeliefs.init(state);
    const view = createBotView(state);
    const rawMove = botRegistry.get('owl').move(view);
    const move = sanitizeMove(rawMove);

    assert.equal(move.pieceId, 'own-open-paper');
    assert.equal(move.row, 2);
    assert.equal(move.col, 3);
    assertLegalMove(view, rawMove, 'owl');
});

test('owl probes a hidden enemy that declined to attack its revealed piece', () => {
    aiEngine.resetMemory();
    const state = makeStateFromPieces(
        [
            makePiece({ id: 'own-flag', type: FLAG, owner: COMPUTER, row: 0, col: 0 }),
            makePiece({
                id: 'own-open-paper',
                type: 'piece',
                pieceType: 'paper',
                owner: COMPUTER,
                row: 2,
                col: 2,
                revealed: true
            }),
            makePiece({ id: 'own-trap', type: 'trap', owner: COMPUTER, row: 0, col: 1 })
        ],
        [
            makePiece({ id: 'enemy-flag', type: FLAG, owner: PLAYER, row: 5, col: 7 }),
            makePiece({
                id: 'enemy-passive-hidden',
                type: 'piece',
                pieceType: 'rock',
                owner: PLAYER,
                row: 2,
                col: 3
            }),
            makePiece({
                id: 'enemy-moving-hidden',
                type: 'piece',
                pieceType: 'scissors',
                owner: PLAYER,
                row: 3,
                col: 3
            }),
            makePiece({ id: 'enemy-trap', type: 'trap', owner: PLAYER, row: 5, col: 6 })
        ],
        { lastMove: { from: [4, 4], to: [3, 3] } }
    );
    aiBeliefs.init(state);
    const view = createBotView(state);
    const rawMove = botRegistry.get('owl').move(view);
    const move = sanitizeMove(rawMove);

    assert.equal(move.pieceId, 'own-open-paper');
    assert.equal(move.row, 2);
    assert.equal(move.col, 3);
    assertLegalMove(view, rawMove, 'owl');
});

test('adapted search bots handle quiet masked-flag positions', () => {
    const ids = [
        'raccoon',
        'wolf',
        'hedgehog',
        'raven',
        'homyachok',
        'losenok',
        'leopardik',
        'akulenok',
        'orlenok',
        'lion',
        'fox',
        'bobrenok',
        'obezyanka'
    ];
    for (const id of ids) {
        aiEngine.resetMemory();
        const state = makeQuietFogState(id);
        aiBeliefs.init(state);
        const view = createBotView(state);
        const snapshot = JSON.stringify(view);
        const startedAt = Date.now();
        const errors = [];
        const originalError = console.error;
        console.error = (...args) => {
            errors.push(args.map(String).join(' '));
        };
        let move;
        try {
            move = botRegistry.get(id).move(view);
        } finally {
            console.error = originalError;
        }
        const elapsed = Date.now() - startedAt;

        assertLegalMove(view, move, id);
        assert.equal(JSON.stringify(view), snapshot, `${id} mutated its input view`);
        assert.deepEqual(errors, [], `${id} swallowed an internal error`);
        assert.ok(elapsed < 8500, `${id} exceeded the move timeout: ${elapsed}ms`);
    }
});

test('owl and rabbit complete authoritative fog-safe dev turns', () => {
    const originalRandom = Math.random;
    const originalError = console.error;
    const errors = [];
    Math.random = seededRandom(0x51A7E);
    console.error = (...args) => {
        errors.push(args.map(String).join(' '));
    };

    try {
        const state = initGame('owl');
        startDevMatch(state, 'owl', 'rabbit');

        for (let turn = 0; turn < 2 && !state.gameOver; turn++) {
            const result = state.currentPlayer === COMPUTER
                ? makeBotMove(state)
                : makeBottomBotMove(state);
            assert.notEqual(result.type, 'error');
            assert.notEqual(result.type, 'no_moves');

            let tieRounds = 0;
            while (state.battleState
                && !state.gameOver
                && tieRounds < 8) {
                const tieResult = resolveDevModeTie(state);
                assert.notEqual(tieResult.type, 'error');
                tieRounds++;
            }
            assert.equal(state.battleState, null);
        }

        assert.ok(state.lastMove);
        assert.deepEqual(errors, []);
    } finally {
        Math.random = originalRandom;
        console.error = originalError;
        devMode.stop();
    }
});
