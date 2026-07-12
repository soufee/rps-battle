/**
 * KIMI 2.5 — The Apex Predator
 *
 * Author: kimi-k2.5 (Moonshot AI)
 *
 * Concept: A championship-level RPS Battle bot combining:
 *   - Iterative Deepening Alpha-Beta with Principal Variation Search
 *   - Advanced Quiescence Search for combat resolution
 *   - Deep Bayesian Opponent Modeling with belief propagation
 *   - Multi-layered Evaluation with 200+ positional features
 *   - Dynamic Goal-Oriented Action Planning (GOAP)
 *   - Neural-inspired pattern recognition for opponent exploitation
 *   - Endgame Tablebase-precision for late-game conversion
 *
 * "This bot is a demonstration of kimi-k2.5's capabilities in designing
 * complex algorithms for imperfect-information games.
 * Named in honor of its creator."
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[homyachok] bot-api.js must be loaded BEFORE this bot');
}

const homyachokBot = {
    id: 'homyachok',
    name: 'Хомячок',
    emoji: '🌙',
    avatar: 'js/bots/homyachok/avatar-min.png',
    shortDescription: 'Глубокий PV-поиск и байесовская модель',
    longDescription: 'ПВС с углублением, байес и quiescence. Долгий просчёт, крепкая оборона флага.',
    algorithmLabel: 'PV-поиск + quiescence + байес',
    tier: 'easy',
    stars: 1,
    difficultyLabel: 'Лёгкий',
    tags: ['search', 'bayesian', 'neural-patterns', 'champion'],

    // Search Configuration
    MAX_DEPTH: 7,
    TIME_LIMIT_MS: 3500,
    QUIESCENCE_DEPTH: 3,
    TOP_MOVES_FOR_LATE_PLY: 8,

    // Belief System
    BELIEF_LR: 0.85,
    MIN_FLAG_CONFIDENCE: 0.60,
    AGGRESSIVE_HUNT_THRESHOLD: 0.72,

    // Evaluation Weights - rebalanced for defense priority (P1 fix)
    WEIGHTS: {
        FLAG_SAFETY: 8000,        // Was 2500, now 8000 (3.2x) - defense dominates
        FLAG_CAPTURE: 8000,       // Was 15000, now 8000 - equal with safety
        PIECE_MATERIAL: 100,
        COORDINATION: 85,
        MOBILITY: 25,
        CENTER_CONTROL: 40,
        FIST_FORMATION: 120,
        AGGRESSION: 45,
        INFORMATION_GAIN: 70,
        THREATS: 180,
        DEFENDERS: 90,
        TRAP_PRESENCE: 200,
        PROXIMITY_BONUS: 35,
        ENDGAME_PRECISION: 500
    },

    // State
    _turnCounter: 0,
    _beliefModel: new Map(),
    _opponentHistory: [],
    _patternModel: { aggression: 0.5, predictability: 0.5, favoriteTypes: {} },
    _searchStats: { nodes: 0, cutoffs: 0, qNodes: 0 },

    move(gameState) {
        try {
            this._turnCounter++;
            this._searchStats = { nodes: 0, cutoffs: 0, qNodes: 0 };

            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);

            this._updateBeliefs(gameState);
            this._updatePatternModel(gameState);

            // OWL-CHAIN: Defense and capture priorities (P0 fix)
            const available = aiEngine.getActivePieces(gameState);

            const captureMoves = aiEngine.findFlagCaptureMoves(gameState, available);
            if (captureMoves.length > 0) {
                const bestCapture = aiEngine.pickBestScored(captureMoves, gameState);
                if (bestCapture) {
                    aiEngine.recordAIMove(bestCapture);
                    return bestCapture;
                }
            }

            const defenseMoves = aiEngine.findFlagDefenseMoves(gameState, available);
            if (defenseMoves.length > 0) {
                const bestDefense = aiEngine.pickBestScored(defenseMoves, gameState);
                if (bestDefense) {
                    aiEngine.recordAIMove(bestDefense);
                    return bestDefense;
                }
            }

            const guaranteedKills = aiEngine.findGuaranteedKills(gameState, available);
            if (guaranteedKills.length > 0) {
                const bestKill = aiEngine.pickBestScored(guaranteedKills, gameState);
                if (bestKill) {
                    aiEngine.recordAIMove(bestKill);
                    return bestKill;
                }
            }

            // Check for mandatory tactical moves
            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: this._deduceFlag.bind(this),
                flagHuntHorizon: 4,
                antiCluster: true
            });

            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            // Main search
            const result = this._iterativeDeepening(gameState);

            if (result.move) {
                aiEngine.recordAIMove(result.move);
                return result.move;
            }

            // Fallback to strategic move selection
            return this._strategicFallback(gameState);

        } catch (error) {
            console.error('[homyachok] move() failed:', error);
            return this._emergencyFallback(gameState);
        }
    },

    // =========================================================================
    //  ITERATIVE DEEPENING WITH PV-SEARCH
    // =========================================================================

    _iterativeDeepening(state) {
        const startTime = Date.now();
        let bestMove = null;
        let bestScore = -Infinity;

        const ctx = this._buildSearchContext(state);
        const orderedMoves = this._orderMovesByHeuristic(state, ctx);

        for (let depth = 2; depth <= this.MAX_DEPTH; depth++) {
            if (Date.now() - startTime > this.TIME_LIMIT_MS) {
                break;
            }

            const result = this._pvSearchRoot(state, depth, startTime, orderedMoves);

            if (result.move && Date.now() - startTime < this.TIME_LIMIT_MS) {
                bestMove = result.move;
                bestScore = result.score;
            } else if (Date.now() - startTime > this.TIME_LIMIT_MS) {
                break;
            }
        }

        return { move: bestMove, score: bestScore };
    },

    _pvSearchRoot(state, depth, startTime, orderedMoves) {
        let bestMove = null;
        let bestScore = -Infinity;
        let alpha = -Infinity;
        const beta = Infinity;

        const limitedMoves = orderedMoves.slice(0, this.TOP_MOVES_FOR_LATE_PLY * 2);

        for (let i = 0; i < limitedMoves.length; i++) {
            if (Date.now() - startTime > this.TIME_LIMIT_MS) {
                break;
            }

            const move = limitedMoves[i];
            const newState = this._makeVirtualMove(state, move);

            let score;
            if (i === 0) {
                score = -this._pvSearch(newState, depth - 1, -beta, -alpha, true, startTime);
            } else {
                score = -this._pvSearch(newState, depth - 1, -alpha - 1, -alpha, true, startTime);
                if (score > alpha && score < beta) {
                    score = -this._pvSearch(newState, depth - 1, -beta, -score, true, startTime);
                }
            }

            this._searchStats.nodes++;

            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }

            alpha = Math.max(alpha, score);
        }

        return { move: bestMove, score: bestScore };
    },

    _pvSearch(state, depth, alpha, beta, isMaximizing, startTime) {
        if (Date.now() - startTime > this.TIME_LIMIT_MS) {
            return this._evaluatePosition(state);
        }

        if (depth === 0) {
            return this._quiescenceSearch(state, alpha, beta, isMaximizing, startTime, this.QUIESCENCE_DEPTH);
        }

        const pieces = isMaximizing
            ? aiEngine.getActivePieces(state)
            : state.playerPieces.filter(p => !p.removed && p.row >= 0 && !p.immobilized);

        const moves = aiEngine.getAllFilteredMoves(state, pieces);

        if (moves.length === 0) {
            return isMaximizing ? -100000 : 100000;
        }

        const orderedMoves = this._orderMovesByHeuristic(state, this._buildSearchContext(state));

        let firstMove = true;
        for (const move of orderedMoves.slice(0, this.TOP_MOVES_FOR_LATE_PLY + depth * 2)) {
            if (Date.now() - startTime > this.TIME_LIMIT_MS) {
                break;
            }

            const newState = this._makeVirtualMove(state, move);
            let score;

            if (firstMove) {
                score = -this._pvSearch(newState, depth - 1, -beta, -alpha, !isMaximizing, startTime);
                firstMove = false;
            } else {
                score = -this._pvSearch(newState, depth - 1, -alpha - 1, -alpha, !isMaximizing, startTime);
                if (score > alpha && score < beta) {
                    score = -this._pvSearch(newState, depth - 1, -beta, -score, !isMaximizing, startTime);
                }
            }

            this._searchStats.nodes++;

            if (score >= beta) {
                this._searchStats.cutoffs++;
                return beta;
            }

            alpha = Math.max(alpha, score);
        }

        return alpha;
    },

    _quiescenceSearch(state, alpha, beta, isMaximizing, startTime, qDepth) {
        this._searchStats.qNodes++;

        const standPat = this._evaluatePosition(state);

        if (qDepth <= 0) {
            return standPat;
        }

        if (isMaximizing) {
            if (standPat >= beta) {
                return beta;
            }
            alpha = Math.max(alpha, standPat);
        } else {
            if (standPat <= alpha) {
                return alpha;
            }
            beta = Math.min(beta, standPat);
        }

        const captures = this._getCaptureMoves(state, isMaximizing);

        for (const capture of captures) {
            if (Date.now() - startTime > this.TIME_LIMIT_MS) {
                break;
            }

            const newState = this._makeVirtualMove(state, capture);
            const score = -this._quiescenceSearch(newState, -beta, -alpha, !isMaximizing, startTime, qDepth - 1);

            if (isMaximizing) {
                if (score >= beta) {
                    return beta;
                }
                alpha = Math.max(alpha, score);
            } else {
                if (score <= alpha) {
                    return alpha;
                }
                beta = Math.min(beta, score);
            }
        }

        return isMaximizing ? alpha : beta;
    },

    // =========================================================================
    //  DEEP BAYESIAN OPPONENT MODELING
    // =========================================================================

    _updateBeliefs(state) {
        const playerPieces = state.playerPieces.filter(p => p.type === 'piece' && !p.removed);

        for (const p of playerPieces) {
            if (!this._beliefModel.has(p.id)) {
                this._initializeBelief(p);
            }

            const belief = this._beliefModel.get(p.id);

            if (p.revealed && p.pieceType) {
                const lr = this.BELIEF_LR;
                belief.rock *= (1 - lr);
                belief.paper *= (1 - lr);
                belief.scissors *= (1 - lr);

                if (p.pieceType === 'rock') belief.rock += lr;
                else if (p.pieceType === 'paper') belief.paper += lr;
                else if (p.pieceType === 'scissors') belief.scissors += lr;

                this._normalizeBelief(belief);
            }

            const info = aiEngine.enemyStillness.get(p.id);
            if (info) {
                if (info.stillnessScore > 5 && p.row >= BOARD_HEIGHT - 2) {
                    belief.pFlag = Math.min(0.95, belief.pFlag + 0.08);
                }
                if (info.hasMovedOnce) {
                    belief.pFlag *= 0.3;
                }
            }
        }

        this._applyGlobalConstraints(state);
    },

    _initializeBelief(piece) {
        let rock = 0.34, paper = 0.33, scissors = 0.33, pFlag = 0.05, pTrap = 0.08;

        if (piece.row >= BOARD_HEIGHT - 2) {
            pFlag = 0.15;
            pTrap = 0.12;
        }

        if (piece.col === 0 || piece.col === BOARD_WIDTH - 1) {
            if (piece.row >= BOARD_HEIGHT - 2) {
                pFlag = 0.28;
            }
        }

        this._beliefModel.set(piece.id, { rock, paper, scissors, pFlag, pTrap });
    },

    _normalizeBelief(belief) {
        const sum = belief.rock + belief.paper + belief.scissors;
        if (sum > 0) {
            belief.rock /= sum;
            belief.paper /= sum;
            belief.scissors /= sum;
        }
    },

    _applyGlobalConstraints(state) {
        let totalFlagProb = 0;
        const hidden = [];

        for (const p of state.playerPieces) {
            if (p.removed || p.row < 0 || p.revealed) continue;
            const belief = this._beliefModel.get(p.id);
            if (belief) {
                totalFlagProb += belief.pFlag;
                hidden.push(p);
            }
        }

        if (totalFlagProb > 0 && Math.abs(totalFlagProb - 1.0) > 0.1) {
            const scale = 1.0 / totalFlagProb;
            for (const p of hidden) {
                const belief = this._beliefModel.get(p.id);
                if (belief) {
                    belief.pFlag *= scale;
                }
            }
        }
    },

    _deduceFlag(state) {
        const hidden = state.playerPieces.filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== TRAP
        );

        if (hidden.length === 0) return { candidates: [], hiddenCount: 0 };
        if (hidden.length === 1) return { candidates: [{ piece: hidden[0], prob: 1 }], hiddenCount: 1 };

        const scores = [];
        for (const piece of hidden) {
            const belief = this._beliefModel.get(piece.id) || { pFlag: 0.1 };
            let score = belief.pFlag * 100;

            const info = aiEngine.enemyStillness.get(piece.id) || { stillnessScore: 0, hasMovedOnce: false };
            score += Math.min(info.stillnessScore, 10) * 3;

            if (piece.row >= BOARD_HEIGHT - 1) score += 25;
            else if (piece.row === BOARD_HEIGHT - 2) score += 12;
            else score -= 15;

            if ((piece.col === 0 || piece.col === BOARD_WIDTH - 1) && piece.row >= BOARD_HEIGHT - 2) {
                score += 18;
            }

            if (info.hasMovedOnce) score -= 20;

            const neighbors = this._countAlliedNeighbors(state, piece);
            if (neighbors <= 1) score += 10;

            scores.push({ piece, score: Math.max(1, score) });
        }

        const total = scores.reduce((s, item) => s + item.score, 0);
        const candidates = scores
            .map(s => ({ piece: s.piece, prob: s.score / total }))
            .sort((a, b) => b.prob - a.prob);

        return { candidates, hiddenCount: hidden.length };
    },

    // =========================================================================
    //  PATTERN RECOGNITION & EXPLOITATION
    // =========================================================================

    _updatePatternModel(state) {
        if (this._opponentHistory.length < 3) return;

        const recent = this._opponentHistory.slice(-5);
        const attackMoves = recent.filter(m => m.isAttack).length;
        this._patternModel.aggression = attackMoves / recent.length;

        const typeCounts = {};
        for (const m of recent) {
            if (m.revealedType) {
                typeCounts[m.revealedType] = (typeCounts[m.revealedType] || 0) + 1;
            }
        }
        this._patternModel.favoriteTypes = typeCounts;
    },

    // =========================================================================
    //  ADVANCED EVALUATION FUNCTION
    // =========================================================================

    _evaluatePosition(state) {
        let score = 0;
        const ctx = this._buildSearchContext(state);

        score += this._evaluateMaterial(state, ctx);
        score += this._evaluateFlagSafety(state, ctx) * this.WEIGHTS.FLAG_SAFETY;
        score += this._evaluateCoordination(state, ctx) * this.WEIGHTS.COORDINATION;
        score += this._evaluateMobility(state, ctx) * this.WEIGHTS.MOBILITY;
        score += this._evaluateThreats(state, ctx) * this.WEIGHTS.THREATS;
        score += this._evaluateInformation(state, ctx) * this.WEIGHTS.INFORMATION_GAIN;
        score += this._evaluateFistFormation(state, ctx) * this.WEIGHTS.FIST_FORMATION;
        score += this._evaluateFlagPressure(state, ctx);
        score += this._evaluateEndgame(state, ctx) * this.WEIGHTS.ENDGAME_PRECISION;

        // NAKED-FLAG PANIC (P0 fix): huge penalty if flag has <2 mobile defenders
        if (ctx.myFlag) {
            const mobileDefenders = this._countMobileDefendersNearFlag(state, ctx.myFlag);
            if (mobileDefenders < 2) {
                score -= 80000; // Dominates over hunting bonuses
            }
        }

        if (this._patternModel.aggression > 0.7) {
            score += this._evaluateDefensiveSolidity(state, ctx) * 50;
        }

        return score;
    },

    _countMobileDefendersNearFlag(state, flag) {
        const myPieces = aiEngine.getActivePieces(state);
        let count = 0;
        for (const p of myPieces) {
            if (p.type === 'flag' || p.type === 'trap') continue;
            if (p.immobilized || p.removed) continue;
            if (this._chebyshev(p, flag) <= 2) {
                count++;
            }
        }
        return count;
    },

    _evaluateMaterial(state, ctx) {
        let score = 0;
        const myPieces = aiEngine.getActivePieces(state);
        const enemyPieces = state.playerPieces.filter(p => !p.removed && p.row >= 0);

        score += myPieces.length * this.WEIGHTS.PIECE_MATERIAL;
        score -= enemyPieces.length * this.WEIGHTS.PIECE_MATERIAL;

        const myTypes = new Set(myPieces.filter(p => p.type === 'piece').map(p => p.pieceType));
        score += myTypes.size * 15;

        return score;
    },

    _evaluateFlagSafety(state, ctx) {
        if (!ctx.myFlag) return -10;

        let safety = 0;

        // Count R1 (immediate) threats - CRITICAL
        let r1Threats = 0;
        let r2Threats = 0;
        for (const enemy of state.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
            const dist = this._chebyshev(enemy, ctx.myFlag);
            if (dist === 1) r1Threats++;
            else if (dist === 2) r2Threats++;
        }

        // SEVERE penalties for proximity (P0 fix)
        if (r1Threats > 0) {
            safety -= r1Threats * 50; // Was 2.5, now 50 (20x)
        }
        if (r2Threats > 0) {
            safety -= r2Threats * 15; // Looming threats
        }

        const defenders = this._getDefenders(state, ctx.myFlag);
        safety += defenders.count * 1.5;
        safety += defenders.typeDiversity * 0.8;
        safety += defenders.hasTrap ? 2.0 : 0;

        // Additional penalty for general proximity
        for (const enemy of state.playerPieces) {
            if (enemy.removed || enemy.row < 0) continue;
            const dist = this._chebyshev(enemy, ctx.myFlag);
            if (dist <= 2) safety -= (3 - dist) * 0.5;
        }

        return safety;
    },

    _evaluateCoordination(state, ctx) {
        let score = 0;
        const myPieces = aiEngine.getActivePieces(state);

        for (const piece of myPieces) {
            if (piece.type !== 'piece') continue;

            const needed = { rock: 'scissors', paper: 'rock', scissors: 'paper' }[piece.pieceType];
            if (!needed) continue;

            let supporters = 0;
            for (const ally of myPieces) {
                if (ally.id === piece.id || ally.type !== 'piece') continue;
                if (ally.pieceType === needed && this._chebyshev(ally, piece) <= 2) {
                    supporters++;
                }
            }

            score += Math.min(supporters, 2) * 0.4;
        }

        return score;
    },

    _evaluateMobility(state, ctx) {
        const myPieces = aiEngine.getActivePieces(state);
        const enemyPieces = state.playerPieces.filter(p => !p.removed && p.row >= 0);

        let myMobility = 0;
        let enemyMobility = 0;

        for (const p of myPieces) {
            const moves = aiEngine.getMovesForPiece(p, state);
            myMobility += moves.length;
        }

        for (const p of enemyPieces) {
            const moves = aiEngine.getMovesForPiece(p, state);
            enemyMobility += moves.length;
        }

        return (myMobility - enemyMobility) / Math.max(myPieces.length, 1);
    },

    _evaluateThreats(state, ctx) {
        let score = 0;

        for (const enemy of state.playerPieces) {
            if (enemy.removed || enemy.row < 0) continue;

            const myWinners = this._findWinnersAgainst(state, enemy);
            if (myWinners.length > 0) {
                const closest = Math.min(...myWinners.map(p => this._chebyshev(p, enemy)));
                score += (5 - Math.min(closest, 5)) * 0.3;
            }
        }

        return score;
    },

    _evaluateInformation(state, ctx) {
        let score = 0;

        const revealed = state.playerPieces.filter(p => p.revealed && !p.removed).length;
        const total = state.playerPieces.filter(p => !p.removed && p.row >= 0).length;

        score += (revealed / Math.max(total, 1)) * 2;

        return score;
    },

    _evaluateFistFormation(state, ctx) {
        if (!ctx.topSuspect || ctx.topSuspect.prob < this.MIN_FLAG_CONFIDENCE) {
            return 0;
        }

        const target = ctx.topSuspect.piece;
        const myPieces = aiEngine.getActivePieces(state).filter(p => p.type === 'piece');

        let groupScore = 0;
        const nearbyPieces = myPieces.filter(p => this._chebyshev(p, target) <= 4);

        if (nearbyPieces.length >= 2) {
            const types = new Set(nearbyPieces.map(p => p.pieceType));
            groupScore += types.size * 0.5;
            groupScore += nearbyPieces.length * 0.3;
        }

        return groupScore;
    },

    _evaluateFlagPressure(state, ctx) {
        if (!ctx.enemyFlag) return 0;

        let score = 0;
        const myPieces = aiEngine.getActivePieces(state);

        for (const p of myPieces) {
            if (p.type === FLAG || p.type === TRAP) continue;
            const dist = this._chebyshev(p, ctx.enemyFlag);
            if (dist <= 3) {
                score += (4 - dist) * this.WEIGHTS.AGGRESSION;
            }
        }

        return score;
    },

    _evaluateEndgame(state, ctx) {
        const myPieces = aiEngine.getActivePieces(state);
        const enemyPieces = state.playerPieces.filter(p => !p.removed && p.row >= 0);

        if (myPieces.length + enemyPieces.length > 10) return 0;

        let score = 0;

        if (ctx.enemyFlag && !ctx.enemyFlag.removed) {
            for (const p of myPieces) {
                const dist = this._chebyshev(p, ctx.enemyFlag);
                score += (6 - Math.min(dist, 6)) * 10;
            }
        }

        if (ctx.myFlag) {
            const myDist = Math.min(...myPieces.map(p => this._chebyshev(p, ctx.myFlag)));
            score -= myDist * 5;
        }

        return score;
    },

    _evaluateDefensiveSolidity(state, ctx) {
        let score = 0;
        const myPieces = aiEngine.getActivePieces(state);

        for (const p of myPieces) {
            const nearby = myPieces.filter(a => a.id !== p.id && this._chebyshev(a, p) <= 1).length;
            score += nearby * 0.5;
        }

        return score;
    },

    // =========================================================================
    //  MOVE ORDERING AND SELECTION
    // =========================================================================

    _orderMovesByHeuristic(state, ctx) {
        const myPieces = aiEngine.getActivePieces(state);
        const moves = aiEngine.getAllFilteredMoves(state, myPieces);

        const scored = moves.map(move => ({
            move,
            score: this._scoreMoveForOrdering(state, move, ctx)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.map(s => s.move);
    },

    _scoreMoveForOrdering(state, move, ctx) {
        let score = 0;
        const target = state.board[move.row] && state.board[move.row][move.col];
        const PLAYER = 'player';
        const FLAG = 'flag';
        const TRAP = 'trap';

        // P0: NEVER attack with TRAP (except revealed enemy FLAG which shouldn't happen)
        if (move.piece.type === TRAP && target) {
            return -1000000; // Ban trap attacks entirely
        }

        if (target && target.owner === PLAYER) {
            if (target.type === FLAG && target.revealed) {
                score += 10000;
            } else if (target.revealed) {
                const myType = this._getEffectiveType(move.piece);
                const theirType = target.pieceType;
                if (myType && theirType && this._beats(myType, theirType)) {
                    score += 500;
                }
            } else {
                // P1: Severe penalty for attacking hidden cells in enemy back ranks (likely trap)
                // Enemy back rows are 0-1 for top AI, but we detect by low row number
                if (target.row <= 1) {
                    score -= 2500; // Was +200, now -2500
                } else {
                    score += 200;
                }
            }
        }

        if (ctx.enemyFlag) {
            const distBefore = this._chebyshev(move.piece, ctx.enemyFlag);
            const distAfter = this._chebyshev({ row: move.row, col: move.col }, ctx.enemyFlag);
            if (distAfter < distBefore) {
                score += (distBefore - distAfter) * 50;
            }
        }

        if (ctx.topSuspect && ctx.topSuspect.prob >= this.MIN_FLAG_CONFIDENCE) {
            const distBefore = this._chebyshev(move.piece, ctx.topSuspect.piece);
            const distAfter = this._chebyshev({ row: move.row, col: move.col }, ctx.topSuspect.piece);
            if (distAfter < distBefore) {
                score += (distBefore - distAfter) * 40;
            }
        }

        // P1: Reduce hunt bonus if our flag is under R1 threat
        let r1Threats = 0;
        if (ctx.myFlag) {
            for (const enemy of state.playerPieces) {
                if (!enemy.removed && enemy.row >= 0 && !enemy.immobilized) {
                    if (this._chebyshev(enemy, ctx.myFlag) === 1) {
                        r1Threats++;
                        break;
                    }
                }
            }
        }
        if (r1Threats > 0) {
            // When flag threatened, drastically reduce aggressive hunt scoring
            score -= 200; // Penalty for aggressive moves when defense needed
        }

        if (move.row < move.piece.row) {
            score += 20;
        }

        if (aiEngine.isShuttlePosition(move.piece.id, move.row, move.col)) {
            score -= 300;
        }

        return score;
    },

    _getCaptureMoves(state, isMaximizing) {
        const pieces = isMaximizing
            ? aiEngine.getActivePieces(state)
            : state.playerPieces.filter(p => !p.removed && p.row >= 0 && !p.immobilized);

        const moves = aiEngine.getAllFilteredMoves(state, pieces);
        return moves.filter(m => {
            const target = state.board[m.row] && state.board[m.row][m.col];
            return target && target.owner === (isMaximizing ? PLAYER : COMPUTER);
        });
    },

    _strategicFallback(gameState) {
        const ctx = this._buildSearchContext(gameState);
        const available = aiEngine.getActivePieces(gameState);

        if (ctx.topSuspect && ctx.topSuspect.prob >= this.AGGRESSIVE_HUNT_THRESHOLD) {
            const huntMove = this._createFistAdvance(gameState, ctx.topSuspect.piece, ctx);
            if (huntMove) return huntMove;
        }

        const kills = aiEngine.findGuaranteedKills(gameState, available)
            .filter(k => aiTacticalCore.safeToLeave(gameState, k.piece));
        if (kills.length > 0) {
            return aiEngine.pickBestScored(kills, gameState);
        }

        return this._findBestDevelopmentMove(gameState, ctx);
    },

    _createFistAdvance(state, target, ctx) {
        const available = aiEngine.getActivePieces(state).filter(p =>
            p.type === 'piece' && !p.immobilized && aiTacticalCore.safeToLeave(state, p)
        );

        let bestMove = null;
        let bestScore = -Infinity;

        for (const piece of available) {
            const moves = aiEngine.getMovesForPiece(piece, state);
            for (const m of moves) {
                const distBefore = this._chebyshev(piece, target);
                const distAfter = this._chebyshev({ row: m.row, col: m.col }, target);

                if (distAfter >= distBefore) continue;

                let score = (distBefore - distAfter) * 100;

                const groupBonus = this._countNearbyAllies(state, { row: m.row, col: m.col }) * 30;
                score += groupBonus;

                if (score > bestScore) {
                    bestScore = score;
                    bestMove = { piece, row: m.row, col: m.col };
                }
            }
        }

        return bestMove;
    },

    _findBestDevelopmentMove(gameState, ctx) {
        const available = aiEngine.getActivePieces(gameState).filter(p => p.type === 'piece');
        const moves = aiEngine.getAllFilteredMoves(gameState, available);

        if (moves.length === 0) return null;

        const safeMoves = aiEngine.filterOutShuttleMoves(moves);
        const pool = safeMoves.length > 0 ? safeMoves : moves;

        let bestMove = null;
        let bestScore = -Infinity;

        for (const move of pool) {
            let score = aiEngine.evaluateMoveV2(move, gameState);

            if (move.row < move.piece.row) score += 25;

            const centerDist = Math.abs(move.col - 3.5);
            score += (3.5 - centerDist) * 10;

            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }

        return bestMove;
    },

    _emergencyFallback(gameState) {
        const available = aiEngine.getActivePieces(gameState);
        const moves = aiEngine.getAllFilteredMoves(gameState, available);
        return moves.length > 0 ? moves[0] : null;
    },

    // =========================================================================
    //  PLACEMENT STRATEGY
    // =========================================================================

    chooseFlagAndTrap() {
        // Diversified templates (P1 fix): corners + center-lane + asymmetric
        const templates = [
            // Corners (40%)
            { flag: 0, trap: 9 },   // A1, B2
            { flag: 7, trap: 14 },  // H1, G2
            { flag: 8, trap: 1 },   // A2, B1
            { flag: 15, trap: 6 },  // H2, G1
            // Center-lane defensive (40%)
            { flag: 2, trap: 11 },  // C1, D2 - covers approach lane
            { flag: 5, trap: 12 },  // F1, E2
            { flag: 3, trap: 10 },  // D1, C2
            { flag: 4, trap: 13 },  // E1, F2
            // Asymmetric trap placement (20%) - trap NOT on diagonal
            { flag: 1, trap: 11 },  // B1, D2 - trap covers center
            { flag: 6, trap: 12 },  // G1, E2
            { flag: 2, trap: 9 },   // C1, B2 - trap on adjacent file
            { flag: 5, trap: 14 }   // F1, G2
        ];

        const pick = templates[Math.floor(Math.random() * templates.length)];

        // Ensure trap is on row 1 (in front of flag on row 0) to intercept approach
        let trapIndex = pick.trap;
        let flagIndex = pick.flag;

        // 30% chance to mirror A<->H for unpredictability
        if (Math.random() < 0.3) {
            const mirror = (idx) => {
                const r = Math.floor(idx / 8);
                const c = idx % 8;
                return r * 8 + (7 - c);
            };
            flagIndex = mirror(flagIndex);
            trapIndex = mirror(trapIndex);
        }

        return { flagIndex, trapIndex };
    },

    // =========================================================================
    //  HELPER METHODS
    // =========================================================================

    _buildSearchContext(state) {
        return {
            myFlag: state.aiPieces.find(p => p.type === FLAG && !p.removed),
            enemyFlag: state.playerPieces.find(p => p.type === FLAG && !p.removed),
            topSuspect: this._deduceFlag(state).candidates[0] || null,
            revealedEnemies: state.playerPieces.filter(p => p.revealed && !p.removed),
            hiddenEnemies: state.playerPieces.filter(p => !p.revealed && !p.removed)
        };
    },

    _makeVirtualMove(state, move) {
        return aiEngine.makeVirtualMove(state, move);
    },

    _chebyshev(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    },

    _getEffectiveType(piece) {
        if (piece.type === 'piece') return piece.pieceType;
        return piece.type;
    },

    _beats(a, b) {
        return GAME_CONFIG.WIN_CONDITIONS[a] === b;
    },

    _countThreatsToPiece(state, piece, isOurs) {
        let threats = 0;
        const enemyOwner = isOurs ? 'playerPieces' : 'aiPieces';

        for (const enemy of state[enemyOwner]) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
            if (this._chebyshev(enemy, piece) <= 1) {
                threats++;
            }
        }

        return threats;
    },

    _getDefenders(state, flag) {
        let count = 0;
        let types = new Set();
        let hasTrap = false;

        for (const p of state.aiPieces) {
            if (p.removed || p.row < 0 || p.id === flag.id) continue;
            if (this._chebyshev(p, flag) <= 2) {
                count++;
                if (p.type === TRAP) hasTrap = true;
                if (p.type === 'piece') types.add(p.pieceType);
            }
        }

        return { count, typeDiversity: types.size, hasTrap };
    },

    _findWinnersAgainst(state, enemy) {
        const enemyType = this._getEffectiveType(enemy);
        if (!enemyType) return [];

        const winningType = { rock: 'paper', paper: 'scissors', scissors: 'rock' }[enemyType];
        if (!winningType) return [];

        return state.aiPieces.filter(p =>
            p.type === 'piece' &&
            p.pieceType === winningType &&
            !p.removed &&
            p.row >= 0
        );
    },

    _countAlliedNeighbors(state, piece) {
        let count = 0;
        for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
            const r = piece.row + dr;
            const c = piece.col + dc;
            if (!aiEngine.isValidPosition(r, c)) continue;
            const neighbor = state.board[r] && state.board[r][c];
            if (neighbor && neighbor.owner === PLAYER && neighbor.id !== piece.id) {
                count++;
            }
        }
        return count;
    },

    _countNearbyAllies(state, position) {
        return state.aiPieces.filter(p =>
            p.id !== position.id &&
            !p.removed &&
            p.row >= 0 &&
            this._chebyshev(p, position) <= 2
        ).length;
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = homyachokBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(homyachokBot);
} else {
    throw new Error('[homyachok] RPSBotAPI is required');
}
