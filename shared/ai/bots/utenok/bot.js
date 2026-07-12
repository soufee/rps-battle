/**
 * Gemini 3.1 PRO
 * 
 * Автор: Gemini 3.1 Pro (Google)
 * 
 * Концепция: Абсолютный чемпионский алгоритм. Использует глубокий PVS (Principal Variation Search)
 * с кэшированием (Transposition Table) и Quiescence-поиском. Параноидально защищает флаг, 
 * математически вычисляет ожидаемую выгоду (EV) каждой атаки на базе байесовских распределений,
 * и формирует тактические "кулаки" (RPS Fists) для синергичного окружения врага.
 * 
 * v3 Update: 
 * - Owl-цепочка приоритетов перед PVS
 * - Фильтрация безнадежных ходов (hopeless attacks) в дереве PVS
 * - Side-aware эвристики продвижения (корректная работа за нижнюю сторону)
 * - Разнообразная расстановка флага и ловушек
 * - Жесткий запрет Trap-атак и усиленная оценка безопасности флага
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[utenok] bot-api.js must be loaded BEFORE this bot');
}

const utenokBot = {
    id: 'utenok',
    name: 'Утёнок',
    emoji: '✨',
    avatar: 'js/bots/utenok/avatar-min.png',
    
    shortDescription: 'ПВС, транспозиция и байесовский EV',
    longDescription: 'ПВС, транспозиция, байес-EV. Слабые ходы отсекает, давит позицию.',
    
    algorithmLabel: 'ПВС + TT + байесовский EV',
    tier: 'easy',
    stars: 1,
    difficultyLabel: 'Лёгкий',
    tags: ['search', 'adaptive', 'ruthless', 'bayesian', 'champion'],

    // === Constants ===
    TIME_BUDGET: 4500, // Search time budget in MS
    TT_SIZE: 50000,

    // === State ===
    _transpositionTable: new Map(),
    _turnCounter: 0,
    _homeRowIsTop: true, // Will be set dynamically

    move(gameState) {
        try {
            this._turnCounter++;
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);

            if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.tick === 'function') {
                aiBeliefs.tick(aiEngine.aiTurnCounter + 1);
            }
            if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.applyConstraints === 'function') {
                aiBeliefs.applyConstraints(gameState);
            }

            // Determine playing side dynamically for side-aware heuristics
            const myFlag = gameState.aiPieces.find(p => p.type === 'flag' && !p.removed);
            if (myFlag) {
                this._homeRowIsTop = myFlag.row <= 2;
            }

            const availablePieces = aiEngine.getActivePieces(gameState);
            if (availablePieces.length === 0) return null;

            // === P0: OWL CHAIN (Tactical overrides before search) ===
            const captures = aiEngine.findFlagCaptureMoves(gameState, availablePieces);
            if (captures.length) {
                const best = aiEngine.pickBestScored(captures, gameState);
                if (best) { aiEngine.recordAIMove(best); return best; }
            }

            const defense = aiEngine.findFlagDefenseMoves(gameState, availablePieces);
            if (defense.length) {
                const best = aiEngine.pickBestScored(defense, gameState);
                if (best) { aiEngine.recordAIMove(best); return best; }
            }

            const guaranteed = aiEngine.findGuaranteedKills(gameState, availablePieces);
            if (guaranteed.length) {
                const best = aiEngine.pickBestScored(guaranteed, gameState);
                if (best) { aiEngine.recordAIMove(best); return best; }
            }

            // Fallback to older mandatory
            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: this._deduceEnemyFlag.bind(this),
                flagHuntHorizon: 4,
                antiCluster: true
            });
            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            // === DEEP SEARCH ===
            const move = this._iterativeDeepeningPVS(gameState);
            if (move) {
                aiEngine.recordAIMove(move);
                return move;
            }

            // === ULTIMATE FALLBACK ===
            // Replaced moveLevel2 with a safe filtered move picker
            const safeMoves = this._getValidFilteredMoves(gameState, 'computer');
            const fallback = aiEngine.pickBestScored(safeMoves, gameState);
            if (fallback) {
                aiEngine.recordAIMove(fallback);
                return fallback;
            }
            return null;

        } catch (error) {
            console.error('[utenok] move() failed:', error);
            // Absolute last resort
            const safeMoves = this._getValidFilteredMoves(gameState, 'computer');
            return safeMoves.length > 0 ? safeMoves[0] : null;
        }
    },

    chooseFlagAndTrap() {
        const rnd = Math.random();
        if (rnd < 0.40) {
            // Corner-strong: Flag A1/H1, Trap B2/G2
            return Math.random() < 0.5 ? { flagIndex: 0, trapIndex: 9 } : { flagIndex: 7, trapIndex: 14 };
        } else if (rnd < 0.80) {
            // Center-lane: Flag D1/E1, Trap C2/F2/D2/E2
            const centers = [
                { flagIndex: 3, trapIndex: 10 },
                { flagIndex: 4, trapIndex: 13 },
                { flagIndex: 3, trapIndex: 11 },
                { flagIndex: 4, trapIndex: 12 }
            ];
            return centers[Math.floor(Math.random() * centers.length)];
        } else {
            // Asymmetric
            const asym = [
                { flagIndex: 1, trapIndex: 12 }, // B1, Trap E2
                { flagIndex: 6, trapIndex: 11 }  // G1, Trap D2
            ];
            return asym[Math.floor(Math.random() * asym.length)];
        }
    },

    // ==========================================================================
    //  DEEP SEARCH (PVS + TT)
    // ==========================================================================
    
    _getValidFilteredMoves(state, owner) {
        const activePieces = state[owner === 'computer' ? 'aiPieces' : 'playerPieces'].filter(p => !p.removed && p.row >= 0 && !p.immobilized);
        let moves;
        if (typeof aiEngine.getAllFilteredMoves === 'function') {
            moves = aiEngine.getAllFilteredMoves(state, activePieces);
        } else {
            moves = aiEngine.getAllPossibleMoves(state, owner);
        }

        // Trap Ban: never allow trap to attack a non-flag piece
        return moves.filter(m => {
            if (m.piece.type === 'trap') {
                const target = state.board[m.row] && state.board[m.row][m.col];
                if (target && target.owner !== m.piece.owner && target.type !== 'flag') return false;
            }
            return true;
        });
    },

    _iterativeDeepeningPVS(gameState) {
        const startTime = Date.now();
        let bestMove = null;
        let bestScore = -Infinity;
        
        const availablePieces = aiEngine.getActivePieces(gameState);
        if (availablePieces.length === 0) return null;

        if (this._turnCounter % 10 === 0) this._transpositionTable.clear();

        for (let depth = 2; depth <= 7; depth++) {
            if (Date.now() - startTime > this.TIME_BUDGET) break;

            const result = this._pvsRoot(gameState, depth, startTime);
            if (result && result.move) {
                bestMove = result.move;
                bestScore = result.score;
                
                if (bestScore > 50000 || bestScore < -50000) break;
            }
        }
        
        // Anti-shuttle filter for the chosen move
        if (bestMove && aiEngine.isShuttlePosition(bestMove.piece.id, bestMove.row, bestMove.col)) {
            const safeMoves = aiEngine.filterOutShuttleMoves(this._getValidFilteredMoves(gameState, 'computer'));
            if (safeMoves.length > 0) {
                let altBest = safeMoves[0];
                let altScore = -Infinity;
                for(const m of safeMoves) {
                    const s = this._quickEvaluateVirtual(gameState, m);
                    if (s > altScore) { altScore = s; altBest = m; }
                }
                return altBest;
            }
        }

        return bestMove;
    },

    _pvsRoot(state, depth, startTime) {
        // P0: Use filtered moves
        const rawMoves = this._getValidFilteredMoves(state, 'computer');
        if (rawMoves.length === 0) return { score: -Infinity, move: null };
        
        const moves = this._orderMoves(rawMoves, state);
        
        let bestMove = null;
        let alpha = -Infinity;
        const beta = Infinity;

        for (let i = 0; i < moves.length; i++) {
            if (Date.now() - startTime > this.TIME_BUDGET) break;

            const move = moves[i];
            const newState = aiEngine.makeVirtualMove(state, move);
            let score;

            if (i === 0) {
                score = -this._pvs(newState, depth - 1, -beta, -alpha, false, startTime);
            } else {
                score = -this._pvs(newState, depth - 1, -alpha - 1, -alpha, false, startTime);
                if (score > alpha && score < beta) {
                    score = -this._pvs(newState, depth - 1, -beta, -score, false, startTime);
                }
            }

            if (score > alpha) {
                alpha = score;
                bestMove = move;
            }
        }

        return { move: bestMove, score: alpha };
    },

    _pvs(state, depth, alpha, beta, isMaximizing, startTime) {
        if (Date.now() - startTime > this.TIME_BUDGET) return this._evaluatePosition(state);
        
        const ttKey = this._hashState(state, isMaximizing);
        const ttEntry = this._transpositionTable.get(ttKey);
        if (ttEntry && ttEntry.depth >= depth) {
            if (ttEntry.flag === 'EXACT') return ttEntry.value;
            if (ttEntry.flag === 'LOWERBOUND' && ttEntry.value >= beta) return ttEntry.value;
            if (ttEntry.flag === 'UPPERBOUND' && ttEntry.value <= alpha) return ttEntry.value;
        }

        if (depth === 0) return this._quiescence(state, alpha, beta, isMaximizing, startTime, 3);

        const owner = isMaximizing ? 'computer' : 'player';
        // P0: Use filtered moves here too
        const rawMoves = this._getValidFilteredMoves(state, owner);
        if (rawMoves.length === 0) return isMaximizing ? -99999 : 99999;

        const moves = this._orderMoves(rawMoves, state);
        let bestValue = -Infinity;
        let originalAlpha = alpha;

        for (let i = 0; i < moves.length; i++) {
            if (Date.now() - startTime > this.TIME_BUDGET) break;
            
            const move = moves[i];
            const newState = aiEngine.makeVirtualMove(state, move);
            let score;

            if (i === 0) {
                score = -this._pvs(newState, depth - 1, -beta, -alpha, !isMaximizing, startTime);
            } else {
                score = -this._pvs(newState, depth - 1, -alpha - 1, -alpha, !isMaximizing, startTime);
                if (score > alpha && score < beta) {
                    score = -this._pvs(newState, depth - 1, -beta, -score, !isMaximizing, startTime);
                }
            }

            bestValue = Math.max(bestValue, score);
            alpha = Math.max(alpha, score);
            if (alpha >= beta) break; 
        }

        if (this._transpositionTable.size < this.TT_SIZE) {
            let flag = 'EXACT';
            if (bestValue <= originalAlpha) flag = 'UPPERBOUND';
            else if (bestValue >= beta) flag = 'LOWERBOUND';
            this._transpositionTable.set(ttKey, { value: bestValue, depth: depth, flag: flag });
        }

        return bestValue;
    },

    _quiescence(state, alpha, beta, isMaximizing, startTime, qDepth) {
        let standPat = this._evaluatePosition(state);
        if (qDepth === 0 || Date.now() - startTime > this.TIME_BUDGET) return standPat;

        if (standPat >= beta) return beta;
        if (alpha < standPat) alpha = standPat;

        const owner = isMaximizing ? 'computer' : 'player';
        const activePieces = state[owner === 'computer' ? 'aiPieces' : 'playerPieces'].filter(p => !p.removed && p.row >= 0 && !p.immobilized);
        
        const myFlag = state[owner === 'computer' ? 'aiPieces' : 'playerPieces'].find(p => p.type === 'flag' && !p.removed);
        const r1Threats = myFlag ? this._countThreatsToPiece(state, myFlag, true) : 0;

        const noisyMoves = [];
        for(const p of activePieces) {
            const moves = aiEngine.getMovesForPiece(p, state);
            for(const m of moves) {
                const t = state.board[m.row] && state.board[m.row][m.col];
                // P2: Defensive moves near own flag in quiescence if threatened
                const isDefensive = (r1Threats > 0 && myFlag && this._chebyshev(m, myFlag) <= 1);
                
                if ((t && t.owner !== owner) || isDefensive) {
                    noisyMoves.push({piece: p, row: m.row, col: m.col});
                }
            }
        }

        if (noisyMoves.length === 0) return standPat;
        const ordered = this._orderMoves(noisyMoves, state);

        for (const move of ordered) {
            const newState = aiEngine.makeVirtualMove(state, move);
            const score = -this._quiescence(newState, -beta, -alpha, !isMaximizing, startTime, qDepth - 1);
            
            if (score >= beta) return beta;
            if (score > alpha) alpha = score;
        }
        return alpha;
    },

    _hashState(state, isMax) {
        let h = isMax ? "1|" : "0|";
        for (const r of state.board) {
            for (const c of r) {
                if (c) {
                    h += `${c.id}:${c.row}:${c.col}|`;
                }
            }
        }
        return h;
    },

    _orderMoves(moves, state) {
        return moves.sort((a, b) => {
            const aTgt = state.board[a.row] && state.board[a.row][a.col];
            const bTgt = state.board[b.row] && state.board[b.row][b.col];
            
            let scoreA = 0;
            let scoreB = 0;

            if (aTgt) scoreA += 1000;
            if (bTgt) scoreB += 1000;

            // P0: Side-aware forward bias
            scoreA += this._getForwardBonus(a.piece, a.row) - this._getForwardBonus(a.piece, a.piece.row);
            scoreB += this._getForwardBonus(b.piece, b.row) - this._getForwardBonus(b.piece, b.piece.row);

            // P2: Penalty for blind attacks in enemy deep territory
            if (aTgt && !aTgt.revealed && this._getForwardBonus(a.piece, a.row) >= 40) scoreA -= 2000;
            if (bTgt && !bTgt.revealed && this._getForwardBonus(b.piece, b.row) >= 40) scoreB -= 2000;

            return scoreB - scoreA;
        });
    },

    // P0: Side-aware heuristic
    _getForwardBonus(piece, row) {
        if (piece.owner === 'computer') {
            return this._homeRowIsTop ? row * 10 : (5 - row) * 10;
        } else {
            return this._homeRowIsTop ? (5 - row) * 10 : row * 10;
        }
    },

    // ==========================================================================
    //  HEURISTIC EVALUATION (THE BRAIN)
    // ==========================================================================
    _evaluatePosition(state) {
        let score = 0;
        
        const myPieces = state.aiPieces.filter(p => !p.removed && p.row >= 0);
        const enemyPieces = state.playerPieces.filter(p => !p.removed && p.row >= 0);
        
        const myFlag = myPieces.find(p => p.type === 'flag');
        const enemyFlag = enemyPieces.find(p => p.type === 'flag');

        if (!myFlag) return -999999;
        if (!enemyFlag && enemyPieces.length > 0) {
            // Flag not explicitly visible
        }

        score += (myPieces.length - enemyPieces.length) * 150;

        if (myFlag) {
            const safetyScore = this._evaluateFlagSafetyParams(state, myFlag, myPieces, enemyPieces);
            score += safetyScore;
        }

        for(const p of myPieces) {
            if (p.type === 'flag' || p.type === 'trap') continue;
            
            // P0: Side-aware forward bonus
            score += this._getForwardBonus(p, p.row);
            
            if (p.col >= 2 && p.col <= 5) score += 15;

            const support = this._calculateSupport(state, p, myPieces);
            score += support * 30;

            const threats = this._countThreatsToPiece(state, p, true);
            if (threats > 0) {
                score -= threats * (support > 0 ? 80 : 180);
            }
        }

        const r1ThreatsToMyFlag = myFlag ? this._countThreatsToPiece(state, myFlag, true) : 0;

        // P1: Disable hunt pressure if R1 threatened
        if (r1ThreatsToMyFlag === 0) {
            const deduction = this._deduceEnemyFlag(state);
            const topSuspect = deduction.candidates[0];
            
            if (topSuspect && topSuspect.prob > 0.4) {
                for(const p of myPieces) {
                    if (p.type === 'flag' || p.type === 'trap') continue;
                    const d = this._chebyshev(p, topSuspect.piece);
                    if (d <= 4) {
                        score += (5 - d) * 35 * topSuspect.prob;
                    }
                    if (d === 2) score += 20 * topSuspect.prob;
                }
            }
        }

        for(const enemy of enemyPieces) {
            if (enemy.type === 'flag') continue;
            score -= 120;
            
            const threats = this._countThreatsToPiece(state, enemy, false);
            if (threats > 0) {
                score += threats * 90;
            }

            for(const myP of myPieces) {
                if (myP.type !== 'piece') continue;
                if (this._chebyshev(myP, enemy) === 1) {
                    score += this._calculateBayesianEV(myP, enemy, state);
                }
            }
        }

        return score;
    },

    _quickEvaluateVirtual(state, move) {
        const newState = aiEngine.makeVirtualMove(state, move);
        return this._evaluatePosition(newState);
    },

    _evaluateFlagSafetyParams(state, myFlag, myPieces, enemyPieces) {
        let score = 0;
        
        const r1Threats = this._countThreatsToPiece(state, myFlag, true);
        score -= r1Threats * 50000; // P1: Massive penalty for R1 threat (increased from 1500)

        let looming = 0;
        for(const e of enemyPieces) {
            if (e.type === 'flag') continue;
            const d = this._chebyshev(e, myFlag);
            if (d === 2) looming += 1;
            if (d === 3) looming += 0.5;
        }
        score -= looming * 200;

        let mobileDefenders = 0;
        let hasTrapNear = false;
        for(const p of myPieces) {
            if (p.id === myFlag.id) continue;
            const d = this._chebyshev(p, myFlag);
            if (d <= 2 && !p.immobilized && p.type !== 'trap') {
                mobileDefenders++;
            }
            if (d <= 1 && p.type === 'trap') hasTrapNear = true;
        }
        
        // P1: Naked flag penalty
        if (mobileDefenders === 0) {
            score -= 100000;
        } else {
            score += mobileDefenders * 80;
        }

        if (hasTrapNear) score += 150;

        // Positioning (Side-aware)
        const forwardPos = this._getForwardBonus(myFlag, myFlag.row) / 10;
        if (forwardPos >= 2) score -= forwardPos * 200;
        
        if (myFlag.col === 0 || myFlag.col === 7) score += 30;

        return score;
    },

    _calculateSupport(state, piece, myPieces) {
        if (!piece.pieceType) return 0;
        // Depending on GAME_CONFIG if available, otherwise fallback
        const WIN_CONDS = typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.WIN_CONDITIONS ? 
            GAME_CONFIG.WIN_CONDITIONS : { rock: 'scissors', paper: 'rock', scissors: 'paper' };
        
        // We need a piece that beats what beats us.
        // E.g. we are rock, paper beats us, scissors beats paper. So we need scissors.
        // Interestingly, in RPS, needed = WIN_CONDS[piece.pieceType] is what WE beat.
        // Wait, if we are Rock, we need Scissors nearby to beat Paper? Yes, Scissors beats Paper.
        // So needed = WIN_CONDS[piece.pieceType] (Rock beats Scissors, so needed = Scissors? No, Scissors beats Paper. So if I am Rock, WIN_CONDS['rock'] = 'scissors'. But we need something that beats Paper. What beats Paper? Scissors. So WIN_CONDS['rock'] actually returns 'scissors', which is what we need!).
        const needed = WIN_CONDS[piece.pieceType];
        if (!needed) return 0;

        let supportLevel = 0;
        for (const ally of myPieces) {
            if (ally.id === piece.id || ally.type !== 'piece') continue;
            if (ally.pieceType === needed) {
                const d = this._chebyshev(ally, piece);
                if (d <= 2) supportLevel += (3 - d);
            }
        }
        return supportLevel;
    },

    _countThreatsToPiece(state, piece, isOurs) {
        let threats = 0;
        const enemies = isOurs ? state.playerPieces : state.aiPieces;
        const WIN_CONDS = typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.WIN_CONDITIONS ? 
            GAME_CONFIG.WIN_CONDITIONS : { rock: 'scissors', paper: 'rock', scissors: 'paper' };

        for (const e of enemies) {
            if (e.removed || e.row < 0 || e.immobilized) continue;
            const d = this._chebyshev(e, piece);
            if (d > 1) continue;

            const enemyType = e.type === 'piece' ? e.pieceType : e.type;
            const myType = piece.type === 'piece' ? piece.pieceType : piece.type;

            if (!enemyType || !myType) {
                threats += 0.6;
            } else if (WIN_CONDS[enemyType] === myType) {
                threats += 1;
            }
        }
        return threats;
    },

    _calculateBayesianEV(myPiece, enemyPiece, state) {
        const myType = myPiece.pieceType;
        if (!myType) return 0;
        
        const WIN_CONDS = typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.WIN_CONDITIONS ? 
            GAME_CONFIG.WIN_CONDITIONS : { rock: 'scissors', paper: 'rock', scissors: 'paper' };
            
        if (enemyPiece.revealed && enemyPiece.type === 'piece') {
            if (WIN_CONDS[myType] === enemyPiece.pieceType) return 300;
            if (WIN_CONDS[enemyPiece.pieceType] === myType) return -400;
            return 0;
        }

        if (typeof aiBeliefs === 'undefined' || !aiBeliefs) return 0;
        
        const dist = aiBeliefs.getProbDistribution ? aiBeliefs.getProbDistribution(enemyPiece.id) : null;
        if (!dist) return 0;

        let ev = 0;
        const pRock = dist.rock || 0.3;
        const pPaper = dist.paper || 0.3;
        const pScissors = dist.scissors || 0.3;
        const pTrap = dist.trap || 0.1;
        const pFlag = dist.flag || 0.0;

        ev += pFlag * 5000;
        ev -= pTrap * 1500;

        if (myType === 'rock') {
            ev += pScissors * 250;
            ev -= pPaper * 350;
        } else if (myType === 'paper') {
            ev += pRock * 250;
            ev -= pScissors * 350;
        } else {
            ev += pPaper * 250;
            ev -= pRock * 350;
        }

        return ev;
    },

    _deduceEnemyFlag(state) {
        const hidden = state.playerPieces.filter(p => !p.removed && p.row >= 0 && !p.revealed && p.type !== 'trap');
        if (hidden.length === 0) return { candidates: [], hiddenCount: 0 };
        if (hidden.length === 1) return { candidates: [{ piece: hidden[0], prob: 1 }], hiddenCount: 1 };

        let candidates = [];
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && aiBeliefs.getFlagCandidates) {
            candidates = aiBeliefs.getFlagCandidates(state, 5) || [];
        }

        if (candidates.length === 0) {
            for(const h of hidden) {
                const forward = this._getForwardBonus(h, h.row) / 10;
                let score = forward <= 1 ? 0.8 : 0.2; // Enemy's backline is our forward >= 4
                candidates.push({piece: h, pFlag: score});
            }
        }

        return { 
            candidates: candidates.map(c => ({piece: c.piece || c, prob: c.pFlag || 0.5})).sort((a,b)=>b.prob-a.prob),
            hiddenCount: hidden.length
        };
    },

    _chebyshev(p1, p2) {
        return Math.max(Math.abs(p1.row - p2.row), Math.abs(p1.col - p2.col));
    }
};

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(utenokBot);
} else {
    throw new Error('[utenok] RPSBotAPI is required');
}
