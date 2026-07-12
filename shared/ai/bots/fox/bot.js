/**
 * Лис 2.0 — GOAP planner reinforced with Bayesian beliefs,
 * multi-layer flag protection, anti-passivity filters,
 * 2-ply mini-search and RPS-fist coordination.
 *
 * Pipeline per move():
 *   1. Prepare: clear caches, refresh stillness/pattern, refresh beliefs.
 *   2. aiTacticalCore.getMandatoryMove with belief-aware deducer.
 *   3. Otherwise: collect candidate moves from every goal that scores > 0.
 *      Each candidate carries a goal-prior weight.
 *   4. Score each candidate with:
 *        goalPrior + local heuristic + attack EV
 *        - flag-exposure penalty + fist bonus
 *        - worst-case opponent reply (cheap 2-ply look-ahead)
 *   5. If no goal produced a candidate, fall back to a strictly
 *      purpose-filtered develop move.
 *   6. Record the move so anti-shuttle / stillness memory stays consistent.
 *
 * Все обращения к aiBeliefs / aiExpert / aiStrategy защищены typeof-проверками,
 * чтобы Лис не падал, если что-то не подгружено.
 *
 * Certified through RPSBotAPI (bot-api.js) — uses the canonical rulebook.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[fox] bot-api.js must be loaded before fox/bot.js');
}

const foxBot = {
    id: 'fox',
    name: 'Лис',
    emoji: '🦊',
    avatar: 'js/bots/fox/avatar-min.png',
    shortDescription: 'GOAP-планировщик, байесовская модель и мини-поиск',
    longDescription: 'План по целям, байес и мини-поиск на 2 хода. Не шаттлит и не оголяет флаг.',
    algorithmLabel: 'GOAP + байес + мини-поиск 2 ply',
    tier: 'medium',
    stars: 2,
    difficultyLabel: 'Средний',
    tags: ['planner', 'beliefs', 'lookahead', 'defensive', 'tactical'],

    DEFEND_RANGE: 3,
    RECON_UNTIL_TURN: 3,
    HUNT_HORIZON: 3,
    HIGH_CERTAINTY_PROB: 0.5,
    BELIEF_WEIGHT: 0.7,
    SHUTTLE_PENALTY: 600,
    PURPOSE_PENALTY: 250,
    LOOKAHEAD_TOP_K: 8,
    LOOKAHEAD_OPPONENT_K: 4,

    move(gameState) {
        try {
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);
            this._refreshBeliefs(gameState);

            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: this._deduceFlag.bind(this),
                flagHuntHorizon: this.HUNT_HORIZON,
                antiCluster: true
            });
            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            // Draw-pressure desperation: force an exchange before the no-capture
            // limit hands out a draw. Fox's goal pipeline favours safe develop /
            // guard moves, so without this it can idle next to the enemy to a draw.
            const drawRatio = this._drawPressureRatio(gameState);
            if (drawRatio >= 0.75
                && !aiEngine.isLosingPosition(gameState)) {
                const forced = this._findDrawPressureAttack(gameState);
                if (forced) {
                    aiEngine.recordAIMove(forced);
                    return forced;
                }
            }

            const move = this._pickMove(gameState);
            if (move) {
                aiEngine.recordAIMove(move);
            }
            return move;
        } catch (error) {
            console.error('[fox] move() failed:', error);
            return null;
        }
    },

    chooseFlagAndTrap() {
        return aiEngine.chooseFlagAndTrapPositions({ style: 'corner-strong' });
    },

    // =========================================================================
    //  DRAW PRESSURE
    // =========================================================================

    _drawPressureRatio(gameState) {
        const movesWithout = gameState.movesWithoutCapture || 0;
        const limit = (GAME_CONFIG.GAME && GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT) || 20;
        return movesWithout / limit;
    },

    /**
     * Pick the best available capture, bypassing the goal pipeline. Only
     * clearly bad targets are skipped (revealed trap, revealed losing fight).
     * Scored with the generic evaluator, which already blends in draw pressure.
     */
    _findDrawPressureAttack(gameState) {
        const available = aiEngine.getActivePieces(gameState);
        const candidates = [];
        for (const piece of available) {
            if (piece.type === FLAG
                || piece.type === TRAP) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row][move.col];
                if (!target
                    || target.owner !== PLAYER
                    || target.type === FLAG) {
                    continue;
                }
                if (target.revealed
                    && target.type === TRAP) {
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
            const score = aiEngine.evaluateMoveV2(candidate, gameState);
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }

        return best
            ? { piece: best.piece, row: best.row, col: best.col }
            : null;
    },

    // =========================================================================
    //  BELIEFS BRIDGE
    // =========================================================================

    _hasBeliefs() {
        return typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && typeof aiBeliefs.getProbDistribution === 'function';
    },

    _refreshBeliefs(state) {
        if (!this._hasBeliefs()) {
            return;
        }
        if (typeof aiBeliefs.applyConstraints === 'function') {
            try {
                aiBeliefs.applyConstraints(state);
            } catch (e) {
                // beliefs not yet initialized for this side — ignore
            }
        }
    },

    _beliefProbs(pieceId) {
        if (!this._hasBeliefs()) {
            return null;
        }
        try {
            return aiBeliefs.getProbDistribution(pieceId);
        } catch (e) {
            return null;
        }
    },

    _beliefFlagCandidates(state) {
        if (!this._hasBeliefs()
            || typeof aiBeliefs.getFlagCandidates !== 'function') {
            return [];
        }
        try {
            return aiBeliefs.getFlagCandidates(state, 5) || [];
        } catch (e) {
            return [];
        }
    },

    // =========================================================================
    //  FLAG DEDUCER — hybrid beliefs + heuristic
    // =========================================================================

    _deduceFlag(state) {
        const hidden = state.playerPieces.filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== TRAP
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

        const heuristicScores = this._heuristicFlagScores(state, hidden);
        const beliefMap = new Map();
        const beliefCandidates = this._beliefFlagCandidates(state);
        for (const bc of beliefCandidates) {
            if (bc.pFlag > 0) {
                beliefMap.set(bc.pieceId, bc.pFlag);
            }
        }

        const useBeliefs = beliefMap.size > 0;
        const wBelief = useBeliefs ? this.BELIEF_WEIGHT : 0;
        const wHeur = 1 - wBelief;

        let sumHeur = 0;
        for (const piece of hidden) {
            sumHeur += heuristicScores.get(piece.id) || 1;
        }
        if (sumHeur <= 0) {
            sumHeur = 1;
        }

        const blended = [];
        for (const piece of hidden) {
            const hProb = (heuristicScores.get(piece.id) || 1) / sumHeur;
            const bProb = beliefMap.get(piece.id) || 0;
            const prob = wBelief * bProb + wHeur * hProb;
            blended.push({ piece, raw: prob });
        }

        let total = 0;
        for (const item of blended) {
            total += item.raw;
        }
        if (total <= 0) {
            total = 1;
        }

        const candidates = blended
            .map(item => ({ piece: item.piece, prob: item.raw / total }))
            .sort((a, b) => b.prob - a.prob);

        return { candidates, hiddenCount: hidden.length };
    },

    _heuristicFlagScores(state, hidden) {
        const scores = new Map();
        for (const piece of hidden) {
            const info = aiEngine.enemyStillness.get(piece.id)
                || { stillnessScore: 0, hasMovedOnce: false };

            let score = 5;
            score += Math.min(info.stillnessScore, 8) * 12;
            if (info.hasMovedOnce) {
                score -= 25;
            }

            if (piece.row >= BOARD_HEIGHT - 1) {
                score += 25;
            } else if (piece.row === BOARD_HEIGHT - 2) {
                score += 12;
            } else {
                score -= 15;
            }

            const isCornerCol = piece.col === 0 || piece.col === BOARD_WIDTH - 1;
            if (isCornerCol && piece.row >= BOARD_HEIGHT - 2) {
                score += 18;
            }

            const neighbours = this._countSurroundingAllies(state, piece);
            if (neighbours >= 3) {
                score += 14;
            }

            scores.set(piece.id, Math.max(1, score));
        }
        return scores;
    },

    _countSurroundingAllies(state, piece) {
        let count = 0;
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const r = piece.row + dRow;
            const c = piece.col + dCol;
            if (!aiEngine.isValidPosition(r, c)) {
                continue;
            }
            const neighbour = state.board[r][c];
            if (neighbour
                && neighbour.owner === PLAYER
                && neighbour.id !== piece.id) {
                count++;
            }
        }
        return count;
    },

    // =========================================================================
    //  HIGH-LEVEL PLANNING
    // =========================================================================

    _pickMove(gameState) {
        const available = aiEngine.getActivePieces(gameState);
        if (available.length === 0) {
            return null;
        }

        const allMoves = aiEngine.getAllFilteredMoves(gameState, available);
        if (allMoves.length === 0) {
            return null;
        }

        const ctx = this._buildContext(gameState, available, allMoves);
        const candidates = this._collectCandidates(gameState, ctx);

        if (candidates.length === 0) {
            return this._fallbackDevelop(gameState, ctx);
        }

        return this._pickWithLookahead(gameState, candidates, ctx);
    },

    _buildContext(state, available, allMoves) {
        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        const playerFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);
        const revealedEnemies = state.playerPieces.filter(p =>
            p.revealed
                && !p.removed
                && p.row >= 0
                && !p.immobilized
                && p.type !== FLAG
                && p.type !== TRAP
        );
        const hiddenEnemies = state.playerPieces.filter(p =>
            !p.revealed
                && !p.removed
                && p.row >= 0
                && !p.immobilized
        );

        const shuttleSafe = aiEngine.filterOutShuttleMoves(allMoves);
        const deduction = this._deduceFlag(state);
        const baselineFlagSafety = aiFlag
            ? aiEngine.evaluateFlagSafety(aiFlag, state)
            : 0;
        const safeKills = aiEngine.findGuaranteedKills(state, available)
            .filter(k => aiTacticalCore.safeToLeave(state, k.piece));
        const flagThreats = aiEngine.getFlagThreats(state);
        const nearFlagThreats = aiEngine.getNearFlagThreats(state);
        const topSuspect = deduction.candidates[0] || null;
        const suspectProb = topSuspect ? topSuspect.prob : 0;

        return {
            available,
            allMoves,
            shuttleSafe,
            aiFlag,
            playerFlag,
            revealedEnemies,
            hiddenEnemies,
            deduction,
            topSuspect,
            suspectProb,
            baselineFlagSafety,
            safeKills,
            flagThreats,
            nearFlagThreats,
            turn: aiEngine.aiTurnCounter
        };
    },

    _collectCandidates(state, ctx) {
        const pool = [];
        const seen = new Set();
        const push = (move, goalPrior, source) => {
            if (!move || !move.piece) {
                return;
            }
            const key = `${move.piece.id}:${move.row}:${move.col}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            pool.push({ move, goalPrior, source });
        };

        if (this._scoreCaptureFlag(state, ctx) > 0) {
            push(this._goalCaptureFlag(this, state, ctx), 1000, 'capture');
        }
        const huntScore = this._scoreHuntLikelyFlag(state, ctx);
        if (huntScore > 0) {
            push(this._goalHuntLikelyFlag(this, state, ctx), huntScore, 'hunt');
        }
        const defendScore = this._scoreDefendFlag(state, ctx);
        if (defendScore > 0) {
            push(this._goalDefendFlag(this, state, ctx), defendScore, 'defend');
        }
        const guardScore = this._scoreGuardFlag(state, ctx);
        if (guardScore > 0) {
            push(this._goalGuardFlag(this, state, ctx), guardScore, 'guard');
        }
        const killScore = this._scoreKillRevealed(state, ctx);
        if (killScore > 0) {
            push(this._goalKillRevealed(this, state, ctx), killScore, 'kill');
        }
        if (this._scoreEncircle(state, ctx) > 0) {
            push(this._goalEncircle(this, state, ctx), 320, 'encircle');
        }
        if (this._scoreRecon(state, ctx) > 0) {
            push(this._goalRecon(this, state, ctx), 400, 'recon');
        }
        if (this._scoreFlankPressure(state, ctx) > 0) {
            push(this._goalFlankPressure(this, state, ctx), 260, 'flank');
        }

        const backup = this._topPurposefulMoves(state, ctx, 3);
        for (const bm of backup) {
            push(bm, 120, 'develop');
        }

        return pool;
    },

    // =========================================================================
    //  GOAL SCORES
    // =========================================================================

    _scoreCaptureFlag(state, ctx) {
        return ctx.playerFlag && ctx.playerFlag.revealed ? 1000 : 0;
    },

    _scoreHuntLikelyFlag(state, ctx) {
        if (!ctx.topSuspect) {
            return 0;
        }
        if (ctx.suspectProb < this.HIGH_CERTAINTY_PROB) {
            return 0;
        }
        return 650 + Math.floor(ctx.suspectProb * 250);
    },

    _scoreDefendFlag(state, ctx) {
        if (!ctx.aiFlag) {
            return 0;
        }
        let maxThreat = 0;

        for (const enemy of ctx.revealedEnemies) {
            const dist = this._chebyshev(enemy, ctx.aiFlag);
            if (dist <= this.DEFEND_RANGE) {
                let threat = 920 - dist * 70;
                if (dist <= 1) {
                    threat += 220;
                }
                if (threat > maxThreat) {
                    maxThreat = threat;
                }
            }
        }

        for (const enemy of ctx.hiddenEnemies) {
            const dist = this._chebyshev(enemy, ctx.aiFlag);
            if (dist > this.DEFEND_RANGE) {
                continue;
            }
            const probs = this._beliefProbs(enemy.id);
            if (!probs) {
                continue;
            }
            const hostile = (probs.rock || 0)
                + (probs.paper || 0)
                + (probs.scissors || 0)
                + (probs.trap || 0);
            if (hostile < 0.4) {
                continue;
            }
            const threat = Math.floor((720 - dist * 60) * hostile);
            if (threat > maxThreat) {
                maxThreat = threat;
            }
        }
        return maxThreat;
    },

    _scoreGuardFlag(state, ctx) {
        if (!ctx.aiFlag) {
            return 0;
        }
        const audit = this._auditFlagRing(state, ctx.aiFlag);
        if (audit.defenders >= 2 && audit.diversity >= 2) {
            return 0;
        }
        let urgency = 350;
        if (ctx.revealedEnemies.length > 0) {
            urgency += 80;
        }
        if (audit.defenders === 0) {
            urgency += 100;
        }
        return urgency;
    },

    _scoreKillRevealed(state, ctx) {
        if (ctx.revealedEnemies.length === 0) {
            return 0;
        }
        let score = 560;
        if (ctx.safeKills.length > 0) {
            score += 240;
        }
        return score;
    },

    _scoreEncircle(state, ctx) {
        if (ctx.revealedEnemies.length === 0) {
            return 0;
        }
        return 320;
    },

    _scoreRecon(state, ctx) {
        return ctx.turn <= this.RECON_UNTIL_TURN ? 400 : 0;
    },

    _scoreFlankPressure(state, ctx) {
        const cols = this._columnLoad(state);
        const weakLoad = Math.min(...cols);
        if (weakLoad === Infinity) {
            return 0;
        }
        return 250 + (8 - weakLoad) * 5;
    },

    // =========================================================================
    //  GOAL PLAYERS
    // =========================================================================

    _goalCaptureFlag(fox, state, ctx) {
        if (!ctx.playerFlag || !ctx.playerFlag.revealed) {
            return null;
        }
        const captures = aiEngine.findFlagCaptureMoves(state, ctx.available);
        if (captures.length > 0) {
            return aiEngine.pickBestScored(captures, state);
        }
        return fox._approach(state, ctx, ctx.playerFlag.row, ctx.playerFlag.col);
    },

    _goalHuntLikelyFlag(fox, state, ctx) {
        if (!ctx.topSuspect || ctx.suspectProb < fox.HIGH_CERTAINTY_PROB) {
            return null;
        }
        const target = ctx.topSuspect.piece;
        const hunter = fox._pickHunter(ctx.available, target, ctx.aiFlag);
        if (!hunter) {
            return null;
        }
        if (!aiTacticalCore.safeToLeave(state, hunter)) {
            return null;
        }
        return fox._stepToward(state, hunter, target.row, target.col, ctx);
    },

    _goalDefendFlag(fox, state, ctx) {
        if (!ctx.aiFlag) {
            return null;
        }

        const defenseMoves = aiEngine.findFlagDefenseMoves(state, ctx.available);
        if (defenseMoves.length > 0) {
            return aiEngine.pickBestScored(defenseMoves, state);
        }

        const threats = ctx.revealedEnemies
            .map(enemy => ({ enemy, dist: fox._chebyshev(enemy, ctx.aiFlag) }))
            .filter(entry => entry.dist <= fox.DEFEND_RANGE)
            .sort((a, b) => a.dist - b.dist);
        if (threats.length === 0) {
            return fox._goalGuardFlag(fox, state, ctx);
        }

        const threat = threats[0].enemy;
        const counterType = fox._counterType(fox._visibleType(threat));

        if (counterType) {
            const counters = ctx.available
                .filter(p =>
                    p.type === 'piece'
                        && p.pieceType === counterType
                        && !p.immobilized
                )
                .sort((a, b) =>
                    fox._chebyshev(a, threat) - fox._chebyshev(b, threat)
                );
            for (const counter of counters) {
                const step = fox._stepToward(state, counter, threat.row, threat.col, ctx);
                if (step) {
                    return step;
                }
            }
        }

        const defenders = ctx.available
            .filter(p => p.type === 'piece' && !p.immobilized)
            .sort((a, b) =>
                fox._chebyshev(a, threat) - fox._chebyshev(b, threat)
            );
        for (const defender of defenders) {
            const step = fox._stepToward(state, defender, threat.row, threat.col, ctx);
            if (step) {
                return step;
            }
        }
        return null;
    },

    _goalGuardFlag(fox, state, ctx) {
        if (!ctx.aiFlag) {
            return null;
        }
        const audit = fox._auditFlagRing(state, ctx.aiFlag);
        if (audit.defenders >= 2 && audit.diversity >= 2) {
            return null;
        }

        const needTypes = ['rock', 'paper', 'scissors'].filter(t =>
            !audit.types.has(t)
        );

        const candidates = ctx.available.filter(p =>
            p.type === 'piece' && !p.immobilized
        );
        if (candidates.length === 0) {
            return null;
        }

        let best = null;
        let bestScore = -Infinity;
        for (const piece of candidates) {
            const distNow = fox._chebyshev(piece, ctx.aiFlag);
            if (distNow <= 1) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, state);
            for (const m of moves) {
                const cell = state.board[m.row][m.col];
                if (cell) {
                    continue;
                }
                const newDist = Math.max(
                    Math.abs(m.row - ctx.aiFlag.row),
                    Math.abs(m.col - ctx.aiFlag.col)
                );
                if (newDist > 2) {
                    continue;
                }
                let score = (distNow - newDist) * 80;
                if (newDist === 1) {
                    score += 120;
                }
                if (needTypes.includes(piece.pieceType)) {
                    score += 90;
                }
                if (audit.defenders === 0) {
                    score += 60;
                }
                if (aiEngine.isShuttlePosition(piece.id, m.row, m.col)) {
                    score -= 200;
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = { piece, row: m.row, col: m.col };
                }
            }
        }
        return best;
    },

    _goalKillRevealed(fox, state, ctx) {
        const guaranteed = aiEngine.findGuaranteedKills(state, ctx.available);
        if (guaranteed.length === 0) {
            return null;
        }
        const survivors = guaranteed.filter(k =>
            aiTacticalCore.safeToLeave(state, k.piece)
        );
        const pool = survivors.length > 0 ? survivors : guaranteed;
        return aiEngine.pickBestScored(pool, state);
    },

    _goalEncircle(fox, state, ctx) {
        if (ctx.revealedEnemies.length === 0) {
            return null;
        }
        let best = null;
        let bestScore = -Infinity;

        for (const enemy of ctx.revealedEnemies) {
            const enemyType = fox._visibleType(enemy);
            const winnerType = fox._counterType(enemyType);
            if (!winnerType) {
                continue;
            }
            const winners = ctx.available.filter(p =>
                p.type === 'piece'
                    && p.pieceType === winnerType
                    && !p.immobilized
            );
            if (winners.length === 0) {
                continue;
            }
            const closest = fox._closestTo(winners, enemy.row, enemy.col);
            if (!closest) {
                continue;
            }
            if (!aiTacticalCore.safeToLeave(state, closest)) {
                continue;
            }
            const distance = fox._chebyshev(closest, enemy);
            const score = 500 - distance * 30;
            if (score > bestScore) {
                const step = fox._stepToward(state, closest, enemy.row, enemy.col, ctx);
                if (step) {
                    bestScore = score;
                    best = step;
                }
            }
        }
        return best;
    },

    _goalRecon(fox, state, ctx) {
        const scouts = ctx.available.filter(p =>
            p.type === 'piece' && p.row <= 1 && !p.immobilized
        );
        if (scouts.length === 0) {
            return null;
        }
        const centerOrder = [3, 4, 2, 5, 1, 6, 0, 7];
        for (const col of centerOrder) {
            const scout = scouts
                .filter(p => Math.abs(p.col - col) <= 1)
                .sort((a, b) => Math.abs(a.col - col) - Math.abs(b.col - col))[0];
            if (!scout) {
                continue;
            }
            const targetRow = Math.min(scout.row + 2, BOARD_HEIGHT - 2);
            const step = fox._stepToward(state, scout, targetRow, col, ctx);
            if (step) {
                return step;
            }
        }
        return null;
    },

    _goalFlankPressure(fox, state, ctx) {
        const cols = fox._columnLoad(state);
        let weakCol = 0;
        let weakLoad = Infinity;
        for (let c = 0; c < BOARD_WIDTH; c++) {
            if (cols[c] < weakLoad) {
                weakLoad = cols[c];
                weakCol = c;
            }
        }
        const pushers = ctx.available.filter(p =>
            p.type === 'piece' && !p.immobilized && p.row <= 2
        );
        if (pushers.length === 0) {
            return null;
        }
        const chosen = fox._closestTo(pushers, BOARD_HEIGHT - 1, weakCol);
        if (!chosen) {
            return null;
        }
        if (!aiTacticalCore.safeToLeave(state, chosen)) {
            return null;
        }
        const targetRow = Math.min(chosen.row + 2, BOARD_HEIGHT - 2);
        return fox._stepToward(state, chosen, targetRow, weakCol, ctx);
    },

    // =========================================================================
    //  LOW-LEVEL ACTIONS
    // =========================================================================

    _approach(state, ctx, targetRow, targetCol) {
        const candidates = ctx.available
            .filter(p => p.type === 'piece' && !p.immobilized)
            .map(p => ({
                piece: p,
                dist: this._chebyshev(p, { row: targetRow, col: targetCol })
            }))
            .sort((a, b) => a.dist - b.dist);

        for (const { piece } of candidates) {
            if (!aiTacticalCore.safeToLeave(state, piece)) {
                continue;
            }
            const step = this._stepToward(state, piece, targetRow, targetCol, ctx);
            if (step) {
                return step;
            }
        }
        return null;
    },

    _stepToward(state, piece, targetRow, targetCol, ctx) {
        const moves = aiEngine.getMovesForPiece(piece, state);
        if (moves.length === 0) {
            return null;
        }

        let best = null;
        let bestScore = -Infinity;
        const baseDist = this._chebyshev(piece, { row: targetRow, col: targetCol });
        const myType = this._ownType(piece);
        const flagThreatPresent = ctx
            && ctx.aiFlag
            && (ctx.flagThreats.length > 0
                || ctx.nearFlagThreats.length > 0
                || ctx.revealedEnemies.some(e => this._chebyshev(e, ctx.aiFlag) <= 3));

        for (const m of moves) {
            const target = state.board[m.row] && state.board[m.row][m.col];

            if (target && target.owner === PLAYER && target.revealed) {
                const theirType = this._visibleType(target);
                if (myType && theirType && this._losesTo(myType, theirType)) {
                    continue;
                }
            }

            if (piece.type === TRAP && !this._isTrapMoveAllowed(piece, m, target)) {
                continue;
            }

            const newDist = this._chebyshev(
                { row: m.row, col: m.col },
                { row: targetRow, col: targetCol }
            );
            let score = (baseDist - newDist) * 100;
            if (newDist === 0) {
                score += 1000;
            }

            const recentMoves = aiEngine.countRecentMovesOfPiece(piece.id, 4);
            if (aiEngine.isShuttlePosition(piece.id, m.row, m.col)
                && recentMoves >= 1) {
                score -= this.SHUTTLE_PENALTY;
            }

            if (target && target.owner === PLAYER) {
                if (target.revealed) {
                    const theirType = this._visibleType(target);
                    if (myType && theirType && this._beats(myType, theirType)) {
                        score += 280;
                    }
                } else if (target.type !== FLAG && myType) {
                    const ev = this._attackEV(myType, target);
                    if (ev < -150) {
                        continue;
                    }
                    score += ev * 0.6;
                }
            }

            const clusterPenalty = aiTacticalCore.clusterPenalty(state, piece, {
                row: m.row,
                col: m.col
            });
            score -= clusterPenalty;

            if (flagThreatPresent) {
                const distBefore = this._chebyshev(piece, ctx.aiFlag);
                const distAfter = this._chebyshev({ row: m.row, col: m.col }, ctx.aiFlag);
                if (distAfter < distBefore) {
                    score += 160;
                }
            }

            const hasClearPurpose =
                (ctx.playerFlag
                    && this._chebyshev({ row: m.row, col: m.col }, ctx.playerFlag) < baseDist)
                || (target && target.owner === PLAYER)
                || (m.row < piece.row);

            if (!hasClearPurpose) {
                score -= 120;
            }

            score += this._fistBonus(state, piece, m);

            if (score > bestScore) {
                bestScore = score;
                best = { piece, row: m.row, col: m.col };
            }
        }
        return best;
    },

    _pickHunter(available, target, aiFlag) {
        let best = null;
        let bestDist = Infinity;
        for (const piece of available) {
            if (piece.type !== 'piece' || piece.immobilized) {
                continue;
            }
            if (aiFlag && piece.id === aiFlag.id) {
                continue;
            }
            const dist = Math.max(
                Math.abs(piece.row - target.row),
                Math.abs(piece.col - target.col)
            );
            if (dist < bestDist) {
                bestDist = dist;
                best = piece;
            }
        }
        return best;
    },

    // =========================================================================
    //  CANDIDATE SCORING + 2-PLY LOOKAHEAD
    // =========================================================================

    _pickWithLookahead(state, candidates, ctx) {
        if (candidates.length === 0) {
            return null;
        }

        const ranked = candidates.slice()
            .sort((a, b) => b.goalPrior - a.goalPrior)
            .slice(0, this.LOOKAHEAD_TOP_K);

        let bestMove = null;
        let bestScore = -Infinity;
        for (const cand of ranked) {
            const score = this._scoreCandidate(state, cand, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestMove = cand.move;
            }
        }
        return bestMove;
    },

    _scoreCandidate(state, candidate, ctx) {
        const { move, goalPrior } = candidate;
        let score = goalPrior;

        const target = state.board[move.row] && state.board[move.row][move.col];
        const myType = this._ownType(move.piece);

        if (target && target.owner === PLAYER) {
            if (target.type === FLAG && target.revealed) {
                score += 10000;
            } else if (target.revealed && target.type === 'piece') {
                const theirType = this._visibleType(target);
                if (myType && theirType && this._beats(myType, theirType)) {
                    score += 400;
                } else if (myType && theirType && this._losesTo(myType, theirType)) {
                    score -= 450;
                }
            } else if (!target.revealed
                && target.type !== FLAG
                && myType) {
                score += this._attackEV(myType, target) * 0.8;
            }
        }

        if (myType) {
            score += this._fistBonus(state, move.piece, move);
        }

        score -= this._flagExposurePenalty(state, move, ctx);

        const recentMoves = aiEngine.countRecentMovesOfPiece(move.piece.id, 4);
        if (aiEngine.isShuttlePosition(move.piece.id, move.row, move.col)
            && recentMoves >= 1) {
            score -= 300;
        }

        const cluster = aiTacticalCore.clusterPenalty(state, move.piece, move);
        score -= cluster;

        score += this._opponentReplyAdjustment(state, move, ctx);

        // Anti-draw pressure: escalate aggression as the no-capture timer grows.
        // Fox scores its moves through this pipeline rather than evaluateMoveV2,
        // so the pressure must be injected here to actually influence decisions.
        score += aiEngine.getDrawPressureBonus(move, state);

        return score;
    },

    _opponentReplyAdjustment(state, move, ctx) {
        let nextState;
        try {
            nextState = aiEngine.makeVirtualMove(state, move);
        } catch (e) {
            return 0;
        }
        if (!nextState) {
            return 0;
        }

        const ourFlag = nextState.aiPieces.find(p =>
            p.type === FLAG && !p.removed
        );
        if (!ourFlag) {
            return -10000;
        }

        const enemyMoves = aiEngine.getAllPossibleMoves(nextState, PLAYER);
        if (enemyMoves.length === 0) {
            return 0;
        }

        let worst = 0;
        const limit = Math.min(this.LOOKAHEAD_OPPONENT_K * 4, enemyMoves.length);
        const sample = enemyMoves.slice(0, limit);

        for (const em of sample) {
            const threat = this._scoreEnemyThreat(nextState, em, ourFlag, move.piece);
            if (threat < worst) {
                worst = threat;
            }
            if (worst <= -1500) {
                break;
            }
        }

        return worst;
    },

    _scoreEnemyThreat(state, enemyMove, ourFlag, ourMovedPiece) {
        let penalty = 0;
        if (!enemyMove || !enemyMove.piece) {
            return 0;
        }
        const target = state.board[enemyMove.row]
            && state.board[enemyMove.row][enemyMove.col];

        if (target && target.owner === COMPUTER) {
            if (target.type === FLAG) {
                if (enemyMove.piece.type !== FLAG) {
                    penalty -= 5000;
                }
            } else if (target.type === TRAP) {
                penalty += 200;
            } else if (target.type === 'piece'
                && target.revealed
                && enemyMove.piece.type === 'piece'
                && enemyMove.piece.revealed) {
                const result = aiEngine.resolveBattle(
                    enemyMove.piece.pieceType,
                    target.pieceType
                );
                if (result === 'win') {
                    let loss = 250;
                    if (ourMovedPiece && target.id === ourMovedPiece.id) {
                        loss += 100;
                    }
                    penalty -= loss;
                }
            }
        }

        const distToFlag = Math.max(
            Math.abs(enemyMove.row - ourFlag.row),
            Math.abs(enemyMove.col - ourFlag.col)
        );
        if (distToFlag === 1) {
            const canBeStopped = this._defendableNextTurn(state, enemyMove, ourFlag);
            if (!canBeStopped) {
                penalty -= 700;
            } else {
                penalty -= 250;
            }
        } else if (distToFlag === 2) {
            penalty -= 80;
        }

        return penalty;
    },

    _defendableNextTurn(state, enemyMove, ourFlag) {
        for (const piece of state.aiPieces) {
            if (piece.removed || piece.row < 0 || piece.immobilized) {
                continue;
            }
            if (piece.type === FLAG) {
                continue;
            }
            const reach = Math.max(
                Math.abs(piece.row - enemyMove.row),
                Math.abs(piece.col - enemyMove.col)
            );
            if (reach > 1) {
                continue;
            }
            if (piece.type === TRAP) {
                return true;
            }
            if (piece.type === 'piece'
                && enemyMove.piece.revealed
                && enemyMove.piece.pieceType
                && piece.pieceType) {
                const r = aiEngine.resolveBattle(piece.pieceType, enemyMove.piece.pieceType);
                if (r === 'win' || r === 'draw') {
                    return true;
                }
            } else if (piece.type === 'piece') {
                return true;
            }
        }
        return false;
    },

    // =========================================================================
    //  FLAG-SAFETY + FIST + EV HELPERS
    // =========================================================================

    _flagExposurePenalty(state, move, ctx) {
        if (!ctx.aiFlag) {
            return 0;
        }
        if (move.piece.type === FLAG) {
            const cur = aiEngine.evaluateFlagMove(
                move.piece, move.piece.row, move.piece.col, state
            );
            const after = aiEngine.evaluateFlagMove(
                move.piece, move.row, move.col, state
            );
            return Math.max(0, cur - after) * 1.2;
        }
        if (!aiTacticalCore.safeToLeave(state, move.piece)) {
            if (move.piece.type === TRAP) {
                return 600;
            }
            const goingAway = this._chebyshev({ row: move.row, col: move.col }, ctx.aiFlag)
                > this._chebyshev(move.piece, ctx.aiFlag);
            if (goingAway) {
                return 700;
            }
            return 250;
        }
        return 0;
    },

    _fistBonus(state, piece, move) {
        if (!piece || piece.type !== 'piece' || !piece.pieceType) {
            return 0;
        }
        const myType = piece.pieceType;
        const seen = new Set([myType]);
        let alliesInR2 = 0;
        for (const ally of state.aiPieces) {
            if (ally.removed
                || ally.row < 0
                || ally.id === piece.id
                || ally.type !== 'piece'
                || !ally.pieceType
                || ally.immobilized) {
                continue;
            }
            const dist = Math.max(
                Math.abs(ally.row - move.row),
                Math.abs(ally.col - move.col)
            );
            if (dist <= 2) {
                seen.add(ally.pieceType);
                alliesInR2++;
            }
        }
        let bonus = 0;
        if (seen.size >= 2) {
            bonus += 90;
        }
        if (seen.size >= 3) {
            bonus += 60;
        }
        if (alliesInR2 === 0) {
            bonus -= 60;
        }
        return bonus;
    },

    _attackEV(myType, hiddenTarget) {
        const probs = this._beliefProbs(hiddenTarget.id);
        if (!probs) {
            return 0;
        }
        let ev = 0;
        for (const opt of ['rock', 'paper', 'scissors']) {
            const p = probs[opt] || 0;
            if (p <= 0) {
                continue;
            }
            const result = aiEngine.resolveBattle(myType, opt);
            if (result === 'win') {
                ev += p * 500;
            } else if (result === 'lose') {
                ev += p * -450;
            } else {
                ev += p * -50;
            }
        }
        ev += (probs.trap || 0) * -450;
        ev += (probs.flag || 0) * 10000;
        return ev;
    },

    _isTrapMoveAllowed(piece, move, target) {
        if (target && target.owner === PLAYER) {
            if (target.type === FLAG && target.revealed) {
                return true;
            }
            if (target.revealed && target.type === 'piece') {
                return true;
            }
            return false;
        }
        return true;
    },

    _auditFlagRing(state, aiFlag) {
        const types = new Set();
        let defenders = 0;
        let hasTrap = false;
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const r = aiFlag.row + dRow;
            const c = aiFlag.col + dCol;
            if (!aiEngine.isValidPosition(r, c)) {
                continue;
            }
            const ally = state.board[r][c];
            if (!ally
                || ally.owner !== COMPUTER
                || ally.removed
                || ally.immobilized
                || ally.type === FLAG) {
                continue;
            }
            defenders++;
            if (ally.type === TRAP) {
                hasTrap = true;
            } else if (ally.pieceType) {
                types.add(ally.pieceType);
            }
        }
        return { defenders, types, diversity: types.size, hasTrap };
    },

    // =========================================================================
    //  ANTI-PASSIVITY FALLBACK
    // =========================================================================

    _topPurposefulMoves(state, ctx, k) {
        const pool = ctx.shuttleSafe.length > 0 ? ctx.shuttleSafe : ctx.allMoves;
        const scored = [];

        const suspect = ctx.topSuspect ? ctx.topSuspect.piece : null;
        const forbidLowPurpose = ctx.safeKills.length > 0
            || (ctx.suspectProb >= 0.5 && suspect)
            || ctx.flagThreats.length > 0
            || ctx.nearFlagThreats.length > 0;

        for (const m of pool) {
            if (m.piece.type === TRAP) {
                const target = state.board[m.row] && state.board[m.row][m.col];
                if (!this._isTrapMoveAllowed(m.piece, m, target)) {
                    continue;
                }
            }
            if (m.piece.type !== FLAG
                && !aiTacticalCore.safeToLeave(state, m.piece)
                && (ctx.flagThreats.length > 0
                    || ctx.nearFlagThreats.length > 0)) {
                continue;
            }

            let score = aiEngine.evaluateMoveV2(m, state);
            score -= aiTacticalCore.clusterPenalty(state, m.piece, m);

            const towardEnemyFlag = ctx.playerFlag
                ? this._chebyshev(m.piece, ctx.playerFlag)
                    - this._chebyshev({ row: m.row, col: m.col }, ctx.playerFlag)
                : 0;
            const towardSuspect = suspect
                ? this._chebyshev(m.piece, suspect)
                    - this._chebyshev({ row: m.row, col: m.col }, suspect)
                : 0;

            const forwardProgress = Math.max(0, (2 - m.piece.row) * 8);
            score += towardEnemyFlag * 25;
            score += towardSuspect * 22;
            score += forwardProgress;

            if (aiEngine.isShuttlePosition(m.piece.id, m.row, m.col)) {
                score -= this.SHUTTLE_PENALTY;
            }

            const purposeful =
                (suspect
                    && this._chebyshev({ row: m.row, col: m.col }, suspect)
                        < this._chebyshev(m.piece, suspect))
                || (ctx.playerFlag
                    && this._chebyshev({ row: m.row, col: m.col }, ctx.playerFlag)
                        < this._chebyshev(m.piece, ctx.playerFlag))
                || (state.board[m.row]
                    && state.board[m.row][m.col]
                    && state.board[m.row][m.col].owner === PLAYER)
                || (ctx.aiFlag
                    && this._chebyshev({ row: m.row, col: m.col }, ctx.aiFlag)
                        < this._chebyshev(m.piece, ctx.aiFlag)
                    && (ctx.flagThreats.length > 0
                        || ctx.nearFlagThreats.length > 0))
                || (m.piece.row < 2 && m.row > m.piece.row);

            if (!purposeful) {
                if (forbidLowPurpose) {
                    continue;
                }
                score -= this.PURPOSE_PENALTY;
            }

            score += this._fistBonus(state, m.piece, m);

            scored.push({ move: m, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k).map(s => s.move);
    },

    _fallbackDevelop(state, ctx) {
        const top = this._topPurposefulMoves(state, ctx, 1);
        if (top.length > 0) {
            return top[0];
        }
        const pool = ctx.shuttleSafe.length > 0 ? ctx.shuttleSafe : ctx.allMoves;
        let best = null;
        let bestScore = -Infinity;
        for (const m of pool) {
            const score = aiEngine.evaluateMoveV2(m, state)
                - aiTacticalCore.clusterPenalty(state, m.piece, m);
            if (score > bestScore) {
                bestScore = score;
                best = m;
            }
        }
        return best;
    },

    // =========================================================================
    //  HELPERS
    // =========================================================================

    _chebyshev(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    },

    _visibleType(piece) {
        if (!piece) {
            return null;
        }
        if (piece.type === 'piece') {
            return piece.revealed ? piece.pieceType : null;
        }
        return piece.type;
    },

    _ownType(piece) {
        if (!piece) {
            return null;
        }
        if (piece.type === 'piece') {
            return piece.pieceType || null;
        }
        return piece.type;
    },

    _counterType(enemyType) {
        if (enemyType === 'rock') {
            return 'paper';
        }
        if (enemyType === 'paper') {
            return 'scissors';
        }
        if (enemyType === 'scissors') {
            return 'rock';
        }
        return null;
    },

    _beats(a, b) {
        return GAME_CONFIG.WIN_CONDITIONS[a] === b;
    },

    _losesTo(a, b) {
        return GAME_CONFIG.WIN_CONDITIONS[b] === a;
    },

    _closestTo(pieces, row, col) {
        let best = null;
        let bestDist = Infinity;
        for (const p of pieces) {
            const dist = this._chebyshev(p, { row, col });
            if (dist < bestDist) {
                bestDist = dist;
                best = p;
            }
        }
        return best;
    },

    _columnLoad(state) {
        const load = new Array(BOARD_WIDTH).fill(0);
        for (const p of state.playerPieces) {
            if (p.removed || p.row < 0 || p.immobilized) {
                continue;
            }
            load[p.col] += 1;
        }
        return load;
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = foxBot;
}

if (typeof RPSBotAPI !== 'undefined'
    && RPSBotAPI
    && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(foxBot);
} else {
    throw new Error('[fox] RPSBotAPI.defineBot is required (bot-api.js must be earlier in the page)');
}
