import assert from 'node:assert/strict';
import test from 'node:test';

import { aiEngine } from '../../shared/ai/index.js';
import aiSearch from '../../shared/ai/ai-search.js';
import { createBotView } from '../../shared/bot-view.js';
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    COMPUTER,
    FLAG,
    PLAYER,
    TRAP
} from '../../shared/game-config.js';

function piece({
    id,
    type = 'piece',
    pieceType = null,
    owner,
    row,
    col,
    revealed = false,
    immobilized = false,
    removed = false
}) {
    return {
        id,
        type,
        pieceType,
        owner,
        row,
        col,
        revealed,
        immobilized,
        removed
    };
}

function stateOf(aiPieces, playerPieces, movesWithoutCapture = 0) {
    const board = Array.from(
        { length: BOARD_HEIGHT },
        () => new Array(BOARD_WIDTH).fill(null)
    );
    for (const current of aiPieces.concat(playerPieces)) {
        if (!current.removed
            && current.row >= 0
            && current.col >= 0) {
            board[current.row][current.col] = current;
        }
    }
    return {
        phase: 'playing',
        currentPlayer: COMPUTER,
        board,
        aiPieces,
        playerPieces,
        selectedPiece: null,
        battleState: null,
        gameOver: false,
        lastMove: null,
        movesWithoutCapture,
        devMode: false
    };
}

function ownArmy(attackerType = 'rock') {
    return [
        piece({
            id: 'my-flag',
            type: FLAG,
            owner: COMPUTER,
            row: 0,
            col: 0
        }),
        piece({
            id: 'attacker',
            pieceType: attackerType,
            owner: COMPUTER,
            row: 2,
            col: 2
        })
    ];
}

function approximately(actual, expected, tolerance = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${actual} is not within ${tolerance} of ${expected}`
    );
}

test('masked enemy flag is not a terminal win', () => {
    const aiPieces = ownArmy();
    const playerPieces = [
        piece({
            id: 'enemy-flag',
            type: FLAG,
            owner: PLAYER,
            row: 5,
            col: 0
        }),
        piece({
            id: 'enemy-rock',
            pieceType: 'rock',
            owner: PLAYER,
            row: 4,
            col: 1
        })
    ];
    const view = createBotView(stateOf(aiPieces, playerPieces));

    assert.equal(view.playerPieces[0].type, 'piece');
    assert.equal(view.playerPieces[0].pieceType, null);
    assert.equal(aiSearch.getTerminalOutcome(view), null);
    assert.equal(aiEngine.isGameOver(view), false);
    assert.ok(Number.isFinite(aiEngine.evaluatePositionV2(view)));
});

test('public flag certainty detects hopeless armies and mutual stalemates', () => {
    const hiddenFlag = piece({
        id: 'hidden-flag',
        owner: PLAYER,
        row: 5,
        col: 5
    });
    const hopeless = stateOf(ownArmy(), [hiddenFlag]);
    const hopelessOutcome = aiSearch.getTerminalOutcome(hopeless);

    assert.equal(hopelessOutcome.outcome, 'win');
    assert.equal(hopelessOutcome.reason, 'enemy_hopeless');

    const ownFlag = piece({
        id: 'own-flag',
        type: FLAG,
        owner: COMPUTER,
        row: 0,
        col: 0
    });
    const ownTrap = piece({
        id: 'own-trap',
        type: TRAP,
        owner: COMPUTER,
        row: 0,
        col: 1,
        revealed: true,
        immobilized: true
    });
    const enemyTrap = piece({
        id: 'enemy-trap',
        type: TRAP,
        owner: PLAYER,
        row: 5,
        col: 4,
        revealed: true,
        immobilized: true
    });
    const stalemate = stateOf(
        [ownFlag, ownTrap],
        [hiddenFlag, enemyTrap]
    );

    assert.equal(aiSearch.getTerminalOutcome(stalemate).outcome, 'draw');
});

test('known special pieces constrain custom hidden-piece distributions', () => {
    const knownFlag = piece({
        id: 'known-flag',
        type: FLAG,
        owner: PLAYER,
        row: 5,
        col: 5,
        revealed: true
    });
    const knownTrap = piece({
        id: 'known-trap',
        type: TRAP,
        owner: PLAYER,
        row: 5,
        col: 4,
        revealed: true
    });
    const hidden = piece({
        id: 'hidden',
        owner: PLAYER,
        row: 4,
        col: 4
    });
    const source = stateOf(ownArmy(), [knownFlag, knownTrap, hidden]);
    const distribution = aiSearch.getPieceDistribution(source, hidden, {
        getDistribution: () => ({
            rock: 0.2,
            flag: 0.4,
            trap: 0.4
        })
    });

    assert.equal(distribution.flag, 0);
    assert.equal(distribution.trap, 0);
    assert.equal(distribution.rock, 1);
});

test('terminal outcomes distinguish wins, losses, and draws', () => {
    const enemy = [
        piece({
            id: 'enemy',
            type: FLAG,
            owner: PLAYER,
            row: 5,
            col: 5,
            revealed: true
        })
    ];
    const loss = stateOf([], enemy);
    assert.equal(aiSearch.getTerminalOutcome(loss).outcome, 'lose');

    const win = stateOf(ownArmy(), []);
    assert.equal(aiSearch.getTerminalOutcome(win).outcome, 'win');

    const drawEnemy = enemy.concat(piece({
        id: 'enemy-rock',
        pieceType: 'rock',
        owner: PLAYER,
        row: 4,
        col: 4,
        revealed: true
    }));
    const draw = stateOf(ownArmy(), drawEnemy, 20);
    assert.equal(aiSearch.getTerminalOutcome(draw).outcome, 'draw');
});

test('unknown combat expands to normalized public-belief outcomes', () => {
    const aiPieces = ownArmy('rock');
    const hidden = piece({
        id: 'hidden',
        owner: PLAYER,
        row: 3,
        col: 2
    });
    const reserve = piece({
        id: 'reserve',
        owner: PLAYER,
        row: 5,
        col: 5
    });
    const source = stateOf(aiPieces, [hidden, reserve]);
    const snapshot = JSON.stringify(source);
    const distribution = {
        rock: 0.2,
        paper: 0.3,
        scissors: 0.1,
        flag: 0.25,
        trap: 0.15
    };
    const outcomes = aiSearch.getMoveOutcomes(
        source,
        { piece: aiPieces[1], row: 3, col: 2 },
        { getDistribution: () => distribution }
    );

    assert.equal(outcomes.length, 7);
    approximately(
        outcomes.reduce((sum, outcome) => {
            return sum
                + outcome.probability;
        }, 0),
        1
    );
    const flagProbability = outcomes.reduce((sum, outcome) => {
        return outcome.event === 'hidden_flag'
            ? sum
                + outcome.probability
            : sum;
    }, 0);
    approximately(flagProbability, 0.25);
    const trapProbability = outcomes.reduce((sum, outcome) => {
        const trap = outcome.state.playerPieces.find(current => {
            return current.id === hidden.id
                && current.type === TRAP
                && current.immobilized;
        });
        return trap
            ? sum
                + outcome.probability
            : sum;
    }, 0);
    approximately(trapProbability, 0.15);
    assert.equal(JSON.stringify(source), snapshot);
});

test('flag and trap branches follow core special-piece rules', () => {
    const aiPieces = ownArmy('rock');
    const hidden = piece({
        id: 'hidden',
        owner: PLAYER,
        row: 3,
        col: 2
    });
    const source = stateOf(aiPieces, [hidden]);
    const move = { piece: aiPieces[1], row: 3, col: 2 };

    const flagOutcomes = aiSearch.getMoveOutcomes(source, move, {
        getDistribution: () => ({ flag: 1 })
    });
    assert.equal(flagOutcomes.length, 1);
    assert.equal(flagOutcomes[0].state.searchOutcome.outcome, 'win');
    assert.equal(flagOutcomes[0].state.playerPieces.length, 0);
    assert.equal(flagOutcomes[0].state.board[3][2].id, 'attacker');

    const trapOutcomes = aiSearch.getMoveOutcomes(source, move, {
        getDistribution: () => ({ trap: 1 })
    });
    assert.equal(trapOutcomes.length, 1);
    assert.equal(
        trapOutcomes[0].state.aiPieces.some(current => current.id === 'attacker'),
        false
    );
    const trap = trapOutcomes[0].state.playerPieces[0];
    assert.equal(trap.type, TRAP);
    assert.equal(trap.immobilized, true);
    assert.equal(trapOutcomes[0].state.board[3][2].id, trap.id);
});

test('shared battle resolver preserves special-piece precedence', () => {
    assert.equal(aiEngine.resolveBattle(FLAG, FLAG), 'win');
    assert.equal(aiEngine.resolveBattle(TRAP, TRAP), 'lose');
    assert.equal(aiEngine.resolveBattle(FLAG, TRAP), 'lose');
    assert.equal(aiEngine.resolveBattle(TRAP, FLAG), 'win');
    assert.equal(aiEngine.resolveBattle('rock', 'rock'), 'draw');
    assert.equal(aiEngine.resolveBattle(null, 'rock'), 'unknown');
});

test('shared move generation keeps revealed flags immobile', () => {
    const enemyFlag = piece({
        id: 'enemy-flag',
        type: FLAG,
        owner: PLAYER,
        row: 5,
        col: 5,
        revealed: true
    });
    const enemyRock = piece({
        id: 'enemy-rock',
        pieceType: 'rock',
        owner: PLAYER,
        row: 4,
        col: 4,
        revealed: true
    });
    const source = stateOf(ownArmy(), [enemyFlag, enemyRock]);
    const moves = aiEngine.getAllPossibleMoves(source, PLAYER);

    assert.equal(
        moves.some(move => move.piece.id === enemyFlag.id),
        false
    );
    assert.equal(
        moves.some(move => move.piece.id === enemyRock.id),
        true
    );
});

test('hidden attackers use probabilistic identities without reading secrets', () => {
    const aiPieces = ownArmy('rock');
    const hidden = piece({
        id: 'hidden-attacker',
        owner: PLAYER,
        row: 3,
        col: 2
    });
    const source = stateOf(aiPieces, [hidden]);
    const move = { piece: hidden, row: 2, col: 2 };

    const paperOutcome = aiSearch.getMoveOutcomes(source, move, {
        getDistribution: () => ({ paper: 1 })
    })[0].state;
    assert.equal(
        paperOutcome.aiPieces.some(current => current.id === 'attacker'),
        false
    );
    assert.equal(paperOutcome.board[2][2].id, hidden.id);
    assert.equal(paperOutcome.board[2][2].pieceType, 'paper');

    const scissorsOutcome = aiSearch.getMoveOutcomes(source, move, {
        getDistribution: () => ({ scissors: 1 })
    })[0].state;
    assert.equal(
        scissorsOutcome.playerPieces.some(current => current.id === hidden.id),
        false
    );
    assert.equal(scissorsOutcome.board[2][2].id, 'attacker');

    const flagOutcome = aiSearch.getMoveOutcomes(source, move, {
        getDistribution: () => ({ flag: 1 })
    })[0].state;
    assert.equal(aiSearch.getTerminalOutcome(flagOutcome).outcome, 'win');
});

test('tie combat exposes all legal resolution classes', () => {
    const aiPieces = ownArmy('rock');
    const defender = piece({
        id: 'defender',
        pieceType: 'rock',
        owner: PLAYER,
        row: 3,
        col: 2,
        revealed: true
    });
    const source = stateOf(aiPieces, [defender]);
    const outcomes = aiSearch.getMoveOutcomes(source, {
        piece: aiPieces[1],
        row: 3,
        col: 2
    });

    assert.deepEqual(
        outcomes.map(outcome => outcome.event).sort(),
        ['tie_attacker_win', 'tie_defender_win', 'tie_mutual'].sort()
    );
    approximately(
        outcomes.reduce((sum, outcome) => {
            return sum
                + outcome.probability;
        }, 0),
        1
    );
});

test('draw clock advances after quiet moves and resets after captures', () => {
    const quietArmy = ownArmy('rock');
    const quietEnemy = [
        piece({
            id: 'enemy-flag',
            type: FLAG,
            owner: PLAYER,
            row: 5,
            col: 5,
            revealed: true
        })
    ];
    const quiet = stateOf(quietArmy, quietEnemy, 19);
    const quietOutcome = aiSearch.getMoveOutcomes(quiet, {
        piece: quietArmy[1],
        row: 2,
        col: 3
    })[0].state;
    assert.equal(quietOutcome.movesWithoutCapture, 20);
    assert.equal(quietOutcome.searchOutcome.outcome, 'draw');

    const captureArmy = ownArmy('rock');
    const captureEnemy = [
        piece({
            id: 'defender',
            pieceType: 'scissors',
            owner: PLAYER,
            row: 3,
            col: 2,
            revealed: true
        }),
        piece({
            id: 'enemy-flag',
            type: FLAG,
            owner: PLAYER,
            row: 5,
            col: 5,
            revealed: true
        })
    ];
    const capture = stateOf(captureArmy, captureEnemy, 19);
    const captureOutcome = aiSearch.getMoveOutcomes(capture, {
        piece: captureArmy[1],
        row: 3,
        col: 2
    })[0].state;
    assert.equal(captureOutcome.movesWithoutCapture, 1);
    assert.equal(captureOutcome.searchOutcome, null);
});

test('determinization is seeded, complete, and non-mutating', () => {
    const hidden = [];
    for (let index = 0; index < 5; index++) {
        hidden.push(piece({
            id: `hidden-${index}`,
            owner: PLAYER,
            row: index < 3 ? 4 : 5,
            col: index
        }));
    }
    const source = stateOf(ownArmy(), hidden);
    const distribution = {
        rock: 0.24,
        paper: 0.24,
        scissors: 0.24,
        flag: 0.16,
        trap: 0.12
    };
    const options = {
        seed: 'fixed-seed',
        getDistribution: () => distribution
    };
    const first = aiSearch.determinizeWorld(source, options);
    const second = aiSearch.determinizeWorld(source, options);
    const types = first.playerPieces.map(aiSearch.knownSearchType);

    assert.equal(types.filter(type => type === FLAG).length, 1);
    assert.equal(types.filter(type => type === TRAP).length, 1);
    assert.equal(types.every(Boolean), true);
    assert.deepEqual(
        first.playerPieces.map(aiSearch.knownSearchType),
        second.playerPieces.map(aiSearch.knownSearchType)
    );
    assert.equal(source.playerPieces.every(current => {
        return current.pieceType === null
            && current._searchHypothesis === undefined;
    }), true);
});
