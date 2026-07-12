/**
 * 🐰 Rabbit — reactive heuristic bot.
 *
 * Playstyle: no deep search, no probabilistic beliefs. Follows a strict
 * priority stack (mandatory tactical → defend flag → capture flag →
 * guaranteed kill → corridor trap → best heuristic move) and relies on
 * evaluateMoveV2 for scoring.
 *
 * Key improvements (season 3):
 *   - aiTacticalCore.getMandatoryMove at the top of the stack.
 *   - Fixed _filterDefenseInvariant: never falls back to unsafe moves.
 *   - PANIC mode: disables corridor/kills when flag is pressured.
 *   - 1-ply virtual safety filter on top candidates.
 *   - Extended proactive defense to range 3.
 *   - Defense-first tie-break when flag is threatened.
 *   - 12+ placement templates.
 *   - flagShieldScore in evaluation (−500 per enemy dist≤2 to flag).
 *
 * This bot is certified via RPSBotAPI (see bot-api.js). The base rules
 * (RPS resolution, legal movement, flag/trap contract) are imported and
 * enforced at defineBot() time.
 */

// === MANDATORY: bot-api contract check (prevents loading without the base rulebook)
if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[rabbit] FATAL: bot-api.js must be loaded BEFORE this bot module.');
}
if (typeof RPSBotAPI === 'undefined' && typeof window !== 'undefined') {
    // Will be caught later by defineBot guard anyway
}

const rabbitConfig = {
    defense: {
        minDefenders: 2,
        minTypeCount: 2,
        dangerRange: 3,
        panicRange: 1
    },
    risk: {
        trapFlagThreshold: 0.35,
        stillnessThreshold: 4
    },
    placement: {
        backRowWeight: 0.55
    }
};

const rabbitBot = {
    id: 'rabbit',
    name: 'Заяц',
    emoji: '🐰',
    avatar: 'js/bots/rabbit/avatar-min.png',
    shortDescription: 'Реактивная эвристика',
    longDescription: 'Защищает флаг, бьёт по открытым целям. Без расчёта на несколько ходов вперёд.',
    algorithmLabel: 'Реактивная эвристика',
    tier: 'easy',
    stars: 1,
    difficultyLabel: 'Лёгкий',
    tags: ['beginner'],
    
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
            console.error('[rabbit] move() failed:', error);
            return null;
        }
    },
    
    _pickMove(gameState) {
        const availablePieces = aiEngine.getActivePieces(gameState);
        if (availablePieces.length === 0) {
            return null;
        }

        // P0: Mandatory tactical move FIRST (capture flag, defend flag, hunt)
        const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
            deducer: (gs) => this._deduceEnemyFlag(gs),
            flagHuntHorizon: 2,
            antiCluster: true
        });
        if (mandatory) {
            return mandatory;
        }
        
        // Assess PANIC state: enemies within panicRange of our flag
        const panicThreats = this._getFlagThreats(gameState, rabbitConfig.defense.panicRange);
        const isPanic = panicThreats.length > 0;
        
        // 1. Critical flag defense (threat in range 1)
        const smartFlagDefense = this._findSmartFlagDefense(gameState, availablePieces);
        const smartFlagDefensePool = this._filterDefenseInvariant(smartFlagDefense, gameState);
        if (smartFlagDefensePool.length > 0) {
            return this._pickBestRabbitScored(smartFlagDefensePool, gameState);
        }
        
        // 2. Guaranteed enemy flag capture
        const flagCapture = aiEngine.findFlagCaptureMoves(gameState, availablePieces);
        if (flagCapture.length > 0) {
            return aiEngine.pickRandom(flagCapture);
        }

        // P0.5: Draw-pressure desperation — force an exchange when a draw looms.
        // Must sit ABOVE the defensive branches (engine flag defense, rescue,
        // proactive defense, corridor): those keep returning timid shuffles that
        // never capture, so the no-capture counter runs out to a draw. Immediate
        // range-1 flag defense (branch 1) already ran, so overriding the softer
        // defensive layers here is safe. Skipped when the bot is losing (a draw
        // is a good outcome then) or when no capturing move exists.
        const drawRatio = this._drawPressureRatio(gameState);
        if (drawRatio >= 0.75
            && !aiEngine.isLosingPosition(gameState)) {
            const engageMove = this._findDrawPressureAttack(gameState, availablePieces);
            if (engageMove) {
                return engageMove;
            }
        }

        // 3. Engine-level flag defense (broader coverage)
        const engineFlagDefense = aiEngine.findFlagDefenseMoves(gameState, availablePieces);
        if (engineFlagDefense.length > 0) {
            const filtered = this._filterDefenseInvariant(engineFlagDefense, gameState);
            if (filtered.length > 0) {
                return this._pickBestRabbitScored(filtered, gameState);
            }
        }
        
        // P0 PANIC: skip corridor and aggressive kills when flag is pressured
        if (!isPanic) {
            // 4. Guaranteed kills (only when NOT in panic)
            const guaranteedKills = aiEngine.findGuaranteedKills(gameState, availablePieces);
            const guaranteedKillPool = this._filterDefenseInvariant(guaranteedKills, gameState);
            if (guaranteedKillPool.length > 0) {
                return this._pickBestRabbitScored(guaranteedKillPool, gameState);
            }
        }
        
        // 5. Rescue endangered revealed pieces
        const rescueMoves = this._findOpenPieceRescueMoves(gameState, availablePieces);
        const rescuePool = this._filterDefenseInvariant(rescueMoves, gameState);
        if (rescuePool.length > 0) {
            return this._pickBestRabbitScored(rescuePool, gameState);
        }
        
        // 6. Proactive flag defense (threat in range 3)
        const proactiveFlagDefense = this._findProactiveFlagDefense(gameState, availablePieces);
        const proactivePool = this._filterDefenseInvariant(proactiveFlagDefense, gameState);
        if (proactivePool.length > 0) {
            return this._pickBestRabbitScored(proactivePool, gameState);
        }
        
        // 7. Death corridor (only when NOT in panic)
        if (!isPanic) {
            const corridorMove = aiEngine.tryDeathCorridor(gameState);
            if (corridorMove) {
                return corridorMove;
            }
        }
        
        // 8. Positional move with safety filters
        const allMoves = aiEngine.getAllFilteredMoves(gameState, availablePieces);
        if (allMoves.length === 0) {
            return null;
        }
        
        const movesPool = aiEngine.filterOutShuttleMoves(allMoves);
        const defensePool = this._filterDefenseInvariant(movesPool, gameState);
        const safetyPool = this._filterRiskyAttacks(
            defensePool.length > 0 ? defensePool : movesPool,
            gameState
        );
        const preFilterPool = safetyPool.length > 0 ? safetyPool : movesPool;
        
        // P1: 1-ply virtual safety filter on top-10 candidates
        const candidatePool = this._applySafetyFilter(preFilterPool, gameState);
        const finalPool = candidatePool.length > 0 ? candidatePool : movesPool;
        
        let bestMove = null;
        let bestScore = -Infinity;
        for (const moveData of finalPool) {
            const score = this._evaluateRabbitMove(moveData, gameState);
            if (score > bestScore) {
                bestScore = score;
                bestMove = moveData;
            }
        }
        
        return bestMove;
    },
    
    // === P1: 1-ply virtual safety filter ===
    
    _applySafetyFilter(moves, gameState) {
        if (!moves || moves.length <= 1) {
            return moves;
        }
        
        const aiFlag = this._getAiFlag(gameState);
        if (!aiFlag) {
            return moves;
        }
        
        const scored = [];
        for (const m of moves) {
            scored.push({ move: m, score: this._evaluateRabbitMove(m, gameState) });
        }
        scored.sort((a, b) => b.score - a.score);
        
        const topN = scored.slice(0, 10);
        const safe = [];
        
        for (const entry of topN) {
            const m = entry.move;
            if (this._isMoveVirtuallySafe(m, gameState, aiFlag)) {
                safe.push(m);
            }
        }
        
        if (safe.length > 0) {
            return safe;
        }
        return moves;
    },
    
    _isMoveVirtuallySafe(moveData, gameState, aiFlag) {
        const piece = moveData.piece;
        const distBefore = Math.max(
            Math.abs(piece.row - aiFlag.row),
            Math.abs(piece.col - aiFlag.col)
        );
        
        if (distBefore > 2) {
            return true;
        }
        
        // Check BEFORE removing: is enemy already adjacent to flag?
        let alreadyThreatened = false;
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) {
                continue;
            }
            if (enemy.type === 'flag') {
                continue;
            }
            const distToFlag = Math.max(
                Math.abs(enemy.row - aiFlag.row),
                Math.abs(enemy.col - aiFlag.col)
            );
            if (distToFlag <= 1) {
                alreadyThreatened = true;
                break;
            }
        }
        if (alreadyThreatened) {
            return true;
        }
        
        // Virtually remove the piece and check if NEW path to flag opens
        const hadCell = gameState.board[piece.row][piece.col];
        gameState.board[piece.row][piece.col] = null;
        
        let flagExposed = false;
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) {
                continue;
            }
            if (enemy.type === 'flag') {
                continue;
            }
            
            for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
                const nr = enemy.row + dRow;
                const nc = enemy.col + dCol;
                if (!aiEngine.isValidPosition(nr, nc)) {
                    continue;
                }
                if (nr === aiFlag.row && nc === aiFlag.col) {
                    const blocker = gameState.board[nr][nc];
                    if (!blocker || blocker.type === 'flag') {
                        flagExposed = true;
                        break;
                    }
                }
            }
            if (flagExposed) {
                break;
            }
        }
        
        gameState.board[piece.row][piece.col] = hadCell;
        return !flagExposed;
    },
    
    // === Defense ===
    
    _pickBestRabbitScored(moves, gameState) {
        if (moves.length === 0) {
            return null;
        }
        
        const pool = aiEngine.filterOutShuttleMoves(moves);
        if (pool.length === 0) {
            return null;
        }
        
        let best = pool[0];
        let bestScore = -Infinity;
        
        for (const move of pool) {
            const score = move.priority !== undefined 
                ? move.priority 
                : this._evaluateRabbitMove(move, gameState);
            if (score > bestScore) {
                bestScore = score;
                best = move;
            }
        }
        
        return { piece: best.piece, row: best.row, col: best.col };
    },

    // === P2: Local flag deduction for mandatory/hunt ===

    _deduceEnemyFlag(gameState) {
        const hidden = gameState.playerPieces.filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== 'trap'
        );
        if (hidden.length === 0) {
            return { candidates: [], hiddenCount: 0 };
        }
        if (hidden.length === 1) {
            return {
                candidates: [{ piece: hidden[0], prob: 1 }],
                hiddenCount: 1
            };
        }

        let sum = 0;
        const scores = [];
        for (const piece of hidden) {
            let score = 1;

            const info = aiEngine.enemyStillness.get(piece.id)
                || { stillnessScore: 0, hasMovedOnce: false };
            score += Math.min(info.stillnessScore, 10) * 2;

            if (piece.row >= BOARD_HEIGHT - 1) {
                score += 6;
            } else if (piece.row >= BOARD_HEIGHT - 2) {
                score += 4;
            }

            if (piece.row >= BOARD_HEIGHT - 2
                && (piece.col === 0 || piece.col === BOARD_WIDTH - 1)) {
                score += 3;
            }

            if (info.hasMovedOnce) {
                score = Math.max(1, score - 5);
            }

            scores.push({ piece, score });
            sum += score;
        }

        const candidates = scores
            .map(s => ({ piece: s.piece, prob: s.score / (sum || 1) }))
            .sort((a, b) => b.prob - a.prob);

        return { candidates, hiddenCount: hidden.length };
    },

    // === Opponent Model ===

    _getAiFlag(gameState) {
        return gameState.aiPieces.find(p => p.type === 'flag' && !p.removed);
    },

    _assessUnknownTargetRisk(target, gameState) {
        if (!target
            || target.revealed) {
            return { riskScore: 0, isHighRisk: false };
        }

        const boardHeight = typeof BOARD_HEIGHT !== 'undefined' ? BOARD_HEIGHT : 6;
        let riskScore = 0;

        if (target.row >= boardHeight - 2) {
            riskScore += 0.2;
        }

        if (aiEngine.enemyStillness && aiEngine.enemyStillness.get) {
            const stillInfo = aiEngine.enemyStillness.get(target.id);
            if (stillInfo && stillInfo.stillnessScore >= rabbitConfig.risk.stillnessThreshold) {
                riskScore += 0.2;
            }
        }

        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.getProbDistribution === 'function') {
            const probs = aiBeliefs.getProbDistribution(target.id);
            if (probs) {
                riskScore = riskScore
                    + probs.trap
                    + probs.flag;
            }
        }

        return {
            riskScore,
            isHighRisk: riskScore >= rabbitConfig.risk.trapFlagThreshold
        };
    },

    // === Attack / Safety ===

    _filterRiskyAttacks(moves, gameState) {
        if (!moves
            || moves.length === 0) {
            return moves;
        }

        const filtered = [];
        for (const move of moves) {
            const target = gameState.board[move.row] && gameState.board[move.row][move.col];
            if (!target
                || target.owner !== PLAYER
                || target.revealed) {
                filtered.push(move);
                continue;
            }

            const risk = this._assessUnknownTargetRisk(target, gameState);
            if (!risk.isHighRisk) {
                filtered.push(move);
                continue;
            }

            const piece = move.piece;
            const hasSupport = typeof aiEngine.hasRetaliationSupport === 'function'
                ? aiEngine.hasRetaliationSupport(piece, move, gameState)
                : true;
            const isDisposable = piece.type === 'piece'
                && !piece.revealed
                && hasSupport;

            if (isDisposable) {
                filtered.push(move);
            }
        }

        return filtered.length > 0 ? filtered : moves;
    },

    _getNearbyAllyTypes(row, col, gameState, excludedId) {
        const coverage = {
            typeCount: 0,
            hasRock: false,
            hasPaper: false,
            hasScissors: false
        };

        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const r = row + dRow;
            const c = col + dCol;
            if (!aiEngine.isValidPosition(r, c)) {
                continue;
            }

            const ally = gameState.board[r][c];
            if (!ally
                || ally.owner !== COMPUTER) {
                continue;
            }
            if (excludedId && ally.id === excludedId) {
                continue;
            }
            if (ally.removed
                || ally.immobilized) {
                continue;
            }
            if (ally.type !== 'piece'
                || !ally.pieceType) {
                continue;
            }

            if (ally.pieceType === 'rock') {
                coverage.hasRock = true;
            }
            if (ally.pieceType === 'paper') {
                coverage.hasPaper = true;
            }
            if (ally.pieceType === 'scissors') {
                coverage.hasScissors = true;
            }
        }

        coverage.typeCount = (coverage.hasRock ? 1 : 0)
            + (coverage.hasPaper ? 1 : 0)
            + (coverage.hasScissors ? 1 : 0);

        return coverage;
    },

    _hasTripletSupport(row, col, gameState, excludedId) {
        const coverage = this._getNearbyAllyTypes(row, col, gameState, excludedId);
        return coverage.typeCount >= 2;
    },

    _getDefenseCoverage(flag, gameState, excludedPiece) {
        const coverage = {
            defenders: 0,
            typeCount: 0,
            hasTrap: false,
            hasRock: false,
            hasPaper: false,
            hasScissors: false
        };

        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const r = flag.row + dRow;
            const c = flag.col + dCol;
            if (!aiEngine.isValidPosition(r, c)) {
                continue;
            }

            const ally = gameState.board[r][c];
            if (!ally
                || ally.owner !== COMPUTER
                || ally.type === FLAG) {
                continue;
            }

            if (excludedPiece && ally.id === excludedPiece.id) {
                continue;
            }

            if (ally.immobilized
                || ally.removed) {
                continue;
            }

            coverage.defenders += 1;
            if (ally.type === TRAP) {
                coverage.hasTrap = true;
            }
            if (ally.type === 'piece' && ally.pieceType) {
                if (ally.pieceType === 'rock') {
                    coverage.hasRock = true;
                }
                if (ally.pieceType === 'paper') {
                    coverage.hasPaper = true;
                }
                if (ally.pieceType === 'scissors') {
                    coverage.hasScissors = true;
                }
            }
        }

        coverage.typeCount = (coverage.hasRock ? 1 : 0)
            + (coverage.hasPaper ? 1 : 0)
            + (coverage.hasScissors ? 1 : 0);

        return coverage;
    },

    /**
     * P0 FIX: never fall back to ALL moves when threats are present.
     * If no safe candidate remains, return an empty array so the caller
     * escalates to the next priority level or uses findFlagDefenseMoves.
     */
    _filterDefenseInvariant(moves, gameState) {
        if (!moves
            || moves.length === 0) {
            return moves;
        }

        const aiFlag = this._getAiFlag(gameState);
        if (!aiFlag) {
            return moves;
        }

        const threats = this._getFlagThreats(gameState, rabbitConfig.defense.dangerRange);
        if (threats.length === 0) {
            return moves;
        }

        const filtered = [];
        for (const move of moves) {
            const piece = move.piece;
            const currentDist = Math.max(
                Math.abs(piece.row - aiFlag.row),
                Math.abs(piece.col - aiFlag.col)
            );
            const nextDist = Math.max(
                Math.abs(move.row - aiFlag.row),
                Math.abs(move.col - aiFlag.col)
            );

            if (currentDist <= 1 && nextDist > 1) {
                const nextCoverage = this._getDefenseCoverage(aiFlag, gameState, piece);
                if (nextCoverage.defenders < rabbitConfig.defense.minDefenders) {
                    continue;
                }
                if (nextCoverage.typeCount < rabbitConfig.defense.minTypeCount) {
                    continue;
                }
            }

            filtered.push(move);
        }

        // P0 FIX: do NOT fall back to unsafe `moves` — return empty to escalate
        return filtered;
    },
    
    /**
     * Find threats to the flag within a Chebyshev radius
     */
    _getFlagThreats(gameState, distLimit) {
        const aiFlag = this._getAiFlag(gameState);
        if (!aiFlag) {
            return [];
        }
        
        const threats = [];
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed
                || enemy.row < 0
                || enemy.immobilized) {
                continue;
            }
            if (enemy.type === 'flag') {
                continue;
            }
            
            const dist = Math.max(Math.abs(enemy.row - aiFlag.row), Math.abs(enemy.col - aiFlag.col));
            if (dist <= distLimit) {
                threats.push({ piece: enemy, dist });
            }
        }
        return threats;
    },
    
    /**
     * Find critical moves for flag defense (range 1 threats)
     */
    _findSmartFlagDefense(gameState, availablePieces) {
        const aiFlag = this._getAiFlag(gameState);
        if (!aiFlag) {
            return [];
        }
        
        const immediateThreats = this._getFlagThreats(gameState, 1);
        if (immediateThreats.length === 0) {
            return [];
        }
        
        const defenseMoves = [];
        
        for (const threatData of immediateThreats) {
            const threat = threatData.piece;
            
            // 1. Attack the threat with a winning or drawing piece
            for (const piece of availablePieces) {
                if (piece.type === 'flag'
                    || piece.type === 'trap') {
                    continue;
                }
                
                const moves = aiEngine.getMovesForPiece(piece, gameState);
                for (const move of moves) {
                    if (move.row === threat.row && move.col === threat.col) {
                        if (threat.revealed) {
                            const result = aiEngine.resolveBattle(piece.pieceType, threat.pieceType);
                            if (result === 'win') {
                                defenseMoves.push({
                                    piece,
                                    row: move.row,
                                    col: move.col,
                                    priority: 1000 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                                });
                            } else if (result === 'draw') {
                                defenseMoves.push({
                                    piece,
                                    row: move.row,
                                    col: move.col,
                                    priority: 850 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                                });
                            }
                        } else {
                            defenseMoves.push({
                                piece,
                                row: move.row,
                                col: move.col,
                                priority: 800 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                            });
                        }
                    }
                }
            }
            
            // 2. Move the flag to a safe adjacent square
            const flagMoves = aiEngine.getMovesForPiece(aiFlag, gameState);
            for (const fMove of flagMoves) {
                const target = gameState.board[fMove.row][fMove.col];
                if (target) {
                    continue;
                }
                
                let isSafe = true;
                for (const enemy of gameState.playerPieces) {
                    if (enemy.removed
                        || enemy.row < 0
                        || enemy.immobilized) {
                        continue;
                    }
                    if (enemy.type === 'flag') {
                        continue;
                    }
                    
                    const distToNext = Math.max(Math.abs(enemy.row - fMove.row), Math.abs(enemy.col - fMove.col));
                    if (distToNext <= 1) {
                        isSafe = false;
                        break;
                    }
                }
                
                if (isSafe) {
                    defenseMoves.push({
                        piece: aiFlag,
                        row: fMove.row,
                        col: fMove.col,
                        priority: 950 + aiEngine.evaluateFlagMove(aiFlag, fMove.row, fMove.col, gameState) / 100
                    });
                }
            }
            
            // 3. Block: step between the threat and the flag
            for (const piece of availablePieces) {
                if (piece.type === 'flag'
                    || piece.type === 'trap') {
                    continue;
                }
                
                const moves = aiEngine.getMovesForPiece(piece, gameState);
                for (const move of moves) {
                    const target = gameState.board[move.row][move.col];
                    if (target) {
                        continue;
                    }
                    
                    const distToFlag = Math.max(Math.abs(move.row - aiFlag.row), Math.abs(move.col - aiFlag.col));
                    const distToThreat = Math.max(Math.abs(move.row - threat.row), Math.abs(move.col - threat.col));
                    
                    if (distToFlag === 1 && distToThreat === 1) {
                        defenseMoves.push({
                            piece,
                            row: move.row,
                            col: move.col,
                            priority: 750 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                        });
                    }
                }
            }
        }
        
        // 4. Desperate attack if nothing else is possible
        if (defenseMoves.length === 0) {
            for (const threatData of immediateThreats) {
                const threat = threatData.piece;
                for (const piece of availablePieces) {
                    if (piece.type === 'flag'
                        || piece.type === 'trap') {
                        continue;
                    }
                    const moves = aiEngine.getMovesForPiece(piece, gameState);
                    for (const move of moves) {
                        if (move.row === threat.row && move.col === threat.col) {
                            defenseMoves.push({
                                piece,
                                row: move.row,
                                col: move.col,
                                priority: 100
                            });
                        }
                    }
                }
            }
        }
        
        return defenseMoves;
    },
    
    /**
     * Find our revealed pieces that are in danger
     */
    _getRevealedPiecesInDanger(gameState, availablePieces) {
        const endangered = [];
        const openPieces = availablePieces.filter(p => p.revealed && p.type === 'piece');
        
        for (const myPiece of openPieces) {
            let maxThreatLevel = 0;
            const threateningEnemies = [];
            
            for (const enemy of gameState.playerPieces) {
                if (enemy.removed
                    || enemy.row < 0
                    || enemy.immobilized) {
                    continue;
                }
                if (enemy.type === 'flag') {
                    continue;
                }
                
                const dist = Math.max(Math.abs(enemy.row - myPiece.row), Math.abs(enemy.col - myPiece.col));
                if (dist <= 2) {
                    let isThreat = false;
                    if (enemy.revealed) {
                        if (enemy.type === 'piece') {
                            const result = aiEngine.resolveBattle(myPiece.pieceType, enemy.pieceType);
                            if (result === 'lose') {
                                isThreat = true;
                            }
                        }
                    } else {
                        isThreat = true;
                    }
                    
                    if (isThreat) {
                        threateningEnemies.push({ piece: enemy, dist });
                        const level = dist === 1 ? 2 : 1;
                        if (level > maxThreatLevel) {
                            maxThreatLevel = level;
                        }
                    }
                }
            }
            
            if (threateningEnemies.length > 0) {
                endangered.push({
                    myPiece,
                    threats: threateningEnemies,
                    dangerLevel: maxThreatLevel
                });
            }
        }
        
        return endangered;
    },
    
    /**
     * Find rescue moves for revealed pieces
     */
    _findOpenPieceRescueMoves(gameState, availablePieces) {
        const endangeredList = this._getRevealedPiecesInDanger(gameState, availablePieces);
        if (endangeredList.length === 0) {
            return [];
        }
        
        const rescueMoves = [];
        
        for (const endangered of endangeredList) {
            const { myPiece, threats, dangerLevel } = endangered;
            
            for (const threatData of threats) {
                const threat = threatData.piece;
                
                // A. Counter-attack: eliminate the threat with another piece
                for (const piece of availablePieces) {
                    if (piece.id === myPiece.id
                        || piece.type === 'flag'
                        || piece.type === 'trap') {
                        continue;
                    }
                    
                    const moves = aiEngine.getMovesForPiece(piece, gameState);
                    for (const move of moves) {
                        if (move.row === threat.row && move.col === threat.col) {
                            if (threat.revealed) {
                                const result = aiEngine.resolveBattle(piece.pieceType, threat.pieceType);
                                if (result === 'win') {
                                    rescueMoves.push({
                                        piece,
                                        row: move.row,
                                        col: move.col,
                                        priority: 800 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                                    });
                                } else if (result === 'draw') {
                                    rescueMoves.push({
                                        piece,
                                        row: move.row,
                                        col: move.col,
                                        priority: 650 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                                    });
                                }
                            } else {
                                rescueMoves.push({
                                    piece,
                                    row: move.row,
                                    col: move.col,
                                    priority: 600 + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                                });
                            }
                        }
                    }
                }
            }
            
            // B. Escape with the endangered revealed piece
            const myMoves = aiEngine.getMovesForPiece(myPiece, gameState);
            for (const move of myMoves) {
                const target = gameState.board[move.row][move.col];
                if (!target) {
                    let allDistsIncreased = true;
                    let isSafeSquare = true;
                    
                    for (const threatData of threats) {
                        const threat = threatData.piece;
                        const currDist = Math.max(Math.abs(myPiece.row - threat.row), Math.abs(myPiece.col - threat.col));
                        const nextDist = Math.max(Math.abs(move.row - threat.row), Math.abs(move.col - threat.col));
                        
                        if (nextDist <= currDist) {
                            allDistsIncreased = false;
                        }
                    }
                    
                    for (const enemy of gameState.playerPieces) {
                        if (enemy.removed
                            || enemy.row < 0
                            || enemy.immobilized) {
                            continue;
                        }
                        
                        const distToNext = Math.max(Math.abs(enemy.row - move.row), Math.abs(enemy.col - move.col));
                        if (distToNext <= 1) {
                            if (enemy.revealed && enemy.type === 'piece') {
                                const battleResult = aiEngine.resolveBattle(myPiece.pieceType, enemy.pieceType);
                                if (battleResult === 'lose') {
                                    isSafeSquare = false;
                                }
                            } else if (!enemy.revealed) {
                                isSafeSquare = false;
                            }
                        }
                    }
                    
                    if (allDistsIncreased && isSafeSquare) {
                        const basePriority = dangerLevel === 2 ? 750 : 550;
                        rescueMoves.push({
                            piece: myPiece,
                            row: move.row,
                            col: move.col,
                            priority: basePriority + this._evaluateRabbitMove({ piece: myPiece, row: move.row, col: move.col }, gameState) / 100
                        });
                    }
                }
            }
            
            // C. Cover: pull a defender next to the threatened piece
            for (const piece of availablePieces) {
                if (piece.id === myPiece.id
                    || piece.type === 'flag'
                    || piece.type === 'trap') {
                    continue;
                }
                
                const moves = aiEngine.getMovesForPiece(piece, gameState);
                for (const move of moves) {
                    const target = gameState.board[move.row][move.col];
                    if (target) {
                        continue;
                    }
                    
                    const nextDistToMyPiece = Math.max(Math.abs(move.row - myPiece.row), Math.abs(move.col - myPiece.col));
                    if (nextDistToMyPiece === 1) {
                        let protectorMatchupBonus = 0;
                        for (const threatData of threats) {
                            const threat = threatData.piece;
                            if (threat.revealed && threat.type === 'piece') {
                                const res = aiEngine.resolveBattle(piece.pieceType, threat.pieceType);
                                if (res === 'win') {
                                    protectorMatchupBonus = 100;
                                }
                            }
                        }
                        
                        rescueMoves.push({
                            piece,
                            row: move.row,
                            col: move.col,
                            priority: 400 + protectorMatchupBonus + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                        });
                    }
                }
            }
        }
        
        return rescueMoves;
    },
    
    /**
     * P1: Proactive flag defense — intercept threats at distance up to 3
     */
    _findProactiveFlagDefense(gameState, availablePieces) {
        const aiFlag = this._getAiFlag(gameState);
        if (!aiFlag) {
            return [];
        }
        
        const approachingThreats = this._getFlagThreats(gameState, 3).filter(t => t.dist >= 2 && t.dist <= 3);
        if (approachingThreats.length === 0) {
            return [];
        }
        
        const proactiveMoves = [];
        
        for (const threatData of approachingThreats) {
            const threat = threatData.piece;
            
            for (const piece of availablePieces) {
                if (piece.type === 'flag'
                    || piece.type === 'trap') {
                    continue;
                }
                
                const currentDistToThreat = Math.max(Math.abs(piece.row - threat.row), Math.abs(piece.col - threat.col));
                const moves = aiEngine.getMovesForPiece(piece, gameState);
                
                for (const move of moves) {
                    const target = gameState.board[move.row][move.col];
                    if (target) {
                        continue;
                    }
                    
                    const nextDistToThreat = Math.max(Math.abs(move.row - threat.row), Math.abs(move.col - threat.col));
                    const nextDistToFlag = Math.max(Math.abs(move.row - aiFlag.row), Math.abs(move.col - aiFlag.col));
                    
                    if (nextDistToThreat < currentDistToThreat && nextDistToFlag <= 3) {
                        const distBonus = threatData.dist === 2 ? 100 : 0;
                        proactiveMoves.push({
                            piece,
                            row: move.row,
                            col: move.col,
                            priority: 500 + distBonus + this._evaluateRabbitMove({ piece, row: move.row, col: move.col }, gameState) / 100
                        });
                    }
                }
            }
        }
        
        return proactiveMoves;
    },
    
    // === Draw pressure ===

    _drawPressureRatio(gameState) {
        const movesWithout = gameState.movesWithoutCapture || 0;
        const limit = (GAME_CONFIG.GAME && GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT) || 20;
        return movesWithout / limit;
    },

    /**
     * Collect legal attacks on adjacent enemies and pick the best-scored one,
     * bypassing the risk filter. Only clearly bad targets are skipped: a
     * revealed trap or a revealed losing fight.
     */
    _findDrawPressureAttack(gameState, availablePieces) {
        const candidates = [];
        for (const piece of availablePieces) {
            if (piece.type === 'flag'
                || piece.type === 'trap') {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row][move.col];
                if (!target
                    || target.owner !== PLAYER
                    || target.type === 'flag') {
                    continue;
                }
                if (target.revealed
                    && target.type === 'trap') {
                    continue;
                }
                if (target.revealed
                    && target.type === 'piece'
                    && piece.pieceType
                    && aiEngine.resolveBattle(piece.pieceType, target.pieceType) === 'lose') {
                    continue;
                }
                candidates.push({ piece, row: move.row, col: move.col });
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        let best = null;
        let bestScore = -Infinity;
        for (const candidate of candidates) {
            const score = this._evaluateRabbitMove(candidate, gameState);
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }

        return best
            ? { piece: best.piece, row: best.row, col: best.col }
            : null;
    },

    // === Evaluation ===

    /**
     * Rabbit move evaluation with flag defense and revealed-piece safety
     */
    _evaluateRabbitMove(moveData, gameState) {
        const { piece, row, col } = moveData;
        const target = gameState.board[row] && gameState.board[row][col];
        let score = aiEngine.evaluateMoveV2(moveData, gameState);
        const pieceType = piece.type === 'piece'
            ? piece.pieceType
            : null;
        
        // 1. Avoid exposing revealed pieces
        const willBeRevealed = piece.revealed
            || (target
                && target.owner === PLAYER);
        if (willBeRevealed && piece.type === 'piece') {
            for (const enemy of gameState.playerPieces) {
                if (enemy.removed
                    || enemy.row < 0
                    || enemy.immobilized
                    || enemy.type === 'flag') {
                    continue;
                }
                
                const nextDist = Math.max(Math.abs(row - enemy.row), Math.abs(col - enemy.col));
                if (nextDist === 1) {
                    if (enemy.revealed) {
                        if (enemy.type === 'piece') {
                            const battleResult = aiEngine.resolveBattle(piece.pieceType, enemy.pieceType);
                            if (battleResult === 'lose') {
                                score -= 600;
                            }
                        }
                    } else {
                        score -= 200;
                    }
                }
            }
        }

        if (target
            && target.owner === PLAYER
            && target.type !== 'flag'
            && pieceType) {
            const attackSupport = this._hasTripletSupport(row, col, gameState, piece.id);
            if (!attackSupport) {
                score -= 120;
            }
        }

        if (target
            && target.owner === PLAYER
            && target.revealed
            && target.type === 'piece'
            && pieceType) {
            const battleResult = aiEngine.resolveBattle(pieceType, target.pieceType);
            if (battleResult === 'win') {
                score += 180;
                const hasSupport = this._hasTripletSupport(row, col, gameState, piece.id);
                if (hasSupport) {
                    score += 80;
                }
            } else if (battleResult === 'draw') {
                score += 40;
            }
        }

        if (pieceType) {
            const currentCoverage = this._getNearbyAllyTypes(piece.row, piece.col, gameState, piece.id);
            const nextCoverage = this._getNearbyAllyTypes(row, col, gameState, piece.id);
            if (nextCoverage.typeCount > currentCoverage.typeCount) {
                score += 40
                    * (nextCoverage.typeCount - currentCoverage.typeCount);
            } else if (nextCoverage.typeCount < currentCoverage.typeCount) {
                score -= 30
                    * (currentCoverage.typeCount - nextCoverage.typeCount);
            }
        }

        if (pieceType) {
            const revealedAllies = gameState.aiPieces.filter(p =>
                !p.removed
                && p.revealed
                && p.type === 'piece'
            );
            for (const ally of revealedAllies) {
                const allyDist = Math.max(
                    Math.abs(ally.row - row),
                    Math.abs(ally.col - col)
                );
                if (allyDist !== 1) {
                    continue;
                }

                const allyCoverage = this._getNearbyAllyTypes(ally.row, ally.col, gameState, piece.id);
                const missingRock = !allyCoverage.hasRock;
                const missingPaper = !allyCoverage.hasPaper;
                const missingScissors = !allyCoverage.hasScissors;

                if ((pieceType === 'rock'
                    && missingRock)
                    || (pieceType === 'paper'
                        && missingPaper)
                    || (pieceType === 'scissors'
                        && missingScissors)) {
                    score += 70;
                }
            }
        }
        
        // 2. Support revealed allies in danger
        if (piece.type === 'piece' && !piece.revealed) {
            const endangered = this._getRevealedPiecesInDanger(gameState, [piece]);
            if (endangered.length > 0) {
                const myEndangeredPiece = endangered[0].myPiece;
                const currentDist = Math.max(Math.abs(piece.row - myEndangeredPiece.row), Math.abs(piece.col - myEndangeredPiece.col));
                const nextDist = Math.max(Math.abs(row - myEndangeredPiece.row), Math.abs(col - myEndangeredPiece.col));
                
                if (nextDist < currentDist && nextDist <= 2) {
                    score += 150;
                }
            }
        }
        
        // 3. Flag defense: keep defenders close
        const aiFlag = this._getAiFlag(gameState);
        if (aiFlag && piece.type !== 'flag') {
            const currentDistToFlag = Math.max(Math.abs(piece.row - aiFlag.row), Math.abs(piece.col - aiFlag.col));
            const nextDistToFlag = Math.max(Math.abs(row - aiFlag.row), Math.abs(col - aiFlag.col));
            
            const enemiesOnOurSide = gameState.playerPieces.filter(e => !e.removed && e.row <= 2);
            if (enemiesOnOurSide.length > 0 && nextDistToFlag > currentDistToFlag && currentDistToFlag <= 3) {
                score -= 100;
            }
        }
        
        // 4. Border patrol: chase enemies that cross into our territory (row <= 1)
        if (piece.type !== 'flag' && piece.type !== 'trap') {
            const enemiesOnOurSide = gameState.playerPieces.filter(e => !e.removed && e.row <= 1);
            if (enemiesOnOurSide.length > 0) {
                let minEnemyDist = Infinity;
                let targetEnemy = null;
                for (const enemy of enemiesOnOurSide) {
                    const d = Math.max(Math.abs(piece.row - enemy.row), Math.abs(piece.col - enemy.col));
                    if (d < minEnemyDist) {
                        minEnemyDist = d;
                        targetEnemy = enemy;
                    }
                }
                
                if (targetEnemy) {
                    const currentDistToEnemy = Math.max(Math.abs(piece.row - targetEnemy.row), Math.abs(piece.col - targetEnemy.col));
                    const nextDistToEnemy = Math.max(Math.abs(row - targetEnemy.row), Math.abs(col - targetEnemy.col));
                    
                    if (nextDistToEnemy < currentDistToEnemy) {
                        score += 80;
                    }
                }
            }
        }
        
        // 5. Defense invariant: keep coverage if we are already thin near the flag
        if (aiFlag && piece.type !== 'flag') {
            const currentDist = Math.max(Math.abs(piece.row - aiFlag.row), Math.abs(piece.col - aiFlag.col));
            const nextDist = Math.max(Math.abs(row - aiFlag.row), Math.abs(col - aiFlag.col));
            if (currentDist <= 1 && nextDist > 1) {
                const nextCoverage = this._getDefenseCoverage(aiFlag, gameState, piece);
                if (nextCoverage.defenders < rabbitConfig.defense.minDefenders) {
                    score -= 220;
                }
                if (nextCoverage.typeCount < rabbitConfig.defense.minTypeCount) {
                    score -= 180;
                }
            }
        }

        // 6. FLAG SHIELD SCORE: context-sensitive penalty/bonus
        if (aiFlag && piece.type !== 'flag') {
            let enemyPressure = 0;
            for (const enemy of gameState.playerPieces) {
                if (enemy.removed || enemy.row < 0 || enemy.immobilized) {
                    continue;
                }
                if (enemy.type === 'flag') {
                    continue;
                }
                const distEnemyToFlag = Math.max(
                    Math.abs(enemy.row - aiFlag.row),
                    Math.abs(enemy.col - aiFlag.col)
                );
                if (distEnemyToFlag <= 2) {
                    enemyPressure++;
                }
            }

            if (enemyPressure > 0) {
                const currentDistToFlag = Math.max(
                    Math.abs(piece.row - aiFlag.row),
                    Math.abs(piece.col - aiFlag.col)
                );
                const nextDistToFlag = Math.max(
                    Math.abs(row - aiFlag.row),
                    Math.abs(col - aiFlag.col)
                );

                if (nextDistToFlag > currentDistToFlag && currentDistToFlag <= 2) {
                    score -= 120 * enemyPressure;
                } else if (nextDistToFlag < currentDistToFlag && nextDistToFlag <= 2) {
                    score += 100;
                }

                if (nextDistToFlag === 1 && pieceType) {
                    score += 150;
                }
            }
        }

        // 7. Endgame consolidation: pull pieces closer to the flag
        const activePieces = gameState.aiPieces.filter(p => !p.removed && p.row >= 0);
        if (activePieces.length <= 5 && aiFlag && piece.type === 'piece') {
            const currentDistToFlag = Math.max(Math.abs(piece.row - aiFlag.row), Math.abs(piece.col - aiFlag.col));
            const nextDistToFlag = Math.max(Math.abs(row - aiFlag.row), Math.abs(col - aiFlag.col));
            if (nextDistToFlag < currentDistToFlag) {
                score += 150;
            } else if (nextDistToFlag > currentDistToFlag) {
                score -= 80;
            }
        }

        // 8. Small organic noise to avoid deterministic loops
        score += Math.random() * 2;
        
        return score;
    },
    
    // === Placement ===

    chooseFlagAndTrap() {
        // Center-biased templates: flag in inner columns (2-5) to maximize
        // defender coverage and avoid corner-hunting heuristics.
        // Index = row * 8 + col, rows 0-1, cols 0-7.
        const templates = [
            // Center back row (row 0, cols 2-5) — hardest to deduce
            { flagIndex: 2, trapIndex: 11 },
            { flagIndex: 3, trapIndex: 10 },
            { flagIndex: 3, trapIndex: 12 },
            { flagIndex: 4, trapIndex: 11 },
            { flagIndex: 4, trapIndex: 13 },
            { flagIndex: 5, trapIndex: 12 },
            { flagIndex: 5, trapIndex: 14 },
            // Inner row center (row 1, cols 2-5)
            { flagIndex: 10, trapIndex: 3 },
            { flagIndex: 11, trapIndex: 2 },
            { flagIndex: 11, trapIndex: 4 },
            { flagIndex: 12, trapIndex: 3 },
            { flagIndex: 12, trapIndex: 5 },
            { flagIndex: 13, trapIndex: 4 },
            // Semi-corners (less common than true corners)
            { flagIndex: 1, trapIndex: 10 },
            { flagIndex: 6, trapIndex: 13 },
            // True corners (rare — only 15% chance)
            { flagIndex: 0, trapIndex: 9 },
            { flagIndex: 7, trapIndex: 14 }
        ];

        const cornerTemplates = templates.slice(-2);
        const centerTemplates = templates.slice(0, -2);
        const useCorner = Math.random() < 0.15;
        const pool = useCorner ? cornerTemplates : centerTemplates;
        const pick = pool[Math.floor(Math.random() * pool.length)];

        // 30% mirror for additional unpredictability
        if (Math.random() < 0.3) {
            const flagRow = Math.floor(pick.flagIndex / 8);
            const flagCol = pick.flagIndex % 8;
            const trapRow = Math.floor(pick.trapIndex / 8);
            const trapCol = pick.trapIndex % 8;
            const mFlagIndex = flagRow * 8 + (7 - flagCol);
            const mTrapIndex = trapRow * 8 + (7 - trapCol);
            if (mFlagIndex !== mTrapIndex) {
                return { flagIndex: mFlagIndex, trapIndex: mTrapIndex };
            }
        }

        return { flagIndex: pick.flagIndex, trapIndex: pick.trapIndex };
    },

    /**
     * P1: Defense-first tie-break when flag is threatened.
     * If enemy pressure >= 2 on our flag, pick the type that maximizes
     * defense coverage rather than the fist formation.
     */
    getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
        const aiFlag = this._getAiFlag(gameState);
        if (aiFlag) {
            const threats = this._getFlagThreats(gameState, 2);
            if (threats.length >= 2) {
                const available = aiEngine.getTieBreakAvailableChoices();
                const revealedThreats = threats.filter(t => t.piece.revealed && t.piece.type === 'piece');
                if (revealedThreats.length > 0) {
                    for (const choice of available) {
                        let countersAll = true;
                        for (const t of revealedThreats) {
                            if (aiEngine.resolveBattle(choice, t.piece.pieceType) !== 'win') {
                                countersAll = false;
                                break;
                            }
                        }
                        if (countersAll) {
                            return choice;
                        }
                    }
                    const threat = revealedThreats[0];
                    const counter = aiEngine.getWinningChoice(threat.piece.pieceType);
                    if (available.indexOf(counter) >= 0) {
                        return counter;
                    }
                }
                return available[Math.floor(Math.random() * available.length)];
            }
        }

        return aiEngine.pickAnimalTieChoice(
            'rabbit',
            currentType,
            opponentRevealed,
            opponentType,
            gameState
        );
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = rabbitBot;
}

// Official registration — MUST go through defineBot (the gate that stamps + enforces rules)
if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(rabbitBot);
} else {
    throw new Error('[rabbit] RPSBotAPI.defineBot is required. Make sure bot-api.js is loaded before bots/*/bot.js');
}
