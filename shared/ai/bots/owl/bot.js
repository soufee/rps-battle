/**
 * 🦉 Сова — classical chess-engine port.
 *
 * Playstyle: a pure, deep expectiminimax searcher with a shared public-belief
 * model for hidden combat outcomes. What makes her feel different from Енот:
 *   - iterative deepening with a time budget,
 *   - transposition table (Zobrist-like hash of state) shared across depths,
 *   - move ordering: TT best move → captures ranked MVV-LVA → killer moves
 *     → history heuristic,
 *   - quiescence search at the leaves (captures-only) to dodge horizon
 *     effects on attacks.
 *
 * Hidden identities are never read directly. Every attack on an unknown piece
 * is expanded into legal outcomes weighted by information available to the bot.
 */

// === MANDATORY bot-api guard (must run before the object literal)
if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[owl] bot-api.js must be loaded before this bot');
}

const owlBot = {
    id: 'owl',
    name: 'Сова',
    emoji: '🦉',
    avatar: 'js/bots/owl/avatar-min.png',
    shortDescription: 'Классический шахматный движок',
    longDescription: 'Глубокий вероятностный α-β по видимой доске с честной оценкой скрытых столкновений.',
    algorithmLabel: 'Expectiminimax + транспозиция',
    // Certified through RPSBotAPI.defineBot (mandatory common rulebook + interface)
    tier: 'hard',
    stars: 3,
    difficultyLabel: 'Сложный',
    tags: ['classic', 'deep-search'],
    
    TIME_BUDGET_MS: 3000,
    MAX_DEPTH: 6,
    START_DEPTH: 2,
    QUIESCENCE_MAX: 3,
    
    // Transposition-table entry flags.
    TT_EXACT: 0,
    TT_LOWER: 1,
    TT_UPPER: 2,
    
    _tt: new Map(),
    _killers: null,
    _history: null,
    _searchStart: 0,
    _nodes: 0,
    _rootBestMove: null,
    
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
            console.error('[owl] move() failed:', error);
            return null;
        }
    },
    
    chooseFlagAndTrap() {
        return aiEngine.chooseFlagAndTrapPositions({ style: 'corner-strong' });
    },
    
    // ==========================================================================
    //  MOVE SELECTION
    // ==========================================================================
    
    _pickMove(gameState) {
        const available = aiEngine.getActivePieces(gameState);
        if (available.length === 0) {
            return null;
        }
        
        const flagCapture = aiEngine.findFlagCaptureMoves(gameState, available);
        if (flagCapture.length > 0) {
            return aiEngine.pickBestScored(flagCapture, gameState);
        }
        
        const flagDefense = aiEngine.findFlagDefenseMoves(gameState, available);
        if (flagDefense.length > 0) {
            return aiEngine.pickBestScored(flagDefense, gameState);
        }
        
        const guaranteed = aiEngine.findGuaranteedKills(gameState, available);
        if (guaranteed.length > 0) {
            const picked = aiEngine.pickBestScored(guaranteed, gameState);
            if (picked) {
                return picked;
            }
        }
        
        return this._iterativeDeepening(gameState);
    },
    
    _iterativeDeepening(gameState) {
        this._searchStart = Date.now();
        this._nodes = 0;
        this._tt.clear();
        this._killers = new Map();
        this._history = new Map();
        this._rootBestMove = null;
        
        let lastBest = null;
        let lastScore = 0;
        
        for (let depth = this.START_DEPTH; depth <= this.MAX_DEPTH; depth++) {
            if (this._timeUp()) {
                break;
            }
            
            const result = this._search(gameState, depth, -Infinity, Infinity, true, 0);
            if (result && result.move && !this._timeUp()) {
                lastBest = result.move;
                lastScore = result.score;
                this._rootBestMove = result.move;
            } else if (this._timeUp()) {
                break;
            }
        }
        
        if (!lastBest) {
            return this._heuristicFallback(gameState);
        }
        
        // Anti-shuttle: if the chosen move is a ping-pong repeat, try to pick
        // the best alternative at the root that isn't. Uses aiEngine memory.
        if (aiEngine.isShuttlePosition(lastBest.piece.id, lastBest.row, lastBest.col)
            && aiEngine.countRecentMovesOfPiece(lastBest.piece.id, 4) >= 2) {
            const alt = this._pickAlternativeRootMove(gameState, lastBest);
            if (alt) {
                return alt;
            }
        }
        return lastBest;
    },
    
    _heuristicFallback(gameState) {
        const pieces = aiEngine.getActivePieces(gameState);
        const all = aiEngine.getAllFilteredMoves(gameState, pieces);
        if (all.length === 0) {
            return null;
        }
        const pool = aiEngine.filterOutShuttleMoves(all);
        let bestMove = null;
        let bestScore = -Infinity;
        for (const m of pool) {
            const score = aiEngine.evaluateMoveV2(m, gameState);
            if (score > bestScore) {
                bestScore = score;
                bestMove = m;
            }
        }
        return bestMove;
    },
    
    _pickAlternativeRootMove(gameState, rejected) {
        const pieces = aiEngine.getActivePieces(gameState);
        const all = aiEngine.getAllFilteredMoves(gameState, pieces);
        const filtered = all.filter(m =>
            !(m.piece.id === rejected.piece.id
                && m.row === rejected.row
                && m.col === rejected.col)
        );
        const pool = aiEngine.filterOutShuttleMoves(filtered);
        let bestMove = null;
        let bestScore = -Infinity;
        for (const m of pool) {
            const score = aiEngine.evaluateMoveV2(m, gameState);
            if (score > bestScore) {
                bestScore = score;
                bestMove = m;
            }
        }
        return bestMove;
    },
    
    // ==========================================================================
    //  SEARCH
    // ==========================================================================
    
    _search(state, depth, alpha, beta, isMax, ply) {
        this._nodes += 1;
        if (this._timeUp()) {
            return { score: aiEngine.evaluatePositionV2(state), move: null };
        }
        if (aiEngine.isGameOver(state)) {
            return { score: aiEngine.evaluatePositionV2(state), move: null };
        }
        if (depth <= 0) {
            return { score: this._quiescence(state, alpha, beta, isMax, this.QUIESCENCE_MAX), move: null };
        }
        
        const hashKey = `${aiEngine.getStateHash(state)}|${isMax ? 'M' : 'm'}`;
        const ttEntry = this._tt.get(hashKey);
        let ttMove = null;
        if (ttEntry && ttEntry.depth >= depth) {
            if (ttEntry.flag === this.TT_EXACT) {
                return { score: ttEntry.score, move: ttEntry.move };
            }
            if (ttEntry.flag === this.TT_LOWER && ttEntry.score > alpha) {
                alpha = ttEntry.score;
            } else if (ttEntry.flag === this.TT_UPPER && ttEntry.score < beta) {
                beta = ttEntry.score;
            }
            if (alpha >= beta) {
                return { score: ttEntry.score, move: ttEntry.move };
            }
        }
        if (ttEntry) {
            ttMove = ttEntry.move;
        }
        
        const owner = isMax ? COMPUTER : PLAYER;
        const rawMoves = aiEngine.getAllPossibleMoves(state, owner);
        if (rawMoves.length === 0) {
            return { score: aiEngine.evaluatePositionV2(state), move: null };
        }
        
        const orderedMoves = this._orderMoves(state, rawMoves, depth, ply, ttMove, owner);
        
        let bestScore = isMax ? -Infinity : Infinity;
        let bestMove = null;
        const originalAlpha = alpha;
        const originalBeta = beta;
        
        for (const move of orderedMoves) {
            if (this._timeUp()) {
                break;
            }
            const score = this._expectedSearchMove(
                state,
                move,
                depth - 1,
                !isMax,
                ply + 1
            );
            
            if (isMax) {
                if (score > bestScore) {
                    bestScore = score;
                    bestMove = move;
                }
                if (bestScore > alpha) {
                    alpha = bestScore;
                }
            } else {
                if (score < bestScore) {
                    bestScore = score;
                    bestMove = move;
                }
                if (bestScore < beta) {
                    beta = bestScore;
                }
            }
            
            if (alpha >= beta) {
                this._recordKillerAndHistory(move, depth, ply, !this._isCapture(state, move));
                break;
            }
        }
        
        if (bestMove) {
            let flag = this.TT_EXACT;
            if (bestScore <= originalAlpha) {
                flag = this.TT_UPPER;
            } else if (bestScore >= originalBeta) {
                flag = this.TT_LOWER;
            }
            this._tt.set(hashKey, { depth, score: bestScore, flag, move: bestMove });
        }
        
        return { score: bestScore, move: bestMove };
    },

    _expectedSearchMove(state, move, depth, isMax, ply) {
        const outcomes = aiSearch.getMoveOutcomes(state, move);
        if (outcomes.length === 0) {
            return aiEngine.evaluatePositionV2(state);
        }
        let expected = 0;
        for (const outcome of outcomes) {
            const child = this._search(
                outcome.state,
                depth,
                -Infinity,
                Infinity,
                isMax,
                ply
            );
            expected += outcome.probability * child.score;
        }
        return expected;
    },
    
    _quiescence(state, alpha, beta, isMax, depthLeft) {
        if (this._timeUp()) {
            return aiEngine.evaluatePositionV2(state);
        }
        const standPat = aiEngine.evaluatePositionV2(state);
        if (depthLeft <= 0) {
            return standPat;
        }
        if (isMax) {
            if (standPat >= beta) {
                return beta;
            }
            if (standPat > alpha) {
                alpha = standPat;
            }
        } else {
            if (standPat <= alpha) {
                return alpha;
            }
            if (standPat < beta) {
                beta = standPat;
            }
        }
        
        const owner = isMax ? COMPUTER : PLAYER;
        const moves = aiEngine.getAllPossibleMoves(state, owner).filter(m => this._isCapture(state, m));
        if (moves.length === 0) {
            return standPat;
        }
        const ordered = this._orderCaptures(state, moves);
        
        for (const move of ordered) {
            if (this._timeUp()) {
                break;
            }
            const score = this._expectedQuiescenceMove(
                state,
                move,
                !isMax,
                depthLeft - 1
            );
            if (isMax) {
                if (score >= beta) {
                    return beta;
                }
                if (score > alpha) {
                    alpha = score;
                }
            } else {
                if (score <= alpha) {
                    return alpha;
                }
                if (score < beta) {
                    beta = score;
                }
            }
        }
        return isMax ? alpha : beta;
    },

    _expectedQuiescenceMove(state, move, isMax, depthLeft) {
        const outcomes = aiSearch.getMoveOutcomes(state, move);
        if (outcomes.length === 0) {
            return aiEngine.evaluatePositionV2(state);
        }
        let expected = 0;
        for (const outcome of outcomes) {
            const score = this._quiescence(
                outcome.state,
                -Infinity,
                Infinity,
                isMax,
                depthLeft
            );
            expected += outcome.probability * score;
        }
        return expected;
    },
    
    // ==========================================================================
    //  MOVE ORDERING
    // ==========================================================================
    
    _orderMoves(state, moves, depth, ply, ttMove, owner) {
        const killers = this._killers.get(ply) || [];
        
        const scored = moves.map(m => ({
            move: m,
            score: this._moveOrderScore(state, m, ttMove, killers, owner)
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.map(s => s.move);
    },
    
    _orderCaptures(state, moves) {
        return moves
            .map(m => ({ move: m, score: this._captureScore(state, m) }))
            .sort((a, b) => b.score - a.score)
            .map(s => s.move);
    },
    
    _moveOrderScore(state, move, ttMove, killers, owner) {
        if (ttMove
            && ttMove.piece
            && move.piece.id === ttMove.piece.id
            && move.row === ttMove.row
            && move.col === ttMove.col) {
            return 10000;
        }
        if (this._isCapture(state, move)) {
            return 5000 + this._captureScore(state, move);
        }
        for (let i = 0; i < killers.length; i++) {
            const k = killers[i];
            if (k
                && move.piece.id === k.piece.id
                && move.row === k.row
                && move.col === k.col) {
                return 3000 - i * 10;
            }
        }
        const histKey = `${move.piece.id}|${move.row}|${move.col}`;
        const hist = this._history.get(histKey) || 0;
        return hist;
    },
    
    _captureScore(state, move) {
        const target = state.board[move.row] && state.board[move.row][move.col];
        if (!target) {
            return 0;
        }
        // MVV-LVA: most valuable victim first, least valuable attacker breaks ties.
        const victimValue = this._pieceValue(target, state);
        const attackerValue = this._pieceValue(move.piece, state);
        // Reveal reward: capturing a hidden piece is more valuable information-wise
        // than capturing a revealed one, so we add a small bonus for unknown targets.
        const revealBonus = target.revealed ? 0 : 20;
        return victimValue * 10 - attackerValue + revealBonus;
    },
    
    _pieceValue(piece, state) {
        if (!piece) {
            return 0;
        }
        if (!piece.revealed
            && piece.owner === PLAYER) {
            const distribution = aiSearch.getPieceDistribution(state, piece);
            return distribution.flag * 1000
                + distribution.trap * 400
                + (
                    distribution.rock
                    + distribution.paper
                    + distribution.scissors
                ) * 100;
        }
        if (piece.type === FLAG) {
            return 1000;
        }
        if (piece.type === TRAP) {
            return 400;
        }
        return 100;
    },
    
    _isCapture(state, move) {
        const target = state.board[move.row] && state.board[move.row][move.col];
        return !!(target && target.owner !== move.piece.owner);
    },
    
    _recordKillerAndHistory(move, depth, ply, isQuiet) {
        if (!isQuiet) {
            return;
        }
        let arr = this._killers.get(ply);
        if (!arr) {
            arr = [];
            this._killers.set(ply, arr);
        }
        if (arr.length > 0
            && arr[0]
            && arr[0].piece.id === move.piece.id
            && arr[0].row === move.row
            && arr[0].col === move.col) {
            return;
        }
        arr.unshift(move);
        if (arr.length > 2) {
            arr.length = 2;
        }
        
        const histKey = `${move.piece.id}|${move.row}|${move.col}`;
        this._history.set(histKey, (this._history.get(histKey) || 0) + depth * depth);
    },
    
    _timeUp() {
        return (Date.now() - this._searchStart) >= this.TIME_BUDGET_MS;
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = owlBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(owlBot);
} else {
    throw new Error('[owl] RPSBotAPI.defineBot is required (bot-api.js must be loaded first)');
}
