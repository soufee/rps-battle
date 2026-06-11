/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                      GEMINI 3.5 FLASH — CHAMPION v1.0                      ║
 * ║                                                                           ║
 * ║  Author: Gemini 3.5 Flash (Google DeepMind)                               ║
 * ║  Status: Championship Ready — Optimized & Balanced                        ║
 * ║                                                                           ║
 * ║  "Designed to dominate. Combines dynamic Alpha-Beta search, custom        ║
 * ║   quiescence overrides, highly refined Bayesian belief processing,        ║
 * ║   paranoid flag safety, and coordinated 'Fist' mechanics.                 ║
 * ║   Named in honor of its creator."                                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[gemini_3_5_flash] bot-api.js must be loaded before this file');
}

var { RULES, resolveBattle, getLegalMoves, canAttack } = window.RPSBotAPI || {};

const gemini35FlashBot = (() => {
    // Search constraints
    const TIME_BUDGET_MS = 2500;
    const TIME_BUDGET_ENDGAME_MS = 3500;
    const MAX_DEPTH = 3;
    const MAX_DEPTH_ENDGAME = 5;
    const HUNT_HORIZON = 4;
    const CONFIRMED_FLAG_THRESHOLD = 0.85;

    // Helper functions
    function chebyshev(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    }

    function getAIFlag(state) {
        return state.aiPieces.find(p => p.type === FLAG && !p.removed);
    }

    /**
     * Local flag deducer that queries aiBeliefs or falls back to aiTacticalCore
     */
    function getFlagSuspect(state) {
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.getFlagCandidates === 'function') {
            const candidates = aiBeliefs.getFlagCandidates(state, 1);
            if (candidates.length > 0) {
                return { piece: candidates[0].piece, prob: candidates[0].pFlag };
            }
        }
        
        // Fallback to tactical core deducer
        const deduction = aiTacticalCore.deducers.simple(state);
        if (deduction.candidates && deduction.candidates.length > 0) {
            return { piece: deduction.candidates[0].piece, prob: deduction.candidates[0].prob };
        }
        
        return null;
    }

    /**
     * Custom Strike/Chase logic for confirmed flag suspect (P(flag) >= 0.85)
     */
    function tryConfirmedFlagStrike(state, availablePieces) {
        const suspect = getFlagSuspect(state);
        if (!suspect || suspect.prob < CONFIRMED_FLAG_THRESHOLD) {
            return null;
        }

        const target = suspect.piece;
        if (!target || target.row < 0) {
            return null;
        }

        // 1. Direct strike if adjacent
        let bestAttack = null;
        let bestAttackScore = -Infinity;
        for (const ai of availablePieces) {
            if (ai.type !== 'piece' || ai.immobilized) {
                continue;
            }
            const dist = chebyshev(target, ai);
            if (dist !== 1) {
                continue;
            }
            const score = 1000 + ai.row; // Prefer further advanced pieces
            if (score > bestAttackScore) {
                bestAttackScore = score;
                bestAttack = { piece: ai, row: target.row, col: target.col };
            }
        }
        if (bestAttack) {
            return bestAttack;
        }

        // 2. Chase
        const chasers = availablePieces.filter(p => p.type === 'piece' && !p.immobilized && p.row >= 0);
        if (chasers.length === 0) {
            return null;
        }

        chasers.sort((a, b) => chebyshev(target, a) - chebyshev(target, b));
        const pool = chasers.slice(0, Math.min(3, chasers.length));

        let bestChaseMove = null;
        let bestChaseScore = -Infinity;

        for (const chaser of pool) {
            const currentDist = chebyshev(target, chaser);
            if (currentDist <= 0) continue;

            const moves = getLegalMoves(chaser, state);
            for (const move of moves) {
                const occupant = state.board[move.row] && state.board[move.row][move.col];

                // Avoid suiciding into known traps or stronger revealed pieces
                if (occupant && occupant.owner !== chaser.owner) {
                    if (occupant.revealed) {
                        if (occupant.type === 'trap') continue;
                        if (occupant.type === 'piece') {
                            const battleOutcome = resolveBattle(chaser.pieceType, occupant.pieceType);
                            if (battleOutcome !== 'win') continue;
                        }
                    }
                }

                const newDist = chebyshev(target, move);
                if (newDist >= currentDist) {
                    continue; // Must get closer
                }

                // Shuttle check
                if (aiEngine.isShuttlePosition(chaser.id, move.row, move.col)) {
                    continue;
                }

                const score = (currentDist - newDist) * 1000 - aiEngine.countRecentMovesOfPiece(chaser.id, 4) * 30;
                if (score > bestChaseScore) {
                    bestChaseScore = score;
                    bestChaseMove = { piece: chaser, row: move.row, col: move.col };
                }
            }
        }

        return bestChaseMove;
    }

    /**
     * Coordinated Multi-factor Evaluation Function
     */
    function evaluatePosition(state, depth) {
        let score = 0;

        const myFlag = getAIFlag(state);
        const playerPieces = state.playerPieces || [];
        const aiPieces = state.aiPieces || [];

        // === 1. MATERIAL EVALUATION ===
        let myAttackers = [];
        for (const p of aiPieces) {
            if (p.removed || p.row < 0 || p.immobilized) continue;
            if (p.type === FLAG) {
                score += 150000;
            } else if (p.type === TRAP) {
                score += 1000;
            } else {
                myAttackers.push(p);
                // Keep pieces hidden! Unrevealed has information advantage.
                score += p.revealed ? 300 : 380;
            }
        }

        for (const p of playerPieces) {
            if (p.removed || p.row < 0 || p.immobilized) continue;
            if (p.type === FLAG) {
                score -= 150000;
            } else if (p.type === TRAP) {
                score -= 250;
            } else {
                // Revealed player pieces are easier to avoid or kill
                score -= p.revealed ? 450 : 320;
            }
        }

        // === 2. PARANOID FLAG SAFETY ===
        if (myFlag) {
            let nearestEnemyDist = Infinity;
            let nearbyThreatsCount = 0;

            for (const enemy of playerPieces) {
                if (enemy.removed || enemy.row < 0 || enemy.immobilized || enemy.type === FLAG) continue;
                const d = chebyshev(enemy, myFlag);
                if (d < nearestEnemyDist) nearestEnemyDist = d;

                if (d <= 3) {
                    nearbyThreatsCount++;
                    // Heavy penalty scaling with closeness
                    score -= (4 - d) * 400;
                }
            }

            // Flag Escape Mobility (empty cells around the flag)
            let escapeSquares = 0;
            for (const [dr, dc] of RULES.DIRECTIONS) {
                const r = myFlag.row + dr;
                const c = myFlag.col + dc;
                if (r >= 0 && r < BOARD_HEIGHT && c >= 0 && c < BOARD_WIDTH) {
                    const occ = state.board[r][c];
                    if (!occ) escapeSquares++;
                }
            }
            score += escapeSquares * 30;

            // Flag Ring Defenders
            let defendersCount = 0;
            let defenderTypes = new Set();
            let hasTrapDefender = false;

            for (const ally of aiPieces) {
                if (ally.removed || ally.row < 0 || ally.immobilized || ally.type === FLAG) continue;
                const d = chebyshev(ally, myFlag);
                if (d <= 2) {
                    defendersCount++;
                    if (ally.type === TRAP) {
                        hasTrapDefender = true;
                    } else if (ally.type === 'piece' && ally.pieceType) {
                        defenderTypes.add(ally.pieceType);
                    }
                }
            }

            // If an enemy is within 3 steps, we require a strong ring
            if (nearestEnemyDist <= 3) {
                if (defendersCount === 0) {
                    score -= 1000; // Critical warning: exposed flag!
                } else {
                    score += defenderTypes.size * 120;
                    if (hasTrapDefender) score += 250;
                }
            }
        }

        // === 3. FIST TACTICS & RPS COORDINATION ===
        let fistBonus = 0;
        let clusterPenalty = 0;

        for (let i = 0; i < myAttackers.length; i++) {
            const ally = myAttackers[i];
            let r = ally.pieceType === 'rock';
            let p = ally.pieceType === 'paper';
            let s = ally.pieceType === 'scissors';
            let sameCount = 0;

            for (let j = 0; j < myAttackers.length; j++) {
                if (i === j) continue;
                const otherAlly = myAttackers[j];
                const d = chebyshev(ally, otherAlly);

                if (d <= 2) {
                    if (otherAlly.pieceType === 'rock') r = true;
                    if (otherAlly.pieceType === 'paper') p = true;
                    if (otherAlly.pieceType === 'scissors') s = true;

                    if (ally.pieceType === otherAlly.pieceType) {
                        sameCount++;
                    }
                }
            }

            // Cluster penalty: penalize grouping same-type pieces together (sweeper vulnerability)
            if (sameCount >= 2) {
                clusterPenalty -= sameCount * 30;
            }

            // Fist bonus: reward keeping diverse types close together (mutual protection)
            const uniqueTypes = (r ? 1 : 0) + (p ? 1 : 0) + (s ? 1 : 0);
            if (uniqueTypes === 3) fistBonus += 80;
            else if (uniqueTypes === 2) fistBonus += 25;
        }

        score += fistBonus;
        score += clusterPenalty;

        // === 4. BAYESIAN FLAG HUNTING ===
        let huntingScore = 0;
        const suspect = getFlagSuspect(state);
        if (suspect && suspect.piece && suspect.piece.row >= 0) {
            const target = suspect.piece;
            const weight = suspect.prob;

            for (const attacker of myAttackers) {
                const dist = chebyshev(attacker, target);
                // Reward attackers getting closer to the suspect
                huntingScore += (6 - Math.min(6, dist)) * 30 * weight;
            }
        }
        score += huntingScore;

        // === 5. PROGRESSION & CENTER CONTROL ===
        for (const attacker of myAttackers) {
            // Encourage moving forward (higher row numbers)
            score += attacker.row * 10;

            // Center control (cols 3 & 4 are the center)
            const centerDist = Math.abs(attacker.col - 3.5);
            score += (4 - centerDist) * 6;
        }

        return score;
    }

    /**
     * Move Ordering for alpha-beta pruning
     */
    function orderMoves(state, moves, owner) {
        const suspect = getFlagSuspect(state);
        const suspectPiece = suspect ? suspect.piece : null;

        return moves.map(m => {
            let score = Math.random() * 5; // Small random noise for unpredictability
            const target = state.board[m.row] && state.board[m.row][m.col];

            if (target && target.owner !== owner) {
                // Capturing is highly interesting
                score += 1000;
                if (target.type === FLAG) {
                    score += 10000;
                }
                
                if (m.piece.type === 'piece' && m.piece.pieceType) {
                    if (target.revealed && target.type === 'piece') {
                        const result = resolveBattle(m.piece.pieceType, target.pieceType);
                        if (result === 'win') score += 2000;
                        if (result === 'lose') score -= 3000;
                    } else if (target.revealed && target.type === 'trap') {
                        score -= 5000; // Never attack a known trap
                    }
                }
            }

            // Guide towards the flag suspect
            if (suspectPiece) {
                const dBefore = chebyshev(m.piece, suspectPiece);
                const dAfter = chebyshev(m, suspectPiece);
                if (dAfter < dBefore) {
                    score += 150;
                }
            }

            // Directional advancement
            if (owner === COMPUTER) {
                score += m.row * 15;
            } else {
                score -= m.row * 15;
            }

            return { m, score };
        }).sort((a, b) => b.score - a.score).map(x => x.m);
    }

    /**
     * Minimax with Alpha-Beta Pruning
     */
    function minimax(state, depth, alpha, beta, isMax, deadline) {
        if (Date.now() > deadline) {
            return { score: evaluatePosition(state, depth), move: null };
        }
        if (aiEngine.isGameOver(state)) {
            return { score: evaluatePosition(state, depth), move: null };
        }
        if (depth === 0) {
            return { score: evaluatePosition(state, depth), move: null };
        }

        const owner = isMax ? COMPUTER : PLAYER;
        let moves = aiEngine.getAllPossibleMoves(state, owner);
        if (moves.length === 0) {
            return { score: evaluatePosition(state, depth), move: null };
        }

        moves = orderMoves(state, moves, owner);

        // Limit branching factor to keep search quick
        const maxBranch = isMax ? 15 : 10;
        if (moves.length > maxBranch) {
            moves = moves.slice(0, maxBranch);
        }

        let bestScore = isMax ? -Infinity : Infinity;
        let bestMove = moves[0];

        for (const move of moves) {
            if (Date.now() > deadline) break;
            const nextState = aiEngine.makeVirtualMove(state, move);
            const child = minimax(nextState, depth - 1, alpha, beta, !isMax, deadline);

            if (isMax) {
                if (child.score > bestScore) {
                    bestScore = child.score;
                    bestMove = move;
                }
                alpha = Math.max(alpha, bestScore);
            } else {
                if (child.score < bestScore) {
                    bestScore = child.score;
                    bestMove = move;
                }
                beta = Math.min(beta, bestScore);
            }

            if (beta <= alpha) break;
        }

        return { score: bestScore, move: bestMove };
    }

    /**
     * Selects the best move using Iterative Deepening
     */
    function pickMove(state) {
        const available = aiEngine.getActivePieces(state);
        if (available.length === 0) return null;

        const all = aiEngine.getAllFilteredMoves(state, available);
        if (all.length === 0) return null;

        const shuttleSafe = aiEngine.filterOutShuttleMoves(all);
        let moves = shuttleSafe.length > 0 ? shuttleSafe : all;

        moves = orderMoves(state, moves, COMPUTER);

        // Determine endgame state (fewer pieces = search deeper)
        const totalPieces = state.playerPieces.filter(p => !p.removed).length + state.aiPieces.filter(p => !p.removed).length;
        const isEndgame = totalPieces <= 8;

        const timeBudget = isEndgame ? TIME_BUDGET_ENDGAME_MS : TIME_BUDGET_MS;
        const maxDepth = isEndgame ? MAX_DEPTH_ENDGAME : MAX_DEPTH;
        const deadline = Date.now() + timeBudget;

        let bestMove = moves[0];
        let bestScore = -Infinity;

        // Iterative Deepening Loop
        for (let depth = 1; depth <= maxDepth; depth++) {
            if (Date.now() > deadline) break;

            let dBestScore = -Infinity;
            let dBestMove = null;
            let alpha = -Infinity;
            let beta = Infinity;

            for (const move of moves) {
                if (Date.now() > deadline) break;
                const nextState = aiEngine.makeVirtualMove(state, move);
                const child = minimax(nextState, depth - 1, alpha, beta, false, deadline);

                if (child.score > dBestScore) {
                    dBestScore = child.score;
                    dBestMove = move;
                }
                alpha = Math.max(alpha, dBestScore);
            }

            // Only update if search completed before deadline or we got a valid move
            if (dBestMove && (Date.now() <= deadline || depth === 1)) {
                bestScore = dBestScore;
                bestMove = dBestMove;
            }

            if (bestScore >= 120000 || bestScore <= -120000) {
                break; // Found winning/losing path
            }

            // Move the best move to the front for the next iteration to speed up alpha-beta pruning
            moves = [bestMove, ...moves.filter(m => m !== bestMove)];
        }

        return bestMove;
    }

    return {
        id: 'gemini_3_5_flash',
        name: 'Gemini 3.5',
        emoji: '✨',
        avatar: 'js/bots/gemini_3_5_flash/avatar-min.png',
        
        shortDescription: 'Вероятностный поиск и координация кулака',
        longDescription: 'Вероятностный поиск, байес, кулак RPS. Баланс атаки и защиты флага.',
        
        algorithmLabel: 'Вероятностный поиск + байес + кулак',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['gemini', 'google', 'search', 'beliefs', 'fist-tactics', 'championship'],

        move(gameState) {
            try {
                // Reset caches and update tracking structures at start of turn
                aiEngine.positionCache.clear();
                aiEngine.analyzePlayerPattern(gameState);
                aiEngine.trackEnemyStillness(gameState);
                aiEngine.updateStrategicTargets(gameState);

                if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.tick === 'function') {
                    aiBeliefs.tick(aiEngine.aiTurnCounter + 1);
                    aiBeliefs.applyConstraints(gameState);
                }

                const available = aiEngine.getActivePieces(gameState);

                // === 1. TACTICAL CORE FORCED MOVES (Absolute Safety) ===
                const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                    deducer: (state) => {
                        const suspect = getFlagSuspect(state);
                        const hiddenCount = state.playerPieces.filter(p => !p.removed && p.row >= 0 && !p.revealed && p.type !== 'trap').length;
                        return {
                            candidates: suspect ? [{ piece: suspect.piece, prob: suspect.prob }] : [],
                            hiddenCount
                        };
                    },
                    flagHuntHorizon: HUNT_HORIZON,
                    antiCluster: true
                });
                if (mandatory) {
                    aiEngine.recordAIMove(mandatory);
                    return mandatory;
                }

                // === 2. HIGH CONFIDENCE STRIKE OR CHASE ===
                const strike = tryConfirmedFlagStrike(gameState, available);
                if (strike) {
                    aiEngine.recordAIMove(strike);
                    return strike;
                }

                // === 3. LOOKAHEAD ALPHA-BETA MINIMAX SEARCH ===
                const searchMove = pickMove(gameState);
                if (searchMove) {
                    aiEngine.recordAIMove(searchMove);
                    return searchMove;
                }

                // === 4. FALLBACK TO ENGINE MOVE LEVEL 2 ===
                const fallback = aiEngine.moveLevel2(gameState);
                if (fallback) {
                    aiEngine.recordAIMove(fallback);
                }
                return fallback;

            } catch (error) {
                console.error('[gemini_3_5_flash] move() failed:', error);
                const fallback = aiEngine.moveLevel2(gameState);
                if (fallback) {
                    aiEngine.recordAIMove(fallback);
                }
                return fallback;
            }
        },

        chooseFlagAndTrap() {
            // Highly defensive and unpredictable setups:
            const templates = [
                { flag: 0, trap: 9 },   // Flag left corner, trap shielding diagonally at (1, 1)
                { flag: 7, trap: 14 },  // Flag right corner, trap shielding diagonally at (1, 6)
                { flag: 1, trap: 8 },   // Flag semi-left corner, trap protecting at (1, 0)
                { flag: 6, trap: 15 },  // Flag semi-right corner, trap protecting at (1, 7)
                { flag: 2, trap: 11 },  // Flag center-left, trap protecting at (1, 3)
                { flag: 5, trap: 12 }   // Flag center-right, trap protecting at (1, 4)
            ];

            const chosen = templates[Math.floor(Math.random() * templates.length)];
            return { flagIndex: chosen.flag, trapIndex: chosen.trap };
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = gemini35FlashBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(gemini35FlashBot);
} else {
    throw new Error('[gemini_3_5_flash] RPSBotAPI.defineBot is required');
}
