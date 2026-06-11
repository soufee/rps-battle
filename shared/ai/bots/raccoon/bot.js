/**
 * 🦝 Енот — heuristic alpha-beta bot.
 *
 * Playstyle: minimax with alpha-beta pruning at a moderate depth, plus a
 * "false weakness" bait tactic against aggressive players. Does not build
 * a probabilistic model of hidden pieces — it treats unknowns with simple
 * risk penalties in the evaluation function.
 *
 * A step up from Заяц: will plan a few plies ahead and won't walk blindly
 * into obvious losing trades.
 */

// === MANDATORY bot-api guard
if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[raccoon] bot-api.js must be loaded first');
}

const raccoonBot = {
    id: 'raccoon',
    name: 'Енот',
    emoji: '🦝',
    avatar: 'js/bots/raccoon/avatar-min.png',
    shortDescription: 'Минимакс с альфа-бета',
    longDescription: 'Минимакс на несколько ходов, без байеса. Редко жертвует фигуры, умеет притворяться слабым.',
    algorithmLabel: 'α-β отсечение',
    // Certified by RPSBotAPI (bot-api.js) — common rules + uniform interface enforced.
    tier: 'medium',
    stars: 2,
    difficultyLabel: 'Средний',
    tags: ['classic'],
    
    move(gameState) {
        try {
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);
            
            const move = this._pickMove(gameState);
            if (move) {
                aiEngine.recordAIMove(move);
            }
            return move;
        } catch (error) {
            console.error('[raccoon] move() failed:', error);
            return null;
        }
    },
    
    _pickMove(gameState) {
        const availablePieces = aiEngine.getActivePieces(gameState);
        if (availablePieces.length === 0) {
            return null;
        }
        
        const flagDefense = aiEngine.findFlagDefenseMoves(gameState, availablePieces);
        if (flagDefense.length > 0) {
            return aiEngine.pickBestScored(flagDefense, gameState);
        }
        
        const flagCapture = aiEngine.findFlagCaptureMoves(gameState, availablePieces);
        if (flagCapture.length > 0) {
            return aiEngine.pickRandom(flagCapture);
        }
        
        const guaranteedKills = aiEngine.findGuaranteedKills(gameState, availablePieces);
        if (guaranteedKills.length > 0) {
            return aiEngine.pickBestScored(guaranteedKills, gameState);
        }
        
        const weaknessMove = aiEngine.tryFalseWeakness(gameState);
        if (weaknessMove) {
            return weaknessMove;
        }
        
        const result = aiEngine.minimax(
            gameState,
            GAME_CONFIG.GAME.MAX_MINIMAX_DEPTH,
            -Infinity,
            Infinity,
            true
        );
        
        if (result.move
            && !aiEngine.isShuttlePosition(result.move.piece.id, result.move.row, result.move.col)
            && aiEngine.countRecentMovesOfPiece(result.move.piece.id, 4) < 2) {
            return result.move;
        }
        
        return this._fallbackHeuristic(gameState, availablePieces);
    },
    
    _fallbackHeuristic(gameState, availablePieces) {
        const allMoves = aiEngine.getAllFilteredMoves(gameState, availablePieces);
        if (allMoves.length === 0) {
            return null;
        }
        const movesPool = aiEngine.filterOutShuttleMoves(allMoves);
        
        let bestMove = null;
        let bestScore = -Infinity;
        for (const moveData of movesPool) {
            const score = aiEngine.evaluateMoveV2(moveData, gameState);
            if (score > bestScore) {
                bestScore = score;
                bestMove = moveData;
            }
        }
        return bestMove;
    },
    
    chooseFlagAndTrap() {
        return aiEngine.chooseFlagAndTrapPositions({ style: 'corner-biased' });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = raccoonBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(raccoonBot);
} else {
    throw new Error('[raccoon] RPSBotAPI.defineBot is required (bot-api.js must be loaded earlier)');
}
