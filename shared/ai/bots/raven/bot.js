/**
 * 🐦‍⬛ Ворон — Grok's Original Strategic Bot (v3 Hardened)
 *
 * "The Raven's Gaze" — cynical, calculating, deeply positional.
 *
 * Design Philosophy (unchanged):
 *   - Extreme respect for Flag safety.
 *   - Patient observation + selective, coordinated aggression ("fist").
 *   - Heavy use of positional pressure and piece safety.
 *   - Custom multi-factor evaluation + search.
 *
 * v3 fixes (why it was 15th and losing 24/38 mostly by flag capture):
 *   - Added explicit post-mandatory defense/capture/guaranteed-kill chain (P0).
 *   - Fixed completely broken custom search (_makeVirtualMove was undefined → always fell back).
 *   - Replaced ultra-predictable corner-only placement with 18 diversified templates + mirror.
 *   - Cleaned up duplicate dead _ravenChooseMove code.
 *   - Stronger integration with shared aiEngine tactics and aiBeliefs.
 *
 * The personality remains "cynical & calculating" — it just finally executes its own philosophy.
 */

const ravenBot = {
    id: 'raven',
    name: 'Ворон',
    emoji: '🐦‍⬛',
    avatar: 'js/bots/raven/avatar-min.png',
    shortDescription: 'Глубокая позиционная стратегия',
    longDescription: 'Кулак и давление на флаг при уверенности. Свои фигуры защищает жёстко.',
    algorithmLabel: 'Цепочка защиты + глубокий поиск',
    tier: 'medium',
    stars: 2,
    difficultyLabel: 'Средний',
    tags: ['search', 'coordinated', 'ruthless', 'original'],

    // === Internal tuning constants (Raven personality) ===
    FLAG_DEFENSE_RADIUS: 3,
    HIGH_THREAT_RADIUS: 2,
    HUNT_PROBABILITY_THRESHOLD: 0.62,
    MAX_RISK_TOLERANCE: 0.35,

    // Aggressive Fist mode thresholds
    AGGRESSIVE_FIST_CONFIDENCE: 0.68,   // When we switch to serious "go for the flag" mode
    FIST_ATTACK_BONUS: 95,              // Extra score for moving toward suspected flag in fist mode

    // === State ===
    _ravenTurn: 0,
    _lastEnemyMoves: [],

    // === Lightweight Beliefs System for Hidden Pieces ===
    // pieceId -> { rock, paper, scissors, updatedTurn }
    _enemyBeliefs: new Map(),

    move(gameState) {
        try {
            this._ravenTurn++;

            // 1. Clear caches
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);

            // Initialize beliefs on first move
            this._initBeliefsIfNeeded(gameState);

            // 2. Always respect hard tactical requirements first (via shared core)
            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: this._deduceEnemyFlag.bind(this),
                flagHuntHorizon: 4,
                antiCluster: true
            });
            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            // P0 — Explicit second-line tactical shield (the critical missing piece)
            // Even if mandatory returned null, we still explicitly check the engine helpers.
            // This is what separates 18-37% bots from the 70-85% champions (owl/gemini).
            if (typeof aiEngine !== 'undefined' && aiEngine) {
                const available = (typeof aiEngine.getActivePieces === 'function')
                    ? aiEngine.getActivePieces(gameState)
                    : gameState.aiPieces.filter(p => !p.removed && p.row >= 0 && !p.immobilized);

                // 2.1 Capture enemy flag if reachable
                if (typeof aiEngine.findFlagCaptureMoves === 'function') {
                    const captures = aiEngine.findFlagCaptureMoves(gameState, available);
                    if (captures && captures.length > 0) {
                        const picked = (typeof aiEngine.pickBestScored === 'function')
                            ? aiEngine.pickBestScored(captures, gameState) : captures[0];
                        if (picked && picked.piece) {
                            aiEngine.recordAIMove(picked);
                            return picked;
                        }
                    }
                }

                // 2.2 Direct + preemptive flag defence (block paths, counter threats)
                if (typeof aiEngine.findFlagDefenseMoves === 'function') {
                    const defense = aiEngine.findFlagDefenseMoves(gameState, available);
                    if (defense && defense.length > 0) {
                        const picked = (typeof aiEngine.pickBestScored === 'function')
                            ? aiEngine.pickBestScored(defense, gameState) : defense[0];
                        if (picked && picked.piece) {
                            aiEngine.recordAIMove(picked);
                            return picked;
                        }
                    }
                }

                // 2.3 Guaranteed kills on revealed winning matchups (only safe ones)
                if (typeof aiEngine.findGuaranteedKills === 'function') {
                    const guaranteed = aiEngine.findGuaranteedKills(gameState, available);
                    if (guaranteed && guaranteed.length > 0) {
                        const picked = (typeof aiEngine.pickBestScored === 'function')
                            ? aiEngine.pickBestScored(guaranteed, gameState) : guaranteed[0];
                        if (picked && picked.piece) {
                            aiEngine.recordAIMove(picked);
                            return picked;
                        }
                    }
                }
            }

            // 3. Run Raven's own decision process (search + cynical evaluation)
            const move = this._ravenChooseMove(gameState);
            if (move) {
                aiEngine.recordAIMove(move);
            }
            return move;

        } catch (error) {
            console.error('[raven] move() failed:', error);
            // Safe fallback to a decent existing picker
            return this._safeFallbackMove(gameState);
        }
    },

    // NOTE: Old heuristic _ravenChooseMove + _findAggressiveFistAdvance were removed
    // (they were dead code after the search upgrade and contained the broken search path).
    // The live decision logic now lives in the second _ravenChooseMove below.

    _buildRavenContext(state, myActive, candidateMoves) {
        const myFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        const enemyFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);

        const revealedEnemies = state.playerPieces.filter(p =>
            p.revealed && !p.removed && p.row >= 0 && !p.immobilized
        );

        const hiddenEnemies = state.playerPieces.filter(p =>
            !p.revealed && !p.removed && p.row >= 0 && !p.immobilized
        );

        const myRevealed = state.aiPieces.filter(p =>
            p.revealed && !p.removed && p.row >= 0 && !p.immobilized
        );

        const flagThreats = this._findDirectFlagThreats(state, myFlag);

        const deduction = this._deduceEnemyFlag(state);

        return {
            myFlag,
            enemyFlag,
            revealedEnemies,
            hiddenEnemies,
            myRevealed,
            flagThreats,
            deduction,
            turn: this._ravenTurn,
            myPieceCount: myActive.length,
            enemyPieceCount: hiddenEnemies.length + revealedEnemies.length
        };
    },

    // =====================================================
    //  SEARCH + EVALUATION (Major upgrade path)
    // =====================================================

    /**
     * Main entry for move selection. Now uses search with a strong custom evaluation.
     */
    _ravenChooseMove(gameState) {
        const myPieces = aiEngine.getActivePieces(gameState);
        if (myPieces.length === 0) return null;

        const allMoves = aiEngine.getAllFilteredMoves(gameState, myPieces);
        if (allMoves.length === 0) return null;

        const safeMoves = aiEngine.filterOutShuttleMoves(allMoves);
        const ctx = this._buildRavenContext(gameState, myPieces, safeMoves);

        // Use iterative deepening alpha-beta when time allows
        const { move: searchMove } = this._iterativeDeepeningSearch(gameState, ctx);

        if (searchMove) {
            return searchMove;
        }

        // Fallback to pure heuristic (old behavior)
        let bestMove = null;
        let bestScore = -Infinity;

        for (const moveData of safeMoves) {
            const score = this._evaluateRavenMove(moveData, gameState, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestMove = moveData;
            }
        }

        if (!bestMove || bestScore < -800) {
            return this._findBestDefensivePosture(gameState, myPieces);
        }

        return bestMove;
    },

    _iterativeDeepeningSearch(gameState, ctx) {
        const myPieces = aiEngine.getActivePieces(gameState);
        if (myPieces.length === 0) return { move: null, score: 0 };

        const timeLimit = (ctx.enemyPieceCount <= 7) ? 4200 : 2800;
        const startTime = Date.now();

        let bestMove = null;
        let bestScore = -Infinity;

        const maxDepth = (ctx.enemyPieceCount <= 7) ? 6 : 5;

        for (let depth = 2; depth <= maxDepth; depth++) {
            if (Date.now() - startTime > timeLimit) break;

            try {
                const { move, score } = this._alphaBetaRoot(gameState, depth, startTime, timeLimit);
                if (move) {
                    bestMove = move;
                    bestScore = score;
                }
            } catch (e) {
                break;
            }
        }

        return { move: bestMove, score: bestScore };
    },

    _alphaBetaRoot(state, depth, startTime, timeLimit) {
        const moves = aiEngine.getAllFilteredMoves(state, aiEngine.getActivePieces(state));
        if (moves.length === 0) return { move: null, score: 0 };

        let bestMove = null;
        let bestScore = -Infinity;

        const orderedMoves = this._orderMoves(moves, state);

        for (const m of orderedMoves) {
            if (Date.now() - startTime > timeLimit) break;

            const newState = this._makeVirtualMove(state, m);
            const score = -this._alphaBeta(newState, depth - 1, -Infinity, Infinity, false, startTime, timeLimit);

            if (score > bestScore) {
                bestScore = score;
                bestMove = m;
            }
        }

        return { move: bestMove, score: bestScore };
    },

    _alphaBeta(state, depth, alpha, beta, isMaximizing, startTime, timeLimit) {
        if (Date.now() - startTime > timeLimit) {
            return this._quickEvaluate(state);
        }

        if (depth === 0) {
            return this._evaluatePosition(state);
        }

        const pieces = isMaximizing 
            ? aiEngine.getActivePieces(state) 
            : state.playerPieces.filter(p => !p.removed && p.row >= 0 && !p.immobilized);

        const moves = aiEngine.getAllFilteredMoves(state, pieces);
        if (moves.length === 0) {
            return isMaximizing ? -99999 : 99999;
        }

        const ordered = this._orderMoves(moves, state);

        if (isMaximizing) {
            let value = -Infinity;
            for (const m of ordered) {
                if (Date.now() - startTime > timeLimit) break;
                const newState = this._makeVirtualMove(state, m);
                value = Math.max(value, -this._alphaBeta(newState, depth - 1, -beta, -alpha, false, startTime, timeLimit));
                alpha = Math.max(alpha, value);
                if (alpha >= beta) break;
            }
            return value;
        } else {
            let value = Infinity;
            for (const m of ordered) {
                if (Date.now() - startTime > timeLimit) break;
                const newState = this._makeVirtualMove(state, m);
                value = Math.min(value, -this._alphaBeta(newState, depth - 1, -beta, -alpha, true, startTime, timeLimit));
                beta = Math.min(beta, value);
                if (alpha >= beta) break;
            }
            return value;
        }
    },

    _orderMoves(moves, state) {
        // Simple ordering: captures first, then by basic heuristic
        return moves.slice().sort((a, b) => {
            const aCapture = state.board[a.row]?.[a.col] ? 1 : 0;
            const bCapture = state.board[b.row]?.[b.col] ? 1 : 0;
            if (aCapture !== bCapture) return bCapture - aCapture;

            const aScore = aiEngine.evaluateMoveV2(a, state);
            const bScore = aiEngine.evaluateMoveV2(b, state);
            return bScore - aScore;
        });
    },

    /**
     * Raven now properly delegates virtual moves to the shared engine.
     * This fixes the critical bug where the entire alpha-beta search was
     * throwing and falling back to weak heuristics.
     */
    _makeVirtualMove(state, move) {
        if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.makeVirtualMove === 'function') {
            try {
                return aiEngine.makeVirtualMove(state, move);
            } catch (e) {
                // fall through to local implementation
            }
        }
        // Minimal safe local clone (rare fallback)
        const newState = JSON.parse(JSON.stringify(state));
        // Rebuild board
        newState.board = [];
        for (let r = 0; r < 6; r++) {
            newState.board[r] = [];
            for (let c = 0; c < 8; c++) newState.board[r][c] = null;
        }
        [...(newState.playerPieces || []), ...(newState.aiPieces || [])].forEach(p => {
            if (!p.removed && p.row >= 0 && p.col >= 0) {
                newState.board[p.row][p.col] = p;
            }
        });

        const piece = newState.board[move.piece.row] && newState.board[move.piece.row][move.piece.col];
        if (!piece) return newState;

        const target = newState.board[move.row] && newState.board[move.row][move.col];

        if (target) {
            if (piece.type === 'flag' && target.owner !== piece.owner) return newState;
            const result = (typeof aiEngine !== 'undefined' && aiEngine.resolveBattle)
                ? aiEngine.resolveBattle(
                    piece.type === 'piece' ? piece.pieceType : piece.type,
                    target.type === 'piece' ? target.pieceType : target.type
                )
                : 'draw';

            if (result === 'win') {
                // remove target
                if (target.owner === 'player') {
                    const idx = newState.playerPieces.findIndex(pp => pp.id === target.id);
                    if (idx >= 0) newState.playerPieces.splice(idx, 1);
                } else {
                    const idx = newState.aiPieces.findIndex(pp => pp.id === target.id);
                    if (idx >= 0) newState.aiPieces.splice(idx, 1);
                }
                newState.board[piece.row][piece.col] = null;
                piece.row = move.row;
                piece.col = move.col;
                newState.board[move.row][move.col] = piece;
            } else if (result === 'lose') {
                // remove piece
                if (piece.owner === 'player') {
                    const idx = newState.playerPieces.findIndex(pp => pp.id === piece.id);
                    if (idx >= 0) newState.playerPieces.splice(idx, 1);
                } else {
                    const idx = newState.aiPieces.findIndex(pp => pp.id === piece.id);
                    if (idx >= 0) newState.aiPieces.splice(idx, 1);
                }
            }
        } else {
            newState.board[piece.row][piece.col] = null;
            piece.row = move.row;
            piece.col = move.col;
            newState.board[move.row][move.col] = piece;
        }
        return newState;
    },

    _evaluatePosition(state) {
        // Strong custom evaluation for Raven - "Cynical & Calculating" version
        let score = 0;

        const myPieces = state.aiPieces.filter(p => !p.removed && p.row >= 0);
        const enemyPieces = state.playerPieces.filter(p => !p.removed && p.row >= 0);

        const myFlag = myPieces.find(p => p.type === FLAG);
        const enemyFlag = enemyPieces.find(p => p.type === FLAG);

        // === 1. EXTREME Flag Safety ===
        if (myFlag) {
            const threats = this._countThreatsToPiece(state, myFlag, true);
            score -= threats * 380; // was 280 → much harsher

            // Heavily reward having defenders near the flag
            let defenderScore = 0;
            for (const p of myPieces) {
                if (p.type === FLAG) continue;
                const d = this._chebyshev(p, myFlag);
                if (d <= 2) {
                    defenderScore += (3 - d) * 70;
                    // Extra bonus if the defender has support
                    if (this._hasRpsSupport(state, p, true)) {
                        defenderScore += 25;
                    }
                }
            }
            score += defenderScore;
        }

        // === 2. RUTHLESS Piece Safety (this was one of the biggest problems) ===
        for (const p of myPieces) {
            if (p.type === FLAG) continue;

            score += 100; // base material

            const threats = this._countThreatsToPiece(state, p, true);

            if (threats > 0) {
                // Very heavy penalty for hanging pieces
                const penalty = threats * 140;

                // Extra penalty if the piece has no support
                if (!this._hasRpsSupport(state, p, true)) {
                    score -= penalty * 1.6; // brutal penalty for unsupported hanging pieces
                } else {
                    score -= penalty;
                }
            }

            // Bonus for well-supported pieces (encourages coordination)
            if (this._hasRpsSupport(state, p, true)) {
                score += 55;
            }
        }

        // Enemy piece safety (we want to create hanging pieces for them)
        for (const p of enemyPieces) {
            if (p.type === FLAG) continue;
            score -= 100;

            const threatsToEnemy = this._countThreatsToPiece(state, p, false);
            if (threatsToEnemy > 0) {
                score += threatsToEnemy * 85;
            }
        }

        // === 3. Flag Pressure (with coordination awareness) ===
        if (enemyFlag) {
            let pressure = 0;
            for (const p of myPieces) {
                if (p.type === FLAG || p.type === TRAP) continue;
                const d = this._chebyshev(p, enemyFlag);
                if (d <= 3) {
                    let piecePressure = (4 - d) * 25;
                    // Bonus if this attacking piece is supported
                    if (this._hasRpsSupport(state, p, true)) {
                        piecePressure *= 1.35;
                    }
                    pressure += piecePressure;
                }
            }
            score += pressure;
        }

        // === 4. Strong Coordination Bonus ===
        score += this._evaluateCoordination(state, true) * 32;
        score -= this._evaluateCoordination(state, false) * 26;

        return score;
    },

    _quickEvaluate(state) {
        // Fast evaluation for deep search
        let score = 0;
        const myPieces = state.aiPieces.filter(p => !p.removed && p.row >= 0);
        const enemyPieces = state.playerPieces.filter(p => !p.removed && p.row >= 0);

        score += myPieces.length * 80;
        score -= enemyPieces.length * 80;

        const myFlag = myPieces.find(p => p.type === FLAG);
        if (myFlag) {
            score -= this._countThreatsToPiece(state, myFlag, true) * 220;
        }

        return score;
    },

    _countThreatsToPiece(state, piece, isOurs) {
        let threats = 0;
        const owner = isOurs ? 'aiPieces' : 'playerPieces';
        const enemyOwner = isOurs ? 'playerPieces' : 'aiPieces';

        for (const enemy of state[enemyOwner]) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
            const d = this._chebyshev(enemy, piece);
            if (d > 1) continue;

            const enemyType = enemy.type === 'piece' ? enemy.pieceType : enemy.type;
            const myType = piece.type === 'piece' ? piece.pieceType : piece.type;

            if (!enemyType || !myType) {
                threats += 0.7;
            } else if (GAME_CONFIG.WIN_CONDITIONS[enemyType] === myType) {
                threats += 1;
            }
        }
        return threats;
    },

    _hasRpsSupport(state, piece, isOurs) {
        if (piece.type !== 'piece') return false;
        const needed = { rock: 'scissors', paper: 'rock', scissors: 'paper' }[piece.pieceType];
        if (!needed) return false;

        const owner = isOurs ? 'aiPieces' : 'playerPieces';
        for (const ally of state[owner]) {
            if (ally.id === piece.id || ally.removed || ally.row < 0) continue;
            if (ally.type === 'piece' && ally.pieceType === needed) {
                const d = this._chebyshev(ally, piece);
                if (d <= 2) return true;
            }
        }
        return false;
    },

    _evaluateCoordination(state, isOurs) {
        let score = 0;
        const pieces = isOurs 
            ? state.aiPieces.filter(p => !p.removed && p.row >= 0 && p.type === 'piece')
            : state.playerPieces.filter(p => !p.removed && p.row >= 0 && p.type === 'piece');

        for (const p of pieces) {
            if (this._hasRpsSupport(state, p, isOurs)) score += 1;
        }
        return score;
    },

    // =====================================================
    //  RAVEN EVALUATION — the heart of the bot (kept as fallback)
    // =====================================================
    _evaluateRavenMove(moveData, state, ctx) {
        const { piece, row, col } = moveData;
        const target = state.board[row] && state.board[row][col];

        let score = 0;

        // === 1. FLAG SAFETY (most important factor) ===
        const myFlag = ctx.myFlag;
        if (myFlag) {
            const distBefore = this._chebyshev(piece, myFlag);
            const distAfter = this._chebyshev({ row, col }, myFlag);

            // Strongly prefer staying close to flag when threatened
            if (ctx.flagThreats.length > 0) {
                if (distAfter < distBefore) score += 280;
                if (distAfter > distBefore + 1) score -= 420; // Very bad to run away
            } else {
                // Normal preference to not abandon the flag completely
                if (distAfter > 4 && distBefore <= 3) score -= 90;
            }
        }

        // === 2. Immediate Combat Outcome ===
        if (target && target.owner === PLAYER) {
            const outcome = this._evaluateCombat(piece, target, state, ctx);
            score += outcome.score;

            // Huge bonus for capturing the actual flag
            if (target.type === FLAG) {
                score += 9500;
            }
        }

        // === 3. Positional Pressure on Suspected Flag ===
        const topSuspect = ctx.deduction.candidates[0];
        if (topSuspect) {
            const distToSuspect = this._chebyshev({ row, col }, topSuspect.piece);
            const approachBonus = Math.max(0, 6 - distToSuspect) * 28;

            // Bonus if we are moving toward the most likely flag location
            if (piece.row <= 2) { // Only forward pieces should hunt
                score += approachBonus;
            }
        }

        // === 4. Custom Raven Evaluation ===
        score += aiEngine.evaluateMoveV2(moveData, state) * 0.65;

        // === 5. Anti-Cluster & Coordination ===
        const clusterPenalty = aiTacticalCore.clusterPenalty(state, piece, { row, col });
        score -= clusterPenalty * 1.4;

        // === 6. Revealed Information Advantage ===
        if (target && target.owner === PLAYER && target.revealed) {
            const myType = this._getEffectiveType(piece);
            const theirType = target.pieceType;
            if (myType && theirType) {
                if (GAME_CONFIG.WIN_CONDITIONS[myType] === theirType) {
                    score += 145; // We are winning the fight
                } else if (GAME_CONFIG.WIN_CONDITIONS[theirType] === myType) {
                    score -= 210; // We are losing — avoid unless desperate
                }
            }
        }

        // === 7. Late Game Precision ===
        if (ctx.enemyPieceCount <= 6) {
            score += this._endgameBonus(moveData, state, ctx);
        }

        // === 8. Don't leave the Flag completely undefended ===
        if (myFlag && this._chebyshev(piece, myFlag) <= 2) {
            score += 35; // slight preference to keep defenders nearby
        }

        // === Интеграция ключевых правил в общую эвристику ===

        // 1. Защита своего флага (сильный компонент)
        if (myFlag) {
            const distBefore = this._chebyshev(piece, myFlag);
            const distAfter = this._chebyshev({ row, col }, myFlag);

            if (ctx.flagThreats.length > 0) {
                // Когда флагу угрожают, приближение к нему ценится очень высоко
                const defenseValue = (distBefore - distAfter) * 95;
                score += defenseValue;

                if (distAfter > distBefore) {
                    score -= 380; // сильный штраф за отдаление от флага под угрозой
                }
            }
        }

        // 2. Съедение открытых фигур (интегрировано в combat scoring выше + дополнительно)
        if (target && target.owner === PLAYER && target.revealed) {
            const myType = this._getEffectiveType(piece);
            const theirType = this._visibleType(target);
            if (myType && theirType && this._beats(myType, theirType)) {
                score += 260; // явный бонус за взятие открытой фигуры
            }
        }

        // 3. Целенаправленность + Координация (очень важно)
        let purpose = 0;

        const highConfidence = ctx.deduction.candidates.length > 0 && ctx.deduction.candidates[0].prob >= 0.60;

        if (ctx.enemyFlag) {
            const dBefore = this._chebyshev(piece, ctx.enemyFlag);
            const dAfter = this._chebyshev({ row, col }, ctx.enemyFlag);
            if (dAfter < dBefore) purpose += 55;
        }

        // === Aggressive Fist Mode when high confidence ===
        const aggressiveFist = highConfidence && topSuspect && topSuspect.prob >= this.AGGRESSIVE_FIST_CONFIDENCE;

        if (highConfidence && topSuspect) {
            const dBefore = this._chebyshev(piece, topSuspect.piece);
            const dAfter = this._chebyshev({ row, col }, topSuspect.piece);

            if (dAfter < dBefore) {
                purpose += this.AGGRESSIVE_FIST_CONFIDENCE ? 95 : 70;
            }

            // Strong penalty for moving away from the target when we are confident
            if (dAfter > dBefore + 1) {
                purpose -= 65;
            }

            // Big bonus for coordinated group movement toward the flag (true fist behavior)
            let nearbyAlliesTowardTarget = 0;
            for (const ally of state.aiPieces) {
                if (ally.id === piece.id || ally.removed || ally.row < 0 || ally.type !== 'piece') continue;

                const allyDBefore = this._chebyshev(ally, topSuspect.piece);
                const allyDCurrent = this._chebyshev({ row: ally.row, col: ally.col }, topSuspect.piece);

                // Count allies that are also reasonably close and moving in the same direction
                if (allyDBefore <= 5 && allyDCurrent <= allyDBefore + 1) {
                    nearbyAlliesTowardTarget++;
                }
            }

            if (nearbyAlliesTowardTarget >= 1) purpose += 45;
            if (nearbyAlliesTowardTarget >= 2) purpose += 40;
            if (nearbyAlliesTowardTarget >= 3) purpose += 25;
        }

        for (const enemy of ctx.revealedEnemies) {
            const dBefore = this._chebyshev(piece, enemy);
            const dAfter = this._chebyshev({ row, col }, enemy);
            if (dAfter < dBefore) {
                purpose += 60;
                break;
            }
        }

        if (piece.row > 1 && row < piece.row) {
            purpose += 20;
        }

        score += purpose;

        // Гораздо более жёсткий штраф за бесцельные ходы
        if (purpose < 25) {
            score -= 220;
        }

        return score;
    },

    _evaluateCombat(attacker, defender, state, ctx) {
        const myType = this._getEffectiveType(attacker);
        const defType = defender.revealed ? defender.pieceType : null;

        if (!myType) {
            return { score: 30, risk: 0.6 };
        }

        if (defender.type === FLAG) {
            return { score: 9999, risk: 0 };
        }
        if (defender.type === TRAP) {
            // Almost never worth hitting a trap unless it's extremely high value
            return { score: -850, risk: 1.0 };
        }

        if (defType) {
            // We know exactly what it is
            if (GAME_CONFIG.WIN_CONDITIONS[myType] === defType) {
                // Very good trade
                return { score: 420, risk: 0.08 };
            }
            if (GAME_CONFIG.WIN_CONDITIONS[defType] === myType) {
                // Bad trade - be very reluctant unless it's for the flag or desperate
                return { score: -480, risk: 0.95 };
            }
            return { score: 40, risk: 0.55 };
        }

        // Unknown — use proper beliefs
        const belief = this._getBeliefForPiece(defender, state);
        let expected = 0;

        expected += (belief.rock || 0.33) * this._rpsScore(myType, 'rock');
        expected += (belief.paper || 0.33) * this._rpsScore(myType, 'paper');
        expected += (belief.scissors || 0.34) * this._rpsScore(myType, 'scissors');

        // Significantly more risk-averse
        const conservativeScore = Math.round(expected * 210);

        return {
            score: conservativeScore,
            risk: expected < -0.1 ? 0.88 : 0.48
        };
    },

    _rpsScore(myType, enemyType) {
        if (myType === enemyType) return 0.1;
        if (GAME_CONFIG.WIN_CONDITIONS[myType] === enemyType) return 1.0;
        return -0.85;
    },

    _getEffectiveType(piece) {
        if (piece.type === 'piece') return piece.pieceType;
        return piece.type;
    },

    // =====================================================
    //  FLAG DEDUCTION (Raven's version — quite paranoid)
    // =====================================================
    _deduceEnemyFlag(state) {
        const hidden = state.playerPieces.filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== TRAP
        );

        if (hidden.length === 0) {
            return { candidates: [], hiddenCount: 0 };
        }
        if (hidden.length === 1) {
            return { candidates: [{ piece: hidden[0], prob: 1 }], hiddenCount: 1 };
        }

        const scores = [];
        let sum = 0;

        for (const piece of hidden) {
            const info = aiEngine.enemyStillness.get(piece.id) || { stillnessScore: 0, hasMovedOnce: false };

            let s = 4;
            s += Math.min(info.stillnessScore, 9) * 11;

            if (info.hasMovedOnce) s -= 22;

            // Back row is extremely suspicious
            if (piece.row >= BOARD_HEIGHT - 1) s += 32;
            else if (piece.row === BOARD_HEIGHT - 2) s += 14;
            else s -= 18;

            // Corners are classic flag spots
            if ((piece.col === 0 || piece.col === BOARD_WIDTH - 1) && piece.row >= BOARD_HEIGHT - 2) {
                s += 19;
            }

            // Isolated pieces are more likely to be the flag
            const alliesAround = this._countAlliedNeighbours(state, piece);
            if (alliesAround <= 1) s += 13;

            s = Math.max(1, s);
            scores.push({ piece, raw: s });
            sum += s;
        }

        const candidates = scores
            .map(s => ({ piece: s.piece, prob: s.raw / sum }))
            .sort((a, b) => b.prob - a.prob);

        return { candidates, hiddenCount: hidden.length };
    },

    _countAlliedNeighbours(state, piece) {
        let count = 0;
        for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
            const r = piece.row + dr;
            const c = piece.col + dc;
            const p = state.board[r] && state.board[r][c];
            if (p && p.owner === PLAYER && p.id !== piece.id) count++;
        }
        return count;
    },

    // =====================================================
    //  HELPERS
    // =====================================================
    _chebyshev(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    },

    _findDirectFlagThreats(state, myFlag) {
        if (!myFlag) return [];
        const threats = [];
        for (const enemy of state.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
            if (this._chebyshev(enemy, myFlag) <= this.HIGH_THREAT_RADIUS) {
                threats.push(enemy);
            }
        }
        return threats;
    },

    // The old simple _getBeliefForPiece has been replaced by the full lightweight beliefs system below.
    // (see _initBeliefs, _updateBeliefsOnBattle, _getBeliefForPiece etc.)

    _endgameBonus(moveData, state, ctx) {
        // When few pieces remain, become much more precise
        let bonus = 0;
        const { piece, row, col } = moveData;

        // In endgame, being close to enemy flag is extremely valuable
        if (ctx.enemyFlag && !ctx.enemyFlag.removed) {
            const d = this._chebyshev({ row, col }, ctx.enemyFlag);
            bonus += (5 - Math.min(d, 5)) * 35;
        }

        // Don't leave your flag alone
        if (ctx.myFlag) {
            const d = this._chebyshev({ row, col }, ctx.myFlag);
            if (d >= 3) bonus -= 120;
        }

        return bonus;
    },

    _findBestDefensivePosture(state, myPieces) {
        const myFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!myFlag) return null;

        let best = null;
        let bestDist = Infinity;

        for (const p of myPieces) {
            if (p.type === FLAG) continue;
            const d = this._chebyshev(p, myFlag);
            if (d < bestDist) {
                bestDist = d;
                best = p;
            }
        }

        if (!best) return null;

        const moves = aiEngine.getMovesForPiece(best, state);
        if (moves.length === 0) return null;

        // Move the closest piece even closer to the flag
        let bestMove = null;
        let bestNewDist = Infinity;

        for (const m of moves) {
            const nd = this._chebyshev(m, myFlag);
            if (nd < bestNewDist) {
                bestNewDist = nd;
                bestMove = { piece: best, row: m.row, col: m.col };
            }
        }
        return bestMove;
    },

    _safeFallbackMove(gameState) {
        const pieces = aiEngine.getActivePieces(gameState);
        const moves = aiEngine.getAllFilteredMoves(gameState, pieces);
        if (moves.length === 0) return null;
        return aiEngine.pickBestScored(moves, gameState) || moves[0];
    },

    // =====================================================
    //  FLAG & TRAP PLACEMENT — very deliberate
    // =====================================================
    chooseFlagAndTrap() {
        // Raven 0.3 placement — deliberately diversified and hard to read.
        // Rejects pure corner predictability that strong bots (gemini, grok_apex, owl)
        // exploit within 15-25 moves. Uses the proven 18-template set + 25% mirror.
        // Still keeps a "cynical" preference for solid defensive structures over wild asymmetry.
        const templates = [
            // Solid defensive (not pure corners)
            { flag: 0, trap: 9 },   // A0 + B1
            { flag: 7, trap: 14 },  // H0 + G1
            { flag: 1, trap: 8 },   // B0 + A1 (compact)
            { flag: 6, trap: 15 },  // G0 + H1

            // Central fortress (much harder to guess)
            { flag: 2, trap: 9 },   // C0 + B1
            { flag: 5, trap: 14 },  // F0 + G1
            { flag: 3, trap: 10 },  // D0 + C1 (very central)
            { flag: 4, trap: 13 },  // E0 + F1

            // Asymmetric (breaks simple diagonal pattern recognition)
            { flag: 0, trap: 13 },  // A0 + F1
            { flag: 1, trap: 14 },  // B0 + G1
            { flag: 2, trap: 15 },  // C0 + H1
            { flag: 7, trap: 8 },   // H0 + A1
            { flag: 6, trap: 9 },   // G0 + B1

            // Forward-shifted traps for better coverage of the 2nd rank
            { flag: 1, trap: 11 },  // B0 + D1
            { flag: 2, trap: 12 },  // C0 + E1
            { flag: 5, trap: 11 },  // F0 + D1
            { flag: 6, trap: 10 },  // G0 + C1

            // One extra "deep" defensive pair
            { flag: 3, trap: 12 }   // D0 + E1
        ];

        let pick = templates[Math.floor(Math.random() * templates.length)];

        // 25% horizontal mirror for extra unpredictability (A↔H)
        if (Math.random() < 0.25) {
            const fRow = Math.floor(pick.flag / 8);
            const fCol = pick.flag % 8;
            const tRow = Math.floor(pick.trap / 8);
            const tCol = pick.trap % 8;
            pick = {
                flag: fRow * 8 + (7 - fCol),
                trap: tRow * 8 + (7 - tCol)
            };
        }

        // Reset any per-game state
        this._ravenTurn = 0;
        this._lastEnemyMoves = [];
        if (this._enemyBeliefs && typeof this._enemyBeliefs.clear === 'function') {
            this._enemyBeliefs.clear();
        }

        return { flagIndex: pick.flag, trapIndex: pick.trap };
    },

    // =====================================================
    //  LIGHTWEIGHT BELIEFS SYSTEM (for hidden piece types)
    // =====================================================

    _initBeliefsIfNeeded(gameState) {
        if (this._enemyBeliefs.size > 0) return;

        this._enemyBeliefs.clear();

        const playerPieces = (gameState.playerPieces || []).filter(p => p.type === 'piece' && !p.removed);

        for (const p of playerPieces) {
            let rock = 0.34, paper = 0.33, scissors = 0.33;

            if (p.row >= 4) {
                paper = 0.37;
                rock = 0.32;
                scissors = 0.31;
            }

            this._enemyBeliefs.set(p.id, {
                rock, paper, scissors,
                updatedTurn: 0
            });
        }
    },

    _updateBeliefOnReveal(pieceId, revealedType) {
        const b = this._enemyBeliefs.get(pieceId);
        if (!b) return;

        const lr = 0.82;
        b.rock *= (1 - lr);
        b.paper *= (1 - lr);
        b.scissors *= (1 - lr);

        if (revealedType === 'rock') b.rock += lr;
        else if (revealedType === 'paper') b.paper += lr;
        else if (revealedType === 'scissors') b.scissors += lr;

        const sum = b.rock + b.paper + b.scissors;
        b.rock /= sum;
        b.paper /= sum;
        b.scissors /= sum;
        b.updatedTurn = this._ravenTurn;
    },

    _getBeliefForPiece(piece, state) {
        // Prefer the global high-quality aiBeliefs when present (used by champions)
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.getProbDistribution === 'function') {
            try {
                const d = aiBeliefs.getProbDistribution(piece.id);
                if (d && (d.rock || d.paper || d.scissors)) {
                    return {
                        rock: d.rock || 0.33,
                        paper: d.paper || 0.33,
                        scissors: d.scissors || 0.33,
                        trap: d.trap || 0,
                        flag: d.flag || 0
                    };
                }
            } catch (e) {}
        }

        this._initBeliefsIfNeeded(state);

        if (!piece || piece.type !== 'piece') {
            return { rock: 0.33, paper: 0.34, scissors: 0.33 };
        }

        if (piece.revealed && piece.pieceType) {
            const t = piece.pieceType;
            return {
                rock: t === 'rock' ? 0.96 : 0.02,
                paper: t === 'paper' ? 0.96 : 0.02,
                scissors: t === 'scissors' ? 0.96 : 0.02
            };
        }

        const b = this._enemyBeliefs.get(piece.id);
        if (!b) {
            return { rock: 0.34, paper: 0.33, scissors: 0.33 };
        }

        // Late game global constraints
        const seen = { rock: 0, paper: 0, scissors: 0 };
        for (const p of (state.playerPieces || [])) {
            if (p.revealed && p.pieceType) seen[p.pieceType]++;
        }

        const totalSeen = seen.rock + seen.paper + seen.scissors;
        if (totalSeen >= 11) {
            const adj = {
                rock: Math.max(0.1, b.rock * Math.max(1, 5 - seen.rock)),
                paper: Math.max(0.1, b.paper * Math.max(1, 5 - seen.paper)),
                scissors: Math.max(0.1, b.scissors * Math.max(1, 4 - seen.scissors))
            };
            const s = adj.rock + adj.paper + adj.scissors;
            return { rock: adj.rock / s, paper: adj.paper / s, scissors: adj.scissors / s };
        }

        return { rock: b.rock, paper: b.paper, scissors: b.scissors };
    },

    _getMostLikelyEnemyType(piece, state) {
        const b = this._getBeliefForPiece(piece, state);
        if (b.rock >= b.paper && b.rock >= b.scissors) return 'rock';
        if (b.paper >= b.rock && b.paper >= b.scissors) return 'paper';
        return 'scissors';
    }
};

// === REGISTRATION ===
if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(ravenBot);
} else {
    throw new Error('[raven] RPSBotAPI.defineBot is required. Make sure bot-api.js is loaded before raven/bot.js');
}