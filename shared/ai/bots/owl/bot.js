/**
 * 🦉 Сова — classical chess-engine port.
 *
 * Playstyle: fortress first. Owl builds layered defenders around its own flag,
 * keeps trap lanes closed, attacks only when the flag is secure or a bad draw is
 * approaching, and uses search as a tactical tool rather than as the whole plan.
 *
 * Hidden identities are never read directly. Enemy flag probabilities come from
 * public features only: back row, edge/corner placement, stillness, and movement.
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
    longDescription: 'Оборонительная Сова: редуты вокруг флага, вероятностная охота только при безопасной позиции.',
    algorithmLabel: 'Fortress doctrine + α-β',
    // Certified through RPSBotAPI.defineBot (mandatory common rulebook + interface)
    tier: 'hard',
    stars: 3,
    difficultyLabel: 'Сложный',
    tags: ['classic', 'deep-search'],
    
    TIME_BUDGET_MS: 3000,
    MAX_DEPTH: 6,
    START_DEPTH: 2,
    QUIESCENCE_MAX: 3,
    FLAG_ATTACK_CONFIDENCE: 0.5,
    STRONG_FLAG_CONFIDENCE: 0.65,
    DRAW_PRESSURE_START: 0.6,
    FORTRESS_MIN_SCORE: 45,
    
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
        const ctx = this._buildStrategicContext(gameState, available);
        
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
            const picked = this._pickPunishingKill(guaranteed, gameState, ctx);
            if (picked) {
                return picked;
            }
        }

        const behavioralProbe = this._pickBehavioralProbeAttack(gameState, ctx);
        if (behavioralProbe) {
            return behavioralProbe;
        }

        const attack = this._pickPermittedAttack(gameState, ctx);
        if (attack) {
            return attack;
        }

        const fortress = this._pickFortressMove(gameState, ctx);
        if (fortress) {
            return fortress;
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
    //  DEFENSIVE DOCTRINE
    // ==========================================================================

    _buildStrategicContext(gameState, available) {
        const ownFlag = gameState.aiPieces.find(piece => {
            return piece.type === FLAG
                && !piece.removed;
        });
        const flagBeliefs = this._estimateEnemyFlagBeliefs(gameState);
        const topFlag = flagBeliefs.length > 0 ? flagBeliefs[0] : null;
        const ownFlagStatus = this._evaluateOwnFlagStatus(gameState, ownFlag);
        const material = this._evaluateMaterialStatus(gameState);
        const drawStatus = this._evaluateDrawStatus(gameState, material);

        return {
            available,
            ownFlag,
            flagBeliefs,
            topFlag,
            ownFlagStatus,
            material,
            drawStatus
        };
    },

    _estimateEnemyFlagBeliefs(gameState) {
        const enemies = gameState.playerPieces.filter(piece => {
            return !piece.removed
                && piece.row >= 0;
        });
        const revealedFlag = enemies.find(piece => {
            return piece.revealed
                && piece.type === FLAG;
        });
        if (revealedFlag) {
            return [{ piece: revealedFlag, probability: 1, score: 1 }];
        }

        const boardHeight = gameState.board.length;
        const boardWidth = gameState.board[0] ? gameState.board[0].length : 0;
        const candidates = [];
        for (const enemy of enemies) {
            if (enemy.revealed
                && enemy.type !== FLAG) {
                continue;
            }

            const stillness = aiEngine.enemyStillness.get(enemy.id)
                || { stillnessScore: 0, hasMovedOnce: false };
            const edgeDistance = Math.min(enemy.col, boardWidth - 1 - enemy.col);
            const backRowWeight = enemy.row / Math.max(1, boardHeight - 1);
            const edgeWeight = 1 - edgeDistance / Math.max(1, (boardWidth - 1) / 2);

            let score = 1;
            score += backRowWeight * 5;
            score += Math.max(0, edgeWeight) * 4;
            score += Math.min(stillness.stillnessScore || 0, 8) * 0.9;

            if (enemy.row >= boardHeight - 2) {
                score += 3;
            }
            if (enemy.col === 0
                || enemy.col === boardWidth - 1) {
                score += 3;
            } else if (enemy.col === 1
                || enemy.col === boardWidth - 2) {
                score += 1.5;
            }
            if (enemy.row <= Math.floor(boardHeight / 2)) {
                score -= 2;
            }
            if (stillness.hasMovedOnce) {
                score *= enemy.row >= boardHeight - 2 ? 0.55 : 0.35;
            }
            if (enemy.revealed
                && enemy.type === 'piece') {
                score = 0;
            }

            if (score > 0) {
                candidates.push({ piece: enemy, score });
            }
        }

        const total = candidates.reduce((sum, candidate) => {
            return sum + candidate.score;
        }, 0);
        if (total <= 0) {
            return [];
        }
        return candidates
            .map(candidate => ({
                ...candidate,
                probability: candidate.score / total
            }))
            .sort((left, right) => right.probability - left.probability);
    },

    _evaluateOwnFlagStatus(gameState, ownFlag) {
        if (!ownFlag) {
            return {
                secure: false,
                defenders: 0,
                innerDefenders: 0,
                coverage: 0,
                trapGate: false,
                nearbyThreats: 99,
                immediateThreats: 99
            };
        }

        const immediateThreats = aiEngine.getFlagThreats(gameState);
        let defenders = 0;
        let innerDefenders = 0;
        let nearbyThreats = 0;
        let trapGate = false;
        const types = new Set();

        for (const piece of gameState.aiPieces) {
            if (piece.removed
                || piece.row < 0
                || piece.type === FLAG
                || piece.immobilized) {
                continue;
            }
            const distance = this._distance(piece, ownFlag);
            if (distance <= 2) {
                defenders++;
                if (piece.type === 'piece'
                    && piece.pieceType) {
                    types.add(piece.pieceType);
                }
                if (distance <= 1) {
                    innerDefenders++;
                }
            }
            if (distance <= 1
                && piece.type === TRAP
                && piece.row >= ownFlag.row) {
                trapGate = true;
            }
        }

        for (const enemy of gameState.playerPieces) {
            if (enemy.removed
                || enemy.row < 0) {
                continue;
            }
            if (this._distance(enemy, ownFlag) <= 3) {
                nearbyThreats++;
            }
        }

        const secure = immediateThreats.length === 0
            && nearbyThreats <= 1
            && defenders >= 5
            && innerDefenders >= 2
            && (types.size >= 2 || trapGate);

        return {
            secure,
            defenders,
            innerDefenders,
            coverage: types.size,
            trapGate,
            nearbyThreats,
            immediateThreats: immediateThreats.length
        };
    },

    _evaluateMaterialStatus(gameState) {
        const ownPieces = gameState.aiPieces.filter(piece => {
            return !piece.removed
                && piece.row >= 0;
        });
        const enemyPieces = gameState.playerPieces.filter(piece => {
            return !piece.removed
                && piece.row >= 0;
        });
        const ownRevealed = ownPieces.filter(piece => piece.revealed).length;
        const enemyRevealed = enemyPieces.filter(piece => piece.revealed).length;
        const diff = ownPieces.length - enemyPieces.length;

        return {
            ownCount: ownPieces.length,
            enemyCount: enemyPieces.length,
            ownRevealed,
            enemyRevealed,
            diff,
            losing: diff <= -2,
            strong: diff >= 3,
            informationAdvantage: Math.abs(diff) <= 1
                && enemyRevealed >= ownRevealed + 2
        };
    },

    _evaluateDrawStatus(gameState, material) {
        const drawLimit = GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT || 20;
        const movesWithoutCapture = gameState.movesWithoutCapture || 0;
        const ratio = movesWithoutCapture / drawLimit;
        const unfavorable = !material.losing
            && (material.diff > 0 || material.informationAdvantage);

        return {
            ratio,
            pressure: ratio >= this.DRAW_PRESSURE_START,
            unfavorable,
            shouldAvoid: ratio >= this.DRAW_PRESSURE_START
                && unfavorable
        };
    },

    _pickPunishingKill(kills, gameState, ctx) {
        let bestMove = null;
        let bestScore = -Infinity;
        for (const move of kills) {
            const score = this._scorePunishingKill(gameState, move, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }
        if (bestMove
            && bestScore >= 120) {
            return bestMove;
        }
        return null;
    },

    _scorePunishingKill(gameState, move, ctx) {
        const target = gameState.board[move.row] && gameState.board[move.row][move.col];
        if (!target
            || !target.revealed
            || target.type !== 'piece') {
            return -Infinity;
        }

        let score = 180;
        if (move.piece.revealed) {
            score += 260;
        } else {
            score -= 60;
        }
        if (this._isStandaloneEnemy(gameState, target)) {
            score += 170;
        }
        if (ctx.ownFlag
            && this._distance(target, ctx.ownFlag) <= 3) {
            score += 220;
        }
        if (this._isCoreDefender(move.piece, ctx)
            && !ctx.ownFlagStatus.secure) {
            score -= move.piece.revealed ? 70 : 240;
        }
        score += this._countAdjacentAllies(gameState, move, move.piece.id) * 30;
        score -= this._enemyDangerAt(gameState, move, move.piece) * 70;
        return score;
    },

    _pickBehavioralProbeAttack(gameState, ctx) {
        const allMoves = aiEngine.getAllFilteredMoves(gameState, ctx.available);
        const pool = aiEngine.filterOutShuttleMoves(allMoves);
        let bestMove = null;
        let bestScore = -Infinity;

        for (const move of pool) {
            const target = gameState.board[move.row] && gameState.board[move.row][move.col];
            if (!target
                || target.owner !== PLAYER
                || target.revealed
                || move.piece.type !== 'piece'
                || !move.piece.revealed) {
                continue;
            }
            const score = this._scoreBehavioralProbe(gameState, move, target, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }

        if (bestMove
            && bestScore >= 180) {
            return bestMove;
        }
        return null;
    },

    _scoreBehavioralProbe(gameState, move, target, ctx) {
        if (ctx.topFlag
            && ctx.topFlag.piece.id === target.id
            && ctx.topFlag.probability >= this.FLAG_ATTACK_CONFIDENCE) {
            return -Infinity;
        }

        let score = 70;
        if (this._hiddenEnemyDeclinedRevealedTarget(gameState, target, move.piece)) {
            score += 190;
        }
        if (this._enemyMovedTowardRevealedPiece(gameState, move.piece, target)) {
            score += 160;
        }
        if (this._isStandaloneEnemy(gameState, target)) {
            score += 90;
        }
        if (this._isCoreDefender(move.piece, ctx)
            && !ctx.ownFlagStatus.secure) {
            score -= move.piece.revealed ? 80 : 260;
        }
        score += this._countAdjacentAllies(gameState, move, move.piece.id) * 25;
        score -= this._enemyDangerAt(gameState, move, move.piece) * 60;
        return score;
    },

    _pickPermittedAttack(gameState, ctx) {
        if (!ctx.topFlag
            || ctx.topFlag.probability < this.FLAG_ATTACK_CONFIDENCE) {
            return null;
        }
        if (!ctx.ownFlagStatus.secure) {
            return null;
        }
        if (!ctx.drawStatus.shouldAvoid
            && !ctx.material.strong
            && ctx.topFlag.probability < this.STRONG_FLAG_CONFIDENCE) {
            return null;
        }

        const allMoves = aiEngine.getAllFilteredMoves(gameState, ctx.available);
        const pool = aiEngine.filterOutShuttleMoves(allMoves);
        let bestMove = null;
        let bestScore = -Infinity;
        for (const move of pool) {
            if (move.piece.type === FLAG
                || move.piece.type === TRAP) {
                continue;
            }
            if (this._isCoreDefender(move.piece, ctx)
                && !ctx.material.strong) {
                continue;
            }

            const score = this._scoreAttackMove(gameState, move, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }

        return bestScore > 0 ? bestMove : null;
    },

    _scoreAttackMove(gameState, move, ctx) {
        const target = ctx.topFlag.piece;
        const before = this._distance(move.piece, target);
        const after = this._distance(move, target);
        const boardTarget = gameState.board[move.row] && gameState.board[move.row][move.col];
        let score = 0;

        if (after < before) {
            score += (before - after) * 110;
        } else if (after > before) {
            score -= 90;
        }
        score += ctx.topFlag.probability * 220;
        score += this._countAdjacentAllies(gameState, move, move.piece.id) * 25;
        score -= this._enemyDangerAt(gameState, move, move.piece) * 70;

        if (boardTarget && boardTarget.owner === PLAYER) {
            if (boardTarget.id === target.id) {
                score += 800 * ctx.topFlag.probability;
            } else if (boardTarget.revealed
                && boardTarget.type === 'piece'
                && move.piece.type === 'piece'
                && aiEngine.resolveBattle(move.piece.pieceType, boardTarget.pieceType) === 'win') {
                score += 180;
            } else if (!boardTarget.revealed) {
                score += 40;
            }
        }

        if (ctx.drawStatus.shouldAvoid) {
            score += 130;
        }
        if (ctx.material.strong) {
            score += 100;
        }
        return score;
    },

    _pickFortressMove(gameState, ctx) {
        if (!ctx.ownFlag) {
            return null;
        }
        const allMoves = aiEngine.getAllFilteredMoves(gameState, ctx.available);
        const quietMoves = allMoves.filter(move => {
            const target = gameState.board[move.row] && gameState.board[move.row][move.col];
            return !target
                && move.piece.type !== FLAG;
        });
        const pool = aiEngine.filterOutShuttleMoves(quietMoves);
        let bestMove = null;
        let bestScore = -Infinity;

        for (const move of pool) {
            const score = this._scoreFortressMove(gameState, move, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }

        if (bestMove
            && bestScore >= this.FORTRESS_MIN_SCORE) {
            return bestMove;
        }
        return null;
    },

    _scoreFortressMove(gameState, move, ctx) {
        const flag = ctx.ownFlag;
        const currentDist = this._distance(move.piece, flag);
        const nextDist = this._distance(move, flag);
        let score = 0;

        if (move.piece.type === TRAP) {
            score += this._scoreTrapGate(move, flag) * 1.4;
        } else if (move.piece.type === 'piece') {
            score += this._scoreDefenderSlot(move, flag);
            score += this._scoreMutualSupport(gameState, move) * 45;
        }

        if (currentDist <= 2
            && nextDist > currentDist) {
            score -= 420;
        }
        if (currentDist > 2
            && nextDist < currentDist) {
            score += (currentDist - nextDist) * 85;
        }
        if (nextDist <= 1) {
            score += 130;
        } else if (nextDist <= 2) {
            score += 90;
        } else if (nextDist === 3) {
            score += 25;
        } else {
            score -= (nextDist - 3) * 35;
        }

        score -= this._enemyDangerAt(gameState, move, move.piece) * 80;
        if (aiEngine.isShuttlePosition(move.piece.id, move.row, move.col)) {
            score -= 180;
        }
        return score;
    },

    _scoreDefenderSlot(move, flag) {
        const rowDelta = move.row - flag.row;
        const colDelta = Math.abs(move.col - flag.col);
        let score = 0;

        if (rowDelta === 1
            && colDelta <= 1) {
            score += 180;
        } else if (rowDelta === 2
            && colDelta <= 2) {
            score += 95;
        } else if (rowDelta === 0
            && colDelta === 1) {
            score += 80;
        }
        if (colDelta >= 3) {
            score -= 70;
        }
        return score;
    },

    _scoreTrapGate(move, flag) {
        const rowDelta = move.row - flag.row;
        const colDelta = Math.abs(move.col - flag.col);
        if (rowDelta === 1
            && colDelta === 0) {
            return 260;
        }
        if (rowDelta === 1
            && colDelta === 1) {
            return 210;
        }
        if (rowDelta === 2
            && colDelta <= 1) {
            return 100;
        }
        return -40;
    },

    _scoreMutualSupport(gameState, move) {
        const allies = [];
        const types = new Set();
        for (const ally of gameState.aiPieces) {
            if (ally.id === move.piece.id
                || ally.removed
                || ally.row < 0
                || ally.type === FLAG
                || ally.immobilized) {
                continue;
            }
            if (this._distance(ally, move) <= 1) {
                allies.push(ally);
                if (ally.type === 'piece'
                    && ally.pieceType) {
                    types.add(ally.pieceType);
                }
                if (ally.type === TRAP) {
                    types.add(TRAP);
                }
            }
        }
        if (move.piece.type === 'piece'
            && move.piece.pieceType) {
            types.add(move.piece.pieceType);
        }
        return allies.length * 0.8
            + types.size;
    },

    _isStandaloneEnemy(gameState, enemy) {
        let adjacentAllies = 0;
        for (const other of gameState.playerPieces) {
            if (other.id === enemy.id
                || other.removed
                || other.row < 0) {
                continue;
            }
            if (this._distance(other, enemy) <= 1) {
                adjacentAllies++;
            }
        }
        return adjacentAllies === 0;
    },

    _hiddenEnemyDeclinedRevealedTarget(gameState, enemy, ownPiece) {
        if (!ownPiece.revealed
            || ownPiece.type !== 'piece'
            || enemy.revealed) {
            return false;
        }
        if (this._distance(enemy, ownPiece) !== 1) {
            return false;
        }
        const lastMove = gameState.lastMove;
        if (!lastMove
            || !lastMove.to) {
            return true;
        }
        return !(lastMove.to[0] === enemy.row
            && lastMove.to[1] === enemy.col);
    },

    _enemyMovedTowardRevealedPiece(gameState, ownPiece, ignoredEnemy) {
        if (!ownPiece.revealed
            || ownPiece.type !== 'piece') {
            return false;
        }
        const lastMove = gameState.lastMove;
        if (!lastMove
            || !lastMove.from
            || !lastMove.to) {
            return false;
        }
        const mover = gameState.board[lastMove.to[0]]
            && gameState.board[lastMove.to[0]][lastMove.to[1]];
        if (!mover
            || mover.owner !== PLAYER
            || mover.id === ignoredEnemy.id) {
            return false;
        }
        const before = Math.max(
            Math.abs(lastMove.from[0] - ownPiece.row),
            Math.abs(lastMove.from[1] - ownPiece.col)
        );
        const after = this._distance(mover, ownPiece);
        return after < before;
    },

    _isCoreDefender(piece, ctx) {
        if (!ctx.ownFlag
            || !piece
            || piece.type === FLAG) {
            return false;
        }
        return this._distance(piece, ctx.ownFlag) <= 2;
    },

    _enemyDangerAt(gameState, position, piece) {
        let danger = 0;
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed
                || enemy.row < 0) {
                continue;
            }
            if (this._distance(enemy, position) !== 1) {
                continue;
            }
            if (!enemy.revealed) {
                danger += 1;
                continue;
            }
            if (enemy.type === TRAP) {
                danger += 3;
                continue;
            }
            if (enemy.type === 'piece'
                && piece.type === 'piece'
                && aiEngine.resolveBattle(enemy.pieceType, piece.pieceType) === 'win') {
                danger += 3;
            }
        }
        return danger;
    },

    _countAdjacentAllies(gameState, position, excludeId) {
        let count = 0;
        for (const ally of gameState.aiPieces) {
            if (ally.id === excludeId
                || ally.removed
                || ally.row < 0
                || ally.type === FLAG) {
                continue;
            }
            if (this._distance(ally, position) <= 1) {
                count++;
            }
        }
        return count;
    },

    _distance(a, b) {
        return Math.max(
            Math.abs(a.row - b.row),
            Math.abs(a.col - b.col)
        );
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
