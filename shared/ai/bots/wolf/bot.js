/**
 * 🐺 Волк — Theory-of-Mind (Psychological Minimax) с тактикой "Кулака".
 *
 * Волк формирует ударный "кулак" из разнотипных фигур (Камень, Ножницы, Бумага),
 * чтобы они страховали друг друга и наносили скоординированный удар.
 * 
 * 1. Непредсказуемая оборона: Флаг и Капкан ставятся вместе в любую точку задней линии.
 * 2. Агрессия: Высокий приоритет на уничтожение открытых фигур соперника. Штраф за "нерешительность".
 * 3. Кулак: Оптимизированный бонус за синергию (разные фигуры рядом), штраф за скученность.
 * 4. Целеуказание: Кулак целенаправленно движется к предполагаемому флагу соперника.
 * 5. Защита базы: Учитывается мобильность флага (клетки для отступления).
 */

const wolfBot = (() => {
    const TIME_BUDGET_MS = 2500;
    const MAX_DEPTH = 3;
    const HUNT_HORIZON = 4;

    if (typeof window !== 'undefined' && !window.RPSBotAPI) {
        console.error('[wolf] bot-api.js required before wolf/bot.js');
    }

    function aiFlag(state) {
        return state.aiPieces.find(p => p.type === FLAG && !p.removed);
    }

    function chebyshev(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    }

    // =========================================================================
    //  FLAG DEDUCER (Поиск вражеского флага)
    // =========================================================================
    function deduceFlag(state) {
        const hidden = state.playerPieces.filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== TRAP
        );
        if (hidden.length === 0) return { candidates: [], hiddenCount: 0 };
        if (hidden.length === 1) return { candidates: [{ piece: hidden[0], prob: 1 }], hiddenCount: 1 };

        const scores = [];
        let sum = 0;
        for (const piece of hidden) {
            let score = 6;
            const info = aiEngine.enemyStillness.get(piece.id) || { stillnessScore: 0, hasMovedOnce: false };

            if (info.hasMovedOnce) {
                score -= 40;
            } else {
                score += Math.min(info.stillnessScore, 10) * 6;
            }

            const backRow = BOARD_HEIGHT - 1;
            const secondRow = BOARD_HEIGHT - 2;
            if (piece.row === backRow) score += 30;
            else if (piece.row === secondRow) score += 10;
            else score -= 25;

            const isCorner = (piece.col === 0 || piece.col === BOARD_WIDTH - 1);
            if (isCorner && piece.row >= secondRow) score += 22;

            score = Math.max(1, score);
            scores.push({ piece, raw: score });
            sum += score;
        }

        const candidates = scores
            .map(s => ({ piece: s.piece, prob: s.raw / sum }))
            .sort((a, b) => b.prob - a.prob);

        return { candidates, hiddenCount: hidden.length };
    }

    // =========================================================================
    //  PSYCHOLOGICAL EVALUATION ("FIST" TACTICS)
    // =========================================================================
    function evaluatePosition(state, depth) {
        const terminal = aiSearch.getTerminalOutcome(state);
        if (terminal) {
            if (terminal.outcome === 'win') {
                return 1000000;
            }
            if (terminal.outcome === 'lose') {
                return -1000000;
            }
            return 0;
        }
        let score = 0;
        
        const myFlag = aiFlag(state);
        const enemyFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);

        let myPiecesCount = 0;

        // 1. Оценка материала
        for (const p of state.aiPieces) {
            if (p.removed || p.row < 0 || p.immobilized) continue;
            if (p.type === FLAG) {
                score += 100000;
            } else if (p.type === TRAP) {
                score += 500;
            } else {
                score += 300; 
            }
        }

        for (const p of state.playerPieces) {
            if (p.removed || p.row < 0 || p.immobilized) continue;
            if (p.type === FLAG) {
                score -= 100000;
            } else if (p.type === TRAP) {
                score -= 200; 
            } else {
                score -= p.revealed ? 450 : 350; 
            }
        }

        const attackers = [];
        for (let i = 0; i < state.aiPieces.length; i++) {
            const p = state.aiPieces[i];
            if (!p.removed && p.row >= 0 && p.type === 'piece') {
                attackers.push(p);
            }
        }

        // 2. Безопасность флага Волка
        if (myFlag) {
            let nearestEnemyDist = Infinity;
            for (const enemy of state.playerPieces) {
                if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
                const d = chebyshev(enemy, myFlag);
                if (d < nearestEnemyDist) nearestEnemyDist = d;
                
                if (d <= 3) {
                    score -= (4 - d) * 300; 
                }
            }

            // Оценка путей отхода (мобильность флага)
            let escapes = 0;
            for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
                const r = myFlag.row + dr, c = myFlag.col + dc;
                if (r >= 0 && r < BOARD_HEIGHT && c >= 0 && c < BOARD_WIDTH) {
                    const target = state.board[r] && state.board[r][c];
                    if (!target) escapes++;
                }
            }
            score += escapes * 30; // Бонус за то, что флагом можно сбежать

            if (nearestEnemyDist <= 3 && escapes <= 2) {
                let defenders = 0;
                for (let i = 0; i < attackers.length; i++) {
                    if (chebyshev(attackers[i], myFlag) <= 2) defenders++;
                }
                if (defenders === 0) score -= 600; // Паника, голый флаг и мало путей
                else if (defenders === 1) score -= 200;
            }
        }

        // 3. Формирование "Боевого кулака" и целеуказание (оптимизировано)
        let fistBonus = 0;
        let clusterPenalty = 0;
        let distanceToSuspect = 0;

        const suspectedFlag = deduceFlag(state).candidates[0];

        for (let i = 0; i < attackers.length; i++) {
            let r = false, p = false, s = false;
            let sameCount = 0;
            const ally = attackers[i];

            if (ally.pieceType === 'rock') r = true;
            else if (ally.pieceType === 'paper') p = true;
            else if (ally.pieceType === 'scissors') s = true;

            for (let j = 0; j < attackers.length; j++) {
                if (i === j) continue;
                const otherAlly = attackers[j];
                const d = chebyshev(ally, otherAlly);
                
                if (d <= 2) { 
                    if (otherAlly.pieceType === 'rock') r = true;
                    else if (otherAlly.pieceType === 'paper') p = true;
                    else if (otherAlly.pieceType === 'scissors') s = true;

                    if (ally.pieceType === otherAlly.pieceType) {
                        sameCount++;
                    }
                }
            }

            if (sameCount > 0) clusterPenalty -= sameCount * 30; 

            const typesCount = (r?1:0) + (p?1:0) + (s?1:0);
            if (typesCount === 3) fistBonus += 80;
            else if (typesCount === 2) fistBonus += 25;

            if (suspectedFlag) {
                const distToFlag = chebyshev(ally, suspectedFlag.piece);
                distanceToSuspect -= distToFlag * 12; 
            }
        }

        score += fistBonus;
        score += clusterPenalty;
        score += distanceToSuspect;

        // 4. Штрафы за подставленные фигуры и НЕРЕШИТЕЛЬНОСТЬ
        for (let i = 0; i < attackers.length; i++) {
            const ally = attackers[i];
            for (const enemy of state.playerPieces) {
                if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
                if (chebyshev(ally, enemy) === 1) { 
                    if (enemy.revealed && enemy.type === 'piece') {
                        const res = aiEngine.resolveBattle(ally.pieceType, enemy.pieceType);
                        if (res === 'lose') {
                            score -= 900; 
                        } else if (res === 'win') {
                            // Штраф за "стояние рядом" без убийства. 
                            // Если Волк стоит рядом с жертвой и не съел ее (что привело бы к удалению врага и +450 очкам), 
                            // мы штрафуем эту "нерешительность", чтобы он предпочел ход со взятием фигуры.
                            score -= 150; 
                        }
                    }
                }
            }
        }

        return score;
    }

    // =========================================================================
    //  MINIMAX ENGINE
    // =========================================================================
    function orderMoves(state, moves, owner) {
        return moves.map(m => {
            let score = Math.random() * 5; 
            const target = state.board[m.row] && state.board[m.row][m.col];
            if (target && target.owner !== owner) {
                score += 1000;
                if (target.type === FLAG) score += 5000;
                if (target.revealed && target.type === 'piece' && m.piece.type === 'piece') {
                    const res = aiEngine.resolveBattle(m.piece.pieceType, target.pieceType);
                    if (res === 'win') score += 2000;
                    if (res === 'lose') score -= 3000;
                }
            }
            if (owner === COMPUTER) score += m.row * 10;
            else score -= m.row * 10;
            
            return { m, score };
        }).sort((a, b) => b.score - a.score).map(x => x.m);
    }

    function minimax(state, depth, alpha, beta, isMax, deadline) {
        if (Date.now() > deadline) return { score: evaluatePosition(state, depth), move: null };
        if (aiEngine.isGameOver(state)) return { score: evaluatePosition(state, depth), move: null };
        if (depth === 0) return { score: evaluatePosition(state, depth), move: null };

        const owner = isMax ? COMPUTER : PLAYER;
        let moves = aiEngine.getAllPossibleMoves(state, owner);
        if (moves.length === 0) return { score: evaluatePosition(state, depth), move: null };

        moves = orderMoves(state, moves, owner);

        const maxMoves = isMax ? 15 : 10;
        if (moves.length > maxMoves) moves = moves.slice(0, maxMoves);

        let bestScore = isMax ? -Infinity : Infinity;
        let bestMove = moves[0];

        for (const move of moves) {
            if (Date.now() > deadline) break;
            const childScore = expectedSearchScore(
                state,
                move,
                depth - 1,
                !isMax,
                deadline
            );
            
            if (isMax) {
                if (childScore > bestScore) {
                    bestScore = childScore;
                    bestMove = move;
                }
                alpha = Math.max(alpha, bestScore);
            } else {
                if (childScore < bestScore) {
                    bestScore = childScore;
                    bestMove = move;
                }
                beta = Math.min(beta, bestScore);
            }

            if (beta <= alpha) break;
        }

        return { score: bestScore, move: bestMove };
    }

    function expectedSearchScore(state, move, depth, isMax, deadline) {
        const outcomes = aiSearch.getMoveOutcomes(state, move);
        if (outcomes.length === 0) {
            return evaluatePosition(state, depth);
        }
        let score = 0;
        for (const outcome of outcomes) {
            const child = minimax(
                outcome.state,
                depth,
                -Infinity,
                Infinity,
                isMax,
                deadline
            );
            score += outcome.probability * child.score;
        }
        return score;
    }

    function pickMove(state) {
        const available = aiEngine.getActivePieces(state);
        if (available.length === 0) return null;

        const all = aiEngine.getAllFilteredMoves(state, available);
        if (all.length === 0) return null;

        const shuttleSafe = aiEngine.filterOutShuttleMoves(all);
        let moves = shuttleSafe.length > 0 ? shuttleSafe : all;

        moves = orderMoves(state, moves, COMPUTER);
        moves = moves.slice(0, 10); 

        const deadline = Date.now() + TIME_BUDGET_MS;
        let bestMove = moves[0];
        let bestScore = -Infinity;

        for (let depth = 1; depth <= MAX_DEPTH; depth++) {
            let dBestScore = -Infinity;
            let dBestMove = null;
            let alpha = -Infinity;
            let beta = Infinity;

            for (const move of moves) {
                if (Date.now() > deadline) break;
                const childScore = expectedSearchScore(
                    state,
                    move,
                    depth - 1,
                    false,
                    deadline
                );
                
                if (childScore > dBestScore) {
                    dBestScore = childScore;
                    dBestMove = move;
                }
                alpha = Math.max(alpha, dBestScore);
            }

            if (Date.now() > deadline && !dBestMove) break;
            
            bestScore = dBestScore;
            if (dBestMove) bestMove = dBestMove;
            
            if (Date.now() > deadline) break;
            
            moves = [bestMove, ...moves.filter(m => m !== bestMove)];
        }

        return bestMove;
    }

    return {
        id: 'wolf',
        name: 'Волк',
        emoji: '🐺',
        avatar: 'js/bots/wolf/avatar-min.png',
        shortDescription: 'Кулак и Точечный Удар',
        longDescription: 'Боевой кулак, охота на флаг, съедает открытые фигуры. Флаг и капкан — не по шаблону.',
        algorithmLabel: 'Минимакс + тактика кулака',
        tier: 'medium',
        stars: 2,
        difficultyLabel: 'Средний',
        tags: ['minimax', 'fist-formation', 'aggressive'],

        move(gameState) {
            try {
                aiEngine.positionCache.clear();
                aiEngine.analyzePlayerPattern(gameState);
                aiEngine.trackEnemyStillness(gameState);
                aiEngine.updateStrategicTargets(gameState);

                const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                    deducer: deduceFlag,
                    flagHuntHorizon: HUNT_HORIZON,
                    antiCluster: false 
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
                console.error('[wolf] move() failed:', error);
                return null;
            }
        },

        chooseFlagAndTrap() {
            // Флаг ставится случайным образом на 0-й линии (индексы 0-7)
            const flagCol = Math.floor(Math.random() * 8);
            const flagIndex = flagCol;
            
            // Капкан ставится в одну из соседних клеток (включая диагональные, так как ходы по диагонали разрешены)
            const traps = [];
            for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
                const r = 0 + dr;
                const c = flagCol + dc;
                if (r >= 0 && r < 2 && c >= 0 && c < 8) {
                    // Разрешаем ставить только на 0 и 1 линии (территория ИИ)
                    traps.push(r * 8 + c);
                }
            }

            const trapIndex = traps[Math.floor(Math.random() * traps.length)];
            return { flagIndex, trapIndex };
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = wolfBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(wolfBot);
} else {
    throw new Error('[wolf] RPSBotAPI.defineBot is required (bot-api.js ordering)');
}
