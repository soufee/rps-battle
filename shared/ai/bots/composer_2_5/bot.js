/**
 * Composer 2.5 — Cursor Championship Engine
 *
 * Author: Composer 2.5 (Cursor)
 *
 * Concept: Ensemble of belief-aware expected-value combat, iterative alpha-beta
 * with quiescence, mandatory tactical obligations, and adaptive flag paranoia.
 * Tuned for long matches against Hedgehog, Raven, Fox, and other hard bots.
 *
 * "This bot demonstrates what Composer 2.5 can build for imperfect-information
 * tactical games. Named in honor of its creator."
 *
 * Architecture:
 *   1. Tactical core — captures, flag defence, guaranteed kills.
 *   2. Urgent flag save + high/mid-confidence flag hunts.
 *   3. Deepening alpha-beta + transposition + quiescence (PV-ordered).
 *   4. Adaptive safety overlay — prefer safer near-equal alternatives.
 *   5. Expert-move sanity check when search disagrees under flag pressure.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[composer_2_5] bot-api.js must be loaded BEFORE this bot');
}

const composer25Bot = (() => {
    'use strict';

    // =====================================================================
    //  TUNING CONSTANTS
    // =====================================================================

    const TIME_BUDGET_MS          = 3000;
    const TIME_BUDGET_ENDGAME_MS  = 4200;
    const MAX_DEPTH               = 5;
    const MAX_DEPTH_ENDGAME       = 7;
    const QUIESCENCE_MAX_DEPTH    = 3;
    const BRANCH_LIMIT_MAX        = 16;
    const BRANCH_LIMIT_MIN        = 8;
    const BRANCH_LIMIT_OPP        = 10;

    const HIGH_CONF_FLAG          = 0.84;
    const MID_CONF_FLAG           = 0.68;
    const HUNT_HORIZON            = 4;

    const SCORE_FLAG              = 200000;
    const SCORE_TRAP              = 1200;
    const SCORE_PIECE_HIDDEN      = 420;
    const SCORE_PIECE_REVEALED    = 320;
    const SCORE_OPP_FLAG          = 200000;
    const SCORE_OPP_TRAP          = 350;
    const SCORE_OPP_PIECE_HIDDEN  = 360;
    const SCORE_OPP_PIECE_REV     = 480;

    // =====================================================================
    //  PRIVATE STATE (per-instance, reset implicitly between games via
    //  aiEngine.resetMemory + aiBeliefs.reset)
    // =====================================================================

    const state = {
        turn: 0,
        lastGameSignature: null,
        killerMoves: [],
        transposition: new Map()
    };

    // =====================================================================
    //  SMALL HELPERS
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

    /**
     * Return the belief distribution for an enemy piece, falling back to a
     * uniform RPS prior when no belief exists (e.g. piece appeared after a
     * memory reset). The returned object always has rock/paper/scissors/flag/
     * trap keys summing to ~1.
     */
    function getBelief(pieceId) {
        if (hasBeliefs()) {
            const dist = aiBeliefs.getProbDistribution(pieceId);
            if (dist) {
                return dist;
            }
        }
        return { rock: 0.30, paper: 0.30, scissors: 0.30, flag: 0.05, trap: 0.05 };
    }

    /**
     * Top-N enemy pieces by P(flag). Routed through aiBeliefs when present,
     * otherwise falls back to the tactical-core stillness deducer so the bot
     * still has a sensible suspect list at the very start of a game.
     */
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

    /**
     * Deducer adapter for aiTacticalCore. Always returns at least an empty
     * deduction object so the tactical core never NPEs.
     */
    function deducerForCore(gs) {
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
    //  PLACEMENT — diversified strong templates
    //  A flag in or near a corner with a trap shielding the most-threatened
    //  diagonal cell. Six templates so opponents cannot memorize a single
    //  setup. Slight randomization keeps us unpredictable.
    // =====================================================================

    function chooseFlagAndTrap() {
        const templates = [
            { flag: 0,  trap: 9 },
            { flag: 7,  trap: 14 },
            { flag: 1,  trap: 8 },
            { flag: 6,  trap: 15 },
            { flag: 0,  trap: 1 },
            { flag: 7,  trap: 6 },
            { flag: 2,  trap: 9 },
            { flag: 5,  trap: 14 }
        ];
        const pick = templates[Math.floor(Math.random() * templates.length)];
        return { flagIndex: pick.flag, trapIndex: pick.trap };
    }

    // =====================================================================
    //  THREAT ANALYSIS
    // =====================================================================

    /**
     * Enemy pieces that sit within `radius` of our flag (Chebyshev distance).
     * Excludes their flag (cannot attack) and immobilized pieces (sprung
     * trap or stuck flag).
     */
    function threatsToFlag(gs, myFlag, radius) {
        const out = [];
        if (!myFlag) {
            return out;
        }
        const enemies = gs.playerPieces || [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (e.removed || e.row < 0 || e.immobilized) {
                continue;
            }
            if (e.type === FLAG) {
                continue;
            }
            const d = cheb(e, myFlag);
            if (d <= radius) {
                out.push(e);
            }
        }
        return out;
    }

    /**
     * True if leaving `piece` from its current square exposes our flag to
     * a one-ply enemy approach. Delegates to aiTacticalCore which already
     * implements the precise board simulation.
     */
    function safeToLeave(gs, piece) {
        return aiTacticalCore.safeToLeave(gs, piece);
    }

    // =====================================================================
    //  EXPECTED-VALUE ARITHMETIC FOR ATTACKS
    //  When an attacker considers attacking a hidden enemy, we use the
    //  belief distribution over its possible types to compute the expected
    //  outcome value. Pieces are valued asymmetrically: losing a piece
    //  hurts us more than killing an unknown enemy gains us (information
    //  asymmetry — they still don't know our piece type either after).
    // =====================================================================

    function expectedAttackValue(attacker, target) {
        if (!attacker || !target) {
            return 0;
        }
        if (target.revealed) {
            return revealedAttackValue(attacker, target);
        }
        return unrevealedAttackValue(attacker, target);
    }

    function revealedAttackValue(attacker, target) {
        if (target.type === FLAG) {
            return SCORE_OPP_FLAG;
        }
        if (target.type === TRAP) {
            if (attacker.type === TRAP) {
                return -SCORE_TRAP;
            }
            return -SCORE_PIECE_REVEALED * 1.4;
        }
        if (attacker.type === TRAP) {
            return SCORE_OPP_PIECE_REV;
        }
        if (attacker.type !== 'piece' || !attacker.pieceType
                || target.type !== 'piece' || !target.pieceType) {
            return 0;
        }
        const verdict = RPSBotAPI.resolveBattle(attacker.pieceType, target.pieceType);
        if (verdict === 'win') {
            return SCORE_OPP_PIECE_REV * 1.2;
        }
        if (verdict === 'lose') {
            return -SCORE_PIECE_REVEALED * 1.4;
        }
        return -40;
    }

    function unrevealedAttackValue(attacker, target) {
        const belief = getBelief(target.id);
        let ev = 0;

        const pFlag = belief.flag || 0;
        const pTrap = belief.trap || 0;
        if (pFlag > 0) {
            ev += pFlag * SCORE_OPP_FLAG;
        }
        if (pTrap > 0) {
            ev += pTrap * (-SCORE_PIECE_HIDDEN * 1.3);
        }

        if (attacker.type === 'piece' && attacker.pieceType) {
            const myType = attacker.pieceType;
            const beats = (myType === 'rock') ? 'scissors'
                        : (myType === 'paper') ? 'rock' : 'paper';
            const beatenBy = (myType === 'rock') ? 'paper'
                           : (myType === 'paper') ? 'scissors' : 'rock';
            const pWin  = belief[beats] || 0;
            const pLose = belief[beatenBy] || 0;
            const pDraw = belief[myType] || 0;
            ev += pWin  *   SCORE_OPP_PIECE_HIDDEN;
            ev += pLose * (-SCORE_PIECE_HIDDEN * 1.25);
            ev += pDraw * (-20);
        } else if (attacker.type === TRAP) {
            const totalRPS = (belief.rock || 0) + (belief.paper || 0) + (belief.scissors || 0);
            ev += totalRPS * SCORE_OPP_PIECE_HIDDEN * 0.7;
        }

        return ev;
    }

    // =====================================================================
    //  TACTICAL PROBES
    // =====================================================================

    /**
     * If an enemy adjacent to our flag is revealed and we hold a winning
     * counter (or a trap) within striking distance, take the immediate
     * defensive kill. This is the "save the flag right now" routine that
     * supplements aiTacticalCore for cases the core doesn't quite reach.
     */
    function tryUrgentFlagSave(gs, available) {
        const myFlag = getMyFlag(gs);
        if (!myFlag) {
            return null;
        }
        const adjEnemies = threatsToFlag(gs, myFlag, 1);
        if (adjEnemies.length === 0) {
            return null;
        }
        let best = null;
        let bestScore = -Infinity;
        for (let i = 0; i < adjEnemies.length; i++) {
            const enemy = adjEnemies[i];
            for (let j = 0; j < available.length; j++) {
                const p = available[j];
                if (p.type === FLAG) {
                    continue;
                }
                const moves = aiEngine.getMovesForPiece(p, gs);
                for (let k = 0; k < moves.length; k++) {
                    const m = moves[k];
                    if (m.row !== enemy.row || m.col !== enemy.col) {
                        continue;
                    }
                    const v = expectedAttackValue(p, enemy);
                    if (v <= 0) {
                        continue;
                    }
                    if (v > bestScore) {
                        bestScore = v;
                        best = { piece: p, row: m.row, col: m.col };
                    }
                }
            }
        }
        return best;
    }

    /**
     * High-confidence hunt. When the suspected enemy flag's posterior crosses
     * HIGH_CONF_FLAG we either land the killing blow if a piece is adjacent
     * or steer the closest viable hunter toward the suspect (without entering
     * shuttle states or known-losing battles).
     */
    function tryConfirmedFlagHunt(gs, available) {
        const candidates = getFlagCandidates(gs, 1);
        if (candidates.length === 0) {
            return null;
        }
        const top = candidates[0];
        if (top.pFlag < HIGH_CONF_FLAG) {
            return null;
        }

        const target = top.piece;
        if (!target || target.row < 0) {
            return null;
        }

        let attackMove = null;
        let attackScore = -Infinity;
        for (let i = 0; i < available.length; i++) {
            const p = available[i];
            if (p.type === FLAG) {
                continue;
            }
            if (cheb(p, target) !== 1) {
                continue;
            }
            if (!safeToLeave(gs, p)) {
                continue;
            }
            const scr = 1000 + p.row;
            if (scr > attackScore) {
                attackScore = scr;
                attackMove = { piece: p, row: target.row, col: target.col };
            }
        }
        if (attackMove) {
            return attackMove;
        }

        const chasers = available.filter(p =>
            p.type === 'piece' && !p.immobilized && p.row >= 0
        );
        if (chasers.length === 0) {
            return null;
        }
        chasers.sort((a, b) => cheb(target, a) - cheb(target, b));
        const pool = chasers.slice(0, Math.min(4, chasers.length));

        let chaseMove = null;
        let chaseScore = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const chaser = pool[i];
            if (!safeToLeave(gs, chaser)) {
                continue;
            }
            const curDist = cheb(target, chaser);
            if (curDist <= 0) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(chaser, gs);
            for (let j = 0; j < moves.length; j++) {
                const m = moves[j];
                const occ = gs.board[m.row] && gs.board[m.row][m.col];
                if (occ && occ.owner === PLAYER && occ.revealed) {
                    if (occ.type === TRAP) {
                        continue;
                    }
                    if (occ.type === 'piece' && chaser.pieceType
                            && RPSBotAPI.resolveBattle(chaser.pieceType, occ.pieceType) !== 'win') {
                        continue;
                    }
                }
                const newDist = cheb(target, m);
                if (newDist >= curDist) {
                    continue;
                }
                if (aiEngine.isShuttlePosition(chaser.id, m.row, m.col)) {
                    continue;
                }
                const recent = aiEngine.countRecentMovesOfPiece(chaser.id, 4);
                const scr = (curDist - newDist) * 1000 - recent * 35 + chaser.row;
                if (scr > chaseScore) {
                    chaseScore = scr;
                    chaseMove = { piece: chaser, row: m.row, col: m.col };
                }
            }
        }
        return chaseMove;
    }

    /**
     * Mid-confidence pressure: when P(flag) is solid but not yet decisive,
     * steer the best hunter one step closer without suicidal trades.
     */
    function tryMidConfidenceFlagPressure(gs, available) {
        const candidates = getFlagCandidates(gs, 1);
        if (candidates.length === 0) {
            return null;
        }
        const top = candidates[0];
        if (top.pFlag < MID_CONF_FLAG || top.pFlag >= HIGH_CONF_FLAG) {
            return null;
        }

        const target = top.piece;
        if (!target || target.row < 0) {
            return null;
        }

        const chasers = available.filter(p =>
            p.type === 'piece' && !p.immobilized && p.row >= 0
        );
        if (chasers.length === 0) {
            return null;
        }

        chasers.sort((a, b) => cheb(target, a) - cheb(target, b));
        let best = null;
        let bestScore = -Infinity;

        for (let i = 0; i < Math.min(3, chasers.length); i++) {
            const chaser = chasers[i];
            if (!safeToLeave(gs, chaser)) {
                continue;
            }
            const curDist = cheb(target, chaser);
            if (curDist <= 1) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(chaser, gs);
            for (let j = 0; j < moves.length; j++) {
                const m = moves[j];
                const occ = gs.board[m.row] && gs.board[m.row][m.col];
                if (occ && occ.owner === PLAYER) {
                    if (occ.revealed && occ.type === TRAP) {
                        continue;
                    }
                    if (occ.revealed && occ.type === 'piece' && chaser.pieceType
                            && RPSBotAPI.resolveBattle(chaser.pieceType, occ.pieceType) !== 'win') {
                        continue;
                    }
                }
                const newDist = cheb(target, m);
                if (newDist >= curDist) {
                    continue;
                }
                if (aiEngine.isShuttlePosition(chaser.id, m.row, m.col)) {
                    continue;
                }
                const scr = (curDist - newDist) * 600 * top.pFlag
                    - aiEngine.countRecentMovesOfPiece(chaser.id, 4) * 25;
                if (scr > bestScore) {
                    bestScore = scr;
                    best = { piece: chaser, row: m.row, col: m.col };
                }
            }
        }
        return best;
    }

    // =====================================================================
    //  STATIC POSITION EVALUATION
    //  A rich multi-factor function. Higher == better for us (COMPUTER).
    // =====================================================================

    function evaluatePosition(gs) {
        const myFlag = getMyFlag(gs);
        const enemyFlag = getEnemyFlag(gs);
        if (!myFlag) {
            return -SCORE_FLAG;
        }
        if (!enemyFlag) {
            return SCORE_FLAG;
        }

        let score = 0;

        const myPieces = (gs.aiPieces || []).filter(p => !p.removed && p.row >= 0);
        const enemyPieces = (gs.playerPieces || []).filter(p => !p.removed && p.row >= 0);

        score += scoreMaterial(myPieces, enemyPieces);
        score += scoreFlagSafety(gs, myFlag, myPieces);
        score += scoreEnemyFlagPressure(gs, enemyFlag);
        score += scoreCoordination(myPieces);
        score += scoreProgression(myPieces);
        score += scoreBeliefAwareThreats(gs, myPieces, enemyPieces);
        return score;
    }

    function scoreMaterial(myPieces, enemyPieces) {
        let s = 0;
        for (let i = 0; i < myPieces.length; i++) {
            const p = myPieces[i];
            if (p.type === FLAG) {
                s += SCORE_FLAG;
            } else if (p.type === TRAP) {
                s += p.immobilized ? SCORE_TRAP * 0.4 : SCORE_TRAP;
            } else {
                s += p.revealed ? SCORE_PIECE_REVEALED : SCORE_PIECE_HIDDEN;
            }
        }
        for (let i = 0; i < enemyPieces.length; i++) {
            const p = enemyPieces[i];
            if (p.type === FLAG) {
                s -= SCORE_OPP_FLAG;
            } else if (p.type === TRAP) {
                s -= p.immobilized ? SCORE_OPP_TRAP * 0.4 : SCORE_OPP_TRAP;
            } else {
                s -= p.revealed ? SCORE_OPP_PIECE_REV : SCORE_OPP_PIECE_HIDDEN;
            }
        }
        return s;
    }

    function scoreFlagSafety(gs, myFlag, myPieces) {
        let s = 0;

        let escapes = 0;
        for (let i = 0; i < GAME_CONFIG.DIRECTIONS.length; i++) {
            const [dr, dc] = GAME_CONFIG.DIRECTIONS[i];
            const r = myFlag.row + dr;
            const c = myFlag.col + dc;
            if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                continue;
            }
            const cell = gs.board[r][c];
            if (!cell) {
                escapes++;
            }
        }
        s += escapes * 18;

        let nearestEnemyDist = Infinity;
        let nearbyThreats = 0;
        const enemies = gs.playerPieces || [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
                continue;
            }
            const d = cheb(e, myFlag);
            if (d < nearestEnemyDist) {
                nearestEnemyDist = d;
            }
            if (d <= 3) {
                nearbyThreats++;
                const revealedMult = e.revealed ? 1.6 : 1.0;
                s -= (4 - d) * 320 * revealedMult;
                if (d === 1 && e.revealed) {
                    s -= 6000;
                }
            }
        }

        const coverage = aiEngine.computeRPSCoverage(myFlag.row, myFlag.col, gs);
        s += coverage.typeCount * 90;
        if (coverage.hasTrap) {
            s += 240;
        }

        let defenders = 0;
        const typesPresent = new Set();
        for (let i = 0; i < myPieces.length; i++) {
            const ally = myPieces[i];
            if (ally.type === FLAG || ally.immobilized) {
                continue;
            }
            const d = cheb(ally, myFlag);
            if (d <= 2) {
                defenders++;
                if (ally.type === 'piece' && ally.pieceType) {
                    typesPresent.add(ally.pieceType);
                }
            }
        }
        if (nearestEnemyDist <= 3) {
            if (defenders === 0) {
                s -= 1400;
            } else {
                s += typesPresent.size * 150;
                if (nearbyThreats >= 2 && defenders < 2) {
                    s -= 350;
                }
            }
        }
        return s;
    }

    function scoreEnemyFlagPressure(gs, enemyFlag) {
        let s = 0;
        const candidates = getFlagCandidates(gs, 2);

        if (enemyFlag.revealed) {
            const myAttackers = (gs.aiPieces || []).filter(p =>
                !p.removed && p.row >= 0 && !p.immobilized && p.type === 'piece'
            );
            for (let i = 0; i < myAttackers.length; i++) {
                const d = cheb(myAttackers[i], enemyFlag);
                s += (6 - Math.min(6, d)) * 55;
            }
            return s;
        }

        if (candidates.length === 0) {
            return 0;
        }
        const top = candidates[0];
        const weight = top.pFlag;
        if (weight < 0.25) {
            return 0;
        }
        const myAttackers = (gs.aiPieces || []).filter(p =>
            !p.removed && p.row >= 0 && !p.immobilized && p.type === 'piece'
        );
        for (let i = 0; i < myAttackers.length; i++) {
            const d = cheb(myAttackers[i], top.piece);
            s += (6 - Math.min(6, d)) * 38 * weight;
        }
        if (candidates.length > 1 && candidates[1].pFlag >= 0.20) {
            const second = candidates[1];
            for (let i = 0; i < myAttackers.length; i++) {
                const d = cheb(myAttackers[i], second.piece);
                s += (6 - Math.min(6, d)) * 14 * second.pFlag;
            }
        }
        return s;
    }

    function scoreCoordination(myPieces) {
        let s = 0;
        let fistBonus = 0;
        let clusterPenalty = 0;

        const attackers = [];
        for (let i = 0; i < myPieces.length; i++) {
            if (myPieces[i].type === 'piece') {
                attackers.push(myPieces[i]);
            }
        }

        for (let i = 0; i < attackers.length; i++) {
            const ally = attackers[i];
            let hasRock = ally.pieceType === 'rock';
            let hasPaper = ally.pieceType === 'paper';
            let hasScissors = ally.pieceType === 'scissors';
            let sameNearby = 0;

            for (let j = 0; j < attackers.length; j++) {
                if (i === j) {
                    continue;
                }
                const other = attackers[j];
                const d = cheb(ally, other);
                if (d > 2) {
                    continue;
                }
                if (other.pieceType === 'rock') {
                    hasRock = true;
                }
                if (other.pieceType === 'paper') {
                    hasPaper = true;
                }
                if (other.pieceType === 'scissors') {
                    hasScissors = true;
                }
                if (other.pieceType === ally.pieceType) {
                    sameNearby++;
                }
            }
            if (sameNearby >= 2) {
                clusterPenalty -= sameNearby * 32;
            }
            const uniq = (hasRock ? 1 : 0) + (hasPaper ? 1 : 0) + (hasScissors ? 1 : 0);
            if (uniq === 3) {
                fistBonus += 90;
            } else if (uniq === 2) {
                fistBonus += 30;
            }
        }
        s += fistBonus + clusterPenalty;
        return s;
    }

    function scoreProgression(myPieces) {
        let s = 0;
        for (let i = 0; i < myPieces.length; i++) {
            const p = myPieces[i];
            if (p.type !== 'piece') {
                continue;
            }
            s += p.row * 11;
            const centerDist = Math.abs(p.col - 3.5);
            s += (4 - centerDist) * 5;
        }
        return s;
    }

    /**
     * Reward standing next to hidden enemies that we likely beat (in EV),
     * penalize standing next to hidden enemies that likely beat us. This
     * encodes the "have a counter in range" intuition at the eval level.
     */
    function scoreBeliefAwareThreats(gs, myPieces, enemyPieces) {
        if (!hasBeliefs()) {
            return 0;
        }
        let s = 0;
        for (let i = 0; i < myPieces.length; i++) {
            const ally = myPieces[i];
            if (ally.type !== 'piece' || !ally.pieceType) {
                continue;
            }
            const myType = ally.pieceType;
            const beats = (myType === 'rock') ? 'scissors'
                        : (myType === 'paper') ? 'rock' : 'paper';
            const beatenBy = (myType === 'rock') ? 'paper'
                           : (myType === 'paper') ? 'scissors' : 'rock';

            for (let j = 0; j < enemyPieces.length; j++) {
                const e = enemyPieces[j];
                if (e.removed || e.immobilized) {
                    continue;
                }
                const d = cheb(ally, e);
                if (d > 2) {
                    continue;
                }
                const belief = getBelief(e.id);
                const winP  = belief[beats] || 0;
                const loseP = belief[beatenBy] || 0;
                const fact = (d === 1) ? 28 : 12;
                s += (winP - loseP * 1.2) * fact;
                if (belief.trap && d === 1) {
                    s -= belief.trap * 40;
                }
            }
        }
        return s;
    }

    // =====================================================================
    //  MOVE GENERATION + ORDERING
    //  We use the engine's safe filter (no flag attacks, no hopeless moves)
    //  then layer in PV / killer / capture heuristics for alpha-beta speed.
    // =====================================================================

    function generateMoves(gs, owner) {
        if (owner === COMPUTER) {
            const pieces = aiEngine.getActivePieces(gs);
            return aiEngine.getAllFilteredMoves(gs, pieces);
        }
        return aiEngine.getAllPossibleMoves(gs, PLAYER);
    }

    function orderMoves(gs, moves, owner, pvMove) {
        const candidates = getFlagCandidates(gs, 1);
        const suspect = candidates.length > 0 ? candidates[0] : null;
        const myFlag = getMyFlag(gs);
        const enemyFlag = getEnemyFlag(gs);

        const scored = moves.map(m => {
            let priority = Math.random() * 3;
            const target = gs.board[m.row] && gs.board[m.row][m.col];

            if (pvMove
                    && pvMove.piece && m.piece
                    && pvMove.piece.id === m.piece.id
                    && pvMove.row === m.row
                    && pvMove.col === m.col) {
                priority += 10000;
            }
            for (let k = 0; k < state.killerMoves.length; k++) {
                const km = state.killerMoves[k];
                if (km
                        && m.piece && km.pieceId === m.piece.id
                        && km.row === m.row && km.col === m.col) {
                    priority += 600;
                    break;
                }
            }

            if (target && target.owner !== m.piece.owner) {
                priority += 700;
                if (target.type === FLAG) {
                    priority += 9000;
                }
                if (m.piece.type === 'piece' && m.piece.pieceType
                        && target.revealed && target.type === 'piece') {
                    const r = RPSBotAPI.resolveBattle(m.piece.pieceType, target.pieceType);
                    if (r === 'win') {
                        priority += 1800;
                    } else if (r === 'lose') {
                        priority -= 4000;
                    }
                } else if (target.revealed && target.type === TRAP) {
                    priority -= 6000;
                } else if (!target.revealed) {
                    const ev = unrevealedAttackValue(m.piece, target);
                    priority += ev * 0.05;
                }
            }

            if (owner === COMPUTER && suspect) {
                const dBefore = cheb(m.piece, suspect.piece);
                const dAfter  = cheb(m, suspect.piece);
                if (dAfter < dBefore) {
                    priority += 130 * suspect.pFlag;
                }
            }
            if (owner === COMPUTER && enemyFlag && enemyFlag.revealed) {
                const dBefore = cheb(m.piece, enemyFlag);
                const dAfter  = cheb(m, enemyFlag);
                if (dAfter < dBefore) {
                    priority += 250;
                }
            }

            if (owner === COMPUTER && myFlag) {
                const threats = threatsToFlag(gs, myFlag, 2);
                if (threats.length > 0) {
                    const distAfter = cheb(m, myFlag);
                    const distBefore = cheb(m.piece, myFlag);
                    if (distAfter < distBefore && distBefore >= 2) {
                        priority += 180;
                    } else if (distAfter > distBefore && distBefore <= 1
                            && m.piece.type !== FLAG) {
                        priority -= 240;
                    }
                }
            }

            if (owner === COMPUTER) {
                priority += m.row * 6;
            } else {
                priority -= m.row * 6;
            }
            return { m, priority };
        });

        scored.sort((a, b) => b.priority - a.priority);
        return scored.map(s => s.m);
    }

    function recordKiller(move) {
        if (!move || !move.piece) {
            return;
        }
        const entry = { pieceId: move.piece.id, row: move.row, col: move.col };
        const existing = state.killerMoves.findIndex(k =>
            k && k.pieceId === entry.pieceId && k.row === entry.row && k.col === entry.col
        );
        if (existing >= 0) {
            state.killerMoves.splice(existing, 1);
        }
        state.killerMoves.unshift(entry);
        if (state.killerMoves.length > 4) {
            state.killerMoves.length = 4;
        }
    }

    // =====================================================================
    //  ALPHA-BETA + QUIESCENCE
    //  - Transposition table cached per move() invocation.
    //  - Quiescence search expands only capture-like moves to dampen the
    //    horizon effect of mid-combat positions.
    //  - Iterative deepening from depth 1 with time control.
    // =====================================================================

    function isCaptureMove(gs, move) {
        if (!move) {
            return false;
        }
        const t = gs.board[move.row] && gs.board[move.row][move.col];
        return !!(t && t.owner !== move.piece.owner);
    }

    function hashState(gs) {
        let h = '';
        for (let r = 0; r < BOARD_HEIGHT; r++) {
            for (let c = 0; c < BOARD_WIDTH; c++) {
                const p = gs.board[r][c];
                if (p) {
                    const code = (p.owner === COMPUTER ? 'C' : 'P')
                               + (p.type === 'piece'
                                  ? (p.revealed ? p.pieceType[0] : 'h')
                                  : p.type[0]);
                    h += code;
                } else {
                    h += '.';
                }
            }
            h += '|';
        }
        return h;
    }

    function quiescence(gs, alpha, beta, isMax, depth, deadline) {
        if (Date.now() > deadline || depth <= 0) {
            return evaluatePosition(gs);
        }
        if (aiEngine.isGameOver(gs)) {
            return evaluatePosition(gs);
        }

        const standPat = evaluatePosition(gs);

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
        const moves = generateMoves(gs, owner);
        const captures = [];
        for (let i = 0; i < moves.length; i++) {
            if (isCaptureMove(gs, moves[i])) {
                captures.push(moves[i]);
            }
        }
        if (captures.length === 0) {
            return standPat;
        }
        const ordered = orderMoves(gs, captures, owner, null);
        const limit = Math.min(ordered.length, 8);

        for (let i = 0; i < limit; i++) {
            if (Date.now() > deadline) {
                break;
            }
            const next = aiEngine.makeVirtualMove(gs, ordered[i]);
            const v = quiescence(next, alpha, beta, !isMax, depth - 1, deadline);
            if (isMax) {
                if (v >= beta) {
                    return beta;
                }
                if (v > alpha) {
                    alpha = v;
                }
            } else {
                if (v <= alpha) {
                    return alpha;
                }
                if (v < beta) {
                    beta = v;
                }
            }
        }
        return isMax ? alpha : beta;
    }

    function alphaBeta(gs, depth, alpha, beta, isMax, deadline, pvMove) {
        if (Date.now() > deadline) {
            return { score: evaluatePosition(gs), move: null };
        }
        if (aiEngine.isGameOver(gs)) {
            return { score: evaluatePosition(gs), move: null };
        }

        const key = depth + '|' + (isMax ? 'X' : 'N') + '|' + hashState(gs);
        const cached = state.transposition.get(key);
        if (cached && cached.depth >= depth) {
            return { score: cached.score, move: cached.move };
        }

        if (depth <= 0) {
            const q = quiescence(gs, alpha, beta, isMax, QUIESCENCE_MAX_DEPTH, deadline);
            return { score: q, move: null };
        }

        const owner = isMax ? COMPUTER : PLAYER;
        let moves = generateMoves(gs, owner);
        if (moves.length === 0) {
            return { score: evaluatePosition(gs), move: null };
        }
        moves = orderMoves(gs, moves, owner, pvMove);

        const branchLimit = isMax
            ? Math.max(BRANCH_LIMIT_MIN, BRANCH_LIMIT_MAX - depth)
            : BRANCH_LIMIT_OPP;
        if (moves.length > branchLimit) {
            moves = moves.slice(0, branchLimit);
        }

        let bestScore = isMax ? -Infinity : Infinity;
        let bestMove = moves[0];

        for (let i = 0; i < moves.length; i++) {
            if (Date.now() > deadline) {
                break;
            }
            const child = aiEngine.makeVirtualMove(gs, moves[i]);
            const inner = alphaBeta(child, depth - 1, alpha, beta, !isMax, deadline, null);

            if (isMax) {
                if (inner.score > bestScore) {
                    bestScore = inner.score;
                    bestMove = moves[i];
                }
                if (bestScore > alpha) {
                    alpha = bestScore;
                }
            } else {
                if (inner.score < bestScore) {
                    bestScore = inner.score;
                    bestMove = moves[i];
                }
                if (bestScore < beta) {
                    beta = bestScore;
                }
            }
            if (beta <= alpha) {
                recordKiller(moves[i]);
                break;
            }
        }

        state.transposition.set(key, { score: bestScore, move: bestMove, depth: depth });
        return { score: bestScore, move: bestMove };
    }

    function iterativeDeepening(gs) {
        const totalPieces = (gs.playerPieces || []).filter(p => !p.removed).length
                          + (gs.aiPieces || []).filter(p => !p.removed).length;
        const endgame = totalPieces <= 9;

        const timeBudget = endgame ? TIME_BUDGET_ENDGAME_MS : TIME_BUDGET_MS;
        const maxDepth   = endgame ? MAX_DEPTH_ENDGAME : MAX_DEPTH;
        const deadline   = Date.now() + timeBudget;

        let bestMove = null;
        let bestScore = -Infinity;
        let pvMove = null;

        state.transposition.clear();

        for (let depth = 1; depth <= maxDepth; depth++) {
            if (Date.now() > deadline) {
                break;
            }
            const result = alphaBeta(gs, depth, -Infinity, Infinity, true, deadline, pvMove);
            if (result.move) {
                if (Date.now() <= deadline || depth === 1) {
                    bestMove = result.move;
                    bestScore = result.score;
                    pvMove = result.move;
                }
            }
            if (bestScore >= SCORE_FLAG * 0.9 || bestScore <= -SCORE_FLAG * 0.9) {
                break;
            }
        }

        return { move: bestMove, score: bestScore };
    }

    // =====================================================================
    //  ADAPTIVE PICK — combines search result with safety overlays.
    //  If the searched move is "scary" (puts our flag into a fresh threat
    //  envelope), we look for a safer top-K alternative within a similar
    //  value range. This is the "Claude" personality: do the best move,
    //  unless a nearly-as-good move is much safer.
    // =====================================================================

    function pickWithDefenseOverlay(gs, available, searched) {
        const adaptive = adaptivePickFromSearch(gs, available, searched);
        if (!adaptive) {
            return null;
        }

        const myFlag = getMyFlag(gs);
        const underPressure = myFlag && threatsToFlag(gs, myFlag, 2).length > 0;
        if (!underPressure) {
            return adaptive;
        }

        const defenses = aiEngine.findFlagDefenseMoves(gs, available);
        if (defenses.length === 0) {
            return adaptive;
        }

        const defense = aiEngine.pickBestScored(defenses, gs);
        if (!defense || !isSafeForFlag(gs, defense)) {
            return adaptive;
        }

        const defenseScore = heuristicScore(gs, defense);
        const adaptiveScore = heuristicScore(gs, adaptive);
        if (defenseScore >= adaptiveScore - 80) {
            return defense;
        }
        return adaptive;
    }

    function adaptivePickFromSearch(gs, available, searched) {
        if (!searched) {
            return null;
        }
        if (isSafeForFlag(gs, searched)) {
            return searched;
        }
        const allMoves = aiEngine.getAllFilteredMoves(gs, available);
        const scored = allMoves.map(m => ({
            m,
            v: heuristicScore(gs, m)
        }));
        scored.sort((a, b) => b.v - a.v);
        const top = scored.slice(0, 6);
        for (let i = 0; i < top.length; i++) {
            const candidate = top[i].m;
            if (isSafeForFlag(gs, candidate)) {
                return candidate;
            }
        }
        return searched;
    }

    function isSafeForFlag(gs, move) {
        if (!move) {
            return true;
        }
        const myFlag = getMyFlag(gs);
        if (!myFlag) {
            return true;
        }
        if (move.piece && move.piece.id === myFlag.id) {
            const fakeFlag = { row: move.row, col: move.col };
            const after = threatsToFlag(gs, fakeFlag, 1);
            return after.filter(t => t.revealed).length === 0;
        }
        if (!safeToLeave(gs, move.piece)) {
            return false;
        }
        return true;
    }

    /**
     * Lightweight heuristic — only used as a tie-breaker / safer alternative
     * picker. Re-uses the engine's V2 evaluator and overlays EV math for
     * unknown-target attacks (which V2 alone cannot reason about).
     */
    function heuristicScore(gs, move) {
        if (!move) {
            return -Infinity;
        }
        let s = aiEngine.evaluateMoveV2(move, gs);
        const target = gs.board[move.row] && gs.board[move.row][move.col];
        if (target && target.owner === PLAYER && !target.revealed) {
            s += expectedAttackValue(move.piece, target) * 0.4;
        }
        if (aiEngine.isShuttlePosition(move.piece.id, move.row, move.col)) {
            s -= 220;
        }
        return s;
    }

    function fallbackSafeMove(gs, available) {
        const all = aiEngine.getAllFilteredMoves(gs, available);
        if (all.length === 0) {
            return null;
        }
        const filtered = aiEngine.filterOutShuttleMoves(all);
        const pool = filtered.length > 0 ? filtered : all;
        return aiEngine.pickFromTopK(pool, gs, 3);
    }

    // =====================================================================
    //  ENTRY POINT
    // =====================================================================

    function move(gameState) {
        try {
            state.turn++;
            aiEngine.positionCache.clear();
            aiEngine.analyzePlayerPattern(gameState);
            aiEngine.trackEnemyStillness(gameState);
            aiEngine.updateStrategicTargets(gameState);

            if (hasBeliefs()) {
                if (typeof aiBeliefs.tick === 'function') {
                    aiBeliefs.tick(aiEngine.aiTurnCounter + 1);
                }
                if (typeof aiBeliefs.applyConstraints === 'function') {
                    aiBeliefs.applyConstraints(gameState);
                }
            }

            if (typeof aiStrategy !== 'undefined'
                    && aiStrategy
                    && typeof aiStrategy.update === 'function') {
                aiStrategy.update(
                    gameState,
                    hasBeliefs() ? aiBeliefs : null,
                    aiEngine.aiTurnCounter
                );
            }

            const available = aiEngine.getActivePieces(gameState);
            if (available.length === 0) {
                return null;
            }

            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: deducerForCore,
                flagHuntHorizon: HUNT_HORIZON,
                antiCluster: true
            });
            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            const urgent = tryUrgentFlagSave(gameState, available);
            if (urgent) {
                aiEngine.recordAIMove(urgent);
                return urgent;
            }

            const hunt = tryConfirmedFlagHunt(gameState, available);
            if (hunt) {
                aiEngine.recordAIMove(hunt);
                return hunt;
            }

            const midPressure = tryMidConfidenceFlagPressure(gameState, available);
            if (midPressure) {
                aiEngine.recordAIMove(midPressure);
                return midPressure;
            }

            const searched = iterativeDeepening(gameState);
            const picked = pickWithDefenseOverlay(gameState, available, searched.move);
            if (picked) {
                aiEngine.recordAIMove(picked);
                return picked;
            }

            const fallback = fallbackSafeMove(gameState, available);
            if (fallback) {
                aiEngine.recordAIMove(fallback);
                return fallback;
            }

            return null;
        } catch (e) {
            console.error('[composer_2_5] move() failed:', e);
            try {
                const pieces = aiEngine.getActivePieces(gameState);
                const fb = fallbackSafeMove(gameState, pieces);
                if (fb) {
                    aiEngine.recordAIMove(fb);
                    return fb;
                }
            } catch (_) {}
            return null;
        }
    }

    // =====================================================================
    //  PUBLIC DESCRIPTOR
    // =====================================================================

    return {
        id: 'composer_2_5',
        name: 'Composer 2.5',
        emoji: '◇',
        avatar: 'js/bots/composer_2_5/avatar-min.png',

        shortDescription: 'Байес, α-β, EV-атаки и оборона флага',
        longDescription: 'Ядро, α-β и EV по скрытым. Охота при вере в флаг, паранойя в обороне.',

        algorithmLabel: 'Тактическое ядро + α-β + байесовский EV',
        modelAuthor: 'Cursor · Composer 2.5',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['cursor', 'composer', 'bayesian', 'alpha-beta', 'quiescence',
               'expected-value', 'ensemble', 'championship'],

        move: move,
        chooseFlagAndTrap: chooseFlagAndTrap
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = composer25Bot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(composer25Bot);
} else {
    throw new Error('[composer_2_5] RPSBotAPI.defineBot is required (load bot-api.js first)');
}
