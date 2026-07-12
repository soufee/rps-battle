/**
 * Sonnet 4.6 Medium — Anthropic Championship Engine v3
 *
 * Author: Claude Sonnet 4.6 (Anthropic)
 *
 * v3 (data-driven fixes from full-league archive analysis):
 *   0. **FATAL BUG FIX**: Infinite shuttle loop eliminated.
 *      v2 leaked a two-cell ping-pong (E3↔D4, 1000+ turns → timeout).
 *      Root cause: `isShuttle` was only checked at move-ordering time;
 *      the α-β search re-discovered the same transposition and returned
 *      the shuttle move as PV. Fix: after search, run `aiEngine.isShuttlePosition`
 *      + `aiEngine.filterOutShuttleMoves`; if the winner is a shuttle, invoke
 *      `_pickAlternativeRootMove` (copied from owl's anti-shuttle pattern).
 *   1. **Trap-as-attacker ban**: Trap may NEVER move into an enemy-occupied
 *      cell unless that cell is the enemy flag.  The old hiddenEV path awarded
 *      positive EV for Trap attacks, causing suicidal moves.
 *   2. **Tactical hat** before search (same as owl/gemini_3_5_flash pattern):
 *      flag-capture → flag-defense → guaranteed-kills → HUNT/FORTRESS layers
 *      → iterative deepening.  Each layer gates on the aiEngine helpers.
 *   3. **Hardened flag escort**: `findMandatoryMove` now checks R1 threats first
 *      and launches immediate counter before flag escape.  Escape only when no
 *      safe counter exists AND a cell at dist ≥ 2 from all threats exists.
 *   4. **Aggressive alternative search**: when in HUNT mode and the search
 *      returns a non-attacking move, `_pickAlternativeRootMove` explicitly
 *      re-ranks by proximity to the top flag candidate.
 *   5. **Anti-shuttle strengthened**: history heuristic applied in `orderMoves`
 *      (shuttle-flagged moves pushed to the bottom of ordering with a –1200
 *      penalty instead of –400).
 *
 * Architecture: layered tactical hat over iterative-deepening α-β.
 * All shuttle detection delegates to `aiEngine.isShuttlePosition` /
 * `aiEngine.filterOutShuttleMoves` which are authoritative.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[kapibarysh] bot-api.js must be loaded BEFORE this bot');
}

const kapibaryshBot = (() => {
    'use strict';

    // =========================================================================
    //  CONSTANTS
    // =========================================================================

    const B_FLAG      = 'flag';
    const B_TRAP      = 'trap';
    const B_PIECE     = 'piece';
    const B_PLAYER    = 'player';
    const B_COMPUTER  = 'computer';

    const B_ROCK      = 'rock';
    const B_PAPER     = 'paper';
    const B_SCISSORS  = 'scissors';

    const BOARD_ROWS  = 6;
    const BOARD_COLS  = 8;

    // Piece values for evaluation
    const V_FLAG      = 200000;
    const V_TRAP      = 1400;
    const V_PIECE_REV = 340;
    const V_PIECE_HID = 420;
    const V_OPP_TRAP  = 380;
    const V_OPP_REV   = 500;
    const V_OPP_HID   = 370;

    // Confidence thresholds for flag hunting
    const CONF_HIGH   = 0.84;
    const CONF_MID    = 0.62;
    const CONF_LOW    = 0.40;

    // Time budgets — read dynamically so the test harness override takes effect
    const TIME_NORMAL_DEFAULT  = 2800;
    const TIME_ENDGAME_DEFAULT = 3900;

    function getTimeBudget(endgame) {
        const hint = (typeof window !== 'undefined' && window.__RPS_TIME_BUDGET)
            ? window.__RPS_TIME_BUDGET
            : null;
        if (hint) return Math.max(hint, 20);
        return endgame ? TIME_ENDGAME_DEFAULT : TIME_NORMAL_DEFAULT;
    }

    // Search limits
    const MAX_DEPTH         = 5;
    const MAX_DEPTH_ENDGAME = 7;
    const BRANCH_MAX        = 14;
    const BRANCH_OPP        = 10;
    const Q_MAX_DEPTH       = 3;

    // Minimum mobile defenders to keep near flag
    const MIN_DEFENDERS = 2;

    // RPS win table
    const BEATS     = { rock: B_SCISSORS, scissors: B_PAPER, paper: B_ROCK };
    const BEATEN_BY = { rock: B_PAPER, scissors: B_ROCK, paper: B_SCISSORS };

    // =========================================================================
    //  PRIVATE STATE
    // =========================================================================

    const S = {
        turn:          0,
        beliefs:       new Map(),     // pieceId -> belief entry
        recentMoves:   [],            // {pieceId, fromRow, fromCol, toRow, toCol}
        killerMoves:   [],            // [{pieceId, row, col}]
        transposition: new Map(),
        mode:          'RECON',       // RECON | PRESSURE | HUNT | FORTRESS
        opp: {
            advancedCount:    0,
            preferredFlank:   null,
            isAggressive:     false
        }
    };

    // =========================================================================
    //  SMALL UTILITIES
    // =========================================================================

    function cheb(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    }

    function getMyFlag(gs) {
        return (gs.aiPieces || []).find(p => p.type === B_FLAG && !p.removed) || null;
    }

    function getEnemyFlag(gs) {
        return (gs.playerPieces || []).find(p => p.type === B_FLAG && !p.removed) || null;
    }

    function getMyActive(gs) {
        return (gs.aiPieces || []).filter(p => !p.removed && !p.immobilized && p.row >= 0);
    }

    function isEndgame(gs) {
        return (gs.aiPieces || []).filter(p => !p.removed).length <= 6;
    }

    function legalMovesFor(piece, gs) {
        if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.getLegalMoves) {
            return RPSBotAPI.getLegalMoves(piece, gs);
        }
        const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
        const out = [];
        for (const [dr, dc] of dirs) {
            const nr = piece.row + dr;
            const nc = piece.col + dc;
            if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;
            const occ = gs.board[nr] && gs.board[nr][nc];
            if (!occ || occ.owner !== piece.owner) out.push({ row: nr, col: nc });
        }
        return out;
    }

    function resolveRPS(t1, t2) {
        if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.resolveBattle) {
            return RPSBotAPI.resolveBattle(t1, t2);
        }
        if (BEATS[t1] === t2) return 'win';
        if (BEATS[t2] === t1) return 'lose';
        return 'draw';
    }

    function makeVirtual(gs, move) {
        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.makeVirtualMove === 'function') {
            return aiEngine.makeVirtualMove(gs, move);
        }
        return fallbackVirtualMove(gs, move);
    }

    function fallbackVirtualMove(gs, move) {
        const newState = {
            aiPieces: gs.aiPieces.map(p => ({ ...p })),
            playerPieces: gs.playerPieces.map(p => ({ ...p })),
            board: Array.from({ length: BOARD_ROWS }, () => new Array(BOARD_COLS).fill(null))
        };
        [...newState.aiPieces, ...newState.playerPieces].forEach(p => {
            if (!p.removed && p.row >= 0 && p.col >= 0) newState.board[p.row][p.col] = p;
        });
        const piece = newState.board[move.piece.row] && newState.board[move.piece.row][move.piece.col];
        if (!piece) return newState;
        const target = newState.board[move.row][move.col];
        if (target && target.owner !== piece.owner) {
            if (piece.type === B_FLAG) return newState;
            const a = piece.type === B_PIECE ? piece.pieceType : piece.type;
            const b = target.type === B_PIECE ? target.pieceType : target.type;
            const result = resolveRPS(a, b);
            if (result === 'win') {
                target.removed = true;
                newState.board[move.row][move.col] = null;
                newState.board[piece.row][piece.col] = null;
                piece.row = move.row; piece.col = move.col;
                newState.board[move.row][move.col] = piece;
            } else if (result === 'lose') {
                piece.removed = true;
                newState.board[piece.row][piece.col] = null;
            }
        } else if (!target) {
            newState.board[piece.row][piece.col] = null;
            piece.row = move.row; piece.col = move.col;
            newState.board[move.row][move.col] = piece;
        }
        return newState;
    }

    function isGameOver(gs) {
        const pf = (gs.playerPieces || []).find(p => p.type === B_FLAG && !p.removed);
        const af = (gs.aiPieces     || []).find(p => p.type === B_FLAG && !p.removed);
        return !pf || !af;
    }

    // =========================================================================
    //  BELIEF SYSTEM (independent + fallback to shared aiBeliefs)
    // =========================================================================

    function initBeliefs(gs) {
        S.beliefs.clear();
        const pieces = (gs.playerPieces || []);
        let fSum = 0, tSum = 0;
        for (const p of pieces) {
            fSum += p.row >= 5 ? 0.13 : 0.035;
            tSum += p.row >= 5 ? 0.09 : 0.04;
        }
        if (fSum <= 0) fSum = 1;
        if (tSum <= 0) tSum = 1;
        for (const p of pieces) {
            const pF = (p.row >= 5 ? 0.13 : 0.035) / fSum;
            const pT = (p.row >= 5 ? 0.09 : 0.04) / tSum;
            const rest = Math.max(1 - pF - pT, 0.05);
            const pR = rest / 3;
            S.beliefs.set(p.id, {
                probs: { rock: pR, paper: pR, scissors: pR, flag: pF, trap: pT },
                still: 0, lastRow: p.row, lastCol: p.col,
                firstMove: null, lastMove: null, ref: p
            });
        }
    }

    function updateBeliefs(gs) {
        const enemies = (gs.playerPieces || []);
        for (const [id] of S.beliefs) {
            if (!enemies.find(p => p.id === id && !p.removed)) S.beliefs.delete(id);
        }
        for (const p of enemies) {
            if (p.removed) continue;
            if (!S.beliefs.has(p.id)) {
                S.beliefs.set(p.id, {
                    probs: { rock: 0.25, paper: 0.25, scissors: 0.25, flag: 0.13, trap: 0.12 },
                    still: 0, lastRow: p.row, lastCol: p.col,
                    firstMove: null, lastMove: null, ref: p
                });
            }
        }
        for (const p of enemies) {
            if (p.removed) continue;
            const b = S.beliefs.get(p.id);
            if (!b) continue;
            b.ref = p;
            if (p.revealed) {
                const t = p.type === B_PIECE ? p.pieceType : p.type;
                for (const k of Object.keys(b.probs)) b.probs[k] = 0;
                if (t) b.probs[t] = 1.0;
                continue;
            }
            const moved = (p.row !== b.lastRow || p.col !== b.lastCol);
            if (moved) {
                const firstTime = b.firstMove === null;
                b.firstMove = b.firstMove ?? S.turn;
                b.lastMove = S.turn;
                b.still = 0;
                b.probs.trap *= firstTime ? 0.18 : 0.04;
                b.probs.flag *= firstTime ? 0.48 : 0.22;
                applyApproachRetreats(b, p, gs);
                b.lastRow = p.row;
                b.lastCol = p.col;
            } else {
                b.still++;
                if (b.still >= 3 && p.row >= 5) {
                    b.probs.flag = Math.min(0.92, b.probs.flag * 1.18);
                }
                if (b.still >= 6) {
                    b.probs.flag    = Math.min(0.96, b.probs.flag * 1.22);
                    b.probs.trap    = Math.min(0.96, b.probs.trap  * 1.12);
                    b.probs.rock    *= 0.88;
                    b.probs.paper   *= 0.88;
                    b.probs.scissors *= 0.88;
                }
            }
            normalizeProbs(b.probs);
        }
        enforceConstraints();
    }

    function applyApproachRetreats(belief, enemy, gs) {
        const ours = (gs.aiPieces || []).filter(p =>
            p.revealed && p.type === B_PIECE && p.pieceType && !p.removed
        );
        for (const o of ours) {
            const dOld = cheb({ row: belief.lastRow, col: belief.lastCol }, o);
            const dNew = cheb(enemy, o);
            if (dOld > 2 && dNew <= 1) applyApproach(belief.probs, o.pieceType);
            else if (dOld <= 1 && dNew > 2) applyRetreat(belief.probs, o.pieceType);
        }
    }

    function applyApproach(probs, ourType) {
        if (ourType === B_ROCK) {
            probs.paper    = Math.min(0.95, probs.paper * 2.9);
            probs.flag     *= 0.07;
            probs.trap     *= 0.12;
            probs.scissors *= 0.28;
        } else if (ourType === B_PAPER) {
            probs.scissors = Math.min(0.95, probs.scissors * 2.9);
            probs.flag     *= 0.07;
            probs.trap     *= 0.12;
            probs.rock     *= 0.28;
        } else if (ourType === B_SCISSORS) {
            probs.rock     = Math.min(0.95, probs.rock * 2.9);
            probs.flag     *= 0.07;
            probs.trap     *= 0.12;
            probs.paper    *= 0.28;
        }
    }

    function applyRetreat(probs, ourType) {
        if (ourType === B_ROCK) {
            probs.scissors = Math.min(0.95, probs.scissors * 2.3);
            probs.flag     = Math.min(0.92, probs.flag * 1.45);
            probs.paper    *= 0.48;
        } else if (ourType === B_PAPER) {
            probs.rock     = Math.min(0.95, probs.rock * 2.3);
            probs.flag     = Math.min(0.92, probs.flag * 1.45);
            probs.scissors *= 0.48;
        } else if (ourType === B_SCISSORS) {
            probs.paper    = Math.min(0.95, probs.paper * 2.3);
            probs.flag     = Math.min(0.92, probs.flag * 1.45);
            probs.rock     *= 0.48;
        }
    }

    function normalizeProbs(probs) {
        let s = 0;
        for (const k of Object.keys(probs)) {
            probs[k] = Math.max(0, probs[k]);
            s += probs[k];
        }
        if (s <= 0) {
            probs.rock = probs.paper = probs.scissors = 1/3;
            probs.flag = probs.trap = 0;
            return;
        }
        for (const k of Object.keys(probs)) probs[k] /= s;
    }

    function enforceConstraints() {
        let fSum = 0, tSum = 0;
        const live = [];
        for (const [, b] of S.beliefs) {
            if (!b.ref || b.ref.removed || b.ref.revealed) continue;
            live.push(b);
            fSum += b.probs.flag;
            tSum += b.probs.trap;
        }
        if (fSum > 0.01) for (const b of live) b.probs.flag /= fSum;
        if (tSum > 0.01) for (const b of live) b.probs.trap  /= tSum;
    }

    function getBelief(pieceId) {
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs
                && typeof aiBeliefs.getProbDistribution === 'function') {
            const d = aiBeliefs.getProbDistribution(pieceId);
            if (d) return d;
        }
        const b = S.beliefs.get(pieceId);
        return b ? b.probs : { rock: 0.3, paper: 0.3, scissors: 0.3, flag: 0.05, trap: 0.05 };
    }

    function getFlagCandidates(gs, n) {
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs
                && typeof aiBeliefs.getFlagCandidates === 'function') {
            const lst = aiBeliefs.getFlagCandidates(gs, n || 3);
            if (lst && lst.length > 0) return lst.map(c => ({ piece: c.piece, pFlag: c.pFlag }));
        }
        const out = [];
        for (const [, b] of S.beliefs) {
            if (!b.ref || b.ref.removed || b.ref.revealed) continue;
            out.push({ piece: b.ref, pFlag: b.probs.flag });
        }
        out.sort((a, z) => z.pFlag - a.pFlag);
        return out.slice(0, n || 3);
    }

    // =========================================================================
    //  PHANTOM ZONE — threat map (not just adjacency count)
    // =========================================================================

    function phantomThreatCount(r, c, gs, steps) {
        let count = 0;
        const enemies = (gs.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 && !p.immobilized && p.type !== B_FLAG
        );
        for (const e of enemies) {
            if (cheb(e, { row: r, col: c }) <= steps) count++;
        }
        return count;
    }

    // =========================================================================
    //  EXPECTED-VALUE HELPERS
    // =========================================================================

    function evAttack(attacker, target) {
        if (!attacker || !target) return 0;
        // v3: TRAP may never profit from attacking non-flag enemies
        if (attacker.type === B_TRAP && target.type !== B_FLAG) return -V_FLAG;
        if (target.revealed && target.type === B_TRAP) return -V_FLAG;
        if (target.type === B_FLAG) return V_FLAG;
        if (target.revealed && target.type === B_FLAG) return V_FLAG;
        if (target.revealed) return revealedEV(attacker, target);
        return hiddenEV(attacker, target);
    }

    function revealedEV(attacker, target) {
        if (target.type === B_FLAG) return V_FLAG;
        if (target.type === B_TRAP) {
            return attacker.type === B_TRAP ? -200 : -V_PIECE_REV * 1.3;
        }
        if (attacker.type === B_TRAP) return V_OPP_REV;  // shouldn't reach here after guard
        if (attacker.type !== B_PIECE || !attacker.pieceType) return 0;
        if (target.type !== B_PIECE || !target.pieceType) return 0;
        const r = resolveRPS(attacker.pieceType, target.pieceType);
        if (r === 'win')  return V_OPP_REV * 1.2;
        if (r === 'lose') return -V_PIECE_REV * 1.4;
        return -40;
    }

    function hiddenEV(attacker, target) {
        const belief = getBelief(target.id);
        let ev = 0;
        const pF = belief.flag || 0;
        const pT = belief.trap || 0;
        ev += pF * V_FLAG;
        // v3: Trap attacking hidden target → large penalty (it almost always loses)
        if (attacker.type === B_TRAP) {
            ev -= (1 - pF) * V_PIECE_HID * 2.0;
            return ev;
        }
        if (attacker.type === B_PIECE && attacker.pieceType) {
            const t = attacker.pieceType;
            const win  = belief[BEATS[t]]    || 0;
            const lose = belief[BEATEN_BY[t]] || 0;
            const draw = belief[t]            || 0;
            ev += win  *  V_OPP_HID;
            ev += lose * (-V_PIECE_HID * 1.25);
            ev += draw * (-38);
            ev += pT   * (-V_PIECE_HID * 1.15);
        }
        return ev;
    }

    // =========================================================================
    //  OPPONENT MODEL UPDATE
    // =========================================================================

    function updateOpponentModel(gs) {
        const enemies = (gs.playerPieces || []).filter(p => !p.removed && p.row >= 0);
        let adv = 0, lft = 0, ctr = 0, rgt = 0;
        for (const p of enemies) {
            if (p.row <= 2) adv++;
            if (p.col <= 2)      lft++;
            else if (p.col >= 5) rgt++;
            else                 ctr++;
        }
        S.opp.advancedCount  = adv;
        S.opp.isAggressive   = adv >= 3;
        const mx = Math.max(lft, ctr, rgt);
        S.opp.preferredFlank = mx >= 4
            ? (lft === mx ? 'left' : rgt === mx ? 'right' : 'center')
            : null;
    }

    function updateStrategyMode(gs) {
        const myFlag = getMyFlag(gs);
        const candidates = getFlagCandidates(gs, 1);
        const topConf = candidates.length > 0 ? candidates[0].pFlag : 0;

        if (myFlag) {
            const r1Threats = (gs.playerPieces || []).filter(p =>
                !p.removed && p.row >= 0 && !p.immobilized
                && p.type !== B_FLAG && cheb(p, myFlag) === 1
            ).length;
            const r2Threats = phantomThreatCount(myFlag.row, myFlag.col, gs, 2);
            if (r1Threats >= 1 || r2Threats >= 4 || S.opp.isAggressive) {
                S.mode = 'FORTRESS';
                return;
            }
        }
        if (topConf >= CONF_HIGH) { S.mode = 'HUNT';     return; }
        if (topConf >= CONF_MID)  { S.mode = 'PRESSURE'; return; }
        S.mode = 'RECON';
    }

    // =========================================================================
    //  ANTI-SHUTTLE  (v3: strengthened, delegates to aiEngine when available)
    // =========================================================================

    function isShuttleMove(move) {
        // Primary: delegate to aiEngine (authoritative, used by owl/gemini)
        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.isShuttlePosition === 'function') {
            return aiEngine.isShuttlePosition(move.piece.id, move.row, move.col);
        }
        // Fallback: local history
        const hist = S.recentMoves.filter(m => m.pieceId === move.piece.id);
        if (hist.length < 2) return false;
        const last = hist[hist.length - 1];
        const prev = hist[hist.length - 2];
        return (last.toRow === move.row && last.toCol === move.col
             && prev.toRow === last.fromRow && prev.toCol === last.fromCol);
    }

    /** Filter shuttle moves out from a list.  Keeps at least one move. */
    function filterShuttles(moves) {
        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.filterOutShuttleMoves === 'function') {
            const filtered = aiEngine.filterOutShuttleMoves(moves);
            return filtered.length > 0 ? filtered : moves;
        }
        const filtered = moves.filter(m => !isShuttleMove(m));
        return filtered.length > 0 ? filtered : moves;
    }

    function recordMove(move) {
        S.recentMoves.push({
            pieceId: move.piece.id,
            fromRow: move.piece.row, fromCol: move.piece.col,
            toRow:   move.row,       toCol:   move.col
        });
        if (S.recentMoves.length > 40) S.recentMoves.shift();
        // Also record in aiEngine if available (keeps shared shuttle state)
        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.recordAIMove === 'function') {
            aiEngine.recordAIMove(move);
        }
    }

    // =========================================================================
    //  EVALUATION
    // =========================================================================

    function evaluatePosition(gs) {
        const myFlag  = getMyFlag(gs);
        const enmFlag = getEnemyFlag(gs);
        if (!myFlag)  return -V_FLAG;
        if (!enmFlag) return  V_FLAG;

        let score = 0;
        const mine = (gs.aiPieces    || []).filter(p => !p.removed && p.row >= 0);
        const opp  = (gs.playerPieces || []).filter(p => !p.removed && p.row >= 0);

        score += scoreMaterial(mine, opp);
        score += scoreFlagSafety(gs, myFlag, mine);
        score += scoreHuntPressure(gs, enmFlag);
        score += scoreCoordination(mine);
        score += scoreProgression(mine);
        score += scoreBeliefAwareProximity(mine, opp);
        return score;
    }

    function scoreMaterial(mine, opp) {
        let s = 0;
        for (const p of mine) {
            if (p.type === B_FLAG) s += V_FLAG;
            else if (p.type === B_TRAP) s += p.immobilized ? V_TRAP * 0.35 : V_TRAP;
            else s += p.revealed ? V_PIECE_REV : V_PIECE_HID;
        }
        for (const p of opp) {
            if (p.type === B_FLAG) s -= V_FLAG;
            else if (p.type === B_TRAP) s -= p.immobilized ? V_OPP_TRAP * 0.35 : V_OPP_TRAP;
            else if (p.revealed) s -= V_OPP_REV;
            else {
                const belief = getBelief(p.id);
                const pRPS = (belief.rock || 0) + (belief.paper || 0) + (belief.scissors || 0);
                s -= pRPS * V_OPP_HID;
            }
        }
        return s;
    }

    function scoreFlagSafety(gs, myFlag, mine) {
        let s = 0;

        const d1 = phantomThreatCount(myFlag.row, myFlag.col, gs, 1);
        const d2 = phantomThreatCount(myFlag.row, myFlag.col, gs, 2);
        s -= d1 * 12000;
        s -= (d2 - d1) * 500;

        // Mobile defenders within radius 2
        const defenders = mine.filter(p =>
            p.type !== B_FLAG && !p.immobilized && cheb(p, myFlag) <= 2
        );
        const typeSet = new Set(
            defenders.map(p => p.type === B_PIECE ? p.pieceType : null).filter(Boolean)
        );
        s += defenders.length * 220;
        s += typeSet.size * 160;
        if (defenders.some(p => p.type === B_TRAP && !p.immobilized)) s += 260;

        if (defenders.length === 0) {
            s -= 9000;
        } else if (defenders.length === 1) {
            s -= 2800;
        }

        const mobileDefenders = defenders.filter(p => !p.immobilized);
        if (mobileDefenders.length === 0) s -= 4500;

        const fc = myFlag.col;
        const fr = myFlag.row;
        if ((fc === 0 || fc === 7) && fr === 0) s += 140;
        else if ((fc <= 1 || fc >= 6) && fr <= 1) s += 80;

        let escapes = 0;
        const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
        for (const [dr, dc] of dirs) {
            const nr = fr + dr;
            const nc = fc + dc;
            if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;
            if (!gs.board[nr] || !gs.board[nr][nc]) escapes++;
        }
        s += escapes * 14;

        return s;
    }

    function scoreHuntPressure(gs, enmFlag) {
        let s = 0;
        const mine = (gs.aiPieces || []).filter(p =>
            !p.removed && p.row >= 0 && p.type === B_PIECE
        );

        if (enmFlag && enmFlag.revealed) {
            for (const p of mine) {
                const d = cheb(p, enmFlag);
                s += (6 - Math.min(6, d)) * 58;
            }
            return s;
        }

        const candidates = getFlagCandidates(gs, 2);
        if (candidates.length === 0) return 0;

        const top = candidates[0];
        if (top.pFlag < 0.25) return 0;
        for (const p of mine) {
            const d = cheb(p, top.piece);
            s += (6 - Math.min(6, d)) * 40 * top.pFlag;
        }
        if (candidates.length > 1 && candidates[1].pFlag >= 0.18) {
            const sec = candidates[1];
            for (const p of mine) {
                const d = cheb(p, sec.piece);
                s += (6 - Math.min(6, d)) * 16 * sec.pFlag;
            }
        }
        return s;
    }

    function scoreCoordination(mine) {
        let s = 0;
        const attackers = mine.filter(p => p.type === B_PIECE);
        for (const a of attackers) {
            let rock = a.pieceType === B_ROCK;
            let paper = a.pieceType === B_PAPER;
            let scissors = a.pieceType === B_SCISSORS;
            let sameNear = 0;
            for (const b of attackers) {
                if (b.id === a.id) continue;
                if (cheb(a, b) > 2) continue;
                if (b.pieceType === B_ROCK)     rock = true;
                if (b.pieceType === B_PAPER)    paper = true;
                if (b.pieceType === B_SCISSORS) scissors = true;
                if (b.pieceType === a.pieceType) sameNear++;
            }
            const uniq = (rock ? 1 : 0) + (paper ? 1 : 0) + (scissors ? 1 : 0);
            s += uniq === 3 ? 88 : uniq === 2 ? 30 : 0;
            if (sameNear >= 2) s -= sameNear * 30;
        }
        return s;
    }

    function scoreProgression(mine) {
        let s = 0;
        for (const p of mine) {
            if (p.type !== B_PIECE) continue;
            s += p.row * 10;
            s += (4 - Math.abs(p.col - 3.5)) * 5;
        }
        return s;
    }

    function scoreBeliefAwareProximity(mine, opp) {
        let s = 0;
        for (const a of mine) {
            if (a.type !== B_PIECE || !a.pieceType) continue;
            const winsVs  = BEATS[a.pieceType];
            const losesTo = BEATEN_BY[a.pieceType];
            for (const e of opp) {
                if (e.removed || e.immobilized) continue;
                const d = cheb(a, e);
                if (d > 2) continue;
                const belief = getBelief(e.id);
                const pWin  = belief[winsVs]  || 0;
                const pLose = belief[losesTo] || 0;
                const factor = d === 1 ? 30 : 14;
                s += (pWin - pLose * 1.25) * factor;
                if ((belief.trap || 0) > 0.15 && d === 1) s -= belief.trap * 45;
            }
        }
        return s;
    }

    // =========================================================================
    //  MOVE GENERATION
    // =========================================================================

    function genMoves(gs, owner) {
        if (owner === B_COMPUTER) {
            if (typeof aiEngine !== 'undefined' && aiEngine
                    && typeof aiEngine.getAllFilteredMoves === 'function') {
                const pieces = aiEngine.getActivePieces(gs);
                return aiEngine.getAllFilteredMoves(gs, pieces);
            }
            return genMovesLocal(gs, owner);
        }
        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.getAllPossibleMoves === 'function') {
            return aiEngine.getAllPossibleMoves(gs, B_PLAYER);
        }
        return genMovesLocal(gs, owner);
    }

    function genMovesLocal(gs, owner) {
        const pieces = owner === B_COMPUTER
            ? (gs.aiPieces    || []).filter(p => !p.removed && !p.immobilized && p.row >= 0)
            : (gs.playerPieces || []).filter(p => !p.removed && !p.immobilized && p.row >= 0);
        const out = [];
        for (const p of pieces) {
            const mvs = legalMovesFor(p, gs);
            for (const m of mvs) {
                const t = gs.board[m.row] && gs.board[m.row][m.col];
                if (p.type === B_FLAG && t) continue;
                if (t && t.revealed && t.type === B_TRAP && t.owner !== p.owner) continue;
                // v3: Trap cannot attack non-flag enemies
                if (p.type === B_TRAP && t && t.owner !== p.owner && t.type !== B_FLAG) continue;
                if (t && t.revealed && t.type === B_PIECE && p.type === B_PIECE && p.pieceType) {
                    if (resolveRPS(p.pieceType, t.pieceType) === 'lose') continue;
                }
                out.push({ piece: p, row: m.row, col: m.col });
            }
        }
        return out;
    }

    // =========================================================================
    //  MOVE ORDERING
    // =========================================================================

    function orderMoves(gs, moves, isMax, pvMove) {
        const candidates = getFlagCandidates(gs, 1);
        const suspect    = candidates.length > 0 ? candidates[0] : null;
        const myFlag     = getMyFlag(gs);
        const enmFlag    = getEnemyFlag(gs);

        const scored = moves.map(m => {
            let pri = 0;
            const t = gs.board[m.row] && gs.board[m.row][m.col];

            if (pvMove && pvMove.piece && m.piece
                    && pvMove.piece.id === m.piece.id
                    && pvMove.row === m.row && pvMove.col === m.col) {
                pri += 12000;
            }

            for (const km of S.killerMoves) {
                if (km && m.piece && km.pieceId === m.piece.id
                        && km.row === m.row && km.col === m.col) {
                    pri += 700;
                    break;
                }
            }

            if (t && t.owner !== m.piece.owner) {
                pri += 800;
                if (t.type === B_FLAG) pri += 9500;
                else if (t.revealed && t.type === B_TRAP) pri -= 7000;
                else if (t.revealed && t.type === B_PIECE && m.piece.pieceType) {
                    const r = resolveRPS(m.piece.pieceType, t.pieceType);
                    if (r === 'win')  pri += 2000;
                    else if (r === 'lose') pri -= 5000;
                } else if (!t.revealed) {
                    pri += hiddenEV(m.piece, t) * 0.06;
                }
            }

            if (isMax) {
                if (suspect && suspect.pFlag >= CONF_LOW) {
                    const dB = cheb(m.piece, suspect.piece);
                    const dA = cheb(m, suspect.piece);
                    if (dA < dB) pri += 150 * suspect.pFlag;
                }
                if (enmFlag && enmFlag.revealed) {
                    if (cheb(m, enmFlag) < cheb(m.piece, enmFlag)) pri += 280;
                }
                if (myFlag) {
                    const r1Threats = (gs.playerPieces || []).filter(p =>
                        !p.removed && p.row >= 0 && !p.immobilized
                        && p.type !== B_FLAG && cheb(p, myFlag) <= 1
                    ).length;
                    if (r1Threats > 0) {
                        if (cheb(m, myFlag) < cheb(m.piece, myFlag)) pri += 400;
                        const tCell = gs.board[m.row] && gs.board[m.row][m.col];
                        if (tCell && tCell.owner === B_PLAYER
                                && cheb(tCell, myFlag) <= 1) pri += 600;
                    } else {
                        const threats = phantomThreatCount(myFlag.row, myFlag.col, gs, 2);
                        if (threats > 0) {
                            if (cheb(m, myFlag) < cheb(m.piece, myFlag)) pri += 200;
                        }
                    }
                }
                pri += m.row * 7;
                // v3: stronger shuttle penalty in ordering
                if (isShuttleMove(m)) pri -= 1200;
            } else {
                pri -= m.row * 7;
            }

            return { m, pri };
        });

        scored.sort((a, b) => b.pri - a.pri);
        return scored.map(x => x.m);
    }

    function recordKiller(move) {
        if (!move || !move.piece) return;
        const e = { pieceId: move.piece.id, row: move.row, col: move.col };
        const idx = S.killerMoves.findIndex(k =>
            k && k.pieceId === e.pieceId && k.row === e.row && k.col === e.col
        );
        if (idx >= 0) S.killerMoves.splice(idx, 1);
        S.killerMoves.unshift(e);
        if (S.killerMoves.length > 6) S.killerMoves.length = 6;
    }

    // =========================================================================
    //  ALPHA-BETA + QUIESCENCE
    // =========================================================================

    function quiescence(gs, alpha, beta, isMax, depth, deadline) {
        if (Date.now() > deadline || depth <= 0) return evaluatePosition(gs);
        if (isGameOver(gs)) return evaluatePosition(gs);

        const standPat = evaluatePosition(gs);
        if (isMax) {
            if (standPat >= beta) return beta;
            alpha = Math.max(alpha, standPat);
        } else {
            if (standPat <= alpha) return alpha;
            beta = Math.min(beta, standPat);
        }

        const owner    = isMax ? B_COMPUTER : B_PLAYER;
        const allMoves = genMoves(gs, owner);
        const captures = allMoves.filter(m => {
            const t = gs.board[m.row] && gs.board[m.row][m.col];
            return !!(t && t.owner !== m.piece.owner);
        });
        if (captures.length === 0) return standPat;

        const ordered = orderMoves(gs, captures, isMax, null).slice(0, 8);
        for (const mv of ordered) {
            if (Date.now() > deadline) break;
            const child = makeVirtual(gs, mv);
            const v = quiescence(child, alpha, beta, !isMax, depth - 1, deadline);
            if (isMax) {
                if (v >= beta) return beta;
                alpha = Math.max(alpha, v);
            } else {
                if (v <= alpha) return alpha;
                beta = Math.min(beta, v);
            }
        }
        return isMax ? alpha : beta;
    }

    function hashState(gs) {
        let h = '';
        for (let r = 0; r < BOARD_ROWS; r++) {
            for (let c = 0; c < BOARD_COLS; c++) {
                const p = gs.board[r] && gs.board[r][c];
                if (p) {
                    h += (p.owner === B_COMPUTER ? 'C' : 'P')
                       + (p.type === B_PIECE
                          ? (p.revealed ? (p.pieceType || '?')[0] : 'h')
                          : p.type[0]);
                } else {
                    h += '.';
                }
            }
            h += '|';
        }
        return h;
    }

    function alphaBeta(gs, depth, alpha, beta, isMax, deadline, pvMove) {
        if (Date.now() > deadline) return { score: evaluatePosition(gs), move: null };
        if (isGameOver(gs))        return { score: evaluatePosition(gs), move: null };

        const key = depth + (isMax ? 'M' : 'N') + hashState(gs);
        const cached = S.transposition.get(key);
        if (cached && cached.depth >= depth) return { score: cached.score, move: cached.move };

        if (depth <= 0) {
            const q = quiescence(gs, alpha, beta, isMax, Q_MAX_DEPTH, deadline);
            return { score: q, move: null };
        }

        const owner = isMax ? B_COMPUTER : B_PLAYER;
        let moves = genMoves(gs, owner);
        if (moves.length === 0) return { score: evaluatePosition(gs), move: null };
        moves = orderMoves(gs, moves, isMax, pvMove);

        const branchLimit = isMax ? BRANCH_MAX : BRANCH_OPP;
        if (moves.length > branchLimit) moves = moves.slice(0, branchLimit);

        let bestScore = isMax ? -Infinity : Infinity;
        let bestMove  = moves[0];

        for (let i = 0; i < moves.length; i++) {
            if (Date.now() > deadline) break;
            const child = makeVirtual(gs, moves[i]);
            const inner = alphaBeta(child, depth - 1, alpha, beta, !isMax, deadline, null);
            if (isMax) {
                if (inner.score > bestScore) {
                    bestScore = inner.score;
                    bestMove  = moves[i];
                }
                if (bestScore > alpha) alpha = bestScore;
            } else {
                if (inner.score < bestScore) {
                    bestScore = inner.score;
                    bestMove  = moves[i];
                }
                if (bestScore < beta) beta = bestScore;
            }
            if (beta <= alpha) {
                recordKiller(moves[i]);
                break;
            }
        }

        if (S.transposition.size > 60000) S.transposition.clear();
        S.transposition.set(key, { score: bestScore, move: bestMove, depth });
        return { score: bestScore, move: bestMove };
    }

    function iterativeDeepening(gs) {
        const endgame  = isEndgame(gs);
        const maxDepth = endgame ? MAX_DEPTH_ENDGAME : MAX_DEPTH;
        const budget   = getTimeBudget(endgame);
        const start    = Date.now();
        const deadline = start + budget;

        let best = null;
        let pvMove = null;

        for (let d = 2; d <= maxDepth; d++) {
            if (Date.now() > deadline * 0.88) break;
            const result = alphaBeta(gs, d, -Infinity, Infinity, true, deadline, pvMove);
            if (result.move) {
                best   = result;
                pvMove = result.move;
            }
            if (!result.move) break;
        }

        return best;
    }

    // =========================================================================
    //  TACTICAL LAYERS
    // =========================================================================

    /**
     * Capture revealed enemy flag OR respond to R1 immediate threat to our flag.
     * v3: guard is tighter — never use Trap to capture non-flag.
     */
    function findMandatoryMove(gs) {
        const myFlag = getMyFlag(gs);
        const mine   = getMyActive(gs);

        // 1. Immediate flag capture (piece only, not trap unless target is flag)
        for (const p of mine) {
            if (p.type === B_FLAG) continue;
            const mvs = legalMovesFor(p, gs);
            for (const m of mvs) {
                const t = gs.board[m.row] && gs.board[m.row][m.col];
                if (t && t.owner === B_PLAYER && t.type === B_FLAG) {
                    return { piece: p, row: m.row, col: m.col };
                }
            }
        }

        if (!myFlag) return null;

        // 2. R1 threats to our flag: try counter-attack first, then flag escape
        const r1Threats = (gs.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 && !p.immobilized
            && p.type !== B_FLAG && cheb(p, myFlag) === 1
        );

        if (r1Threats.length > 0) {
            // 2a. Try to eliminate the threat (only with pieces, not with trap against non-flag)
            for (const threat of r1Threats) {
                let best = null, bestEV = -Infinity;
                for (const p of mine) {
                    if (p.type === B_FLAG) continue;
                    // v3: trap can't counter-attack a non-flag threat
                    if (p.type === B_TRAP && threat.type !== B_FLAG) continue;
                    const mvs = legalMovesFor(p, gs);
                    for (const m of mvs) {
                        if (m.row !== threat.row || m.col !== threat.col) continue;
                        const ev = evAttack(p, threat);
                        if (ev > bestEV) { bestEV = ev; best = { piece: p, row: m.row, col: m.col }; }
                    }
                }
                if (best && bestEV > -V_PIECE_REV * 0.5) return best;
            }

            // 2b. No safe counter-attack: escape the flag to a cell at dist ≥2 from all threats
            const allEnemies = (gs.playerPieces || []).filter(p =>
                !p.removed && p.type !== B_FLAG && !p.immobilized
            );
            const flagMoves = legalMovesFor(myFlag, gs);
            let bestEscape = null, bestMinDist = 0;
            for (const m of flagMoves) {
                const t = gs.board[m.row] && gs.board[m.row][m.col];
                if (t) continue; // Flag only moves to empty cells
                let minEnemyDist = Infinity;
                for (const e of allEnemies) {
                    const d = cheb({ row: m.row, col: m.col }, e);
                    if (d < minEnemyDist) minEnemyDist = d;
                }
                if (minEnemyDist >= 2 && minEnemyDist > bestMinDist) {
                    bestMinDist = minEnemyDist;
                    bestEscape = { piece: myFlag, row: m.row, col: m.col };
                }
            }
            if (bestEscape) return bestEscape;
        }

        return null;
    }

    /** Defensive response to R2 threats when mode is FORTRESS */
    function findDefensiveMove(gs) {
        const myFlag = getMyFlag(gs);
        if (!myFlag) return null;
        const mine = getMyActive(gs);

        const r2Threats = (gs.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 && !p.immobilized
            && p.type !== B_FLAG && cheb(p, myFlag) === 2
        );
        if (r2Threats.length === 0) return null;

        let best = null, bestScore = -Infinity;
        for (const p of mine) {
            if (p.type === B_FLAG) continue;
            const mvs = legalMovesFor(p, gs);
            for (const m of mvs) {
                let score = 0;
                const t = gs.board[m.row] && gs.board[m.row][m.col];

                // Attack a r2 threat (only pieces, trap only if threat is flag)
                if (t && t.owner === B_PLAYER && r2Threats.some(e => e.id === t.id)) {
                    if (p.type === B_TRAP && t.type !== B_FLAG) continue;
                    const ev = evAttack(p, t);
                    if (ev < -V_PIECE_REV * 0.9) continue;
                    score += ev + 900;
                }

                // Move closer to flag
                const dB = cheb(p, myFlag);
                const dA = cheb({ row: m.row, col: m.col }, myFlag);
                if (dA < dB && dA <= 2) score += 420;

                if (score > bestScore && score > 300) {
                    bestScore = score;
                    best = { piece: p, row: m.row, col: m.col };
                }
            }
        }
        return best;
    }

    /**
     * Defender pullback: if < MIN_DEFENDERS mobile pieces are within R2 of
     * flag, pull the closest available piece back to defend.
     */
    function findDefenderPullback(gs) {
        const myFlag = getMyFlag(gs);
        if (!myFlag) return null;
        const mine = getMyActive(gs);

        const defenders = mine.filter(p =>
            p.type !== B_FLAG && !p.immobilized && cheb(p, myFlag) <= 2
        );
        if (defenders.length >= MIN_DEFENDERS) return null;

        const notDefending = mine.filter(p =>
            p.type !== B_FLAG && !p.immobilized && cheb(p, myFlag) > 2
        );
        notDefending.sort((a, b) => cheb(a, myFlag) - cheb(b, myFlag));

        for (const p of notDefending) {
            const mvs = legalMovesFor(p, gs);
            let bestM = null;
            let bestD = cheb(p, myFlag);
            for (const m of mvs) {
                const t = gs.board[m.row] && gs.board[m.row][m.col];
                if (t && t.revealed && t.type === B_TRAP && t.owner !== p.owner) continue;
                if (t && t.revealed && t.type === B_PIECE && p.type === B_PIECE
                        && p.pieceType && resolveRPS(p.pieceType, t.pieceType) === 'lose') continue;
                const d = cheb({ row: m.row, col: m.col }, myFlag);
                if (d < bestD && !isShuttleMove({ piece: p, row: m.row, col: m.col })) {
                    bestD = d;
                    bestM = { piece: p, row: m.row, col: m.col };
                }
            }
            if (bestM) return bestM;
        }
        return null;
    }

    /**
     * Coordinated flag hunt: commit 2-3 pieces toward suspected flag.
     * Safety invariant: never return a move that would leave fewer than
     * MIN_DEFENDERS mobile pieces near our own flag.
     */
    function findFlagHuntMove(gs) {
        const candidates = getFlagCandidates(gs, 2);
        if (candidates.length === 0) return null;
        const top = candidates[0];
        if (top.pFlag < CONF_MID) return null;

        const target  = top.piece;
        const mine    = getMyActive(gs);
        const myFlag  = getMyFlag(gs);

        function moveSafeForFlag(movingPiece, destRow, destCol) {
            if (!myFlag) return true;
            const afterDefenders = mine.filter(p =>
                p.type !== B_FLAG && !p.immobilized
                && p.id !== movingPiece.id
                && cheb(p, myFlag) <= 2
            ).length + (cheb({ row: destRow, col: destCol }, myFlag) <= 2 ? 1 : 0);
            return afterDefenders >= MIN_DEFENDERS;
        }

        // Direct kill if adjacent — always try first
        for (const p of mine) {
            if (p.type === B_FLAG || p.type === B_TRAP) continue;
            if (cheb(p, target) !== 1) continue;
            const mvs = legalMovesFor(p, gs);
            for (const m of mvs) {
                if (m.row === target.row && m.col === target.col) {
                    return { piece: p, row: m.row, col: m.col };
                }
            }
        }

        // High confidence: steer closest hunter
        if (top.pFlag >= CONF_HIGH) {
            const hunters = mine.filter(p => p.type === B_PIECE && !p.immobilized);
            hunters.sort((a, b) => cheb(a, target) - cheb(b, target));
            for (const hunter of hunters.slice(0, 4)) {
                const mvs = legalMovesFor(hunter, gs);
                let bestM = null, bestD = cheb(hunter, target);
                for (const m of mvs) {
                    const t = gs.board[m.row] && gs.board[m.row][m.col];
                    if (t && t.revealed && t.type === B_TRAP && t.owner !== hunter.owner) continue;
                    if (t && t.revealed && t.type === B_PIECE && hunter.pieceType
                            && resolveRPS(hunter.pieceType, t.pieceType) === 'lose') continue;
                    const newD = cheb({ row: m.row, col: m.col }, target);
                    if (newD < bestD && !isShuttleMove({ piece: hunter, row: m.row, col: m.col })
                            && moveSafeForFlag(hunter, m.row, m.col)) {
                        bestD = newD;
                        bestM = { piece: hunter, row: m.row, col: m.col };
                    }
                }
                if (bestM) return bestM;
            }
        }

        // Mid confidence: one-step pressure
        if (top.pFlag >= CONF_MID) {
            const hunters = mine.filter(p => p.type === B_PIECE && !p.immobilized);
            hunters.sort((a, b) => cheb(a, target) - cheb(b, target));
            const hunter = hunters[0];
            if (hunter) {
                const mvs = legalMovesFor(hunter, gs);
                let bestM = null, bestD = cheb(hunter, target);
                for (const m of mvs) {
                    const t = gs.board[m.row] && gs.board[m.row][m.col];
                    if (t && t.revealed && t.type === B_TRAP && t.owner !== hunter.owner) continue;
                    if (t && t.revealed && t.type === B_PIECE && hunter.pieceType
                            && resolveRPS(hunter.pieceType, t.pieceType) === 'lose') continue;
                    const newD = cheb({ row: m.row, col: m.col }, target);
                    if (newD < bestD && !isShuttleMove({ piece: hunter, row: m.row, col: m.col })
                            && moveSafeForFlag(hunter, m.row, m.col)) {
                        bestD = newD;
                        bestM = { piece: hunter, row: m.row, col: m.col };
                    }
                }
                if (bestM) return bestM;
            }
        }

        return null;
    }

    // =========================================================================
    //  ANTI-SHUTTLE ALTERNATIVE ROOT MOVE  (v3: copied from owl pattern)
    // =========================================================================

    /**
     * When the search returns a shuttle move, pick the best non-shuttle
     * alternative using aiEngine.evaluateMoveV2 (or our own hiddenEV fallback).
     */
    function pickAlternativeRootMove(gs, rejected) {
        const allMoves = genMoves(gs, B_COMPUTER);
        // Exclude the rejected (shuttle) move
        const filtered = allMoves.filter(m =>
            !(m.piece.id === rejected.piece.id
                && m.row === rejected.row
                && m.col === rejected.col)
        );
        const pool = filterShuttles(filtered);

        // Also exclude obviously suicidal moves
        const safe = pool.filter(m => !isMoveObviouslySuicidal(m, gs));
        const candidates = safe.length > 0 ? safe : pool;

        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.evaluateMoveV2 === 'function') {
            let best = null, bestScore = -Infinity;
            for (const m of candidates) {
                const sc = aiEngine.evaluateMoveV2(m, gs);
                if (sc > bestScore) { bestScore = sc; best = m; }
            }
            if (best) return best;
        }

        // Fallback: rank by hunt pressure toward flag candidate
        const topCands = getFlagCandidates(gs, 1);
        const topTarget = topCands.length > 0 ? topCands[0].piece : null;
        let best = null, bestScore = -Infinity;
        for (const m of candidates) {
            if (m.piece.type === B_TRAP) continue; // never move trap to attack
            let sc = 0;
            if (topTarget) sc += (6 - Math.min(6, cheb(m, topTarget))) * 30;
            const myFlag = getMyFlag(gs);
            if (myFlag) sc -= cheb(m, myFlag) * 5;
            sc += m.row * 8;
            if (sc > bestScore) { bestScore = sc; best = m; }
        }
        return best;
    }

    // =========================================================================
    //  PLACEMENT
    // =========================================================================

    function chooseFlagAndTrap() {
        const templates = [
            // Corners — still included for unpredictability
            { flagIndex:  0, trapIndex:  9 },  // A1, trap B2
            { flagIndex:  7, trapIndex: 14 },  // H1, trap G2
            { flagIndex:  1, trapIndex:  8 },  // B1, trap A2
            { flagIndex:  6, trapIndex: 15 },  // G1, trap H2

            // Center-adjacent — harder to locate
            { flagIndex:  2, trapIndex: 11 },  // C1, trap D2
            { flagIndex:  5, trapIndex: 12 },  // F1, trap E2
            { flagIndex:  2, trapIndex:  9 },  // C1, trap B2
            { flagIndex:  5, trapIndex: 14 },  // F1, trap G2

            // True center — maximum unpredictability
            { flagIndex:  3, trapIndex: 10 },  // D1, trap C2
            { flagIndex:  4, trapIndex: 13 },  // E1, trap F2
            { flagIndex:  3, trapIndex: 12 },  // D1, trap E2
            { flagIndex:  4, trapIndex: 11 },  // E1, trap D2
            { flagIndex:  3, trapIndex:  8 },  // D1, trap A2
            { flagIndex:  4, trapIndex: 15 },  // E1, trap H2
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }

    // =========================================================================
    //  SMART TIE-BREAK
    // =========================================================================

    function smartTieChoice(currentType, opponentRevealed, opponentType, gs) {
        if (opponentRevealed && opponentType
                && opponentType !== B_FLAG && opponentType !== B_TRAP) {
            return BEATEN_BY[opponentType] || currentType;
        }

        const mine   = getMyActive(gs);
        const counts = { rock: 0, paper: 0, scissors: 0 };
        for (const p of mine) {
            if (p.type === B_PIECE && p.pieceType) counts[p.pieceType]++;
        }
        const minCount = Math.min(counts.rock, counts.paper, counts.scissors);
        for (const [t, cnt] of Object.entries(counts)) {
            if (cnt === minCount && t !== currentType) return t;
        }

        const options = [B_ROCK, B_PAPER, B_SCISSORS].filter(t => t !== currentType);
        return options[Math.floor(Math.random() * options.length)] || B_ROCK;
    }

    // =========================================================================
    //  SAFETY GUARD — verify a search result before returning
    // =========================================================================

    function isMoveObviouslySuicidal(move, gs) {
        if (!move || !move.piece) return true;
        const t = gs.board[move.row] && gs.board[move.row][move.col];
        if (!t || t.owner !== B_PLAYER) return false;
        if (t.revealed && t.type === B_TRAP) return true;
        if (t.revealed && t.type === B_PIECE
                && move.piece.type === B_PIECE && move.piece.pieceType) {
            return resolveRPS(move.piece.pieceType, t.pieceType) === 'lose';
        }
        return false;
    }

    // =========================================================================
    //  MAIN MOVE SELECTOR
    // =========================================================================

    function selectMove(gs) {
        S.turn++;
        S.transposition.clear();

        updateBeliefs(gs);
        updateOpponentModel(gs);
        updateStrategyMode(gs);

        const mine = getMyActive(gs);
        if (mine.length === 0) return null;

        // === LAYER 1: MANDATORY (capture enemy flag or block/flee R1 threat) ===
        const mandatory = findMandatoryMove(gs);
        if (mandatory) {
            recordMove(mandatory);
            return mandatory;
        }

        // === LAYER 2: FORTRESS MODE — critical defense ===
        if (S.mode === 'FORTRESS') {
            const def = findDefensiveMove(gs);
            if (def) {
                recordMove(def);
                return def;
            }
        }

        // === LAYER 3: DEFENDER INVARIANT — keep ≥2 mobile defenders near flag ===
        const myFlag = getMyFlag(gs);
        if (myFlag) {
            const mobileDefenders = mine.filter(p =>
                p.type !== B_FLAG && !p.immobilized && cheb(p, myFlag) <= 2
            );
            if (mobileDefenders.length < MIN_DEFENDERS) {
                const pullback = findDefenderPullback(gs);
                if (pullback) {
                    recordMove(pullback);
                    return pullback;
                }
            }
        }

        // === LAYER 4: HUNT — high-confidence flag pursuit ===
        if (S.mode === 'HUNT' || S.mode === 'PRESSURE') {
            const hunt = findFlagHuntMove(gs);
            if (hunt) {
                recordMove(hunt);
                return hunt;
            }
        }

        // === LAYER 5: ITERATIVE DEEPENING SEARCH ===
        // Flag must not wander during normal play.
        const hasMobileNonFlag = mine.some(p => p.type !== B_FLAG && !p.immobilized);
        try {
            const result = iterativeDeepening(gs);
            if (result && result.move && !isMoveObviouslySuicidal(result.move, gs)) {
                let chosen = result.move;

                // Skip flag moves if we have non-flag pieces
                if (chosen.piece && chosen.piece.type === B_FLAG && hasMobileNonFlag) {
                    chosen = null;
                }

                if (chosen) {
                    // v3: Anti-shuttle check after search — critical fix for infinite loops
                    const isShuttle = isShuttleMove(chosen);
                    const recentForPiece = (typeof aiEngine !== 'undefined' && aiEngine
                        && typeof aiEngine.countRecentMovesOfPiece === 'function')
                        ? aiEngine.countRecentMovesOfPiece(chosen.piece.id, 4)
                        : S.recentMoves.filter(m => m.pieceId === chosen.piece.id).length;

                    if (isShuttle && recentForPiece >= 2) {
                        const alt = pickAlternativeRootMove(gs, chosen);
                        if (alt) chosen = alt;
                    }
                }

                if (chosen) {
                    recordMove(chosen);
                    return chosen;
                }
            }
        } catch (e) {
            console.error('[kapibarysh] search error:', e);
        }

        // === LAYER 6: FALLBACK via shared engine ===
        if (typeof aiEngine !== 'undefined' && aiEngine
                && typeof aiEngine.evaluateMoveV2 === 'function') {
            try {
                const fallbackMoves = genMoves(gs, B_COMPUTER);
                const nonShuttle = filterShuttles(fallbackMoves);
                let best = null, bestScore = -Infinity;
                for (const m of nonShuttle) {
                    if (isMoveObviouslySuicidal(m, gs)) continue;
                    if (m.piece && m.piece.type === B_FLAG && hasMobileNonFlag) continue;
                    const sc = aiEngine.evaluateMoveV2(m, gs);
                    if (sc > bestScore) { bestScore = sc; best = m; }
                }
                if (best) { recordMove(best); return best; }
            } catch (e) {}
        }

        // === LAYER 7: LAST RESORT ===
        const safeOnes = filterShuttles(
            genMoves(gs, B_COMPUTER).filter(m => !isMoveObviouslySuicidal(m, gs))
        );
        if (safeOnes.length > 0) {
            const m = safeOnes[Math.floor(Math.random() * Math.min(4, safeOnes.length))];
            recordMove(m);
            return m;
        }

        return null;
    }

    // =========================================================================
    //  PUBLIC INTERFACE
    // =========================================================================

    return {
        id:   'sonnet_4_6_medium',
        name: 'Капибарыш',
        emoji: '🔷',
        avatar: 'js/bots/kapibarysh/avatar-min.png',

        shortDescription: 'ПВС-поиск, байесовская модель и защита от шаттла',
        longDescription: 'ПВС и байес, антишаттл. Сначала тактика; капкан бьёт только флаг.',

        algorithmLabel: 'ПВС + байес + тактическая цепочка',
        tier: 'easy',
        stars: 1,
        difficultyLabel: 'Лёгкий',
        tags: ['anthropic', 'claude', 'pvs', 'bayesian', 'phantom-zone', 'championship'],

        move(gameState) {
            try {
                return selectMove(gameState);
            } catch (e) {
                console.error('[kapibarysh] move() error:', e);
                return null;
            }
        },

        chooseFlagAndTrap() {
            return chooseFlagAndTrap();
        },

        getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
            return smartTieChoice(currentType, opponentRevealed, opponentType, gameState);
        }
    };
})();

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(kapibaryshBot);
} else {
    throw new Error('[kapibarysh] RPSBotAPI.defineBot is required (load bot-api.js first)');
}
