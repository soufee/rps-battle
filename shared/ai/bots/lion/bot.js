/**
 * 🦁 Львёнок — flat Information-Set Monte-Carlo bot.
 *
 * Simplified flat ISMCTS:
 *   1. Ask aiTacticalCore for mandatory flag, defence, kill, or hunt moves.
 *   2. Rank root candidates with evaluateMoveV2 and anti-clustering pressure.
 *   3. Build a seeded world for every trial from public Bayesian beliefs,
 *      preserving exactly one hidden flag and one hidden trap when possible.
 *   4. Sample every combat through the shared fog-safe outcome model.
 *   5. Roll out both sides with lightweight tactical policies.
 *   6. Evaluate final positions and choose the highest mean root score.
 *
 * Its flag deducer combines stillness, position, and local formation signals.
 *
 * Unlike deterministic minimax bots, Lion accepts uncertainty and compares
 * moves by their sampled mean value.
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
    const HUNT_HORIZON = 3;

    function determinize(state, seed) {
        return aiSearch.determinizeWorld(state, { seed });
    }

    function sampleMoveOutcome(state, move) {
        const outcomes = aiSearch.getMoveOutcomes(state, move);
        if (outcomes.length === 0) {
            return aiSearch.cloneSearchState(state);
        }
        let roll = Math.random();
        for (const outcome of outcomes) {
            roll -= outcome.probability;
            if (roll <= 0) {
                return outcome.state;
            }
        }
        return outcomes[0].state;
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
            const target = state.board[m.row] && state.board[m.row][m.col];
            if (piece.type === FLAG
                && target) {
                continue;
            }

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
            current = sampleMoveOutcome(current, move);
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

                const seed = `${done}|${entry.move.piece.id}|${entry.move.row}|${entry.move.col}|${Math.random()}`;
                const trial = determinize(state, seed);
                const afterRoot = sampleMoveOutcome(trial, entry.move);
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
