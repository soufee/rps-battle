import { GAME_CONFIG, PLAYER, COMPUTER, FLAG, TRAP, PIECE_TYPES, PIECE_SYMBOLS, BOARD_WIDTH, BOARD_HEIGHT } from './game-config.js';
import { resolveBattle, getValidMoves, isMoveLegal } from './game-rules.js';
import { botRegistry, aiEngine, aiBeliefs, devMode } from './ai/index.js';
import { createBotView, createTieView } from './bot-view.js';
import { sanitizeSetup, sanitizeMove } from './bot-guard.js';

/**
 * Generate a shuffled array of `count` RPS types with a guaranteed
 * minimum of `minPerType` of each type. Prevents pathological random
 * distributions.
 */
export function generateBalancedPieceTypes(count, minPerType) {
    const floor = Math.max(0, minPerType || 0);
    const pool = [];
    for (const type of PIECE_TYPES) {
        for (let i = 0; i < floor; i++) {
            pool.push(type);
        }
    }
    while (pool.length < count) {
        pool.push(PIECE_TYPES[Math.floor(Math.random() * PIECE_TYPES.length)]);
    }
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
    }
    return pool;
}

/**
 * Initialize a fresh game state
 */
export function initGame(botId = 'rabbit') {
    const board = [];
    for (let r = 0; r < BOARD_HEIGHT; r++) {
        board[r] = [];
        for (let c = 0; c < BOARD_WIDTH; c++) {
            board[r][c] = null;
        }
    }
    
    return {
        phase: GAME_CONFIG.PHASES.SETUP,
        currentPlayer: PLAYER,
        board: board,
        selectedPiece: null,
        playerPieces: [],
        aiPieces: [],
        setupPhase: GAME_CONFIG.SETUP_PHASES.FLAG,
        flagPosition: null,
        trapPosition: null,
        battleState: null,
        botId: botId,
        gameOver: false,
        lastMove: null,
        winner: null,
        endReason: null,
        movesWithoutCapture: 0,
        devMode: false,
        topBotId: botId,
        bottomBotId: botId
    };
}

/**
 * Start the playing phase after setups are done
 */
export function startGame(gameState) {
    if (!gameState.flagPosition || !gameState.trapPosition) {
        throw new Error('Flag and Trap positions must be set before starting the game.');
    }
    
    gameState.phase = GAME_CONFIG.PHASES.PLAYING;
    gameState.gameOver = false;
    gameState.currentPlayer = PLAYER;
    gameState.movesWithoutCapture = 0;
    
    // Reset AI state
    aiEngine.resetMemory();
    aiBeliefs.init(gameState);
    
    // Place pieces
    placePlayerPieces(gameState);
    placeComputerPieces(gameState);
}

/**
 * Place the player's pieces
 */
export function placePlayerPieces(gameState) {
    const [flagRow, flagCol] = gameState.flagPosition;
    const [trapRow, trapCol] = gameState.trapPosition;
    
    const totalPieces = GAME_CONFIG.GAME.TOTAL_PIECES;
    const pieceTypes = generateBalancedPieceTypes(totalPieces - 2, 3);
    let pieceIdx = 0;
    
    gameState.playerPieces = [];
    for (let i = 0; i < totalPieces; i++) {
        const col = i % 8;
        const row = Math.floor(i / 8) + 4; // rows 4 & 5
        
        let type;
        let pieceType = null;
        if (row === flagRow && col === flagCol) {
            type = FLAG;
        } else if (row === trapRow && col === trapCol) {
            type = TRAP;
        } else {
            type = 'piece';
            pieceType = pieceTypes[pieceIdx++];
        }
        
        const piece = {
            id: `player_${i}`,
            type: type,
            pieceType: pieceType,
            owner: PLAYER,
            row: row,
            col: col,
            revealed: false,
            immobilized: false,
            removed: false
        };
        
        gameState.playerPieces.push(piece);
        gameState.board[row][col] = piece;
    }
}

/**
 * Place the computer's pieces
 */
export function placeComputerPieces(gameState) {
    const botId = gameState.botId || 'rabbit';
    const bot = botRegistry.get(botId);
    // Anti-cheat: never trust a bot's raw setup — a malformed setup could field
    // an army without a flag or with duplicate specials. sanitizeSetup() forces
    // exactly one flag and one trap in two distinct on-board cells.
    const { flagIndex: flagPos, trapIndex: trapPos } = sanitizeSetup(bot.chooseFlagAndTrap());
    
    let flagCount = 0;
    let trapCount = 0;
    
    const totalPieces = GAME_CONFIG.GAME.TOTAL_PIECES;
    const pieceTypes = generateBalancedPieceTypes(totalPieces - 2, 3);
    let pieceIdx = 0;
    
    gameState.aiPieces = [];
    for (let i = 0; i < totalPieces; i++) {
        const col = i % 8;
        const row = Math.floor(i / 8); // rows 0 & 1
        
        let type;
        let pieceType = null;
        if (i === flagPos && flagCount === 0) {
            type = FLAG;
            flagCount++;
        } else if (i === trapPos && trapCount === 0) {
            type = TRAP;
            trapCount++;
        } else {
            type = 'piece';
            pieceType = pieceTypes[pieceIdx++];
        }
        
        const piece = {
            id: `ai_${i}`,
            type: type,
            pieceType: pieceType,
            owner: COMPUTER,
            row: row,
            col: col,
            revealed: false,
            immobilized: false,
            removed: false
        };
        
        gameState.aiPieces.push(piece);
        gameState.board[row][col] = piece;
    }
}

/**
 * Remove a piece from the board
 */
export function removePiece(gameState, piece) {
    gameState.board[piece.row][piece.col] = null;
    gameState.movesWithoutCapture = 0;
    
    if (piece.owner === PLAYER) {
        const index = gameState.playerPieces.findIndex(p => p.id === piece.id);
        if (index > -1) {
            gameState.playerPieces.splice(index, 1);
        }
        aiBeliefs.onPieceRemoved(piece.id);
    } else {
        const index = gameState.aiPieces.findIndex(p => p.id === piece.id);
        if (index > -1) {
            gameState.aiPieces.splice(index, 1);
        }
        // Dev mode mirror: the bottom bot must also forget this piece.
        if (gameState.devMode && typeof devMode !== 'undefined' && devMode.active) {
            devMode.notifyBottomOfPieceRemoved(piece.id);
        }
    }
    
    piece.removed = true;
    piece.row = -1;
    piece.col = -1;
}

/**
 * Check if a player's army is in a hopeless state
 */
export function isHopeless(pieces) {
    const activePieces = pieces.filter(p => !p.immobilized && !p.removed);
    
    // Only flag left
    if (activePieces.length === 1 && activePieces[0].type === FLAG) {
        return true;
    }
    
    // Only flag and immobilized trap left
    if (pieces.filter(p => !p.removed).length === 2) {
        const hasFlag = pieces.some(p => p.type === FLAG && !p.removed);
        const hasImmobilizedTrap = pieces.some(p => p.type === TRAP && p.immobilized && !p.removed);
        return hasFlag && hasImmobilizedTrap;
    }
    
    return false;
}

/**
 * Check if the game is in a mutual stalemate (both players have only flags and revealed/immobilized traps)
 */
export function isMutualStalemate(playerPieces, aiPieces) {
    const activePlayer = playerPieces.filter(p => !p.removed);
    const activeAi = aiPieces.filter(p => !p.removed);

    if (activePlayer.length === 0 || activeAi.length === 0) {
        return false;
    }

    const playerOnlyFlagsAndTraps = activePlayer.every(p =>
        p.type === FLAG || (p.type === TRAP && (p.revealed || p.immobilized))
    );

    const aiOnlyFlagsAndTraps = activeAi.every(p =>
        p.type === FLAG || (p.type === TRAP && (p.revealed || p.immobilized))
    );

    return playerOnlyFlagsAndTraps && aiOnlyFlagsAndTraps;
}

/**
 * Check game-over conditions
 */
export function checkGameEnd(gameState) {
    if (gameState.playerPieces.length === 0) {
        endGame(gameState, false, 'no_pieces');
        return true;
    }
    
    if (gameState.aiPieces.length === 0) {
        endGame(gameState, true, 'no_pieces');
        return true;
    }

    if (isMutualStalemate(gameState.playerPieces, gameState.aiPieces)) {
        endGame(gameState, 'draw', 'mutual_stalemate');
        return true;
    }
    
    const playerHopeless = isHopeless(gameState.playerPieces);
    const aiHopeless = isHopeless(gameState.aiPieces);
    
    if (playerHopeless) {
        endGame(gameState, false, 'hopeless');
        return true;
    }
    
    if (aiHopeless) {
        endGame(gameState, true, 'hopeless');
        return true;
    }
    
    return false;
}

/**
 * End game state transition
 */
export function endGame(gameState, playerWon, reason) {
    gameState.phase = GAME_CONFIG.PHASES.FINISHED;
    gameState.gameOver = true;
    gameState.winner = playerWon === 'draw' ? 'draw' : (playerWon ? PLAYER : COMPUTER);
    gameState.endReason = reason;
    
    // Reveal all pieces
    [...gameState.playerPieces, ...gameState.aiPieces].forEach(piece => {
        piece.revealed = true;
    });

    if (gameState.devMode && typeof devMode !== 'undefined' && devMode.active) {
        devMode.stop();
    }

    // Call window.gameCore.endGame if defined (so Playwright hook captures it)
    if (typeof window !== 'undefined' && window.gameCore && typeof window.gameCore.endGame === 'function') {
        window.gameCore.gameState = gameState;
        window.gameCore.endGame(playerWon, reason);
    }
}

/**
 * Pre-commit AI's choice during a tie
 */
export function precommitAITieChoice(gameState) {
    if (!gameState || !gameState.battleState) return;
    
    const { attacker, defender } = gameState.battleState;
    const aiPiece = attacker.owner === COMPUTER ? attacker : defender;
    const playerPiece = attacker.owner === PLAYER ? attacker : defender;
    
    const botId = gameState.botId || 'rabbit';
    const bot = botRegistry.get(botId);
    
    const preChoice = aiEngine.resolveTieChoiceForBot(bot, {
        gameState: createTieView(gameState, 'top'),
        ourPiece: aiPiece,
        opponentPiece: playerPiece,
        battleRow: gameState.battleState.newRow,
        battleCol: gameState.battleState.newCol
    });
    
    gameState.battleState.aiChoice = preChoice;
}

/**
 * Perform a game move
 */
export function makeMove(gameState, piece, newRow, newCol) {
    const oldRow = piece.row;
    const oldCol = piece.col;
    const targetPiece = gameState.board[newRow][newCol];
    
    if (targetPiece) {
        // Battle!
        piece.revealed = true;
        targetPiece.revealed = true;
        
        // Feed belief model
        if (piece.owner === PLAYER) {
            const revealedType = piece.type === 'piece' ? piece.pieceType : piece.type;
            aiBeliefs.onBattle(piece.id, revealedType, null, aiEngine.aiTurnCounter);
        }
        if (targetPiece.owner === PLAYER) {
            const revealedType = targetPiece.type === 'piece' ? targetPiece.pieceType : targetPiece.type;
            aiBeliefs.onBattle(targetPiece.id, revealedType, null, aiEngine.aiTurnCounter);
        }
        
        // Dev-mode: mirror reveal events into the bottom bot's belief slot
        if (gameState.devMode && typeof devMode !== 'undefined' && devMode.active) {
            if (piece.owner === COMPUTER) {
                devMode.notifyBottomOfBattle(piece);
            }
            if (targetPiece.owner === COMPUTER) {
                devMode.notifyBottomOfBattle(targetPiece);
            }
        }
        
        // Flag Capture
        if (targetPiece.type === FLAG) {
            removePiece(gameState, targetPiece);
            gameState.board[piece.row][piece.col] = null;
            piece.row = newRow;
            piece.col = newCol;
            gameState.board[newRow][newCol] = piece;
            gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
            endGame(gameState, piece.owner === PLAYER, 'flag_captured');
            return {
                type: 'battle_flag',
                attacker: piece,
                defender: targetPiece,
                result: 'win',
                winner: piece.owner
            };
        }
        
        if (piece.type === FLAG) {
            endGame(gameState, piece.owner !== PLAYER, 'flag_captured');
            return {
                type: 'battle_flag',
                attacker: piece,
                defender: targetPiece,
                result: 'lose',
                winner: targetPiece.owner
            };
        }
        
        // Trap
        if (targetPiece.type === TRAP) {
            removePiece(gameState, piece);
            targetPiece.immobilized = true;
            gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
            checkGameEnd(gameState);
            return {
                type: 'battle_trap',
                attacker: piece,
                defender: targetPiece,
                result: 'lose',
                winner: targetPiece.owner
            };
        }
        
        if (piece.type === TRAP) {
            removePiece(gameState, targetPiece);
            gameState.board[piece.row][piece.col] = null;
            piece.row = newRow;
            piece.col = newCol;
            gameState.board[newRow][newCol] = piece;
            piece.immobilized = true;
            gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
            checkGameEnd(gameState);
            return {
                type: 'battle_trap',
                attacker: piece,
                defender: targetPiece,
                result: 'win',
                winner: piece.owner
            };
        }
        
        // RPS Battle
        const result = resolveBattle(piece.pieceType, targetPiece.pieceType);
        
        if (result === 'win') {
            removePiece(gameState, targetPiece);
            gameState.board[piece.row][piece.col] = null;
            piece.row = newRow;
            piece.col = newCol;
            gameState.board[newRow][newCol] = piece;
            gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
            checkGameEnd(gameState);
            return {
                type: 'battle',
                attacker: { ...piece },
                defender: { ...targetPiece },
                result: 'win',
                winner: piece.owner
            };
        } else if (result === 'lose') {
            removePiece(gameState, piece);
            gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
            checkGameEnd(gameState);
            return {
                type: 'battle',
                attacker: { ...piece },
                defender: { ...targetPiece },
                result: 'lose',
                winner: targetPiece.owner
            };
        } else {
            // Draw
            gameState.battleState = {
                attacker: piece,
                defender: targetPiece,
                newRow: newRow,
                newCol: newCol,
                isPlayerFirst: piece.owner === PLAYER,
                aiChoice: null,
                playerChoice: null,
                drawRound: 1
            };
            
            precommitAITieChoice(gameState);
            return {
                type: 'battle',
                attacker: { ...piece },
                defender: { ...targetPiece },
                result: 'draw'
            };
        }
    } else {
        // Simple move
        gameState.board[piece.row][piece.col] = null;
        piece.row = newRow;
        piece.col = newCol;
        gameState.board[newRow][newCol] = piece;
        gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
        
        if (piece.owner === PLAYER) {
            aiEngine.playerPatternAnalysis.moves.push({
                from: { row: oldRow, col: oldCol },
                to: { row: newRow, col: newCol },
                piece: piece
            });
            aiBeliefs.onPlayerMove(piece.id, oldRow, oldCol, newRow, newCol, gameState);
        }

        // Dev-mode: mirror top moves into bottom bot's memory slot
        if (gameState.devMode && piece.owner === COMPUTER && typeof devMode !== 'undefined' && devMode.active) {
            devMode.notifyBottomOfTopMove(piece, oldRow, oldCol, newRow, newCol, gameState);
        }
        
        checkGameEnd(gameState);
        return {
            type: 'move',
            piece: piece,
            from: [oldRow, oldCol],
            to: [newRow, newCol]
        };
    }
}

/**
 * Handle a player's choice during a tie-break
 */
export function makeChoice(gameState, newType) {
    if (!gameState.battleState) return { success: false };
    
    const { attacker, defender, newRow, newCol } = gameState.battleState;
    gameState.battleState.playerChoice = newType;
    
    if (attacker.owner === PLAYER) {
        attacker.pieceType = newType;
    } else {
        defender.pieceType = newType;
    }
    
    const aiChoice = gameState.battleState.aiChoice;
    const aiPiece = attacker.owner === COMPUTER ? attacker : defender;
    aiPiece.pieceType = aiChoice;
    
    const result = resolveBattle(attacker.pieceType, defender.pieceType);
    const drawRound = gameState.battleState.drawRound;
    
    if (result === 'win') {
        removePiece(gameState, defender);
        const oldRow = attacker.row;
        const oldCol = attacker.col;
        gameState.board[attacker.row][attacker.col] = null;
        attacker.row = newRow;
        attacker.col = newCol;
        gameState.board[newRow][newCol] = attacker;
        gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
        
        gameState.battleState = null;
        checkGameEnd(gameState);
        return {
            type: 'tie_resolved',
            attacker,
            defender,
            result: 'win',
            winner: attacker.owner,
            playerChoice: newType,
            aiChoice: aiChoice
        };
    } else if (result === 'lose') {
        removePiece(gameState, attacker);
        gameState.lastMove = { from: [attacker.row, attacker.col], to: [defender.row, defender.col] };
        
        gameState.battleState = null;
        checkGameEnd(gameState);
        return {
            type: 'tie_resolved',
            attacker,
            defender,
            result: 'lose',
            winner: defender.owner,
            playerChoice: newType,
            aiChoice: aiChoice
        };
    } else {
        // Draw again
        const nextRound = drawRound + 1;
        gameState.battleState.drawRound = nextRound;
        
        if (nextRound > 6) {
            // Mutual Annihilation
            const attRow = attacker.row;
            const attCol = attacker.col;
            const defRow = defender.row;
            const defCol = defender.col;
            removePiece(gameState, attacker);
            removePiece(gameState, defender);
            gameState.lastMove = { from: [attRow, attCol], to: [defRow, defCol] };
            gameState.battleState = null;
            checkGameEnd(gameState);
            return {
                type: 'mutual_annihilation',
                attacker,
                defender,
                playerChoice: newType,
                aiChoice: aiChoice
            };
        }
        
        gameState.battleState.lastRound = {
            playerChoice: newType,
            opponentChoice: aiChoice,
            attackerType: attacker.pieceType,
            defenderType: defender.pieceType
        };

        precommitAITieChoice(gameState);
        return {
            type: 'tie_draw',
            drawRound: nextRound,
            playerChoice: newType,
            aiChoice: aiChoice
        };
    }
}

/**
 * End current turn and flip active player
 */
export function endTurn(gameState) {
    if (gameState.gameOver) return;
    
    gameState.movesWithoutCapture = (gameState.movesWithoutCapture || 0) + 1;
    const drawLimit = GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT || 20;
    if (gameState.movesWithoutCapture >= drawLimit) {
        endGame(gameState, 'draw', 'no_captures_draw');
        return;
    }
    
    gameState.currentPlayer = gameState.currentPlayer === PLAYER ? COMPUTER : PLAYER;
    
    if (gameState.currentPlayer === COMPUTER) {
        aiEngine.aiTurnCounter++;
        // Tick beliefs to let bot estimate stagnation
        aiBeliefs.tick(aiEngine.aiTurnCounter);
    }
}

/**
 * Execute computer bot turn
 */
export function makeBotMove(gameState) {
    if (gameState.gameOver || gameState.currentPlayer !== COMPUTER || gameState.battleState) {
        return { type: 'error', reason: 'Not bot turn' };
    }
    
    const bot = botRegistry.get(gameState.botId);

    // Anti-cheat: hand the bot a fog-of-war clone (hidden enemy identities
    // stripped, real state un-mutable). The returned move references a cloned
    // piece, so it is mapped back to the real piece by id and validated.
    const view = createBotView(gameState);
    // Anti-cheat: reduce the bot's output to safe primitives, resolve the real
    // piece by id, and re-validate legality against the authoritative board.
    const move = sanitizeMove(bot.move(view));

    const realPiece = move
        ? gameState.aiPieces.find(p => p.id === move.pieceId)
        : null;
    const isLegal = realPiece
        && isMoveLegal(realPiece.row, realPiece.col, move.row, move.col, gameState.board, COMPUTER);

    if (isLegal) {
        const result = makeMove(gameState, realPiece, move.row, move.col);
        if (result.type !== 'battle' || result.result !== 'draw') {
            endTurn(gameState);
        }
        return result;
    }

    // No move, unknown piece, or illegal move -> the bot forfeits its turn.
    endGame(gameState, true, 'no_moves');
    return {
        type: 'no_moves',
        winner: PLAYER
    };
}

export function startDevMatch(gameState, topBotId, bottomBotId) {
    const fallbackId = botRegistry.getFallbackId ? botRegistry.getFallbackId() : 'rabbit';
    const resolvedTopId = botRegistry.get(topBotId) ? topBotId : fallbackId;
    const resolvedBottomId = botRegistry.get(bottomBotId) ? bottomBotId : fallbackId;
    
    gameState.phase = GAME_CONFIG.PHASES.PLAYING;
    gameState.gameOver = false;
    gameState.currentPlayer = COMPUTER;
    gameState.devMode = true;
    gameState.botId = resolvedTopId;
    gameState.topBotId = resolvedTopId;
    gameState.bottomBotId = resolvedBottomId;
    gameState.movesWithoutCapture = 0;
    
    aiEngine.resetMemory();
    devMode.start(resolvedTopId, resolvedBottomId);
    
    // Clear board
    for (let r = 0; r < BOARD_HEIGHT; r++) {
        for (let c = 0; c < BOARD_WIDTH; c++) {
            gameState.board[r][c] = null;
        }
    }
    
    placeBottomPieces(gameState, resolvedBottomId);
    placeComputerPieces(gameState);
    
    devMode.initBothBeliefs(gameState);
}

export function placeBottomPieces(gameState, botId) {
    gameState.playerPieces = [];
    
    const { flagIndex: flagPos, trapIndex: trapPos } =
        devMode.chooseBottomFlagAndTrapPositions(botId);
    
    let flagCount = 0;
    let trapCount = 0;
    
    const totalPieces = GAME_CONFIG.GAME.TOTAL_PIECES;
    const pieceTypes = generateBalancedPieceTypes(totalPieces - 2, 3);
    let pieceIdx = 0;
    
    for (let i = 0; i < totalPieces; i++) {
        const col = i % 8;
        const row = Math.floor(i / 8) + 4; // rows 4 & 5
        
        let type;
        let pieceType = null;
        if (i === flagPos && flagCount === 0) {
            type = FLAG;
            flagCount++;
        } else if (i === trapPos && trapCount === 0) {
            type = TRAP;
            trapCount++;
        } else {
            type = 'piece';
            pieceType = pieceTypes[pieceIdx++];
        }
        
        const piece = {
            id: `player_${i}`,
            type: type,
            pieceType: pieceType,
            owner: PLAYER,
            row: row,
            col: col,
            revealed: false,
            immobilized: false,
            removed: false
        };
        
        gameState.playerPieces.push(piece);
        gameState.board[row][col] = piece;
    }
}

export function makeBottomBotMove(gameState) {
    if (gameState.gameOver || !gameState.devMode || gameState.currentPlayer !== PLAYER || gameState.battleState) {
        return { type: 'error', reason: 'Not bottom bot turn' };
    }
    
    const move = devMode.makeBottomMove(gameState);

    const legal = move
        && move.piece
        && !move.piece.removed
        && isMoveLegal(move.piece.row, move.piece.col, move.row, move.col, gameState.board, PLAYER);

    if (legal) {
        const result = makeMove(gameState, move.piece, move.row, move.col);
        if (result.type !== 'battle' || result.result !== 'draw') {
            endTurn(gameState);
        }
        return result;
    }

    // No move, unknown piece, or illegal move -> the bottom bot forfeits.
    endGame(gameState, false, 'no_moves');
    return {
        type: 'no_moves',
        winner: COMPUTER
    };
}

export function resolveDevModeTie(gameState) {
    if (!gameState.battleState || !gameState.devMode) return { type: 'error', reason: 'Not in battle tie' };
    
    const { attacker, defender, newRow, newCol } = gameState.battleState;
    const topPiece = attacker.owner === COMPUTER ? attacker : defender;
    const bottomPiece = attacker.owner === PLAYER ? attacker : defender;

    // Anti-cheat: both sides choose simultaneously. Snapshot the pre-choice
    // (publicly known) types and compute BOTH choices from that snapshot before
    // committing either one. This way neither bot can observe the opponent's
    // fresh choice — not via the "opponent type" argument and not via
    // battleState.playerChoice / aiChoice (still null while choosing).
    const topPublicType = topPiece.pieceType;
    const bottomPublicType = bottomPiece.pieceType;

    const bottomChoice = devMode.pickChoiceForSide(
        'bottom',
        bottomPublicType,
        topPublicType,
        gameState
    );
    const topChoice = devMode.pickChoiceForSide(
        'top',
        topPublicType,
        bottomPublicType,
        gameState
    );

    bottomPiece.pieceType = bottomChoice;
    topPiece.pieceType = topChoice;
    gameState.battleState.playerChoice = bottomChoice;
    gameState.battleState.aiChoice = topChoice;
    
    const result = resolveBattle(attacker.pieceType, defender.pieceType);
    const drawRound = gameState.battleState.drawRound;
    
    if (result === 'win') {
        removePiece(gameState, defender);
        const oldRow = attacker.row;
        const oldCol = attacker.col;
        gameState.board[attacker.row][attacker.col] = null;
        attacker.row = newRow;
        attacker.col = newCol;
        gameState.board[newRow][newCol] = attacker;
        gameState.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
        
        gameState.battleState = null;
        checkGameEnd(gameState);
        endTurn(gameState);
        return {
            type: 'tie_resolved',
            attacker,
            defender,
            result: 'win',
            winner: attacker.owner,
            playerChoice: bottomChoice,
            aiChoice: topChoice
        };
    } else if (result === 'lose') {
        removePiece(gameState, attacker);
        gameState.lastMove = { from: [attacker.row, attacker.col], to: [defender.row, defender.col] };
        
        gameState.battleState = null;
        checkGameEnd(gameState);
        endTurn(gameState);
        return {
            type: 'tie_resolved',
            attacker,
            defender,
            result: 'lose',
            winner: defender.owner,
            playerChoice: bottomChoice,
            aiChoice: topChoice
        };
    } else {
        const nextRound = drawRound + 1;
        gameState.battleState.drawRound = nextRound;
        
        if (nextRound > 6) {
            const attRow = attacker.row;
            const attCol = attacker.col;
            const defRow = defender.row;
            const defCol = defender.col;
            removePiece(gameState, attacker);
            removePiece(gameState, defender);
            gameState.lastMove = { from: [attRow, attCol], to: [defRow, defCol] };
            gameState.battleState = null;
            checkGameEnd(gameState);
            endTurn(gameState);
            return {
                type: 'mutual_annihilation',
                attacker,
                defender,
                playerChoice: bottomChoice,
                aiChoice: topChoice
            };
        }
        
        gameState.battleState.lastRound = {
            playerChoice: bottomChoice,
            opponentChoice: topChoice,
            attackerType: attacker.pieceType,
            defenderType: defender.pieceType
        };
        
        precommitAITieChoice(gameState);
        return {
            type: 'tie_draw',
            drawRound: nextRound,
            playerChoice: bottomChoice,
            aiChoice: topChoice
        };
    }
}
