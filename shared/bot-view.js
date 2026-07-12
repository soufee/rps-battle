import { BOARD_WIDTH, BOARD_HEIGHT } from './game-config.js';

/**
 * Fog-of-war for bots (anti-cheat).
 *
 * A bot ALWAYS plays the COMPUTER side, so in the state it receives its own
 * pieces are `aiPieces` and the opponent is `playerPieces`. Any opponent piece
 * that is not yet `revealed` must be indistinguishable from any other: its
 * concrete identity (`type` = flag/trap/piece and `pieceType` = rock/paper/
 * scissors) is secret and is stripped here. Position, ownership and the public
 * flags (`revealed`, `removed`, `immobilized`) stay visible — exactly what a
 * fair opponent can observe on the board.
 *
 * All pieces and the board are deep-cloned so a bot cannot mutate real game
 * state as a side effect. Because the bot receives clones, callers MUST map the
 * returned move back to the real piece by `id`.
 */

function cloneOwnPiece(p) {
    return {
        id: p.id,
        type: p.type,
        pieceType: p.pieceType,
        owner: p.owner,
        row: p.row,
        col: p.col,
        revealed: p.revealed,
        immobilized: p.immobilized,
        removed: p.removed
    };
}

/**
 * Clone an opponent piece, hiding its identity while it is still hidden.
 */
export function cloneMaskedEnemyPiece(p) {
    const hidden = !p.revealed
        && !p.removed;
    return {
        id: p.id,
        type: hidden ? 'piece' : p.type,
        pieceType: hidden ? null : p.pieceType,
        owner: p.owner,
        row: p.row,
        col: p.col,
        revealed: p.revealed,
        immobilized: p.immobilized,
        removed: p.removed
    };
}

function emptyBoard() {
    const board = [];
    for (let r = 0; r < BOARD_HEIGHT; r++) {
        const row = [];
        for (let c = 0; c < BOARD_WIDTH; c++) {
            row.push(null);
        }
        board.push(row);
    }
    return board;
}

function cloneLastMove(lastMove) {
    if (!lastMove) {
        return null;
    }
    return {
        from: lastMove.from ? [...lastMove.from] : null,
        to: lastMove.to ? [...lastMove.to] : null
    };
}

/**
 * Build a sanitized, fog-of-war copy of the game state to hand to a bot.
 * Exposes only whitelisted public fields (no engine internals), hides hidden
 * opponent identities, and deep-clones everything.
 *
 * @param {object} gameState real game state (bot is the COMPUTER side)
 * @returns {object} safe view for bot.move() / bot.getSmartTieChoice()
 */
export function createBotView(gameState) {
    const aiPieces = (gameState.aiPieces || []).map(cloneOwnPiece);
    const playerPieces = (gameState.playerPieces || []).map(cloneMaskedEnemyPiece);

    const board = emptyBoard();
    for (const piece of aiPieces) {
        if (!piece.removed
            && piece.row >= 0) {
            board[piece.row][piece.col] = piece;
        }
    }
    for (const piece of playerPieces) {
        if (!piece.removed
            && piece.row >= 0) {
            board[piece.row][piece.col] = piece;
        }
    }

    return {
        phase: gameState.phase,
        currentPlayer: gameState.currentPlayer,
        board,
        aiPieces,
        playerPieces,
        selectedPiece: null,
        battleState: null,
        botId: gameState.botId,
        topBotId: gameState.topBotId,
        bottomBotId: gameState.bottomBotId,
        gameOver: !!gameState.gameOver,
        lastMove: cloneLastMove(gameState.lastMove),
        movesWithoutCapture: gameState.movesWithoutCapture || 0,
        devMode: !!gameState.devMode
    };
}

/**
 * Fog-of-war view for the tie-break (RPS re-roll) choice. Keeps the SAME
 * board orientation as `gameState` (the tie code derives the choosing side from
 * botId), masks the hidden pieces of the CHOOSING side's opponent, and — most
 * importantly — never exposes the opponent's current-round choice: both
 * `playerChoice` and `aiChoice` are forced to null so a bot cannot counter a
 * choice the opponent already committed. Past rounds (`lastRound`) stay visible
 * because both throws were revealed then.
 *
 * @param {object} gameState real state that still holds `battleState`
 * @param {'top'|'bottom'} side which side is about to choose
 */
export function createTieView(gameState, side) {
    const maskAiSide = side === 'bottom';
    const aiPieces = (gameState.aiPieces || []).map(
        maskAiSide ? cloneMaskedEnemyPiece : cloneOwnPiece
    );
    const playerPieces = (gameState.playerPieces || []).map(
        maskAiSide ? cloneOwnPiece : cloneMaskedEnemyPiece
    );

    const board = emptyBoard();
    for (const piece of aiPieces) {
        if (!piece.removed
            && piece.row >= 0) {
            board[piece.row][piece.col] = piece;
        }
    }
    for (const piece of playerPieces) {
        if (!piece.removed
            && piece.row >= 0) {
            board[piece.row][piece.col] = piece;
        }
    }

    const bs = gameState.battleState;
    let battleState = null;
    if (bs) {
        battleState = {
            attacker: bs.attacker ? cloneOwnPiece(bs.attacker) : null,
            defender: bs.defender ? cloneOwnPiece(bs.defender) : null,
            newRow: bs.newRow,
            newCol: bs.newCol,
            drawRound: bs.drawRound,
            isPlayerFirst: bs.isPlayerFirst,
            // Current-round choices are secret until both have committed.
            playerChoice: null,
            aiChoice: null,
            // Previous rounds were revealed to both sides — safe to expose.
            lastRound: bs.lastRound ? { ...bs.lastRound } : null
        };
    }

    return {
        phase: gameState.phase,
        currentPlayer: gameState.currentPlayer,
        board,
        aiPieces,
        playerPieces,
        selectedPiece: null,
        battleState,
        botId: gameState.botId,
        topBotId: gameState.topBotId,
        bottomBotId: gameState.bottomBotId,
        gameOver: !!gameState.gameOver,
        lastMove: cloneLastMove(gameState.lastMove),
        movesWithoutCapture: gameState.movesWithoutCapture || 0,
        devMode: !!gameState.devMode
    };
}
