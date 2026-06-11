/**
 * codex 5.3 Medium
 *
 * Author: Codex 5.3
 *
 * Concept: a layered competitive bot that combines hard tactical obligations,
 * expert search, and a belief-aware evaluator for robust decisions in hidden-information play.
 *
 * "This bot is a demonstration of what Codex 5.3 can do in designing
 * advanced algorithms for imperfect-information tactical games.
 * It is named after its creator."
 */
if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[codex_5_3_medium] bot-api.js must be loaded BEFORE this bot');
}

const codex53MediumBot = {
    id: 'codex_5_3_medium',
    name: 'Codex 5.3',
    emoji: '⚡',
    avatar: 'js/bots/codex_5_3_medium/avatar-min.png',
    shortDescription: 'Тактическое слияние, контроль давления и безопасный просмотр',
    longDescription: 'Тактика плюс экспертный поиск. Симулирует ответы соперника, бережёт флаг.',
    algorithmLabel: 'Тактическое слияние + топ-K ответы',
    modelAuthor: 'OpenAI · Codex 5.3',
    tier: 'medium',
    stars: 2,
    difficultyLabel: 'Средний',
    tags: ['codex', 'search', 'beliefs', 'tactical', 'adaptive'],

    _turn: 0,
    _enemyMemory: new Map(),
    _lookaheadTopK: 8,
    _replySampleLimitSafe: 12,
    _replySampleLimitPressure: 18,

    move(gameState) {
        try {
            this._turn += 1;
            this._syncEnemyMemory(gameState);
            this._updateSharedSystems(gameState);

            const availablePieces = this._getAvailablePieces(gameState);
            if (availablePieces.length === 0) {
                return null;
            }

            const strategicContext = this._buildStrategicContext(gameState, availablePieces);
            const candidates = this._collectCandidates(gameState, availablePieces, strategicContext);
            if (candidates.length === 0) {
                return null;
            }

            const bestMove = this._pickBestMove(gameState, candidates, strategicContext);
            if (bestMove
                && typeof aiEngine !== 'undefined'
                && aiEngine
                && typeof aiEngine.recordAIMove === 'function') {
                aiEngine.recordAIMove(bestMove);
            }

            return bestMove;
        } catch (error) {
            console.error('[codex_5_3_medium] move() failed:', error);
            return null;
        }
    },

    chooseFlagAndTrap() {
        this._turn = 0;
        this._enemyMemory.clear();

        const templates = [
            { flagIndex: 0, trapIndex: 9 },
            { flagIndex: 0, trapIndex: 10 },
            { flagIndex: 7, trapIndex: 14 },
            { flagIndex: 7, trapIndex: 13 },
            { flagIndex: 1, trapIndex: 8 },
            { flagIndex: 1, trapIndex: 10 },
            { flagIndex: 6, trapIndex: 15 },
            { flagIndex: 6, trapIndex: 13 },
            { flagIndex: 2, trapIndex: 9 },
            { flagIndex: 5, trapIndex: 14 },
            { flagIndex: 3, trapIndex: 10 },
            { flagIndex: 4, trapIndex: 13 },
            { flagIndex: 2, trapIndex: 11 },
            { flagIndex: 5, trapIndex: 12 }
        ];

        let pick = templates[Math.floor(Math.random() * templates.length)];
        if (Math.random() < 0.3) {
            pick = this._mirrorSetup(pick);
        }

        return {
            flagIndex: pick.flagIndex,
            trapIndex: pick.trapIndex
        };
    },

    _syncEnemyMemory(gameState) {
        const seenIds = new Set();
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.col < 0) {
                continue;
            }

            seenIds.add(enemy.id);
            const prev = this._enemyMemory.get(enemy.id);
            const stillness = (!prev || (prev.row !== enemy.row || prev.col !== enemy.col))
                ? 0
                : (prev.stillness + 1);

            this._enemyMemory.set(enemy.id, {
                id: enemy.id,
                row: enemy.row,
                col: enemy.col,
                stillness,
                moved: !!(prev && (prev.row !== enemy.row || prev.col !== enemy.col)),
                revealed: !!enemy.revealed,
                type: enemy.type,
                pieceType: enemy.pieceType || null
            });
        }

        for (const id of this._enemyMemory.keys()) {
            if (!seenIds.has(id)) {
                this._enemyMemory.delete(id);
            }
        }
    },

    _updateSharedSystems(gameState) {
        if (typeof aiEngine !== 'undefined' && aiEngine) {
            if (aiEngine.positionCache && typeof aiEngine.positionCache.clear === 'function') {
                aiEngine.positionCache.clear();
            }
            if (typeof aiEngine.analyzePlayerPattern === 'function') {
                aiEngine.analyzePlayerPattern(gameState);
            }
            if (typeof aiEngine.trackEnemyStillness === 'function') {
                aiEngine.trackEnemyStillness(gameState);
            }
            if (typeof aiEngine.updateStrategicTargets === 'function') {
                aiEngine.updateStrategicTargets(gameState);
            }
        }

        if (typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && typeof aiBeliefs.applyConstraints === 'function') {
            aiBeliefs.applyConstraints(gameState);
        }
    },

    _getAvailablePieces(gameState) {
        if (typeof aiEngine !== 'undefined'
            && aiEngine
            && typeof aiEngine.getActivePieces === 'function') {
            return aiEngine.getActivePieces(gameState);
        }

        return gameState.aiPieces.filter(piece =>
            !piece.removed
            && !piece.immobilized
            && piece.row >= 0
            && piece.col >= 0
        );
    },

    _buildStrategicContext(gameState, availablePieces) {
        const fallback = this._deduceFlagCandidatesFromMemory(gameState, 4);
        const beliefs = this._deduceFlagCandidatesFromBeliefs(gameState, 4);
        const topFlagCandidates = this._mergeFlagCandidates(beliefs, fallback, 4);
        const myFlag = gameState.aiPieces.find(piece => piece.type === 'flag' && !piece.removed);
        const enemyPressure = this._countEnemyPressureNearFlag(gameState, myFlag);
        const hasHeavyPressure = enemyPressure >= 2;
        const topProb = topFlagCandidates.length > 0
            ? (topFlagCandidates[0].prob || 0)
            : 0;
        const revealedEnemyPieces = gameState.playerPieces.filter(piece =>
            !piece.removed
            && piece.row >= 0
            && piece.revealed
        ).length;
        const consolidateMode = this._turn >= 10 || revealedEnemyPieces >= 4;
        const huntEnabled = topProb >= 0.75 && enemyPressure < 2;
        let flagSafetyMultiplier = 1;
        if (enemyPressure >= 2) {
            flagSafetyMultiplier = 8;
        } else if (enemyPressure === 1) {
            flagSafetyMultiplier = 4;
        }

        return {
            availablePieces,
            topFlagCandidates,
            myFlag,
            enemyPressure,
            hasHeavyPressure,
            topProb,
            huntEnabled,
            flagSafetyMultiplier,
            consolidateMode,
            revealedEnemyPieces
        };
    },

    _collectCandidates(gameState, availablePieces, strategicContext) {
        const mandatory = [];
        const captures = [];
        const defenses = [];
        const guaranteedKills = [];
        const filtered = [];
        const safeFiltered = [];
        const experts = [];
        const addCandidate = (list, move, source) => {
            if (!this._isValidMoveShape(move)) {
                return;
            }
            if (!this._isMoveLegal(gameState, move)) {
                return;
            }
            list.push({ move, source });
        };

        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && typeof aiTacticalCore.getMandatoryMove === 'function') {
            const mandatoryMove = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: this._deduceFlagViaTacticalCore.bind(this),
                flagHuntHorizon: 4,
                antiCluster: true
            });
            addCandidate(mandatory, mandatoryMove, 'mandatory');
        }

        let hasDefenseMoves = false;
        if (typeof aiEngine !== 'undefined' && aiEngine) {
            if (typeof aiEngine.findFlagCaptureMoves === 'function') {
                const captureMoves = aiEngine.findFlagCaptureMoves(gameState, availablePieces);
                for (const capture of captureMoves) {
                    addCandidate(captures, capture, 'flag-capture');
                }
            }
            if (typeof aiEngine.findFlagDefenseMoves === 'function') {
                const defenseMoves = aiEngine.findFlagDefenseMoves(gameState, availablePieces);
                hasDefenseMoves = defenseMoves.length > 0;
                for (const defense of defenseMoves) {
                    addCandidate(defenses, defense, 'flag-defense');
                }
            }
            if (typeof aiEngine.findGuaranteedKills === 'function') {
                const kills = aiEngine.findGuaranteedKills(gameState, availablePieces);
                for (const kill of kills) {
                    addCandidate(guaranteedKills, kill, 'guaranteed-kill');
                }
            }
            if (typeof aiEngine.getAllFilteredMoves === 'function') {
                const pool = aiEngine.getAllFilteredMoves(gameState, availablePieces);
                for (const move of pool) {
                    addCandidate(filtered, move, 'filtered');
                }
            }
        }

        if (strategicContext.hasHeavyPressure) {
            let safeKeys = null;
            if (typeof aiEngine !== 'undefined'
                && aiEngine
                && typeof aiEngine.findSafeMoves === 'function') {
                const safePool = aiEngine.findSafeMoves(gameState, availablePieces);
                safeKeys = new Set(safePool.map(move => this._moveKey(move)));
            }

            for (const candidate of filtered) {
                if (safeKeys && !safeKeys.has(this._moveKey(candidate.move))) {
                    continue;
                }
                if (!this._isDefensiveSafeMove(gameState, candidate.move, strategicContext)) {
                    continue;
                }
                safeFiltered.push(candidate);
            }
        }

        const dangerGate = strategicContext.hasHeavyPressure || hasDefenseMoves;
        if (!dangerGate
            && typeof aiExpert !== 'undefined'
            && aiExpert
            && typeof aiExpert.move === 'function') {
            const expertMove = aiExpert.move(gameState);
            if (this._passesSafetySimulation(gameState, expertMove, strategicContext)) {
                addCandidate(experts, expertMove, 'expert');
            }
        }

        const candidateGroups = strategicContext.hasHeavyPressure
            ? [mandatory, captures, defenses, safeFiltered]
            : [mandatory, captures, defenses, guaranteedKills, filtered, experts];
        let merged = this._mergeUniqueCandidates(candidateGroups);

        if (merged.length === 0) {
            const fallbackMoves = this._buildFallbackMoves(gameState, availablePieces);
            for (const move of fallbackMoves) {
                addCandidate(merged, move, 'fallback');
            }
        }

        return merged;
    },

    _buildFallbackMoves(gameState, availablePieces) {
        const result = [];
        for (const piece of availablePieces) {
            const legalMoves = RPSBotAPI.getLegalMoves(piece, gameState);
            for (const cell of legalMoves) {
                result.push({
                    piece,
                    row: cell.row,
                    col: cell.col
                });
            }
        }
        return result;
    },

    _pickBestMove(gameState, candidates, strategicContext) {
        const scored = [];
        for (const candidate of candidates) {
            const tacticalScore = this._scoreMove(
                gameState,
                candidate.move,
                candidate.source,
                strategicContext
            );
            scored.push({
                move: candidate.move,
                source: candidate.source,
                score: tacticalScore
            });
        }

        if (scored.length === 0) {
            return null;
        }

        scored.sort((a, b) => b.score - a.score);
        const topK = Math.min(this._lookaheadTopK, scored.length);
        const considered = scored.slice(0, topK);
        if (considered.length === 1) {
            return considered[0].move;
        }

        let bestMove = considered[0].move;
        let bestTactical = considered[0].score;
        let bestDanger = Infinity;
        let bestComposite = -Infinity;
        const dangerWeight = strategicContext.hasHeavyPressure
            ? 1.8
            : (strategicContext.enemyPressure >= 1 ? 1.2 : 0.85);

        for (const entry of considered) {
            const danger = this._estimateEnemyReplyDanger(gameState, entry.move, strategicContext);
            if (strategicContext.hasHeavyPressure) {
                if (danger < bestDanger || (danger === bestDanger && entry.score > bestTactical)) {
                    bestDanger = danger;
                    bestTactical = entry.score;
                    bestMove = entry.move;
                }
                continue;
            }

            const composite = entry.score - danger * dangerWeight;
            if (composite > bestComposite) {
                bestComposite = composite;
                bestMove = entry.move;
                bestTactical = entry.score;
                bestDanger = danger;
            }
        }

        return bestMove;
    },

    _scoreMove(gameState, move, source, strategicContext) {
        let score = 0;
        const target = gameState.board[move.row] && gameState.board[move.row][move.col];
        const piece = move.piece;

        if (source === 'mandatory') {
            score += 200000;
        }
        if (source === 'flag-capture') {
            score += 190000;
        }
        if (source === 'flag-defense') {
            score += 165000;
        }
        if (source === 'guaranteed-kill') {
            score += 5200;
        }
        if (source === 'expert') {
            score += 250;
        }

        if (typeof aiEngine !== 'undefined'
            && aiEngine
            && typeof aiEngine.evaluateMoveV2 === 'function') {
            score += aiEngine.evaluateMoveV2(move, gameState);
        }

        score += this._scoreFlagSafetyContribution(gameState, move, strategicContext);
        score += this._scoreFlagHuntContribution(move, strategicContext);
        score += this._scoreLocalCoordination(gameState, move);
        score += this._scoreConsolidationContribution(gameState, move, strategicContext);

        if (target && target.owner === 'player') {
            score += this._scoreAttackContribution(piece, target);
        } else {
            score += this._scorePositionalContribution(piece, move, strategicContext);
        }

        if (typeof aiEngine !== 'undefined'
            && aiEngine
            && typeof aiEngine.isShuttlePosition === 'function'
            && aiEngine.isShuttlePosition(piece.id, move.row, move.col)) {
            score -= 600;
        }

        if (strategicContext.hasHeavyPressure
            && source !== 'mandatory'
            && source !== 'flag-capture'
            && source !== 'flag-defense') {
            score -= 1400;
        }

        if (strategicContext.hasHeavyPressure
            && strategicContext.myFlag
            && piece.type !== 'flag') {
            const before = this._chebyshev(piece.row, piece.col, strategicContext.myFlag.row, strategicContext.myFlag.col);
            const after = this._chebyshev(move.row, move.col, strategicContext.myFlag.row, strategicContext.myFlag.col);
            if (after > before) {
                score -= 450 * strategicContext.flagSafetyMultiplier;
            }
        }

        return score;
    },

    _scoreFlagSafetyContribution(gameState, move, strategicContext) {
        const myFlag = strategicContext.myFlag;
        if (!myFlag) {
            return 0;
        }

        const multiplier = strategicContext.flagSafetyMultiplier || 1;
        if (move.piece.id === myFlag.id) {
            const before = this._flagCellThreatScore(gameState, myFlag.row, myFlag.col);
            const after = this._flagCellThreatScore(gameState, move.row, move.col);
            return (before - after) * 120 * multiplier;
        }

        const before = this._chebyshev(move.piece.row, move.piece.col, myFlag.row, myFlag.col);
        const after = this._chebyshev(move.row, move.col, myFlag.row, myFlag.col);
        let score = 0;
        if (after < before) {
            score += 45 * multiplier;
        } else if (after > before && before <= 2) {
            score -= 70 * multiplier;
        }

        if (after <= 1 && move.piece.type === 'piece') {
            score += 28 * multiplier;
        }

        return score;
    },

    _scoreFlagHuntContribution(move, strategicContext) {
        if (!strategicContext.huntEnabled) {
            return 0;
        }

        const topFlagCandidates = strategicContext.topFlagCandidates;
        if (!topFlagCandidates || topFlagCandidates.length === 0) {
            return 0;
        }

        let total = 0;
        for (const entry of topFlagCandidates) {
            const target = entry.piece;
            const weight = entry.prob || entry.pFlag || 0;
            if (!target || weight <= 0) {
                continue;
            }

            const before = this._chebyshev(move.piece.row, move.piece.col, target.row, target.col);
            const after = this._chebyshev(move.row, move.col, target.row, target.col);
            total += (before - after) * 75 * weight;

            if (after === 0) {
                total += 1800 * weight;
            }
        }

        if (strategicContext.topProb >= 0.9) {
            total *= 1.2;
        }

        return total;
    },

    _scoreLocalCoordination(gameState, move) {
        if (move.piece.type !== 'piece' || !move.piece.pieceType) {
            return 0;
        }

        const desiredGuard = this._counterType(move.piece.pieceType);
        let support = 0;
        for (const ally of gameState.aiPieces) {
            if (ally.removed || ally.row < 0 || ally.id === move.piece.id) {
                continue;
            }
            const dist = this._chebyshev(ally.row, ally.col, move.row, move.col);
            if (dist > 2) {
                continue;
            }

            if (ally.type === 'trap' && !ally.immobilized) {
                support += 1.5;
                continue;
            }
            if (ally.type === 'piece' && ally.pieceType === desiredGuard) {
                support += 1;
            }
        }
        return support * 70;
    },

    _scoreConsolidationContribution(gameState, move, strategicContext) {
        if (!strategicContext.consolidateMode
            || !strategicContext.myFlag
            || move.piece.type !== 'piece') {
            return 0;
        }

        const myFlag = strategicContext.myFlag;
        const before = this._chebyshev(move.piece.row, move.piece.col, myFlag.row, myFlag.col);
        const after = this._chebyshev(move.row, move.col, myFlag.row, myFlag.col);
        let score = 0;
        if (after < before) {
            score += 120;
        } else if (after > before && before <= 3) {
            score -= 140;
        }

        const localSupport = this._countAlliesNearCell(
            gameState.aiPieces,
            move.piece.id,
            move.row,
            move.col,
            2
        );
        if (localSupport >= 2) {
            score += 75;
        } else if (localSupport === 0 && move.row >= 2) {
            score -= 160;
        }

        const target = gameState.board[move.row] && gameState.board[move.row][move.col];
        if (!target && move.row >= 3 && localSupport <= 1) {
            score -= 110;
        }

        return score;
    },

    _countAlliesNearCell(pieces, selfId, row, col, radius) {
        let allies = 0;
        for (const ally of pieces) {
            if (ally.removed || ally.row < 0 || ally.id === selfId) {
                continue;
            }
            const dist = this._chebyshev(ally.row, ally.col, row, col);
            if (dist <= radius) {
                allies += 1;
            }
        }
        return allies;
    },

    _scoreAttackContribution(attacker, target) {
        if (target.type === 'flag') {
            return 200000;
        }

        if (target.revealed && target.type === 'trap') {
            return -100000;
        }

        if (attacker.type === 'trap') {
            return 120;
        }

        if (attacker.type !== 'piece' || !attacker.pieceType) {
            return -80;
        }

        if (target.revealed && target.type === 'piece' && target.pieceType) {
            const result = RPSBotAPI.resolveBattle(attacker.pieceType, target.pieceType);
            if (result === 'win') {
                return 1200;
            }
            if (result === 'draw') {
                return 120;
            }
            return -120000;
        }

        if (!target.revealed) {
            return 80;
        }

        return 0;
    },

    _scorePositionalContribution(piece, move, strategicContext) {
        let score = 0;
        const forward = move.row - piece.row;
        score += forward * 11;

        const centerBefore = Math.abs(piece.row - 2.5) + Math.abs(piece.col - 3.5);
        const centerAfter = Math.abs(move.row - 2.5) + Math.abs(move.col - 3.5);
        score += (centerBefore - centerAfter) * 8;

        if (strategicContext.myFlag && piece.type === 'piece') {
            const beforeFlag = this._chebyshev(piece.row, piece.col, strategicContext.myFlag.row, strategicContext.myFlag.col);
            const afterFlag = this._chebyshev(move.row, move.col, strategicContext.myFlag.row, strategicContext.myFlag.col);
            if (strategicContext.consolidateMode) {
                if (afterFlag < beforeFlag) {
                    score += 65;
                } else if (afterFlag > beforeFlag && beforeFlag <= 3) {
                    score -= 90;
                }
            }

            if (strategicContext.hasHeavyPressure && afterFlag > beforeFlag) {
                score -= 120;
            }
        }

        return score;
    },

    _flagCellThreatScore(gameState, row, col) {
        let score = 0;
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) {
                continue;
            }
            if (enemy.type === 'flag') {
                continue;
            }

            const dist = this._chebyshev(enemy.row, enemy.col, row, col);
            if (dist === 1) {
                score += enemy.revealed ? 8 : 4;
            } else if (dist === 2) {
                score += enemy.revealed ? 3 : 1;
            }
        }
        return score;
    },

    _countEnemyPressureNearFlag(gameState, myFlag) {
        if (!myFlag) {
            return 0;
        }

        let pressure = 0;
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) {
                continue;
            }

            const dist = this._chebyshev(enemy.row, enemy.col, myFlag.row, myFlag.col);
            if (dist <= 2) {
                pressure += 1;
            }
        }
        return pressure;
    },

    _deduceFlagCandidatesFromBeliefs(gameState, limit) {
        if (typeof aiBeliefs === 'undefined'
            || !aiBeliefs
            || typeof aiBeliefs.getFlagCandidates !== 'function') {
            return [];
        }

        const candidates = aiBeliefs.getFlagCandidates(gameState, limit || 3);
        return candidates.map(entry => ({
            piece: entry.piece,
            prob: entry.pFlag
        }));
    },

    _deduceFlagCandidatesFromMemory(gameState, limit) {
        const hidden = gameState.playerPieces.filter(piece =>
            !piece.removed
            && piece.row >= 0
            && !piece.revealed
            && piece.type !== 'trap'
        );

        if (hidden.length === 0) {
            return [];
        }

        const scored = hidden.map(piece => {
            const memory = this._enemyMemory.get(piece.id);
            const stillness = memory ? memory.stillness : 0;
            let score = 1
                + Math.min(6, stillness) * 2;

            if (piece.row >= 4) {
                score += 2;
            }
            if (piece.row >= 5) {
                score += 2;
            }
            if (piece.col === 0 || piece.col === 7) {
                score += 1;
            }
            return { piece, score };
        });

        const total = scored.reduce((acc, entry) => acc + entry.score, 0) || 1;
        scored.sort((a, b) => b.score - a.score);

        return scored.slice(0, limit || 3).map(entry => ({
            piece: entry.piece,
            prob: entry.score / total
        }));
    },

    _deduceFlagViaTacticalCore(gameState) {
        const candidates = this._deduceFlagCandidatesFromBeliefs(gameState, 4);
        if (candidates.length > 0) {
            return {
                candidates,
                hiddenCount: gameState.playerPieces.filter(piece =>
                    !piece.removed
                    && piece.row >= 0
                    && !piece.revealed
                    && piece.type !== 'trap'
                ).length
            };
        }

        const fallback = this._deduceFlagCandidatesFromMemory(gameState, 4);
        return {
            candidates: fallback,
            hiddenCount: fallback.length
        };
    },

    _mirrorSetup(setup) {
        const flagRow = Math.floor(setup.flagIndex / 8);
        const flagCol = setup.flagIndex % 8;
        const trapRow = Math.floor(setup.trapIndex / 8);
        const trapCol = setup.trapIndex % 8;
        return {
            flagIndex: flagRow * 8 + (7 - flagCol),
            trapIndex: trapRow * 8 + (7 - trapCol)
        };
    },

    _moveKey(move) {
        return `${move.piece.id}:${move.row}:${move.col}`;
    },

    _mergeUniqueCandidates(groups) {
        const unique = new Map();
        for (const group of groups) {
            for (const candidate of group) {
                const key = this._moveKey(candidate.move);
                if (!unique.has(key)) {
                    unique.set(key, candidate);
                }
            }
        }
        return Array.from(unique.values());
    },

    _mergeFlagCandidates(primary, secondary, limit) {
        const merged = new Map();
        const pushEntries = (entries, weightFactor) => {
            for (const entry of entries) {
                if (!entry || !entry.piece || entry.piece.removed || entry.piece.row < 0) {
                    continue;
                }
                const raw = entry.prob || entry.pFlag || 0;
                if (raw <= 0) {
                    continue;
                }

                const score = raw * weightFactor;
                const prev = merged.get(entry.piece.id);
                if (!prev) {
                    merged.set(entry.piece.id, { piece: entry.piece, prob: score });
                } else {
                    prev.prob = Math.max(prev.prob, score);
                }
            }
        };

        pushEntries(primary || [], 1);
        pushEntries(secondary || [], 0.65);

        const list = Array.from(merged.values());
        list.sort((a, b) => b.prob - a.prob);
        return list.slice(0, limit || 4);
    },

    _isDefensiveSafeMove(gameState, move, strategicContext) {
        if (!strategicContext.myFlag) {
            return true;
        }

        if (move.piece.id === strategicContext.myFlag.id) {
            const beforeThreat = this._flagCellThreatScore(
                gameState,
                strategicContext.myFlag.row,
                strategicContext.myFlag.col
            );
            const afterThreat = this._flagCellThreatScore(gameState, move.row, move.col);
            return afterThreat <= beforeThreat;
        }

        if (!strategicContext.hasHeavyPressure) {
            return true;
        }

        const beforeDist = this._chebyshev(
            move.piece.row,
            move.piece.col,
            strategicContext.myFlag.row,
            strategicContext.myFlag.col
        );
        const afterDist = this._chebyshev(
            move.row,
            move.col,
            strategicContext.myFlag.row,
            strategicContext.myFlag.col
        );

        if (beforeDist <= 2 && afterDist > beforeDist) {
            return false;
        }
        return true;
    },

    _passesSafetySimulation(gameState, move, strategicContext) {
        if (!this._isValidMoveShape(move)) {
            return false;
        }
        if (!strategicContext || !strategicContext.myFlag) {
            return true;
        }

        const currentDanger = this._evaluateFlagDangerState(gameState);
        const projectedDanger = this._estimateEnemyReplyDanger(gameState, move, strategicContext);
        if (projectedDanger >= 1000000) {
            return false;
        }

        const tolerance = strategicContext.hasHeavyPressure
            ? 40
            : (strategicContext.enemyPressure >= 1 ? 180 : 320);
        return projectedDanger <= currentDanger + tolerance;
    },

    _estimateEnemyReplyDanger(gameState, move, strategicContext) {
        if (typeof aiEngine === 'undefined'
            || !aiEngine
            || typeof aiEngine.makeVirtualMove !== 'function'
            || typeof aiEngine.getAllPossibleMoves !== 'function') {
            return 0;
        }

        const afterOurMove = aiEngine.makeVirtualMove(gameState, move);
        const myFlag = afterOurMove.aiPieces.find(piece => piece.type === 'flag' && !piece.removed);
        if (!myFlag) {
            return 1000000;
        }

        let worstDanger = this._evaluateFlagDangerState(afterOurMove);
        const enemyMoves = aiEngine.getAllPossibleMoves(afterOurMove, 'player');
        if (!enemyMoves || enemyMoves.length === 0) {
            return worstDanger;
        }

        const rankedReplies = enemyMoves.map(reply => ({
            move: reply,
            priority: this._scoreEnemyReplyPriority(afterOurMove, reply, myFlag)
        }));
        rankedReplies.sort((a, b) => b.priority - a.priority);

        const replyLimit = strategicContext.hasHeavyPressure
            ? this._replySampleLimitPressure
            : this._replySampleLimitSafe;
        const sampled = rankedReplies.slice(0, Math.min(replyLimit, rankedReplies.length));

        for (const entry of sampled) {
            const afterEnemy = aiEngine.makeVirtualMove(afterOurMove, entry.move);
            const danger = this._evaluateFlagDangerState(afterEnemy);
            if (danger > worstDanger) {
                worstDanger = danger;
            }
            if (worstDanger >= 1000000) {
                break;
            }
        }

        return worstDanger;
    },

    _scoreEnemyReplyPriority(state, move, myFlag) {
        if (move.row === myFlag.row && move.col === myFlag.col) {
            return 1000000;
        }

        let score = 0;
        const dist = this._chebyshev(move.row, move.col, myFlag.row, myFlag.col);
        score += Math.max(0, 4 - dist) * 320;

        const target = state.board[move.row] && state.board[move.row][move.col];
        if (target && target.owner === 'computer') {
            score += 160;
        }
        if (move.piece && move.piece.revealed && move.piece.type === 'piece') {
            score += 25;
        }

        return score;
    },

    _evaluateFlagDangerState(gameState) {
        const myFlag = gameState.aiPieces.find(piece => piece.type === 'flag' && !piece.removed);
        if (!myFlag) {
            return 1000000;
        }

        let r1 = 0;
        let r2 = 0;
        let r3 = 0;
        let r1Revealed = 0;
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized || enemy.type === 'flag') {
                continue;
            }

            const dist = this._chebyshev(enemy.row, enemy.col, myFlag.row, myFlag.col);
            if (dist <= 1) {
                r1 += 1;
                if (enemy.revealed) {
                    r1Revealed += 1;
                }
            } else if (dist === 2) {
                r2 += 1;
            } else if (dist === 3) {
                r3 += 1;
            }
        }

        let danger = r1 * 950 + r1Revealed * 450 + r2 * 260 + r3 * 90;
        let defenders = 0;
        let trapCover = false;
        const coverTypes = new Set();
        for (const ally of gameState.aiPieces) {
            if (ally.removed || ally.row < 0 || ally.id === myFlag.id) {
                continue;
            }

            const dist = this._chebyshev(ally.row, ally.col, myFlag.row, myFlag.col);
            if (dist > 1) {
                continue;
            }

            defenders += 1;
            if (ally.type === 'trap' && !ally.immobilized) {
                trapCover = true;
                continue;
            }
            if (ally.type === 'piece' && ally.pieceType) {
                coverTypes.add(ally.pieceType);
            }
        }

        danger -= defenders * 130;
        danger -= coverTypes.size * 75;
        if (trapCover) {
            danger -= 180;
        }

        if (typeof aiEngine !== 'undefined'
            && aiEngine
            && typeof aiEngine.findFlagDefenseMoves === 'function') {
            const available = this._getAvailablePieces(gameState);
            const defenses = aiEngine.findFlagDefenseMoves(gameState, available);
            if (defenses.length === 0 && r1 > 0) {
                danger += 800;
            } else if (defenses.length > 0) {
                danger -= Math.min(260, defenses.length * 45);
            }
        }

        return Math.max(0, danger);
    },

    _isValidMoveShape(move) {
        return !!(move
            && move.piece
            && Number.isInteger(move.row)
            && Number.isInteger(move.col));
    },

    _isMoveLegal(gameState, move) {
        const piece = move.piece;
        if (!piece || piece.removed || piece.immobilized || piece.row < 0 || piece.col < 0) {
            return false;
        }

        const legal = RPSBotAPI.getLegalMoves(piece, gameState);
        const exists = legal.some(cell => cell.row === move.row && cell.col === move.col);
        if (!exists) {
            return false;
        }

        const target = gameState.board[move.row] && gameState.board[move.row][move.col];
        if (!target) {
            return true;
        }
        if (target.owner === piece.owner) {
            return false;
        }
        if (!RPSBotAPI.canAttack(piece, target)) {
            return false;
        }

        if (target.revealed && target.type === 'trap') {
            return false;
        }
        if (piece.type === 'piece'
            && target.revealed
            && target.type === 'piece'
            && piece.pieceType
            && target.pieceType
            && RPSBotAPI.resolveBattle(piece.pieceType, target.pieceType) === 'lose') {
            return false;
        }

        return true;
    },

    getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
        if (typeof aiEngine === 'undefined'
            || !aiEngine
            || typeof aiEngine.getTieBreakAvailableChoices !== 'function') {
            return null;
        }

        const available = aiEngine.getTieBreakAvailableChoices();
        if (!available || available.length === 0) {
            return null;
        }

        if (gameState) {
            const myFlag = gameState.aiPieces.find(piece => piece.type === 'flag' && !piece.removed);
            if (myFlag) {
                const pressure = this._countEnemyPressureNearFlag(gameState, myFlag);
                if (pressure >= 2) {
                    const revealedThreats = gameState.playerPieces.filter(piece => {
                        if (piece.removed || piece.row < 0 || !piece.revealed) {
                            return false;
                        }
                        if (piece.type !== 'piece' || !piece.pieceType) {
                            return false;
                        }
                        const dist = this._chebyshev(piece.row, piece.col, myFlag.row, myFlag.col);
                        return dist <= 2;
                    });

                    if (revealedThreats.length > 0 && typeof aiEngine.resolveBattle === 'function') {
                        let bestChoice = available[0];
                        let bestScore = -Infinity;
                        for (const choice of available) {
                            let score = 0;
                            for (const threat of revealedThreats) {
                                const result = aiEngine.resolveBattle(choice, threat.pieceType);
                                if (result === 'win') {
                                    score += 2;
                                } else if (result === 'draw') {
                                    score += 0.2;
                                } else {
                                    score -= 1.5;
                                }
                            }
                            if (score > bestScore) {
                                bestScore = score;
                                bestChoice = choice;
                            }
                        }
                        return bestChoice;
                    }

                    for (const choice of available) {
                        if (choice !== currentType) {
                            return choice;
                        }
                    }
                }
            }
        }

        if (opponentRevealed
            && opponentType
            && typeof aiEngine.getWinningChoice === 'function') {
            const winning = aiEngine.getWinningChoice(opponentType);
            if (available.indexOf(winning) >= 0) {
                return winning;
            }
        }

        if (typeof aiEngine.pickChoiceFromAvailable === 'function') {
            return aiEngine.pickChoiceFromAvailable(available, opponentRevealed, opponentType);
        }

        return available[Math.floor(Math.random() * available.length)];
    },

    _counterType(pieceType) {
        if (pieceType === 'rock') {
            return 'scissors';
        }
        if (pieceType === 'paper') {
            return 'rock';
        }
        if (pieceType === 'scissors') {
            return 'paper';
        }
        return null;
    },

    _chebyshev(r1, c1, r2, c2) {
        return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = codex53MediumBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(codex53MediumBot);
} else {
    throw new Error('[codex_5_3_medium] RPSBotAPI is required');
}
