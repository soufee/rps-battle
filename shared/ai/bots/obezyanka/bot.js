/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                    GROK APEX — SOVEREIGN PROTOCOL v3.4                    ║
 * ║                                                                           ║
 * ║  Author: Grok-4 (xAI)                                                     ║
 * ║  Status: Paranoid Sovereign — Beliefs + Mandatory Defense First + Hybrid  ║
 * ║                                                                           ║
 * ║  v3.4 (post-champ2 emergency hardening):                                  ║
 * ║  • PANIC gate: if flag in danger (r≤2 pressure or shared defense non-empty) → ONLY defense/capture/safe. Hunt & deep search BANNED.  ║
 * ║  • Tactical Core (aiTacticalCore.getMandatoryMove + deducer) inserted early as Owl-chain P0  ║
 * ║  • _beliefDrivenHunt drastically tightened (pFlag≥0.85 + stillness≥4 + !danger + back-rank or material)  ║
 * ║  • _beliefAwareSearch: quiescence flag-threat penalty (−1e6) after virtualMove; fortressScore in leaves; defense-filtered candidates  ║
 * ║  • _fortressScore added (defenders diversity near flag, live trap, enemy proximity)  ║
 * ║  • _selectBestMove / generators now use shared filtered + shuttle/trap risk everywhere  ║
 * ║  • P0 hybrid net kept and de-duped; Sovereign belief system + criticalDefense preserved as core differentiator  ║
 * ║                                                                           ║
 * ║  Цель: вернуть в верхнюю половину лиги (≥50% winrate, ≤#10 из 20).         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[obezyanka] bot-api.js must be loaded before this file');
}

var { RULES, resolveBattle, getLegalMoves, canAttack } = window.RPSBotAPI || {};

const obezyankaBot = {
    id: 'obezyanka',
    name: 'Обезьянка',
    emoji: '🧠',
    avatar: 'js/bots/obezyanka/avatar-min.png',

    shortDescription: 'Параноидальная защита флага и байесовский поиск',
    longDescription: 'При угрозе флагу — только оборона. Иначе байес, «крепость» и охота.',

    algorithmLabel: 'Байес + тактическое ядро + оценка крепости',
    tier: 'easy',
    stars: 1,
    difficultyLabel: 'Лёгкий',
    tags: ['independent', 'bayesian', 'original', 'hybrid', 'championship', 'paranoid', 'v3.4'],

    // ==================== ВНУТРЕННЕЕ СОСТОЯНИЕ ====================
    _beliefs: new Map(),           // pieceId -> {probs, lastMoveTurn, stillTurns, ...}
    _turn: 0,
    _ownFlagId: null,
    _ownTrapId: null,
    _lastMoveByPiece: {},          // для анти-шаттл эвристики

    // ==================== РЕГИСТРАЦИЯ ====================
    _register() {
        if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
            RPSBotAPI.defineBot(this);
        } else {
            throw new Error('[obezyanka] RPSBotAPI.defineBot is required');
        }
    },

    // ==================== РАССТАНОВКА (Apex v3.3 — Diversified Sovereign) ====================
    chooseFlagAndTrap() {
        // Была слишком corner-heavy (65% чистые углы). Это одна из причин 29 захватов флага.
        // Теперь используем богатый набор из 18+ шаблонов + 25% mirror, проверенный на других ботах.
        // Сохраняем "суверенный" характер — чуть более агрессивные/центральные варианты.
        const templates = [
            { flag: 0, trap: 9 }, { flag: 7, trap: 14 },
            { flag: 1, trap: 8 }, { flag: 6, trap: 15 },
            { flag: 2, trap: 9 }, { flag: 5, trap: 14 },
            { flag: 3, trap: 10 }, { flag: 4, trap: 13 },
            { flag: 0, trap: 13 }, { flag: 1, trap: 14 }, { flag: 2, trap: 15 },
            { flag: 7, trap: 8 }, { flag: 6, trap: 9 },
            { flag: 1, trap: 11 }, { flag: 2, trap: 12 }, { flag: 5, trap: 11 }, { flag: 6, trap: 10 },
            { flag: 3, trap: 12 }, { flag: 4, trap: 11 }
        ];

        let pick = templates[Math.floor(Math.random() * templates.length)];

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

        this._ownFlagId = null;
        this._ownTrapId = null;
        this._beliefs.clear(); // чистим beliefs между играми
        this._turn = 0;
        this._lastMoveByPiece = {};

        return { flagIndex: pick.flag, trapIndex: pick.trap };
    },

    // ==================== ГЛАВНЫЙ МЕТОД ====================
    move(gameState) {
        this._turn++;

        try {
            this._updateOwnSpecialIds(gameState);
            this._updateBeliefs(gameState);

            const myPieces = this._getMyActivePieces(gameState);
            if (myPieces.length === 0) return null;

            // =====================================================================
            // P0 — PARANOID PANIC GATE (максимальный ROI по IMPROVE_PROMPT)
            // Если флаг в опасности (давление в радиусе 2 ИЛИ shared defense видит угрозу) —
            // ПОЛНЫЙ ЗАПРЕТ на hunt и глубокий search. Только защита, захват, безопасные.
            // Это ломает паттерн "охотимся пока флаг под ударом" из чемпионата 2.
            // =====================================================================
            const inPanic = this._isFlagInDanger(gameState, myPieces);

            // === 1. ЖЁСТКАЯ ТАКТИКА (своя + теперь через Tactical Core как у Build 0.1) ===
            // Вставляем Owl-цепочку РАНЬШЕ hunt/search. Deducer на базе наших beliefs.
            if (typeof aiTacticalCore !== 'undefined' && aiTacticalCore &&
                typeof aiTacticalCore.getMandatoryMove === 'function') {
                const deducer = (typeof this._deduceEnemyFlag === 'function')
                    ? this._deduceEnemyFlag.bind(this) : null;
                const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                    deducer: deducer,
                    flagHuntHorizon: 3,
                    antiCluster: true
                });
                if (mandatory && mandatory.piece) {
                    if (typeof aiEngine !== 'undefined' && aiEngine &&
                        typeof aiEngine.recordAIMove === 'function') {
                        aiEngine.recordAIMove(mandatory);
                    }
                    return this._finalizeMove(mandatory);
                }
            }

            const tactical = this._findMandatoryTacticalMove(gameState, myPieces);
            if (tactical) return this._finalizeMove(tactical);

            // === 2. КРИТИЧЕСКАЯ ЗАЩИТА ФЛАГА (суверенный слой — сохраняем и усиливаем) ===
            const defense = this._criticalFlagDefense(gameState, myPieces);
            if (defense) return this._finalizeMove(defense);

            // === P0 HYBRID SAFETY NET (оставляем, но в panic-режиме он становится главным) ===
            // Даже после своей _critical мы вызываем проверенные shared. В panic это доминирует.
            if (typeof aiEngine !== 'undefined' && aiEngine) {
                const available = (typeof aiEngine.getActivePieces === 'function')
                    ? aiEngine.getActivePieces(gameState)
                    : myPieces;

                if (typeof aiEngine.findFlagCaptureMoves === 'function') {
                    const captures = aiEngine.findFlagCaptureMoves(gameState, available);
                    if (captures && captures.length > 0) {
                        const picked = (typeof aiEngine.pickBestScored === 'function')
                            ? aiEngine.pickBestScored(captures, gameState) : captures[0];
                        if (picked && picked.piece) return this._finalizeMove(picked);
                    }
                }

                if (typeof aiEngine.findFlagDefenseMoves === 'function') {
                    const def2 = aiEngine.findFlagDefenseMoves(gameState, available);
                    if (def2 && def2.length > 0) {
                        const picked = (typeof aiEngine.pickBestScored === 'function')
                            ? aiEngine.pickBestScored(def2, gameState) : def2[0];
                        if (picked && picked.piece) return this._finalizeMove(picked);
                    }
                }

                if (typeof aiEngine.findGuaranteedKills === 'function') {
                    const kills = aiEngine.findGuaranteedKills(gameState, available);
                    if (kills && kills.length > 0) {
                        const picked = (typeof aiEngine.pickBestScored === 'function')
                            ? aiEngine.pickBestScored(kills, gameState) : kills[0];
                        if (picked && picked.piece) return this._finalizeMove(picked);
                    }
                }
            }

            // В РЕЖИМЕ PANIC — hunt и search ЗАПРЕЩЕНЫ. Только безопасный fallback.
            if (inPanic) {
                return this._safePanicMove(gameState, myPieces) || this._safeFallbackMove(gameState, myPieces);
            }

            // === 3. ВЫСОКОУВЕРЕННАЯ ОХОТА НА ВРАЖЕСКИЙ ФЛАГ (теперь только когда флаг БЕЗОПАСЕН) ===
            const hunt = this._beliefDrivenHunt(gameState, myPieces);
            if (hunt) return this._finalizeMove(hunt);

            // === 4. ГЛУБОКИЙ ПОИСК С УЧЁТОМ НЕОПРЕДЕЛЁННОСТИ (усилен quiescence + fortress) ===
            // Глубина адаптивная: 2 в build/давлении, 4 только при полной безопасности флага.
            const searchDepth = this._getAdaptiveSearchDepth(gameState, myPieces);
            const searchMove = this._beliefAwareSearch(gameState, myPieces, searchDepth);
            if (searchMove) return this._finalizeMove(searchMove);

            // === 5. Запасной вариант через сильную эвристику (теперь с shared фильтрами) ===
            const bestMove = this._selectBestMove(gameState, myPieces);
            if (bestMove) return this._finalizeMove(bestMove);

            return this._safeFallbackMove(gameState, myPieces);

        } catch (e) {
            console.error('[Grok Apex Sovereign] Error:', e);
            return this._safeFallbackMove(gameState, this._getMyActivePieces(gameState));
        }
    },

    // ==================== BELIEF SYSTEM (ОРИГИНАЛЬНЫЙ) ====================
    _updateBeliefs(gameState) {
        const enemyPieces = gameState.playerPieces || [];

        // Инициализация при необходимости
        for (const ep of enemyPieces) {
            if (ep.removed || this._beliefs.has(ep.id)) continue;

            const row = ep.row;
            const isBackRow = row >= 5;

            // Априоры
            let pFlag = isBackRow ? 0.13 : 0.035;
            let pTrap = isBackRow ? 0.09 : 0.04;
            let remaining = Math.max(1 - pFlag - pTrap, 0.4);
            const pEach = remaining / 3;

            this._beliefs.set(ep.id, {
                probs: { rock: pEach, paper: pEach, scissors: pEach, flag: pFlag, trap: pTrap },
                lastMoveTurn: this._turn,
                stillTurns: 0,
                firstMoveTurn: null,
                _pieceRef: ep   // сохраняем ссылку на актуальный объект фигуры
            });
        }

        // Обновление по наблюдениям
        for (const ep of enemyPieces) {
            if (ep.removed) {
                this._beliefs.delete(ep.id);
                continue;
            }

            const b = this._beliefs.get(ep.id);
            if (!b) continue;
            b._pieceRef = ep; // всегда держим свежую ссылку

            // Если фигура раскрылась в бою — жёсткое обновление
            if (ep.revealed && ep.type !== 'piece') {
                for (const k of Object.keys(b.probs)) b.probs[k] = 0;
                b.probs[ep.type] = 1.0;
                continue;
            }

            // Движение
            if (ep.row !== (b.lastKnownRow ?? ep.row) || ep.col !== (b.lastKnownCol ?? ep.col)) {
                const wasFirst = b.firstMoveTurn === null;
                b.firstMoveTurn = b.firstMoveTurn ?? this._turn;
                b.lastMoveTurn = this._turn;
                b.stillTurns = 0;

                // Движение сильно бьёт по вероятности trap и умеренно по flag
                b.probs.trap *= wasFirst ? 0.25 : 0.05;
                b.probs.flag *= wasFirst ? 0.55 : 0.32;

                b.lastKnownRow = ep.row;
                b.lastKnownCol = ep.col;

                // Сигналы от наших раскрытых фигур (если есть)
                this._applyApproachRetreatSignals(b, ep, gameState);
            } else {
                b.stillTurns++;
                // Долгая неподвижность на заднем ряду → повышаем флаг
                if (b.stillTurns >= 4 && ep.row >= 5) {
                    b.probs.flag = Math.min(0.85, b.probs.flag + 0.12);
                }
            }

            this._normalize(b.probs);
        }

        // Глобальные ограничения: ровно один флаг и один капкан
        this._enforceGlobalConstraints();
    },

    _applyApproachRetreatSignals(belief, enemyPiece, gameState) {
        const ourRevealed = (gameState.aiPieces || []).filter(p =>
            p.revealed && p.type === 'piece' && p.pieceType
        );

        for (const ours of ourRevealed) {
            const dOld = Math.max(Math.abs(ours.row - (belief.lastKnownRow ?? enemyPiece.row)),
                                  Math.abs(ours.col - (belief.lastKnownCol ?? enemyPiece.col)));
            const dNew = Math.max(Math.abs(ours.row - enemyPiece.row), Math.abs(ours.col - enemyPiece.col));

            if (dOld <= 1 && dNew > 1) {
                // Отступил от нашей фигуры
                this._applyRetreatSignal(belief.probs, ours.pieceType);
            } else if (dOld > 1 && dNew <= 1) {
                // Приблизился
                this._applyApproachSignal(belief.probs, ours.pieceType);
            }
        }
    },

    _applyRetreatSignal(probs, ourType) {
        if (ourType === 'rock') {
            probs.scissors = Math.min(0.95, probs.scissors * 2.1);
            probs.flag = Math.min(0.9, probs.flag * 1.35);
            probs.paper *= 0.55;
        } else if (ourType === 'paper') {
            probs.rock = Math.min(0.95, probs.rock * 2.1);
            probs.flag = Math.min(0.9, probs.flag * 1.35);
            probs.scissors *= 0.55;
        } else if (ourType === 'scissors') {
            probs.paper = Math.min(0.95, probs.paper * 2.1);
            probs.flag = Math.min(0.9, probs.flag * 1.35);
            probs.rock *= 0.55;
        }
    },

    _applyApproachSignal(probs, ourType) {
        if (ourType === 'rock') {
            probs.paper = Math.min(0.95, probs.paper * 2.6);
            probs.flag *= 0.12;
            probs.scissors *= 0.35;
        } else if (ourType === 'paper') {
            probs.scissors = Math.min(0.95, probs.scissors * 2.6);
            probs.flag *= 0.12;
            probs.rock *= 0.35;
        } else if (ourType === 'scissors') {
            probs.rock = Math.min(0.95, probs.rock * 2.6);
            probs.flag *= 0.12;
            probs.paper *= 0.35;
        }
    },

    _normalize(probs) {
        let sum = 0;
        for (const k of Object.keys(probs)) sum += probs[k];
        if (sum <= 0) return;
        for (const k of Object.keys(probs)) probs[k] /= sum;
    },

    _enforceGlobalConstraints() {
        // Оставляем только живые скрытые фигуры
        const aliveHidden = [];
        for (const [id, b] of this._beliefs.entries()) {
            // Находим соответствующую фигуру
            // (упрощённо — просто нормализуем суммы)
        }

        // Простая нормализация сумм P(flag) и P(trap) ≈ 1 среди скрытых
        let flagSum = 0, trapSum = 0;
        const entries = [];

        for (const [id, b] of this._beliefs) {
            entries.push({ id, b });
            flagSum += b.probs.flag;
            trapSum += b.probs.trap;
        }

        if (flagSum > 0) {
            for (const e of entries) e.b.probs.flag /= flagSum;
        }
        if (trapSum > 0) {
            for (const e of entries) e.b.probs.trap /= trapSum;
        }
    },

    // ==================== РОЛИ И ОЦЕНКА ====================

    _getMyActivePieces(gameState) {
        return (gameState.aiPieces || []).filter(p => !p.removed && !p.immobilized && p.row >= 0);
    },

    _findMandatoryTacticalMove(gameState, myPieces) {
        const myFlag = myPieces.find(p => p.type === 'flag');

        // Захват раскрытого вражеского флага
        for (const p of myPieces) {
            if (p.type === 'flag') continue;
            const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);
            for (const m of moves) {
                const target = gameState.board[m.row]?.[m.col];
                if (target && target.owner === 'player' && target.type === 'flag') {
                    return { piece: p, row: m.row, col: m.col };
                }
            }
        }

        // Критическая защита флага (R1 угроза)
        if (myFlag) {
            const immediate = this._getThreatsToFlag(gameState, myFlag, 1);
            if (immediate.length > 0) {
                for (const threat of immediate) {
                    for (const p of myPieces) {
                        if (p.type === 'flag') continue;
                        const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);
                        for (const m of moves) {
                            if (m.row === threat.row && m.col === threat.col) {
                                return { piece: p, row: m.row, col: m.col };
                            }
                        }
                    }
                }
            }
        }
        return null;
    },

    _criticalFlagDefense(gameState, myPieces) {
        const myFlag = myPieces.find(p => p.type === 'flag');
        if (!myFlag) return null;

        const threats = this._getThreatsToFlag(gameState, myFlag, 2.5);
        if (threats.length === 0) return null;

        // Ищем лучший защитный ход
        let best = null;
        let bestScore = -Infinity;

        for (const p of myPieces) {
            if (p.type === 'flag') continue;
            const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);

            for (const m of moves) {
                let score = 0;
                const distBefore = Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col));
                const distAfter = Math.max(Math.abs(m.row - myFlag.row), Math.abs(m.col - myFlag.col));

                if (distAfter < distBefore) score += 80;

                // Атака на угрозу
                const target = gameState.board[m.row]?.[m.col];
                if (target && threats.some(t => t.id === target.id)) {
                    score += 140;
                    if (target.revealed && p.type === 'piece' && p.pieceType) {
                        const res = resolveBattle(p.pieceType, target.pieceType);
                        if (res === 'win') score += 90;
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    best = { piece: p, row: m.row, col: m.col };
                }
            }
        }
        return bestScore > 30 ? best : null;
    },

    _beliefDrivenHunt(gameState, myPieces) {
        const candidates = this._getFlagCandidates(3);
        if (candidates.length === 0) return null;

        const top = candidates[0];
        const target = top.piece;

        // ЖЁСТКИЕ ПОРОГИ v3.4 (по IMPROVE_PROMPT): только при высокой уверенности + stillness + безопасность флага
        if (top.pFlag < 0.85) return null;

        // stillness из beliefs (не с куска)
        let still = 0;
        for (const [id, b] of this._beliefs) {
            if (b._pieceRef && b._pieceRef.id === target.id) { still = b.stillTurns || 0; break; }
        }
        if (still < 4) return null; // сильные боты не сидят 40 ходов в углу

        // Дополнительно: только если флаг в тылу ИЛИ мы уже сняли 8+ вражеских фигур (материальный перевес)
        const isBackRank = target.row >= 4 || target.row <= 1; // верх или низ в зависимости от стороны
        const removedEnemies = (gameState.playerPieces || []).filter(p => p.removed).length;
        if (!isBackRank && removedEnemies < 8) return null;

        // Никогда не охотимся когда флаг под угрозой (дополнительный пояс)
        if (this._isFlagInDanger(gameState, myPieces)) return null;

        let best = null;
        let bestScore = -Infinity;

        for (const p of myPieces) {
            if (p.type === 'flag') continue;
            const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);

            for (const m of moves) {
                const newDist = Math.max(Math.abs(m.row - target.row), Math.abs(m.col - target.col));
                const oldDist = Math.max(Math.abs(p.row - target.row), Math.abs(p.col - target.col));

                let score = (oldDist - newDist) * 120;

                if (newDist <= 1) score += 200;
                if (top.pFlag > 0.90 && newDist <= 2) score += 120;

                // Corner pressure
                score += this._cornerPressure(target, m, gameState) * 28;

                if (score > bestScore) {
                    bestScore = score;
                    best = { piece: p, row: m.row, col: m.col };
                }
            }
        }

        return bestScore > 60 ? best : null; // выше порог
    },

    _selectBestMove(gameState, myPieces) {
        // v3.4: предпочитаем shared getAllFilteredMoves + наши фильтры (shuttle, trap-risk, fortress-aware)
        let all = [];
        if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.getAllFilteredMoves === 'function') {
            const avail = (typeof aiEngine.getActivePieces === 'function')
                ? aiEngine.getActivePieces(gameState) : myPieces;
            all = aiEngine.getAllFilteredMoves(gameState, avail) || [];
        } else {
            for (const p of myPieces) {
                const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);
                for (const m of moves) {
                    all.push({ piece: p, row: m.row, col: m.col });
                }
            }
        }

        // Применяем дополнительные фильтры безопасности (shuttle + trap risk)
        all = this._applyExtraSafetyFilters(gameState, all, myPieces);

        let best = null;
        let bestScore = -Infinity;

        for (const move of all) {
            let score = this._evaluatePosition(gameState, move);
            // fortress tie-break
            score += this._fortressScore(gameState) * 0.3;
            if (score > bestScore) {
                bestScore = score;
                best = move;
            }
        }
        return best;
    },

    /** Дополнительные фильтры (shuttle, hidden back-rank trap risk, etc) */
    _applyExtraSafetyFilters(gameState, moves, myPieces) {
        const turn = this._turn || 0;
        const myFlag = myPieces.find(pp => pp.type === 'flag');
        const result = [];

        for (const mv of moves) {
            const p = mv.piece;
            const m = { row: mv.row, col: mv.col };

            // Shuttle
            if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.isShuttlePosition === 'function') {
                if (aiEngine.isShuttlePosition(p.id, m.row, m.col)) continue;
            }

            // Ранний hidden back-rank trap risk (как было)
            if (!gameState.board[m.row]?.[m.col] && turn < 18) {
                const isTop = (myFlag && myFlag.row <= 2);
                const oppBackRow = isTop ? (m.row >= 4) : (m.row <= 1);
                if (oppBackRow) {
                    if (myFlag) {
                        const d = Math.max(Math.abs(m.row - myFlag.row), Math.abs(m.col - myFlag.col));
                        if (d > 3) continue;
                    } else {
                        continue;
                    }
                }
            }

            result.push(mv);
        }
        return result;
    },

    // ==================== ОЦЕНКА ПОЗИЦИИ (СИЛЬНАЯ ОРИГИНАЛЬНАЯ) ====================
    _evaluatePosition(gameState, move) {
        let score = 0;
        const { piece, row, col } = move;

        const myFlag = gameState.aiPieces.find(p => p.type === 'flag' && !p.removed);
        if (!myFlag) return 0;

        // === 1. КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ ФЛАГА (самый важный фактор) ===
        const distBefore = Math.max(Math.abs(piece.row - myFlag.row), Math.abs(piece.col - myFlag.col));
        const distAfter = Math.max(Math.abs(row - myFlag.row), Math.abs(col - myFlag.col));
        const threats = this._getThreatsToFlag(gameState, myFlag, 3);

        if (threats.length > 0) {
            if (distAfter < distBefore) score += 120;
            if (distAfter > distBefore && distBefore <= 2) score -= 95;
            // Особенно наказываем уход от флага, когда рядом есть угрозы
            if (distAfter > distBefore && threats.length >= 2) score -= 60;
        }

        // === FORTRESS (v3.4) — вес защиты флага ×10 относительно hunt ===
        score += this._fortressScore(gameState) * 1.8;

        // === 2. ДАВЛЕНИЕ НА ВРАЖЕСКИЙ ФЛАГ (belief-driven) ===
        const candidates = this._getFlagCandidates(2);
        if (candidates.length > 0) {
            const top = candidates[0];
            const d = Math.max(Math.abs(row - top.piece.row), Math.abs(col - top.piece.col));
            const weight = top.pFlag > 0.75 ? 42 : 28;
            score += (5 - Math.min(5, d)) * weight;

            // Дополнительный бонус за координацию (другие наши фигуры тоже рядом)
            if (top.pFlag > 0.65) {
                let support = 0;
                for (const ally of gameState.aiPieces) {
                    if (ally.removed || ally.id === piece.id) continue;
                    const allyDist = Math.max(Math.abs(row - ally.row), Math.abs(col - ally.col));
                    if (allyDist <= 2) support++;
                }
                score += support * 18;
            }
        }

        // === 3. ПРОДВИЖЕНИЕ И КОНТРОЛЬ ПРОСТРАНСТВА ===
        score += (row - piece.row) * 9;
        const center = 6 - (Math.abs(row - 2.5) + Math.abs(col - 3.5));
        score += center * 5.5;

        // === 4. ИЗБЕГАНИЕ ГЛУПЫХ АТАК ===
        const target = gameState.board[row]?.[col];
        if (target && target.owner === 'player' && target.revealed) {
            if (piece.type === 'piece' && piece.pieceType) {
                const res = resolveBattle(piece.pieceType, target.pieceType);
                if (res === 'win') score += 420;
                if (res === 'lose') score -= 2800;
            }
            if (target.type === 'trap') score -= 9999;
        }

        // === 5. Штраф за излишнюю активность одной фигуры (анти-шаттл) ===
        // (упрощённо)
        if (this._turn - (this._lastMoveByPiece?.[piece.id] || 0) < 2) {
            score -= 18;
        }

        return score;
    },

    // ==================== ВСПОМОГАТЕЛЬНЫЕ ====================
    _getFlagCandidates(topN = 3) {
        const result = [];
        // Мы храним актуальные ссылки на фигуры при обновлении beliefs
        for (const [id, b] of this._beliefs) {
            const piece = b._pieceRef; // сохраняем ссылку при обновлении
            if (!piece || piece.removed) continue;
            if (piece.revealed && piece.type !== 'flag') continue;

            result.push({ piece, pFlag: b.probs.flag });
        }
        result.sort((a, b) => b.pFlag - a.pFlag);
        return result.slice(0, topN);
    },

    _getThreatsToFlag(gameState, myFlag, radius) {
        return (gameState.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 &&
            Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col)) <= radius &&
            p.type !== 'flag'
        );
    },

    _cornerPressure(target, hypothetical, gameState) {
        let p = 0;
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const r = target.row + dr, c = target.col + dc;
                if (r < 0 || r >= 6 || c < 0 || c >= 8) { p++; continue; }
                if (r === hypothetical.row && c === hypothetical.col) { p++; continue; }
                const occ = gameState.board[r]?.[c];
                if (occ && occ.owner === 'computer') p += 0.6;
            }
        }
        return p;
    },

    _updateOwnSpecialIds(gameState) {
        if (!this._ownFlagId) {
            const f = (gameState.aiPieces || []).find(p => p.type === 'flag');
            if (f) this._ownFlagId = f.id;
        }
        if (!this._ownTrapId) {
            const t = (gameState.aiPieces || []).find(p => p.type === 'trap');
            if (t) this._ownTrapId = t.id;
        }
    },

    _getLegalMovesLocal(piece, gameState) {
        const moves = [];
        const dirs = RULES?.DIRECTIONS || [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
        for (const [dr, dc] of dirs) {
            const nr = piece.row + dr, nc = piece.col + dc;
            if (nr < 0 || nr >= 6 || nc < 0 || nc >= 8) continue;
            const target = gameState.board[nr]?.[nc];
            if (!target || target.owner !== piece.owner) {
                moves.push({ row: nr, col: nc });
            }
        }
        return moves;
    },

    _safeFallbackMove(gameState, pieces) {
        for (const p of pieces) {
            if (p.type === 'flag') continue;
            const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);
            if (moves.length > 0) return { piece: p, row: moves[0].row, col: moves[0].col };
        }
        return null;
    },

    _finalizeMove(move) {
        if (move && move.piece) {
            this._lastMoveByPiece[move.piece.id] = this._turn;
            // Для shared anti-shuttle памяти (используется owl-style bots и движком)
            if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.recordAIMove === 'function') {
                aiEngine.recordAIMove(move);
            }
        }
        return move;
    },

    // ==================== P0 PANIC + DEDUCER + ADAPTIVE (v3.4) ====================

    /**
     * PANIC gate: true если флаг под реальной угрозой.
     * Используем и свои _getThreats, и shared aiEngine.findFlagDefenseMoves (не пусто = угроза есть).
     */
    _isFlagInDanger(gameState, myPieces) {
        const pieces = myPieces || this._getMyActivePieces(gameState);
        const myFlag = pieces.find(p => p.type === 'flag' && !p.removed);
        if (!myFlag) return true;

        // 1. Прямые угрозы в радиусе 1 (любой не-флаг враг)
        const imm = this._getThreatsToFlag(gameState, myFlag, 1);
        if (imm.length > 0) return true;

        // 2. Давление в радиусе 2 + используем shared детектор
        const threats2 = this._getThreatsToFlag(gameState, myFlag, 2);
        if (threats2.length >= 2) return true;

        if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.findFlagDefenseMoves === 'function') {
            const avail = (typeof aiEngine.getActivePieces === 'function')
                ? aiEngine.getActivePieces(gameState) : pieces;
            const defMoves = aiEngine.findFlagDefenseMoves(gameState, avail);
            if (defMoves && defMoves.length > 0) return true;
        }

        // 3. Любая revealed вражеская фигура в радиусе 2 без достаточного нашего покрытия
        const revealedNear = threats2.filter(t => t.revealed && t.type !== 'flag');
        if (revealedNear.length >= 1 && threats2.length >= 1) {
            // Если нет живого trap рядом и нет разнообразия RPS-защитников — паника
            const trapNear = pieces.some(p => p.type === 'trap' && !p.removed &&
                Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col)) <= 2);
            if (!trapNear) return true;
        }

        return false;
    },

    /**
     * Deducer для aiTacticalCore.getMandatoryMove (R5 hunt last hidden flag).
     * Использует нашу сильную belief-систему как источник правды.
     */
    _deduceEnemyFlag(gameState) {
        const candidates = this._getFlagCandidates(6);
        const hidden = candidates.filter(c => {
            const p = c.piece;
            return p && !p.removed && (!p.revealed || p.type === 'flag');
        }).length;

        return {
            candidates: candidates.map(c => ({ piece: c.piece, prob: c.pFlag })),
            hiddenCount: Math.max(1, hidden || 1)
        };
    },

    /** Безопасный ход в режиме паники — только ближайшие к флагу защитные/блокирующие позиции */
    _safePanicMove(gameState, myPieces) {
        const myFlag = myPieces.find(p => p.type === 'flag' && !p.removed);
        if (!myFlag) return null;

        let best = null;
        let bestScore = -Infinity;

        for (const p of myPieces) {
            if (p.type === 'flag') continue;
            const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);
            for (const m of moves) {
                let score = 0;
                const distBefore = Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col));
                const distAfter = Math.max(Math.abs(m.row - myFlag.row), Math.abs(m.col - myFlag.col));
                if (distAfter < distBefore) score += 100;
                if (distAfter <= 1) score += 60;

                const target = gameState.board[m.row]?.[m.col];
                if (target && target.owner === 'player' && target.type !== 'flag') {
                    score += 40; // блокировка/атака угрозы
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = { piece: p, row: m.row, col: m.col };
                }
            }
        }
        return bestScore > 20 ? best : null;
    },

    /** Адаптивная глубина поиска: меньше когда флаг под давлением или ранняя игра */
    _getAdaptiveSearchDepth(gameState, myPieces) {
        const myFlag = myPieces.find(p => p.type === 'flag' && !p.removed);
        if (!myFlag) return 2;

        const threats = this._getThreatsToFlag(gameState, myFlag, 3);
        if (threats.length >= 2) return 2;
        if (threats.length >= 1) return 3;

        const turn = this._turn || 0;
        if (turn < 6) return 2; // build phase — не рискуем глубоким поиском
        return 4;
    },

    /**
     * Fortress score — «крепость» вокруг своего флага (P1 по IMPROVE_PROMPT).
     * + за разнообразных защитников в радиусе 1, живой trap в 2, − за врагов рядом.
     */
    _fortressScore(gameState) {
        const myPieces = this._getMyActivePieces(gameState);
        const myFlag = myPieces.find(p => p.type === 'flag' && !p.removed);
        if (!myFlag) return 0;

        let score = 0;
        const near = myPieces.filter(p => p.type !== 'flag' && !p.removed &&
            Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col)) <= 1);

        // Разнообразие RPS вблизи флага — сильный бонус
        const types = new Set(near.filter(p => p.type === 'piece' && p.pieceType).map(p => p.pieceType));
        score += types.size * 28;

        // Живой trap в радиусе 2
        const trap = myPieces.find(p => p.type === 'trap' && !p.removed &&
            Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col)) <= 2);
        if (trap) score += 45;

        // Враги в радиусе 2 — сильный штраф
        const enemiesNear = (gameState.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 &&
            Math.max(Math.abs(p.row - myFlag.row), Math.abs(p.col - myFlag.col)) <= 2 &&
            p.type !== 'flag'
        );
        score -= enemiesNear.length * 38;

        // Дополнительно: если есть 2+ защитника разных типов — бонус "кулак"
        if (near.length >= 2 && types.size >= 2) score += 22;

        return score;
    },

    // ==================== BELIEF-AWARE SEARCH (ГЛАВНОЕ ОРУЖИЕ) ====================
    _beliefAwareSearch(gameState, myPieces, depth) {
        let bestMove = null;
        let bestScore = -Infinity;

        const moves = this._generateAllSafeMoves(gameState, myPieces);

        for (const move of moves) {
            // Оцениваем ход с учётом неопределённости врага
            const score = this._evaluateMoveWithSearch(gameState, move, depth - 1);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
        }

        return bestMove;
    },

    _generateAllSafeMoves(gameState, pieces) {
        const turn = this._turn || 0;
        const myFlag = pieces.find(pp => pp.type === 'flag');

        // v3.4: база из shared (если есть) — уже отфильтровано по правилам движка
        let base = [];
        if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.getAllFilteredMoves === 'function') {
            const avail = (typeof aiEngine.getActivePieces === 'function')
                ? aiEngine.getActivePieces(gameState) : pieces;
            base = aiEngine.getAllFilteredMoves(gameState, avail) || [];
        } else {
            for (const p of pieces) {
                const moves = getLegalMoves ? getLegalMoves(p, gameState) : this._getLegalMovesLocal(p, gameState);
                for (const m of moves) base.push({ piece: p, row: m.row, col: m.col });
            }
        }

        // Наши дополнительные safety + fortress-aware фильтры
        return this._applyExtraSafetyFilters(gameState, base, pieces);
    },

    _evaluateMoveWithSearch(gameState, move, depth) {
        // Быстрая статическая оценка + бонус за качество хода
        let score = this._evaluatePosition(gameState, move);

        // Бонус за приближение к высоковероятному флагу
        const candidates = this._getFlagCandidates(1);
        if (candidates.length > 0 && candidates[0].pFlag > 0.55) {
            const t = candidates[0].piece;
            const dist = Math.max(Math.abs(move.row - t.row), Math.abs(move.col - t.col));
            score += (5 - Math.min(5, dist)) * 28;
        }

        // Если глубина позволяет — делаем простой lookahead + quiescence
        if (depth > 0) {
            const virtualScore = this._quickLookahead(gameState, move, depth);
            score += virtualScore * 0.6;
        }

        // v3.4: fortress в листьях поиска
        score += this._fortressScore(gameState) * 0.9;

        return score;
    },

    _quickLookahead(gameState, move, depth) {
        // Улучшенный lookahead v3.4: точный makeVirtualMove + quiescence на захват флага
        // (по IMPROVE_PROMPT: после каждого виртуального хода проверяем findFlagDefenseMoves на "ответ" соперника)
        if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.makeVirtualMove === 'function') {
            try {
                const after = aiEngine.makeVirtualMove(gameState, move);

                // === QUIESCENCE v3.4: флаг под боем и нет защиты → мгновенная смерть (-1e6) ===
                const myFlagAfter = after.aiPieces && after.aiPieces.find(p => p.type === 'flag' && !p.removed);
                if (myFlagAfter) {
                    const threatsAfter = (after.playerPieces || []).filter(p =>
                        !p.removed && p.row >= 0 &&
                        Math.max(Math.abs(p.row - myFlagAfter.row), Math.abs(p.col - myFlagAfter.col)) <= 1 &&
                        p.type !== 'flag'
                    );

                    if (threatsAfter.length > 0) {
                        // Пытаемся вызвать shared defense detector на новой позиции
                        let hasDefense = false;
                        if (typeof aiEngine.findFlagDefenseMoves === 'function') {
                            const availAfter = (typeof aiEngine.getActivePieces === 'function')
                                ? aiEngine.getActivePieces(after) : (after.aiPieces || []).filter(p => !p.removed && !p.immobilized);
                            const defs = aiEngine.findFlagDefenseMoves(after, availAfter);
                            hasDefense = !!(defs && defs.length > 0);
                        }
                        if (!hasDefense) {
                            return -1000000; // флаг висит без защиты после нашего хода
                        }
                    }
                }

                // Простая проверка (backward compat)
                if (this._opponentCanTakeOurFlag(after)) {
                    return -9500;
                }

                // Fortress-aware оценка
                const base = this._evaluatePosition(after, null) * 0.7;
                // Если после хода крепость улучшилась — небольшой бонус
                const fortDelta = this._fortressScore(after) - this._fortressScore(gameState);
                return base + fortDelta * 0.8;
            } catch (e) {}
        }

        // Fallback к старой лёгкой эвристике (на случай отсутствия движка)
        let bonus = 0;
        const myFlag = gameState.aiPieces.find(p => p.type === 'flag' && !p.removed);
        if (myFlag) {
            const distBefore = Math.max(Math.abs(move.piece.row - myFlag.row), Math.abs(move.piece.col - myFlag.col));
            const distAfter = Math.max(Math.abs(move.row - myFlag.row), Math.abs(move.col - myFlag.col));
            if (distAfter < distBefore) bonus += 35;
        }
        const topSuspect = this._getFlagCandidates(1)[0];
        if (topSuspect && topSuspect.pFlag > 0.6) {
            const d = Math.max(Math.abs(move.row - topSuspect.piece.row), Math.abs(move.col - topSuspect.piece.col));
            bonus += (4 - Math.min(4, d)) * 18;
        }
        return bonus;
    },

    _opponentCanTakeOurFlag(state) {
        const myFlag = state.aiPieces && state.aiPieces.find(p => p.type === 'flag' && !p.removed);
        if (!myFlag) return false;

        const enemies = (state.playerPieces || []).filter(p => !p.removed && p.row >= 0 && !p.immobilized);
        for (const e of enemies) {
            if (e.type === 'flag') continue;
            const d = Math.max(Math.abs(e.row - myFlag.row), Math.abs(e.col - myFlag.col));
            if (d <= 1) return true; // король-ход на клетку флага возможен
        }
        return false;
    }
};

obezyankaBot._register();