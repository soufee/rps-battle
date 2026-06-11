/**
 * 🦔 Ёжик — Bayesian expert bot.
 *
 * Playstyle: the flagship "smart" opponent. Combines:
 *   - aiBeliefs — probabilistic model of hidden piece types (Bayesian
 *     updates on moves, battles, removals + global flag/trap uniqueness
 *     constraint propagation).
 *   - aiStrategy — long-term plan with roles (fist / defenders / scouts)
 *     and modes (RECON, FLANK_ATTACK, DENSE_DEFENSE, ENDGAME).
 *   - aiExpert — iterative-deepening alpha-beta with quiescence search,
 *     flag-pursuit heuristics, preemptive flag defence and corner pressure.
 *
 * Will actively hunt the opponent's flag once beliefs converge, and will
 * reinforce or relocate its own flag against distant threats it can see
 * from observed moves.
 *
 * Certified via RPSBotAPI.defineBot — obeys the shared rule contract.
 */

// === MANDATORY
if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[hedgehog] bot-api.js required before this bot');
}

const hedgehogBot = {
    id: 'hedgehog',
    name: 'Ёжик',
    emoji: '🦔',
    avatar: 'js/bots/hedgehog/avatar-min.png',
    shortDescription: 'Вероятностный эксперт',
    longDescription: 'Байес, RPS-координация, жёсткая защита флага. Кулак при уверенности в вражеском флаге.',
    algorithmLabel: 'Байесовский эксперт + координация',
    tier: 'medium',
    stars: 2,
    difficultyLabel: 'Средний',
    tags: ['advanced', 'coordinated', 'ruthless'],

    // === Состояние для контроля "зависаний" (Phase A) ===
    _consecutiveLowPurposeMoves: 0,
    _lastMoveWasLowPurpose: false,
    
    move(gameState) {
        try {
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);
            
            if (typeof aiBeliefs !== 'undefined'
                && aiBeliefs
                && typeof aiBeliefs.tick === 'function') {
                aiBeliefs.tick(aiEngine.aiTurnCounter + 1);
            }
            
            const move = this._pickMove(gameState);
            if (move) {
                aiEngine.recordAIMove(move);
            }
            return move;
        } catch (error) {
            console.error('[hedgehog] move() failed:', error);
            return null;
        }
    },
    
    _pickMove(gameState) {
        const riskReport = this._assessOwnRisks(gameState);
        const isLowPurposeForbidden = this._isLowPurposeMoveForbidden(gameState, riskReport);

        // === Новый стратегический слой ===
        const opponentIntent = this._inferOpponentIntent(gameState);
        const keyPieces = this._identifyKeyPieces(gameState);

        if (typeof aiExpert !== 'undefined'
            && aiExpert
            && typeof aiExpert.move === 'function') {
            try {
                const expertMove = aiExpert.move(gameState);

                if (expertMove) {
                    const moveRisk = this._evaluateMoveRisk(gameState, expertMove, riskReport);
                    const wouldBeLowPurpose = moveRisk.isLowPurpose;

                    // Обогащаем отчёт о рисках информацией о намерениях и ключевых фигурах
                    const enrichedRisk = this._enrichRiskWithStrategy(moveRisk, opponentIntent, keyPieces, gameState, expertMove);

                    // === Улучшенная логика принятия решений ===

                    // 1. Если ход сильно опасен для флага или ключевых фигур — исправляем
                    if (enrichedRisk.isDangerous || enrichedRisk.threatensKeyPiece) {
                        const safer = this._findSaferAlternative(gameState, expertMove, riskReport);
                        if (safer) return safer;
                    }

                    // 2. Бесцельные ходы
                    if (wouldBeLowPurpose) {
                        if (isLowPurposeForbidden) {
                            let alternative = this._findSaferAlternative(gameState, expertMove, riskReport) 
                                || this._findCoordinatedSupportMove(gameState, riskReport);

                            if (!alternative && this._hasHighConfidenceEnemyFlag(gameState)) {
                                alternative = this._findFistFormationMove(gameState);
                            }

                            if (alternative) {
                                this._consecutiveLowPurposeMoves = 0;
                                return alternative;
                            }
                        }

                        if (this._consecutiveLowPurposeMoves >= 3) {
                            let alternative = this._findSaferAlternative(gameState, expertMove, riskReport) 
                                || this._findCoordinatedSupportMove(gameState, riskReport);

                            if (!alternative && this._hasHighConfidenceEnemyFlag(gameState)) {
                                alternative = this._findFistFormationMove(gameState);
                            }

                            if (alternative) {
                                this._consecutiveLowPurposeMoves = 0;
                                return alternative;
                            }
                        }

                        this._consecutiveLowPurposeMoves++;
                        this._lastMoveWasLowPurpose = true;
                        return expertMove;
                    }

                    this._consecutiveLowPurposeMoves = 0;
                    this._lastMoveWasLowPurpose = false;
                    return expertMove;
                }
            } catch (error) {
                console.error('[hedgehog] aiExpert.move failed, falling back:', error);
            }
        }

        this._consecutiveLowPurposeMoves = 0;
        if (typeof raccoonBot !== 'undefined' && raccoonBot && typeof raccoonBot._pickMove === 'function') {
            try {
                return raccoonBot._pickMove(gameState);
            } catch (e) {}
        }
        return null;
    },

    /**
     * Обогащает оценку риска информацией о намерениях соперника и важности наших фигур.
     */
    _enrichRiskWithStrategy(moveRisk, opponentIntent, keyPieces, gameState, proposedMove) {
        let enriched = { ...moveRisk };
        enriched.threatensKeyPiece = false;

        // Проверяем, не подвергает ли ход опасности одну из наших ключевых фигур
        for (const key of keyPieces) {
            const piece = key.piece;
            const distBefore = Math.max(Math.abs(piece.row - proposedMove.piece.row), Math.abs(piece.col - proposedMove.piece.col));
            const distAfter = Math.max(Math.abs(piece.row - proposedMove.row), Math.abs(piece.col - proposedMove.col));

            // Если мы уводим защиту от важной фигуры или отдаляемся от неё при угрозе
            if (distAfter > distBefore + 1 && key.importance >= 3.5) {
                enriched.threatensKeyPiece = true;
                break;
            }
        }

        // Усиливаем опасность, если противник, судя по намерениям, идёт именно в эту зону
        if (opponentIntent.pressureAreas.length > 0) {
            const moveCol = proposedMove.col;
            const isMovingIntoPressure = 
                (opponentIntent.pressureAreas.includes('left') && moveCol <= 2) ||
                (opponentIntent.pressureAreas.includes('right') && moveCol >= 5) ||
                (opponentIntent.pressureAreas.includes('center') && moveCol > 2 && moveCol < 5);

            if (isMovingIntoPressure && opponentIntent.aggressionLevel > 0.6) {
                if (moveRisk.dangerScore) moveRisk.dangerScore += 2;
            }
        }

        return enriched;
    },

    /**
     * Определяет, запрещён ли сейчас бесцельный ход (строго по твоим правилам Phase A).
     */
    _isLowPurposeMoveForbidden(gameState, riskReport) {
        // Правило: Бесцельные ходы критичны и запрещены при следующих условиях:

        // 1. Есть реальная угроза нашему флагу
        if (riskReport.flagThreats && riskReport.flagThreats.length > 0) {
            return true;
        }

        // 2. Есть открытая фигура соперника, которую мы можем относительно безопасно съесть
        const available = aiEngine.getActivePieces(gameState);
        const safeKills = aiEngine.findGuaranteedKills(gameState, available)
            .filter(k => aiTacticalCore.safeToLeave(gameState, k.piece));

        if (safeKills.length > 0) {
            return true;
        }

        // 3. У нас есть достаточно уверенное предположение, где находится флаг соперника (≥ 60%)
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.getFlagCandidates === 'function') {
            try {
                const candidates = aiBeliefs.getFlagCandidates(gameState, 3);
                if (candidates.length > 0 && candidates[0].pFlag >= 0.60) {
                    return true;
                }
            } catch (e) {}
        }

        return false;
    },

    _hasHighConfidenceEnemyFlag(gameState) {
        if (typeof aiBeliefs === 'undefined' || !aiBeliefs || typeof aiBeliefs.getFlagCandidates !== 'function') {
            return false;
        }
        try {
            const candidates = aiBeliefs.getFlagCandidates(gameState, 2);
            return candidates.length > 0 && candidates[0].pFlag >= 0.60;
        } catch (e) {
            return false;
        }
    },

    /**
     * Пытается найти ход, который помогает формировать кулак для атаки на подозреваемый флаг.
     * Сильно предпочитает ходы, которые одновременно приближают к цели и улучшают RPS-координацию.
     */
    _findFistFormationMove(gameState) {
        if (typeof aiBeliefs === 'undefined' || !aiBeliefs || typeof aiBeliefs.getFlagCandidates !== 'function') {
            return null;
        }

        try {
            const candidates = aiBeliefs.getFlagCandidates(gameState, 1);
            if (candidates.length === 0) return null;

            const target = candidates[0].piece;
            const available = aiEngine.getActivePieces(gameState);

            let bestMove = null;
            let bestScore = -Infinity;

            for (const piece of available) {
                if (piece.type !== 'piece' || piece.immobilized) continue;

                const moves = aiEngine.getMovesForPiece(piece, gameState);
                for (const m of moves) {
                    const fakeMove = { piece, row: m.row, col: m.col };

                    const dBefore = Math.max(Math.abs(piece.row - target.row), Math.abs(piece.col - target.col));
                    const dAfter = Math.max(Math.abs(m.row - target.row), Math.abs(m.col - target.col));
                    const distReduction = dBefore - dAfter;

                    let score = distReduction * 12; // чуть выше вес на приближение

                    // Сильный бонус за улучшение взаимной поддержки внутри потенциального кулака
                    if (this._improvesMutualSupport(gameState, fakeMove)) {
                        score += 55;
                    }

                    // Дополнительный бонус за движение фигур, которые уже находятся в разумной близости к цели
                    if (dBefore <= 5) {
                        score += 12;
                    }

                    // Сильный штраф за продвижение изолированных фигур при построении кулака
                    const localAllies = available.filter(p =>
                        p.id !== piece.id &&
                        Math.max(Math.abs(p.row - m.row), Math.abs(p.col - m.col)) <= 3
                    ).length;

                    if (localAllies <= 1) {
                        score -= 35; // гораздо сильнее штрафуем за отправку одиноких фигур
                    }

                    // Дополнительный бонус, если эта фигура уже имеет хорошую поддержку на текущей позиции
                    // (лучше двигать хорошо защищённые фигуры вперёд)
                    const pieceType = piece.type === 'piece' ? piece.pieceType : piece.type;
                    const desiredSupportType = {
                        rock: 'scissors',
                        paper: 'rock',
                        scissors: 'paper'
                    }[pieceType];

                    let currentSupport = 0;
                    for (const ally of available) {
                        if (ally.id === piece.id) continue;
                        const allyType = ally.type === 'piece' ? ally.pieceType : ally.type;
                        if (allyType === desiredSupportType && Math.max(Math.abs(ally.row - piece.row), Math.abs(ally.col - piece.col)) <= 2) {
                            currentSupport++;
                        }
                    }
                    if (currentSupport >= 1) {
                        score += 20;
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        bestMove = fakeMove;
                    }
                }
            }

            return bestMove;
        } catch (e) {
            return null;
        }
    },

    /**
     * Ищет ход, который улучшает взаимную RPS-защиту наших фигур.
     */
    _findCoordinatedSupportMove(gameState, riskReport) {
        const available = aiEngine.getActivePieces(gameState);
        let bestMove = null;
        let bestImprovement = 0;

        for (const piece of available) {
            if (piece.type !== 'piece') continue;

            const moves = aiEngine.getMovesForPiece(piece, gameState);
            for (const m of moves) {
                const fakeMove = { piece, row: m.row, col: m.col };
                if (this._improvesMutualSupport(gameState, fakeMove)) {
                    const improvement = 1;
                    if (improvement > bestImprovement) {
                        bestImprovement = improvement;
                        bestMove = fakeMove;
                    }
                }
            }
        }
        return bestMove;
    },

    /**
     * Анализирует текущие угрозы нашим фигурам и флагу.
     * Возвращает отчёт о рисках.
     */
    _assessOwnRisks(gameState) {
        const myFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);
        const myPieces = aiEngine.getActivePieces(gameState);

        const report = {
            flagThreats: [],
            hangingPieces: [],      // Наши фигуры под угрозой
            criticalRisks: []       // Самые опасные ситуации
        };

        // Угрозы флагу (используем существующую инфраструктуру)
        if (myFlag) {
            report.flagThreats = aiEngine.getVisibleThreatsAtCell 
                ? aiEngine.getVisibleThreatsAtCell(myFlag.row, myFlag.col, gameState) 
                : [];
        }

        // Ищем наши висящие / уязвимые фигуры
        for (const myPiece of myPieces) {
            if (myPiece.type === FLAG) continue;

            const threats = this._findThreatsToPiece(gameState, myPiece);

            if (threats.length > 0) {
                const riskLevel = this._calculatePieceRisk(myPiece, threats, gameState);
                if (riskLevel >= 2) {  // Средний и выше риск
                    report.hangingPieces.push({
                        piece: myPiece,
                        threats: threats,
                        riskLevel: riskLevel
                    });
                }
            }
        }

        // Сортируем по уровню риска
        report.hangingPieces.sort((a, b) => b.riskLevel - a.riskLevel);

        return report;
    },

    /**
     * Находит вражеские фигуры, которые могут атаковать нашу.
     */
    _findThreatsToPiece(gameState, myPiece) {
        const threats = [];
        const myType = myPiece.type === 'piece' ? myPiece.pieceType : myPiece.type;

        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;

            const dist = Math.max(Math.abs(enemy.row - myPiece.row), Math.abs(enemy.col - myPiece.col));
            if (dist > 1) continue; // Только непосредственные угрозы в R1

            const enemyType = enemy.type === 'piece' ? enemy.pieceType : enemy.type;

            // Если враг может нас съесть (или мы не знаем, но это возможно)
            if (!enemyType || !myType) {
                threats.push({ enemy, certainty: 0.6 }); // Неизвестный — считаем потенциальной угрозой
            } else if (GAME_CONFIG.WIN_CONDITIONS[enemyType] === myType) {
                threats.push({ enemy, certainty: 1.0 });
            }
        }

        return threats;
    },

    _calculatePieceRisk(myPiece, threats, gameState) {
        if (threats.length === 0) return 0;

        let risk = threats.length * 1.5;

        // Если фигура далеко от поддержки — риск выше
        const supporters = gameState.aiPieces.filter(p => 
            p.id !== myPiece.id && 
            !p.removed && 
            Math.max(Math.abs(p.row - myPiece.row), Math.abs(p.col - myPiece.col)) <= 2
        );

        if (supporters.length <= 1) risk += 2.5;

        // Если это важная фигура для плана (fist member) — риск критичнее
        if (typeof aiStrategy !== 'undefined' && aiStrategy.currentPlan && aiStrategy.currentPlan.fist) {
            const isInFist = aiStrategy.currentPlan.fist.some(f => f.id === myPiece.id);
            if (isInFist) risk += 1.5;
        }

        return Math.min(10, risk);
    },

    /**
     * Оценивает, насколько опасен предлагаемый ход для нашей позиции.
     */
    _evaluateMoveRisk(gameState, proposedMove, riskReport) {
        let dangerScore = 0;
        let purposeScore = 0;
        let reasons = [];

        const myFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);

        // 1. Защита флага
        if (myFlag && riskReport.flagThreats.length > 0) {
            const distBefore = Math.max(Math.abs(proposedMove.piece.row - myFlag.row), Math.abs(proposedMove.piece.col - myFlag.col));
            const distAfter = Math.max(Math.abs(proposedMove.row - myFlag.row), Math.abs(proposedMove.col - myFlag.col));

            if (distAfter > distBefore + 1) {
                dangerScore += 5;
                reasons.push('Отдаляется от флага при угрозе');
            } else if (distAfter < distBefore) {
                purposeScore += 3;
            }
        }

        // 2. Защита висячих фигур
        for (const hanging of riskReport.hangingPieces) {
            if (hanging.piece.id === proposedMove.piece.id) continue;

            const stillThreatened = hanging.threats.some(t => 
                Math.max(Math.abs(t.enemy.row - hanging.piece.row), Math.abs(t.enemy.col - hanging.piece.col)) <= 1
            );

            if (stillThreatened) {
                dangerScore += 3;
                reasons.push(`Оставляет под угрозой ${hanging.piece.id}`);
            }
        }

        // 3. Проверка на бесцельность хода (строгое правило A)
        let hasPurpose = false;

        const highConfidence = this._hasHighConfidenceEnemyFlag(gameState);

        // Приближение к вражескому флагу / подозреваемому флагу
        const enemyFlag = gameState.playerPieces.find(p => p.type === FLAG && !p.removed);
        if (enemyFlag) {
            const dBefore = Math.max(Math.abs(proposedMove.piece.row - enemyFlag.row), Math.abs(proposedMove.piece.col - enemyFlag.col));
            const dAfter = Math.max(Math.abs(proposedMove.row - enemyFlag.row), Math.abs(proposedMove.col - enemyFlag.col));
            if (dAfter < dBefore) hasPurpose = true;
        }

        // Если у нас высокая уверенность в флаге — любое приближение к области цели считается purposeful
        if (!hasPurpose && highConfidence) {
            if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.getFlagCandidates === 'function') {
                try {
                    const candidates = aiBeliefs.getFlagCandidates(gameState, 1);
                    if (candidates.length > 0) {
                        const target = candidates[0].piece;
                        const dBefore = Math.max(Math.abs(proposedMove.piece.row - target.row), Math.abs(proposedMove.piece.col - target.col));
                        const dAfter = Math.max(Math.abs(proposedMove.row - target.row), Math.abs(proposedMove.col - target.col));
                        if (dAfter < dBefore) hasPurpose = true;
                    }
                } catch (e) {}
            }
        }

        // Движение к висячим фигурам соперника (атака открытых)
        for (const enemy of gameState.playerPieces) {
            if (enemy.revealed && !enemy.removed) {
                const dBefore = Math.max(Math.abs(proposedMove.piece.row - enemy.row), Math.abs(proposedMove.piece.col - enemy.col));
                const dAfter = Math.max(Math.abs(proposedMove.row - enemy.row), Math.abs(proposedMove.col - enemy.col));
                if (dAfter < dBefore) { hasPurpose = true; break; }
            }
        }

        // Улучшение взаимной защиты (RPS support) — важный фактор purposeful хода
        const improvesSupport = this._improvesMutualSupport(gameState, proposedMove);
        if (improvesSupport) {
            hasPurpose = true;
            purposeScore += 6;
        }

        // Сильный бонус за координацию, когда мы строим кулак (высокая уверенность в флаге)
        if (highConfidence) {
            if (improvesSupport) {
                purposeScore += 8; // значительно выше вес при формировании кулака
            } else if (this._worsensOverallCoordination(gameState, proposedMove)) {
                purposeScore -= 5; // сильнее штрафуем за ухудшение координации в критической фазе
            }
        }

        // Небольшой постоянный штраф за ходы, которые ухудшают общую координацию армии
        if (this._worsensOverallCoordination(gameState, proposedMove)) {
            purposeScore -= 2;
        }

        // Развитие / давление вперед
        if (proposedMove.row < proposedMove.piece.row) hasPurpose = true;

        if (!hasPurpose) {
            dangerScore += 2.5;
            reasons.push('Бесцельный ход (шаттл/зависание)');
        }

        return {
            isDangerous: dangerScore >= 4,
            isLowPurpose: !hasPurpose || purposeScore < 1,
            dangerScore,
            reasons
        };
    },

    /**
     * Проверяет, улучшает ли ход взаимную RPS-защиту фигур.
     * "В совершенстве" версия: учитывает как прямую поддержку движущейся фигуры,
     * так и общее качество координации в локальной группе.
     */
    _improvesMutualSupport(gameState, move) {
        const piece = move.piece;
        if (piece.type !== 'piece') return false;

        const myType = piece.pieceType;
        const desiredSupport = {
            rock: 'scissors',
            paper: 'rock',
            scissors: 'paper'
        }[myType];

        if (!desiredSupport) return false;

        let directImprovement = 0;
        let groupQualityBefore = 0;
        let groupQualityAfter = 0;

        const relevantPieces = gameState.aiPieces.filter(p =>
            p.type === 'piece' && !p.removed && p.row >= 0 &&
            Math.max(Math.abs(p.row - piece.row), Math.abs(p.col - piece.col)) <= 4
        );

        // Оценка до хода
        for (const p of relevantPieces) {
            const pType = p.pieceType;
            const needed = { rock: 'scissors', paper: 'rock', scissors: 'paper' }[pType];
            if (!needed) continue;

            let hasSupport = false;
            for (const ally of relevantPieces) {
                if (ally.id === p.id) continue;
                if (ally.pieceType === needed && Math.max(Math.abs(ally.row - p.row), Math.abs(ally.col - p.col)) <= 2) {
                    hasSupport = true;
                    break;
                }
            }
            if (hasSupport) groupQualityBefore++;
        }

        // Оценка после хода (симулируем)
        for (const p of relevantPieces) {
            const pType = p.pieceType;
            const needed = { rock: 'scissors', paper: 'rock', scissors: 'paper' }[pType];
            if (!needed) continue;

            let hasSupport = false;

            // Особый случай: если мы двигаем поддержку для этой фигуры
            const movingToSupportThis = (piece.id === p.id) ? false :
                (myType === needed && Math.max(Math.abs(move.row - p.row), Math.abs(move.col - p.col)) <= 2);

            for (const ally of relevantPieces) {
                if (ally.id === p.id) continue;

                let allyRow = ally.row;
                let allyCol = ally.col;
                if (ally.id === piece.id) {
                    allyRow = move.row;
                    allyCol = move.col;
                }

                if (ally.pieceType === needed && Math.max(Math.abs(allyRow - p.row), Math.abs(allyCol - p.col)) <= 2) {
                    hasSupport = true;
                    break;
                }
            }

            if (hasSupport || movingToSupportThis) groupQualityAfter++;
        }

        const groupImprovement = groupQualityAfter - groupQualityBefore;

        // Прямая поддержка для движущейся фигуры
        let directBefore = 0, directAfter = 0;
        for (const ally of gameState.aiPieces) {
            if (ally.id === piece.id || ally.removed || ally.row < 0) continue;
            if (ally.pieceType !== desiredSupport) continue;

            const dBefore = Math.max(Math.abs(ally.row - piece.row), Math.abs(ally.col - piece.col));
            const dAfter = Math.max(Math.abs(ally.row - move.row), Math.abs(ally.col - move.col));

            if (dBefore <= 2) directBefore++;
            if (dAfter <= 2) directAfter++;
        }
        directImprovement = directAfter - directBefore;

        return (directImprovement + groupImprovement) > 0;
    },

    /**
     * Простая проверка: ухудшает ли ход общую координацию армии.
     */
    _worsensOverallCoordination(gameState, move) {
        const piece = move.piece;
        const myType = piece.type === 'piece' ? piece.pieceType : piece.type;
        if (!myType) return false;

        const desiredSupport = {
            rock: 'scissors',
            paper: 'rock',
            scissors: 'paper'
        }[myType];

        let closeAlliesBefore = 0;
        let closeAlliesAfter = 0;

        for (const ally of gameState.aiPieces) {
            if (ally.id === piece.id || ally.removed || ally.row < 0) continue;

            const dBefore = Math.max(Math.abs(ally.row - piece.row), Math.abs(ally.col - piece.col));
            const dAfter = Math.max(Math.abs(ally.row - move.row), Math.abs(ally.col - move.col));

            if (dBefore <= 3) closeAlliesBefore++;
            if (dAfter <= 3) closeAlliesAfter++;
        }

        // Если после хода стало значительно меньше союзников рядом — координация ухудшилась
        return (closeAlliesBefore - closeAlliesAfter) >= 2;
    },

    /**
     * Пытается найти более безопасную альтернативу предложенному ходу.
     */
    _findSaferAlternative(gameState, riskyMove, riskReport) {
        const available = aiEngine.getActivePieces(gameState);
        const allMoves = aiEngine.getAllFilteredMoves(gameState, available);

        let bestSafe = null;
        let bestScore = -Infinity;

        const highConfidence = this._hasHighConfidenceEnemyFlag(gameState);

        for (const candidate of allMoves) {
            const candidateRisk = this._evaluateMoveRisk(gameState, candidate, riskReport);

            if (candidateRisk.isDangerous) continue;

            // Оцениваем стратегическую ценность хода
            let strategicValue = aiEngine.evaluateMoveV2(candidate, gameState);

            // Бонус за приближение к вражескому флагу или подозреваемому флагу
            const enemyFlag = gameState.playerPieces.find(p => p.type === FLAG && !p.removed);
            if (enemyFlag) {
                const dBefore = Math.max(Math.abs(candidate.piece.row - enemyFlag.row), Math.abs(candidate.piece.col - enemyFlag.col));
                const dAfter = Math.max(Math.abs(candidate.row - enemyFlag.row), Math.abs(candidate.col - enemyFlag.col));
                if (dAfter < dBefore) strategicValue += 180;
            }

            // Сильный бонус за улучшение координации, особенно когда мы строим кулак
            if (this._improvesMutualSupport(gameState, candidate)) {
                strategicValue += highConfidence ? 140 : 50;
            }

            // Дополнительный бонус за ходы, которые не ухудшают координацию при высокой уверенности в флаге
            if (highConfidence && !this._worsensOverallCoordination(gameState, candidate)) {
                strategicValue += 25;
            }

            if (strategicValue > bestScore) {
                bestScore = strategicValue;
                bestSafe = candidate;
            }
        }

        // Возвращаем только если альтернатива не сильно хуже по стратегии
        if (bestSafe && bestScore > -200) {
            return bestSafe;
        }

        return null;
    },
    
    chooseFlagAndTrap() {
        return aiEngine.chooseFlagAndTrapPositions({ style: 'corner-strong' });
    },

    /**
     * Дополнительный метод: позволяет внешнему коду (например, из dev-mode или тестов)
     * запросить текущую стратегическую оценку позиции.
     */
    getStrategicAssessment(gameState) {
        return {
            opponentIntent: this._inferOpponentIntent(gameState),
            keyPieces: this._identifyKeyPieces(gameState),
            highConfidenceOnEnemyFlag: this._hasHighConfidenceEnemyFlag(gameState),
            riskReport: this._assessOwnRisks(gameState)
        };
    },

    /**
     * === Strategic Oversight Layer ===
     * Эти методы добавляют Ёжику стратегический уровень мышления поверх aiExpert.
     */

    /**
     * Простая, но полезная модель намерений соперника.
     * Пытается понять, что противник сейчас старается сделать на доске.
     */
    _inferOpponentIntent(gameState) {
        const intent = {
            primaryGoal: 'unknown',
            pressureAreas: [],      // Куда противник давит
            likelyCounterType: null,  // Какой тип он скорее всего подводит
            aggressionLevel: 0.5
        };

        const playerPieces = gameState.playerPieces.filter(p => !p.removed && p.row >= 0);

        // Анализируем движение раскрытых фигур
        let leftPressure = 0, centerPressure = 0, rightPressure = 0;

        for (const p of playerPieces) {
            if (!p.revealed) continue;

            if (p.col <= 2) leftPressure++;
            else if (p.col >= 5) rightPressure++;
            else centerPressure++;
        }

        // Определяем основное направление давления
        const maxPressure = Math.max(leftPressure, centerPressure, rightPressure);
        if (maxPressure >= 3) {
            if (leftPressure === maxPressure) intent.pressureAreas.push('left');
            if (centerPressure === maxPressure) intent.pressureAreas.push('center');
            if (rightPressure === maxPressure) intent.pressureAreas.push('right');
        }

        // Простая эвристика агрессии
        const advancedPieces = playerPieces.filter(p => p.row <= 2).length;
        intent.aggressionLevel = Math.min(1, advancedPieces / 5);

        // Предполагаем, какой контр они скорее всего подводят
        if (intent.pressureAreas.includes('left') || intent.pressureAreas.includes('right')) {
            intent.likelyCounterType = 'paper'; // часто бумага для фланговых атак
        }

        // Определяем основную цель
        if (intent.aggressionLevel > 0.65 && intent.pressureAreas.length > 0) {
            intent.primaryGoal = 'flank_attack';
        } else if (intent.aggressionLevel > 0.5) {
            intent.primaryGoal = 'general_pressure';
        } else {
            intent.primaryGoal = 'probing';
        }

        return intent;
    },

    /**
     * Определяет, какие из наших фигур сейчас стратегически важны.
     */
    _identifyKeyPieces(gameState) {
        const keyPieces = [];
        const myPieces = aiEngine.getActivePieces(gameState);
        const myFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);

        if (!myFlag) return keyPieces;

        for (const piece of myPieces) {
            if (piece.type !== 'piece') continue;

            let importance = 0;
            let reasons = [];

            // Защитники флага
            const distToFlag = Math.max(Math.abs(piece.row - myFlag.row), Math.abs(piece.col - myFlag.col));
            if (distToFlag <= 2) {
                importance += 3;
                reasons.push('flag_defender');
            }

            // Члены кулака (если план есть)
            if (typeof aiStrategy !== 'undefined' && aiStrategy.currentPlan?.fist) {
                const isInFist = aiStrategy.currentPlan.fist.some(f => f.id === piece.id);
                if (isInFist) {
                    importance += 4;
                    reasons.push('fist_member');
                }
            }

            // Фигуры с хорошей поддержкой (ценные для координации)
            if (this._hasGoodLocalSupport(gameState, piece)) {
                importance += 1.5;
                reasons.push('well_supported');
            }

            if (importance >= 3) {
                keyPieces.push({
                    piece,
                    importance,
                    reasons
                });
            }
        }

        return keyPieces.sort((a, b) => b.importance - a.importance);
    },

    _hasGoodLocalSupport(gameState, piece) {
        if (piece.type !== 'piece') return false;
        const needed = { rock: 'scissors', paper: 'rock', scissors: 'paper' }[piece.pieceType];
        if (!needed) return false;

        let supporters = 0;
        for (const ally of gameState.aiPieces) {
            if (ally.id === piece.id || ally.removed || ally.row < 0) continue;
            if (ally.type === 'piece' && ally.pieceType === needed) {
                const d = Math.max(Math.abs(ally.row - piece.row), Math.abs(ally.col - piece.col));
                if (d <= 2) supporters++;
            }
        }
        return supporters >= 1;
    },

    /**
     * Улучшенная оценка риска хода с учётом намерений противника и важности фигур.
     */
    _evaluateStrategicRisk(gameState, proposedMove, opponentIntent, keyPieces) {
        let extraDanger = 0;

        // Если противник давит в зону, куда мы хотим пойти — повышаем опасность
        const moveCol = proposedMove.col;
        if (opponentIntent.pressureAreas.includes('left') && moveCol <= 2) extraDanger += 1.5;
        if (opponentIntent.pressureAreas.includes('right') && moveCol >= 5) extraDanger += 1.5;

        // Если мы уводим защиту от ключевой фигуры
        for (const key of keyPieces) {
            const distToKey = Math.max(Math.abs(key.piece.row - proposedMove.row), Math.abs(key.piece.col - proposedMove.col));
            if (distToKey > 3 && key.importance > 3.5) {
                extraDanger += 2;
            }
        }

        return extraDanger;
    },

    getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
        const myPieces = aiEngine.getActivePieces(gameState);
        const counts = { rock: 0, paper: 0, scissors: 0 };

        for (const p of myPieces) {
            if (p.type === 'piece' && p.pieceType) {
                counts[p.pieceType]++;
            }
        }

        // Если у нас есть открытая важная фигура, которую нужно защитить
        const myExposed = myPieces.filter(p =>
            p.revealed && p.type === 'piece' && Math.max(Math.abs(p.row - gameState.aiPieces.find(f => f.type === FLAG)?.row || 0), Math.abs(p.col - gameState.aiPieces.find(f => f.type === FLAG)?.col || 0)) <= 3
        );

        if (myExposed.length > 0) {
            // Попробуем выбрать тип, который защищает самую уязвимую нашу фигуру
            for (const exposed of myExposed) {
                const needed = { rock: 'scissors', paper: 'rock', scissors: 'paper' }[exposed.pieceType];
                if (needed) return needed;
            }
        }

        // Ищем, какого типа нам не хватает для хорошего кулака / баланса
        const missing = [];
        if (counts.scissors < 2) missing.push('scissors');
        if (counts.rock < 2) missing.push('rock');
        if (counts.paper < 2) missing.push('paper');

        if (missing.length > 0) {
            // Предпочитаем тип, которого реально не хватает
            return missing[0];
        }

        if (typeof aiEngine !== 'undefined' && aiEngine.pickChoiceFromAvailable) {
            const available = aiEngine.getTieBreakAvailableChoices();
            return aiEngine.pickChoiceFromAvailable(
                available,
                opponentRevealed,
                opponentType
            );
        }

        return ['rock', 'paper', 'scissors'].find(t => t !== currentType) || 'rock';
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = hedgehogBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(hedgehogBot);
} else {
    throw new Error('[hedgehog] RPSBotAPI.defineBot is required (load bot-api.js first)');
}
