/**
 * 🦁 Львёнок — flat Information-Set Monte-Carlo bot.
 *
 * Классический ISMCTS в упрощённой форме:
 *   1. Сначала спрашиваем aiTacticalCore — есть ли "обязательный" ход
 *      (захват флага, защита, гарантированный kill, охота на
 *      последнюю скрытую). Если есть — делаем его. Это страхует Льва
 *      от того, что Монте-Карло "усреднит" немедленный выигрыш.
 *   2. Выбираем root-кандидатов: top-K по evaluateMoveV2 с учётом
 *      антикластерного штрафа плюс любой гарантированный kill.
 *   3. Для каждого root-хода гоняем N симуляций. Перед каждой симуляцией
 *      сэмплируем типы скрытых вражеских фигур БАЙЕСОВСКИ — по
 *      апостериорному распределению «сколько ещё остаётся каждого
 *      типа» (inferTypeCounts). Это точнее, чем равномерное 1/3/3.
 *   4. Играем rollout: на своём ходу предпочитаем tactical-core
 *      (мини-правила) с ε-исследованием, на ходу соперника — лёгкая
 *      эвристика (не лезет в проигрыш).
 *   5. Итоговую позицию оцениваем через evaluatePositionV2.
 *   6. Выбираем root-ход с максимальным средним скором.
 *
 * Flag deducer: "Bayesian-ish" — как Лис/Волк, но калиброванный под
 * симуляционный подход (stillness + позиция + окружение).
 *
 * Отличие от Ёжика (minimax + beliefs) и Совы (alpha-beta): стохастическая
 * усреднённая оценка. Лев смел и терпим к неопределённости, но иногда
 * подставляется — цена Монте-Карло.
 *
 * Certified by RPSBotAPI (mandatory base rules + contract).
 */

// === MANDATORY guard
if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[lion] bot-api.js must be loaded first');
}

const lionBot = (() => {
    const TIME_BUDGET_MS = 3500;
    const ROOT_CANDIDATES = 5;
    const SIMULATIONS_PER_ROOT = 80;
    const ROLLOUT_DEPTH = 6;
    const EPSILON = 0.10;
    const ASSUMED_TOTAL_PIECES = 14;
    const ASSUMED_DISTRIBUTION = { rock: 5, paper: 5, scissors: 4 };
    const HUNT_HORIZON = 3;

    function cloneState(state) {
        const clone = JSON.parse(JSON.stringify(state));
        clone.board = [];
        for (let row = 0; row < BOARD_HEIGHT; row++) {
            clone.board[row] = [];
            for (let col = 0; col < BOARD_WIDTH; col++) {
                clone.board[row][col] = null;
            }
        }
        [...clone.playerPieces, ...clone.aiPieces].forEach(piece => {
            if (!piece.removed && piece.row >= 0 && piece.col >= 0) {
                clone.board[piece.row][piece.col] = piece;
            }
        });
        return clone;
    }

    /**
     * Infer how many of each type are likely still hidden among the
     * opponent's unrevealed 'piece' entries. We use a rough prior from the
     * nominal placement distribution (~5/5/4), then subtract types we've
     * already seen revealed. Floor at 1 so we never assign zero weight to
     * a type that might still exist.
     */
    function inferTypeCounts(state) {
        const seen = { rock: 0, paper: 0, scissors: 0 };
        for (const piece of state.playerPieces) {
            if (piece.type !== 'piece') {
                continue;
            }
            if (!piece.pieceType) {
                continue;
            }
            if (piece.revealed || piece.removed) {
                seen[piece.pieceType] = (seen[piece.pieceType] || 0) + 1;
            }
        }
        const counts = {};
        let total = 0;
        for (const key of PIECE_TYPES) {
            counts[key] = Math.max(1, ASSUMED_DISTRIBUTION[key] - seen[key]);
            total += counts[key];
        }
        return { counts, total };
    }

    function sampleType(counts) {
        const total = counts.rock + counts.paper + counts.scissors;
        if (total <= 0) {
            return PIECE_TYPES[Math.floor(Math.random() * PIECE_TYPES.length)];
        }
        let roll = Math.random() * total;
        for (const key of PIECE_TYPES) {
            roll -= counts[key] || 0;
            if (roll <= 0) {
                return key;
            }
        }
        return PIECE_TYPES[PIECE_TYPES.length - 1];
    }

    /**
     * ISMCTS determinization with Bayesian-ish type weighting:
     * Each hidden enemy 'piece' gets a pieceType sampled from the
     * inferred remaining distribution. Flag/trap entries are left alone
     * (the current engine already stores their true type).
     */
    function determinize(state) {
        const hidden = state.playerPieces.filter(p =>
            !p.removed
                && p.row >= 0
                && p.type === 'piece'
                && !p.revealed
        );
        const { counts } = inferTypeCounts(state);
        const pool = { ...counts };
        for (const piece of hidden) {
            const type = sampleType(pool);
            piece.pieceType = type;
            pool[type] = Math.max(1, (pool[type] || 1) - 1);
        }
    }

    function deduceFlag(state) {
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

        const scores = [];
        let sum = 0;
        for (const piece of hidden) {
            let score = 5;

            const info = aiEngine.enemyStillness.get(piece.id)
                || { stillnessScore: 0, hasMovedOnce: false };

            score += Math.min(info.stillnessScore, 10) * 10;
            if (info.hasMovedOnce) {
                score -= 30;
            }

            if (piece.row === BOARD_HEIGHT - 1) {
                score += 25;
            } else if (piece.row === BOARD_HEIGHT - 2) {
                score += 10;
            } else {
                score -= 18;
            }

            const isCorner = piece.col === 0 || piece.col === BOARD_WIDTH - 1;
            if (isCorner && piece.row >= BOARD_HEIGHT - 2) {
                score += 15;
            }

            score = Math.max(1, score);
            scores.push({ piece, raw: score });
            sum += score;
        }

        const candidates = scores
            .map(s => ({ piece: s.piece, prob: s.raw / sum }))
            .sort((a, b) => b.prob - a.prob);

        return { candidates, hiddenCount: hidden.length };
    }

    function isGameOver(state) {
        return aiEngine.isGameOver(state);
    }

    /**
     * Лёгкая эвристика ответа соперника.
     */
    function opponentResponse(state) {
        const moves = aiEngine.getAllPossibleMoves(state, PLAYER);
        if (moves.length === 0) {
            return null;
        }

        const ourFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);

        const scored = [];
        for (const m of moves) {
            const piece = m.piece;
            if (piece.type === FLAG) {
                continue;
            }
            const target = state.board[m.row] && state.board[m.row][m.col];

            let score = 0;

            if (target && target.owner === COMPUTER) {
                if (target.type === FLAG) {
                    score += 100000;
                } else if (target.type === TRAP && target.revealed) {
                    continue;
                } else if (target.revealed && target.type === 'piece' && piece.type === 'piece') {
                    const r = aiEngine.resolveBattle(piece.pieceType, target.pieceType);
                    if (r === 'win') {
                        score += 600;
                    } else {
                        continue;
                    }
                } else {
                    score += 40;
                }
            }

            if (ourFlag) {
                const baseDist = Math.max(
                    Math.abs(piece.row - ourFlag.row),
                    Math.abs(piece.col - ourFlag.col)
                );
                const newDist = Math.max(
                    Math.abs(m.row - ourFlag.row),
                    Math.abs(m.col - ourFlag.col)
                );
                score += (baseDist - newDist) * 20;
            }

            score += Math.random() * 10;
            scored.push({ move: m, score });
        }

        if (scored.length === 0) {
            return moves[Math.floor(Math.random() * moves.length)];
        }
        scored.sort((a, b) => b.score - a.score);
        return scored[0].move;
    }

    /**
     * Наш ход в rollout: сначала проверяем мини-правила через tactical-core
     * (captureFlag, defence, guaranteedKill, hunt). Если ничего — обычная
     * эвристика с ε-случайностью.
     */
    function ourRolloutMove(state) {
        const forced = aiTacticalCore.getMandatoryMove(state, {
            deducer: deduceFlag,
            flagHuntHorizon: HUNT_HORIZON,
            antiCluster: true
        });
        if (forced) {
            return forced;
        }

        const available = aiEngine.getActivePieces(state);
        const moves = aiEngine.getAllFilteredMoves(state, available);
        if (moves.length === 0) {
            return null;
        }

        if (Math.random() < EPSILON) {
            return moves[Math.floor(Math.random() * moves.length)];
        }

        let best = moves[0];
        let bestScore = -Infinity;
        for (const m of moves) {
            let s = aiEngine.evaluateMoveV2(m, state);
            s -= aiTacticalCore.clusterPenalty(state, m.piece, m);
            s += Math.random() * 5;
            if (s > bestScore) {
                bestScore = s;
                best = m;
            }
        }
        return best;
    }

    function rollout(state) {
        let current = state;
        let turn = PLAYER;

        for (let ply = 0; ply < ROLLOUT_DEPTH && !isGameOver(current); ply++) {
            const move = turn === COMPUTER
                ? ourRolloutMove(current)
                : opponentResponse(current);
            if (!move) {
                break;
            }
            current = aiEngine.makeVirtualMove(current, move);
            turn = turn === COMPUTER ? PLAYER : COMPUTER;
        }

        return aiEngine.evaluatePositionV2(current);
    }

    function topRootMoves(state) {
        const available = aiEngine.getActivePieces(state);
        if (available.length === 0) {
            return [];
        }
        const all = aiEngine.getAllFilteredMoves(state, available);
        if (all.length === 0) {
            return [];
        }

        const shuttleSafe = aiEngine.filterOutShuttleMoves(all);
        const pool = shuttleSafe.length > 0 ? shuttleSafe : all;

        const scored = pool.map(m => {
            let score = aiEngine.evaluateMoveV2(m, state);
            score -= aiTacticalCore.clusterPenalty(state, m.piece, m);
            if (!aiTacticalCore.safeToLeave(state, m.piece)) {
                score -= 60;
            }
            return { move: m, score };
        });
        scored.sort((a, b) => b.score - a.score);

        const topMoves = scored.slice(0, Math.min(ROOT_CANDIDATES, scored.length));
        const kills = aiEngine.findGuaranteedKills(state, available)
            .filter(k => aiTacticalCore.safeToLeave(state, k.piece));

        const roots = topMoves.map(e => e.move);
        for (const k of kills) {
            const present = roots.some(r =>
                r.piece.id === k.piece.id && r.row === k.row && r.col === k.col
            );
            if (!present) {
                roots.push(k);
            }
        }
        return roots;
    }

    function pickMove(state) {
        const roots = topRootMoves(state);
        if (roots.length === 0) {
            return null;
        }
        if (roots.length === 1) {
            return roots[0];
        }

        const stats = roots.map(m => ({ move: m, sum: 0, count: 0 }));
        const deadline = Date.now() + TIME_BUDGET_MS;
        const budget = roots.length * SIMULATIONS_PER_ROOT;
        let done = 0;

        while (done < budget && Date.now() < deadline) {
            for (const entry of stats) {
                if (Date.now() >= deadline) {
                    break;
                }

                const trial = cloneState(state);
                determinize(trial);
                const afterRoot = aiEngine.makeVirtualMove(trial, entry.move);
                const score = rollout(afterRoot);
                entry.sum += score;
                entry.count += 1;
                done += 1;

                if (done >= budget) {
                    break;
                }
            }
        }

        stats.sort((a, b) => {
            const avgA = a.count === 0 ? -Infinity : a.sum / a.count;
            const avgB = b.count === 0 ? -Infinity : b.sum / b.count;
            return avgB - avgA;
        });

        return stats[0].move;
    }

    return {
        id: 'lion',
        name: 'Львёнок',
        emoji: '🦁',
        avatar: 'js/bots/lion/avatar-min.png',
        shortDescription: 'Монте-Карло в пространстве информации',
        longDescription: 'Сотни случайных партий с угадыванием скрытых типов. Смелый к риску, грубый в мелочах.',
        algorithmLabel: 'ISMCTS (плоский)',
        tier: 'medium',
        stars: 2,
        difficultyLabel: 'Средний',
        tags: ['mcts', 'stochastic'],

        move(gameState) {
            try {
                aiEngine.positionCache.clear();
                aiEngine.analyzePlayerPattern(gameState);
                aiEngine.trackEnemyStillness(gameState);
                aiEngine.updateStrategicTargets(gameState);

                const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                    deducer: deduceFlag,
                    flagHuntHorizon: HUNT_HORIZON,
                    antiCluster: true
                });
                if (mandatory) {
                    aiEngine.recordAIMove(mandatory);
                    return mandatory;
                }

                const move = pickMove(gameState);
                if (move) {
                    aiEngine.recordAIMove(move);
                }
                return move;
            } catch (error) {
                console.error('[lion] move() failed:', error);
                return null;
            }
        },

        chooseFlagAndTrap() {
            return aiEngine.chooseFlagAndTrapPositions({ style: 'corner-biased' });
        },

        getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
            return aiEngine.pickAnimalTieChoice(
                'lion',
                currentType,
                opponentRevealed,
                opponentType,
                gameState
            );
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = lionBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(lionBot);
} else {
    throw new Error('[lion] RPSBotAPI.defineBot is required (bot-api.js must precede all bot scripts)');
}
