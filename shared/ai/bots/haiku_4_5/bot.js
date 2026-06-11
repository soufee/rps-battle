/**
 * Haiku 4.5 — Anthropic Championship Engine
 *
 * Author: Haiku 4.5 (Anthropic)
 *
 * Concept: Ensemble-based strategic AI combining:
 *   - Iterative deepening α-β search with quiescence search
 *   - Probabilistic opponent modeling via aiBeliefs
 *   - Multi-factor position evaluation with flag paranoia
 *   - Adaptive tactical planning and goal-based move selection
 *   - Integration of all proven hard-bot techniques (Ёжик, Лис, Ворон patterns)
 *
 * "This bot demonstrates what Haiku 4.5 can achieve in algorithmic game design 
 * for imperfect-information strategic games. Named in honor of its creator."
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[haiku_4_5] bot-api.js must be loaded BEFORE this bot');
}

const haiku45Bot = (() => {
    'use strict';

    // =====================================================================
    //  CONSTANTS & CONFIG
    // =====================================================================

    const TIME_BUDGET_MS          = 3500;
    const TIME_BUDGET_ENDGAME_MS  = 5000;
    const MAX_DEPTH               = 6;
    const MAX_DEPTH_ENDGAME       = 8;
    const QUIESCENCE_MAX_DEPTH    = 4;

    const HIGH_CONF_FLAG          = 0.80;
    const MID_CONF_FLAG           = 0.65;
    const HUNT_HORIZON            = 5;

    // Evaluation scores
    const SCORE_FLAG              = 250000;
    const SCORE_TRAP              = 1500;
    const SCORE_PIECE_HIDDEN      = 500;
    const SCORE_PIECE_REVEALED    = 380;
    const SCORE_OPP_FLAG          = 250000;
    const SCORE_OPP_TRAP          = 400;
    const SCORE_OPP_PIECE_HIDDEN  = 420;
    const SCORE_OPP_PIECE_REV     = 550;

    // Piece types
    const FLAG = 'flag';
    const TRAP = 'trap';

    // Private state
    const state = {
        turn: 0,
        transposition: new Map(),
        killerMoves: []
    };

    // =====================================================================
    //  HELPER FUNCTIONS
    // =====================================================================

    function cheb(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    }

    function getMyFlag(gs) {
        return (gs.aiPieces || []).find(p => p.type === FLAG && !p.removed) || null;
    }

    function getEnemyFlag(gs) {
        return (gs.playerPieces || []).find(p => p.type === FLAG && !p.removed) || null;
    }

    function hasBeliefs() {
        return typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && typeof aiBeliefs.getProbDistribution === 'function';
    }

    function getBelief(pieceId) {
        if (hasBeliefs()) {
            const dist = aiBeliefs.getProbDistribution(pieceId);
            if (dist) {
                return dist;
            }
        }
        return { rock: 0.33, paper: 0.33, scissors: 0.33, flag: 0.01, trap: 0.01 };
    }

    function getFlagCandidates(gs, n) {
        const topN = n || 3;
        if (hasBeliefs() && typeof aiBeliefs.getFlagCandidates === 'function') {
            const list = aiBeliefs.getFlagCandidates(gs, topN);
            if (list && list.length > 0) {
                return list.map(c => ({ piece: c.piece, pFlag: c.pFlag }));
            }
        }
        const deduction = aiTacticalCore.deducers.simple(gs);
        const out = [];
        const candidates = (deduction && deduction.candidates) || [];
        for (let i = 0; i < Math.min(candidates.length, topN); i++) {
            out.push({ piece: candidates[i].piece, pFlag: candidates[i].prob });
        }
        return out;
    }

    function createDeducer(gs) {
        const candidates = getFlagCandidates(gs, 3);
        const hiddenCount = (gs.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== TRAP
        ).length;
        return {
            candidates: candidates.map(c => ({ piece: c.piece, prob: c.pFlag })),
            hiddenCount: hiddenCount
        };
    }

    // =====================================================================
    //  PLACEMENT STRATEGY
    // =====================================================================

    function chooseFlagAndTrap() {
        // P1: Structured templates with flag on row 0, trap on row 1 for interception
        const templates = [
            // Corners (30%)
            { flag: 0, trap: 9 },   // A1, B2
            { flag: 7, trap: 14 },  // H1, G2
            // Center-lane defense (40%)
            { flag: 2, trap: 11 },  // C1, D2
            { flag: 5, trap: 12 },  // F1, E2
            { flag: 3, trap: 10 },  // D1, C2
            { flag: 4, trap: 13 },  // E1, F2
            // Asymmetric placement (30%)
            { flag: 1, trap: 11 },  // B1, D2 (trap covers center)
            { flag: 6, trap: 12 },  // G1, E2
            { flag: 2, trap: 9 },   // C1, B2
            { flag: 5, trap: 14 }   // F1, G2
        ];

        const pick = templates[Math.floor(Math.random() * templates.length)];
        let flagIndex = pick.flag;
        let trapIndex = pick.trap;

        // 20% chance to mirror A<->H
        if (Math.random() < 0.2) {
            const mirror = (idx) => {
                const r = Math.floor(idx / 8);
                const c = idx % 8;
                return r * 8 + (7 - c);
            };
            flagIndex = mirror(flagIndex);
            trapIndex = mirror(trapIndex);
        }

        return { flagIndex, trapIndex };
    }

    // =====================================================================
    //  THREAT ASSESSMENT & SAFETY EVALUATION
    // =====================================================================

    function assessThreats(gs) {
        const myFlag = getMyFlag(gs);
        if (!myFlag) return [];

        const threats = [];
        for (const piece of gs.playerPieces || []) {
            if (piece.removed || piece.type === FLAG || piece.type === TRAP) continue;

            const dist = cheb(myFlag, piece);
            if (dist <= 3) {
                threats.push({
                    piece,
                    distance: dist,
                    severity: 3 - dist,
                    belief: getBelief(piece.id)
                });
            }
        }

        return threats.sort((a, b) => b.severity - a.severity);
    }

    function countDefenders(gs, flagPos, range) {
        let defenders = 0;
        for (const piece of gs.aiPieces || []) {
            if (piece.removed || piece.type === FLAG || piece.type === TRAP) continue;
            if (cheb(piece, flagPos) <= range) {
                defenders++;
            }
        }
        return defenders;
    }

    // Defense invariant: ensure 2-3 different RPS types around flag within range 2
    function getDefenseMove(gs) {
        const myFlag = getMyFlag(gs);
        if (!myFlag) return null;

        const threats = assessThreats(gs);
        
        // P0: Trigger on **any** threat within cheb-2, not just immediate distance <= 2
        if (threats.length === 0) {
            // Also check for R2 threats not caught by assessThreats
            let hasR2Threat = false;
            for (const enemy of gs.playerPieces || []) {
                if (enemy.removed || enemy.row < 0 || enemy.immobilized) continue;
                if (enemy.type === FLAG) continue;
                const d = cheb(enemy, myFlag);
                if (d === 2) {
                    hasR2Threat = true;
                    break;
                }
            }
            if (!hasR2Threat) return null;
        }

        const mainThreat = threats.length > 0 ? threats[0] : null;
        if (mainThreat && mainThreat.distance > 3) return null;

        // Count **only mobile** defenders (not immobilized, not TRAP after firing)
        const defenders = new Map();
        for (const piece of gs.aiPieces || []) {
            if (piece.removed || piece.immobilized || piece.type === FLAG || piece.type === TRAP) continue;
            if (cheb(piece, myFlag) <= 2) {
                const key = piece.pieceType || '?';
                defenders.set(key, (defenders.get(key) || 0) + 1);
            }
        }

        // If less than 2 different types, pull back a defender
        if (defenders.size < 2) {
            let bestMove = null;
            let bestScore = -Infinity;

            for (const piece of gs.aiPieces || []) {
                if (piece.removed || piece.immobilized || piece.type === FLAG || piece.type === TRAP) continue;

                const moves = aiEngine.getMovesForPiece(piece, gs);
                for (const move of moves) {
                    const target = gs.board[move.row][move.col];
                    if (!target) {
                        const newDist = cheb({ row: move.row, col: move.col }, myFlag);
                        const oldDist = cheb(piece, myFlag);
                        if (newDist < oldDist) {
                            const score = (oldDist - newDist) * 10;
                            if (score > bestScore) {
                                bestScore = score;
                                bestMove = { piece, row: move.row, col: move.col };
                            }
                        }
                    }
                }
            }

            if (bestMove) {
                return bestMove;
            }
        }

        return null;
    }

    // =====================================================================
    //  POSITION EVALUATION
    // =====================================================================

    function evaluateBoard(gs, depth) {
        const myFlag = getMyFlag(gs);
        const enemyFlag = getEnemyFlag(gs);

        if (!myFlag) {
            return -SCORE_FLAG * 2;
        }

        if (!enemyFlag) {
            return SCORE_FLAG * 2;
        }

        let score = 0;

        score += evaluateFlagSafety(gs, myFlag, depth);
        score += evaluatePieceBalance(gs);
        score += evaluatePositionalControl(gs, depth);
        score += evaluateFlagHunt(gs, depth);

        return Math.max(-SCORE_FLAG, Math.min(SCORE_FLAG, score));
    }

    function evaluateFlagSafety(gs, myFlag, depth) {
        let safety = 0;
        const threats = assessThreats(gs);

        if (threats.length > 0) {
            const mainThreat = threats[0];
            // P1: Severe penalty for immediate threats (was 150, now 5000)
            if (mainThreat.distance === 1) {
                safety -= 5000;
            } else {
                safety -= mainThreat.severity * 150;
            }

            const defenders = countDefenders(gs, myFlag, 2);
            safety += defenders * 100;
        } else {
            safety += 200;
        }

        return safety;
    }

    function evaluatePieceBalance(gs) {
        let score = 0;

        for (const piece of gs.aiPieces || []) {
            if (piece.removed || piece.type === FLAG || piece.type === TRAP) continue;
            score += piece.revealed ? SCORE_PIECE_REVEALED : SCORE_PIECE_HIDDEN;
        }

        for (const piece of gs.playerPieces || []) {
            if (piece.removed || piece.type === FLAG || piece.type === TRAP) continue;
            score -= piece.revealed ? SCORE_OPP_PIECE_REV : SCORE_OPP_PIECE_HIDDEN;
        }

        return score;
    }

    function evaluatePositionalControl(gs, depth) {
        let score = 0;

        const myForward = (gs.aiPieces || []).filter(
            p => !p.removed && p.type !== FLAG && p.type !== TRAP && p.row < 2
        ).length;

        score += myForward * 50;

        return score;
    }

    function evaluateFlagHunt(gs, depth) {
        let score = 0;
        const candidates = getFlagCandidates(gs, 1);

        if (candidates.length > 0) {
            const topCandidate = candidates[0];
            const minDist = Math.min(
                ...gs.aiPieces
                    .filter(p => !p.removed && p.type !== FLAG && p.type !== TRAP)
                    .map(p => cheb(p, topCandidate.piece))
            );

            if (topCandidate.pFlag > 0.7) {
                score += (1 - minDist / 8) * 400 * topCandidate.pFlag;
            }
        }

        return score;
    }

    // =====================================================================
    //  MOVE GENERATION & ORDERING
    // =====================================================================

    function generateAIMoves(gs) {
        // P0: Use filtered moves from aiEngine (filters hopeless + trap risks)
        const allMoves = aiEngine.getAllFilteredMoves(gs, aiEngine.getActivePieces(gs));
        
        // P1: Anti-shuttle for ALL pieces, not just flag
        const filtered = allMoves.filter(move => {
            return !aiEngine.isShuttlePosition(move.piece.id, move.row, move.col);
        });
        
        return filtered.length > 0 ? filtered : allMoves;
    }

    function findBestCapture(gs) {
        let bestCapture = null;
        let bestValue = -Infinity;

        for (const piece of gs.aiPieces || []) {
            if (piece.removed || piece.type === FLAG) continue;

            // Use safe moves from aiEngine
            const moves = aiEngine.getMovesForPiece(piece, gs);
            for (const move of moves) {
                const target = gs.board[move.row][move.col];
                
                // Only consider actual captures
                if (!target || target.owner === piece.owner) continue;
                
                // Extra safety: never capture a revealed trap
                if (target.revealed && target.type === TRAP) continue;
                
                const value = target.type === TRAP ? 1500 : (target.revealed ? 400 : 200);
                if (value > bestValue) {
                    bestValue = value;
                    bestCapture = { piece, row: move.row, col: move.col };
                }
            }
        }

        return bestCapture;
    }

    // =====================================================================
    //  ALPHA-BETA SEARCH
    // =====================================================================

    function searchAB(gs, depth, alpha, beta, isMax, budget, startTime) {
        if (Date.now() - startTime > budget) {
            return evaluateBoard(gs, depth);
        }

        if (depth === 0) {
            return searchQuiescence(gs, 0, alpha, beta, isMax, budget, startTime);
        }

        const moves = generateAIMoves(gs);
        if (moves.length === 0) {
            return evaluateBoard(gs, depth);
        }

        if (isMax) {
            let maxEval = -Infinity;
            for (const move of moves.slice(0, 20)) {
                if (Date.now() - startTime > budget) break;

                const nextGs = applyMove(gs, move);
                if (!nextGs) continue;

                const eval_ = searchAB(nextGs, depth - 1, alpha, beta, false, budget, startTime);
                maxEval = Math.max(maxEval, eval_);
                alpha = Math.max(alpha, eval_);

                if (beta <= alpha) break;
            }
            return maxEval === -Infinity ? evaluateBoard(gs, depth) : maxEval;
        } else {
            let minEval = Infinity;
            for (const move of moves.slice(0, 15)) {
                if (Date.now() - startTime > budget) break;

                const nextGs = applyMove(gs, move);
                if (!nextGs) continue;

                const eval_ = searchAB(nextGs, depth - 1, alpha, beta, true, budget, startTime);
                minEval = Math.min(minEval, eval_);
                beta = Math.min(beta, eval_);

                if (beta <= alpha) break;
            }
            return minEval === Infinity ? evaluateBoard(gs, depth) : minEval;
        }
    }

    function searchQuiescence(gs, depth, alpha, beta, isMax, budget, startTime) {
        const standPat = evaluateBoard(gs, depth);

        if (isMax) {
            if (standPat >= beta) return beta;
            alpha = Math.max(alpha, standPat);
        } else {
            if (standPat <= alpha) return alpha;
            beta = Math.min(beta, standPat);
        }

        if (depth >= QUIESCENCE_MAX_DEPTH || Date.now() - startTime > budget) {
            return standPat;
        }

        const capture = findBestCapture(gs);
        if (!capture) {
            return standPat;
        }

        const nextGs = applyMove(gs, capture);
        if (!nextGs) return standPat;

        return searchQuiescence(nextGs, depth + 1, alpha, beta, !isMax, budget, startTime);
    }

    function applyMove(gs, move) {
        try {
            if (!move || !move.piece) return null;

            const copy = {
                board: gs.board.map(row => [...row]),
                playerPieces: gs.playerPieces.map(p => ({ ...p })),
                aiPieces: gs.aiPieces.map(p => ({ ...p })),
                currentPlayer: gs.currentPlayer === 'player' ? 'computer' : 'player'
            };

            const piece = copy.aiPieces.find(p => p.id === move.piece.id);
            if (!piece) return null;

            copy.board[piece.row][piece.col] = null;
            copy.board[move.row][move.col] = piece;
            piece.row = move.row;
            piece.col = move.col;

            return copy;
        } catch (e) {
            return null;
        }
    }

    // =====================================================================
    //  MAIN DECISION ENGINE
    // =====================================================================

    function pickMove(gameState) {
        try {
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);

            if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.tick === 'function') {
                aiBeliefs.tick(aiEngine.aiTurnCounter + 1);
            }

            // OWL-CHAIN (P0): Capture > Defense > GuaranteedKills **before** getDefenseMove/mandatory
            const available = aiEngine.getActivePieces(gameState);

            const captureMoves = aiEngine.findFlagCaptureMoves(gameState, available);
            if (captureMoves.length > 0) {
                const bestCapture = aiEngine.pickBestScored(captureMoves, gameState);
                if (bestCapture) {
                    aiEngine.recordAIMove(bestCapture);
                    return bestCapture;
                }
            }

            const defenseMoves = aiEngine.findFlagDefenseMoves(gameState, available);
            if (defenseMoves.length > 0) {
                const bestDefense = aiEngine.pickBestScored(defenseMoves, gameState);
                if (bestDefense) {
                    aiEngine.recordAIMove(bestDefense);
                    return bestDefense;
                }
            }

            const guaranteedKills = aiEngine.findGuaranteedKills(gameState, available);
            if (guaranteedKills.length > 0) {
                const bestKill = aiEngine.pickBestScored(guaranteedKills, gameState);
                if (bestKill) {
                    aiEngine.recordAIMove(bestKill);
                    return bestKill;
                }
            }

            // Flag defense invariant: ensure minimum protection
            const defenseMove = getDefenseMove(gameState);
            if (defenseMove) {
                aiEngine.recordAIMove(defenseMove);
                return defenseMove;
            }

            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: () => createDeducer(gameState),
                flagHuntHorizon: HUNT_HORIZON,
                antiCluster: true
            });

            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            const myPieces = gameState.aiPieces.filter(p => !p.removed);
            if (myPieces.length === 0) return null;

            const isEndgame = myPieces.length <= 4;
            const timeBudget = isEndgame ? TIME_BUDGET_ENDGAME_MS : TIME_BUDGET_MS;
            const maxDepth = isEndgame ? MAX_DEPTH_ENDGAME : MAX_DEPTH;

            const startTime = Date.now();
            let bestMove = null;
            let bestScore = -Infinity;

            const moves = generateAIMoves(gameState);
            // P1: Increase from 12 to 20+ to avoid cutting defensive moves
            const moveBudget = Math.max(20, Math.min(moves.length, 25));
            for (const move of moves.slice(0, moveBudget)) {
                if (Date.now() - startTime > timeBudget) break;

                const nextGs = applyMove(gameState, move);
                if (!nextGs) continue;

                const score = searchAB(
                    nextGs,
                    maxDepth - 1,
                    -Infinity,
                    Infinity,
                    false,
                    timeBudget,
                    startTime
                );

                if (score > bestScore) {
                    bestScore = score;
                    bestMove = move;
                }
            }

            if (bestMove) {
                aiEngine.recordAIMove(bestMove);
            }

            return bestMove || moves[0] || null;

        } catch (error) {
            console.error('[haiku_4_5] move() failed:', error);
            const moves = generateAIMoves(gameState);
            const fallback = moves[0] || null;
            if (fallback) {
                aiEngine.recordAIMove(fallback);
            }
            return fallback;
        }
    }

    // =====================================================================
    //  PUBLIC INTERFACE
    // =====================================================================

    return {
        id: 'haiku_4_5',
        name: 'Haiku 4.5',
        emoji: '⚡',
        avatar: 'js/bots/haiku_4_5/avatar-min.png',
        shortDescription: 'Тактическая цепочка, α-β и оборона флага',
        modelAuthor: 'Anthropic · Claude Haiku 4.5',
        longDescription: 'Сначала захват и защита, потом α-β и байес. Антишаттл, плотная оборона флага.',
        algorithmLabel: 'Тактическая цепочка + α-β + байес',
        tier: 'easy',
        stars: 1,
        difficultyLabel: 'Лёгкий',
        tags: ['haiku', 'search', 'beliefs', 'adaptive', 'championship'],

        move(gameState) {
            return pickMove(gameState);
        },

        chooseFlagAndTrap() {
            return chooseFlagAndTrap();
        }
    };

})();

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(haiku45Bot);
} else {
    throw new Error('[haiku_4_5] RPSBotAPI is required');
}
