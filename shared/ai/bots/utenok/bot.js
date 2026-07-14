/**
 * Утёнок (Utenok) — original championship-grade bot.
 *
 * Design philosophy (written from scratch, no other bot's code was read or
 * copied, and it uses ONLY the sanctioned RPSBotAPI fog-of-war data — it never
 * peeks at hidden identities or engine internals):
 *
 *   1. Bayesian beliefs. Every hidden enemy piece keeps a probability
 *      distribution over {rock, paper, scissors}. It is refined by reveals and,
 *      crucially, by MOTIVE INFERENCE: a hidden piece fleeing my open rock is
 *      probably scissors (rock eats scissors); a hidden piece charging my open
 *      rock is probably paper (paper eats rock).
 *   2. Forward search. A minimax with alpha-beta looks several plies ahead using
 *      an opponent model built from those beliefs, so threats to my flag and
 *      winning exchanges are found before they happen.
 *   3. Fortress defence. The flag hides in a back corner behind a bodyguard
 *      trap and a ring of guards; the flag never attacks (instant loss) and
 *      flees the instant a search line exposes it.
 *   4. Organised offence. The evaluation rewards mutually-supporting pieces,
 *      diverse RPS "fists", and pressure on the cell most likely to hide the
 *      enemy flag (inferred from stillness and geometry).
 *   5. Deception. Placement varies, strong pieces stay concealed, and tie-break
 *      throws mix a counter to the opponent's habits with unexploitable noise.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[utenok] bot-api.js must be loaded BEFORE this bot');
}

const utenokBot = (function () {
    'use strict';

    const API = (typeof window !== 'undefined' && window.RPSBotAPI)
        || (typeof globalThis !== 'undefined' && globalThis.RPSBotAPI)
        || null;

    // --- Rules mirrored locally (values only, no foreign logic) ---
    const WIDTH = 8;
    const HEIGHT = 6;
    const TYPES = ['rock', 'paper', 'scissors'];
    // What each type beats.
    const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const DIRS = [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1], [0, 1],
        [1, -1], [1, 0], [1, 1]
    ];

    // Search / evaluation tuning.
    const WIN_SCORE = 10000000;
    const SEARCH_DEPTH = 3;      // plies below my root move (opp, me, opp)
    const MY_BRANCH = 8;         // move-ordering cap for my nodes inside search
    const OPP_BRANCH = 10;       // move-ordering cap for opponent nodes
    const TIME_BUDGET_LIVE = 700;
    const TIME_BUDGET_DEV = 140;

    // ------------------------------------------------------------------
    //  PERSISTENT MEMORY (per side, isolated so a mirror match is safe)
    // ------------------------------------------------------------------
    const MEM = { ai: null, player: null };

    function freshSide() {
        return {
            lastMyCount: 0,
            mwc: 0,
            adv: 0,
            mode: 'normal',          // 'normal' | 'avoidDraw' | 'seekDraw'
            beliefs: new Map(),      // enemyId -> {rock,paper,scissors}
            special: new Map(),      // enemyId -> {still, movedEver, lastRow, lastCol}
            prevEnemy: new Map(),    // enemyId -> {row,col,revealed,type}
            flagProb: new Map(),     // enemyId -> probability of being the flag
            enemyThrows: { rock: 0, paper: 0, scissors: 0 },
            suspFlagId: null,
            suspFlagP: 0
        };
    }

    function sideKeyOf(view) {
        const mine = view.aiPieces && view.aiPieces[0];
        if (mine && typeof mine.id === 'string' && mine.id.indexOf('player') === 0) {
            return 'player';
        }
        return 'ai';
    }

    function getMem(view) {
        const key = sideKeyOf(view);
        if (!MEM[key]) {
            MEM[key] = freshSide();
        }
        return MEM[key];
    }

    // ------------------------------------------------------------------
    //  BELIEF HELPERS
    // ------------------------------------------------------------------
    function beatenByOf(t) {
        // The type that beats t.
        if (t === 'rock') {
            return 'paper';
        }
        if (t === 'paper') {
            return 'scissors';
        }
        return 'rock';
    }

    function uniformBelief() {
        return { rock: 1 / 3, paper: 1 / 3, scissors: 1 / 3 };
    }

    function certainBelief(t) {
        return {
            rock: t === 'rock' ? 1 : 0,
            paper: t === 'paper' ? 1 : 0,
            scissors: t === 'scissors' ? 1 : 0
        };
    }

    function normalize(b) {
        const s = b.rock + b.paper + b.scissors;
        if (s <= 0) {
            return uniformBelief();
        }
        return { rock: b.rock / s, paper: b.paper / s, scissors: b.scissors / s };
    }

    function nudge(b, type, factor) {
        const nb = { rock: b.rock, paper: b.paper, scissors: b.scissors };
        nb[type] *= factor;
        return normalize(nb);
    }

    function argmaxBelief(b) {
        let best = 'rock';
        let bv = b.rock;
        if (b.paper > bv) {
            best = 'paper';
            bv = b.paper;
        }
        if (b.scissors > bv) {
            best = 'scissors';
        }
        return best;
    }

    function cheb(ar, ac, br, bc) {
        return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
    }

    function resolveRPS(a, b) {
        if (a === b) {
            return 'draw';
        }
        return BEATS[a] === b ? 'win' : 'lose';
    }

    // ------------------------------------------------------------------
    //  PERCEPTION: update beliefs and suspicions from the fresh view
    // ------------------------------------------------------------------
    function updatePerception(view, mem) {
        const opp = (view.playerPieces || []).filter(p => !p.removed && p.row >= 0);
        const mine = (view.aiPieces || []).filter(p => !p.removed && p.row >= 0);
        const myRevealed = mine.filter(
            p => p.revealed && p.type === 'piece' && p.pieceType
        );

        // 1) Reveals set certainty; new hidden pieces start uniform.
        for (const e of opp) {
            if (e.revealed && e.type === 'piece' && e.pieceType) {
                mem.beliefs.set(e.id, certainBelief(e.pieceType));
            } else if (!mem.beliefs.has(e.id)) {
                mem.beliefs.set(e.id, uniformBelief());
            }
        }

        // 2) Motive inference from movement relative to my open pieces.
        for (const e of opp) {
            if (e.revealed || e.type !== 'piece') {
                continue;
            }
            const prev = mem.prevEnemy.get(e.id);
            if (!prev) {
                continue;
            }
            const moved = prev.row !== e.row
                || prev.col !== e.col;
            if (!moved) {
                continue;
            }
            for (const r of myRevealed) {
                const before = cheb(prev.row, prev.col, r.row, r.col);
                const after = cheb(e.row, e.col, r.row, r.col);
                if (before > 3 && after > 3) {
                    continue;
                }
                let b = mem.beliefs.get(e.id) || uniformBelief();
                if (after > before) {
                    // Fled from r -> probably the type r beats.
                    b = nudge(b, BEATS[r.pieceType], 1.7);
                } else if (after < before) {
                    // Charged r -> probably the type that beats r.
                    b = nudge(b, beatenByOf(r.pieceType), 1.6);
                }
                mem.beliefs.set(e.id, b);
            }
        }

        // 3) Count freshly revealed enemy throws (used by tie-break).
        for (const e of opp) {
            const prev = mem.prevEnemy.get(e.id);
            const nowType = e.revealed && e.type === 'piece' ? e.pieceType : null;
            const wasType = prev ? prev.type : null;
            if (nowType && !wasType) {
                mem.enemyThrows[nowType] = (mem.enemyThrows[nowType] || 0) + 1;
            }
        }

        // 4) Probabilistic model of where the enemy flag hides.
        updateFlagProbabilities(mem, opp);

        // 5) Snapshot positions for next turn's motive diff.
        mem.prevEnemy = new Map();
        for (const e of opp) {
            mem.prevEnemy.set(e.id, {
                row: e.row,
                col: e.col,
                revealed: !!e.revealed,
                type: e.revealed && e.type === 'piece' ? e.pieceType : null
            });
        }
    }

    // Estimate a probability distribution over "which hidden enemy piece is the
    // flag". The enemy flag is inferred from behaviour and geometry, never from
    // forbidden data:
    //   - it lives on the enemy's back ranks (rows 5 then 4), often in a corner;
    //   - it tends never to move (a moving piece is a weak flag candidate);
    //   - it is usually shielded by a cluster of guards;
    //   - a revealed piece or a spent trap cannot be the flag.
    function updateFlagProbabilities(mem, opp) {
        for (const e of opp) {
            let sp = mem.special.get(e.id);
            if (!sp) {
                sp = { still: 0, movedEver: false, lastRow: e.row, lastCol: e.col };
                mem.special.set(e.id, sp);
            }
            if (sp.lastRow !== e.row || sp.lastCol !== e.col) {
                sp.movedEver = true;
                sp.still = 0;
            } else {
                sp.still += 1;
            }
            sp.lastRow = e.row;
            sp.lastCol = e.col;
        }

        const raw = new Map();
        let total = 0;
        for (const e of opp) {
            if (e.revealed || e.immobilized) {
                continue;
            }
            const sp = mem.special.get(e.id);
            let s = 0.5;
            if (e.row === 5) {
                s += 4;
            } else if (e.row === 4) {
                s += 2.5;
            } else if (e.row === 3) {
                s += 0.6;
            }
            if (e.col === 0 || e.col === 7) {
                s += 1.6;
            } else if (e.col === 1 || e.col === 6) {
                s += 0.5;
            }
            if (sp) {
                if (!sp.movedEver) {
                    s += 3;
                } else {
                    s *= 0.25;
                }
                s += Math.min(sp.still, 12) * 0.35;
            }
            let neigh = 0;
            for (const o of opp) {
                if (o !== e && !o.removed && cheb(o.row, o.col, e.row, e.col) === 1) {
                    neigh += 1;
                }
            }
            s += neigh * 0.5;
            if (s < 0.01) {
                s = 0.01;
            }
            raw.set(e.id, s);
            total += s;
        }

        mem.flagProb = new Map();
        let bestId = null;
        let bestP = -1;
        if (total > 0) {
            for (const entry of raw) {
                const p = entry[1] / total;
                mem.flagProb.set(entry[0], p);
                if (p > bestP) {
                    bestP = p;
                    bestId = entry[0];
                }
            }
        }
        mem.suspFlagId = bestId;
        mem.suspFlagP = bestP > 0 ? bestP : 0;
    }

    // The no-capture draw fires after DRAW_LIMIT combined half-moves without a
    // capture. Knowing whether I am ahead tells me whether to force a capture
    // (avoid a draw I would otherwise win) or to stall for the draw (save a lost
    // game). Advantage is judged by combat-piece material plus flag exposure.
    const DRAW_LIMIT = 20;

    function updateDrawPolicy(view, mem) {
        let myP = 0;
        let oppP = 0;
        for (const p of view.aiPieces) {
            if (p.removed || p.row < 0) {
                continue;
            }
            if (p.type === 'piece') {
                myP += 1;
            }
        }
        for (const p of view.playerPieces) {
            if (p.removed || p.row < 0) {
                continue;
            }
            // Every non-flag, non-spent enemy body counts as fighting material.
            if (!(p.revealed && p.type === 'flag')
                && !(p.immobilized)) {
                oppP += 1;
            }
        }
        const adv = myP - oppP;
        mem.adv = adv;

        const mwc = mem.mwc || 0;
        if (adv <= -2 && mwc >= 11) {
            mem.mode = 'seekDraw';
        } else if (adv >= 1 && mwc >= 9) {
            mem.mode = 'avoidDraw';
        } else {
            mem.mode = 'normal';
        }
    }

    // ------------------------------------------------------------------
    //  SIMULATION STATE (lightweight, from the fog-of-war view + beliefs)
    // ------------------------------------------------------------------
    function buildState(view, mem) {
        const me = [];
        for (const p of view.aiPieces) {
            if (p.removed || p.row < 0) {
                continue;
            }
            const kind = p.type === 'flag'
                ? 'flag'
                : (p.type === 'trap' ? 'trap' : 'piece');
            me.push({
                id: p.id,
                side: 'me',
                kind,
                type: kind === 'piece' ? p.pieceType : null,
                hidden: false,
                belief: null,
                row: p.row,
                col: p.col,
                alive: true,
                immob: !!p.immobilized,
                revealed: !!p.revealed
            });
        }

        const opp = [];
        for (const p of view.playerPieces) {
            if (p.removed || p.row < 0) {
                continue;
            }
            let kind;
            let type = null;
            let hidden = false;
            let belief = null;
            if (p.revealed) {
                kind = p.type === 'flag'
                    ? 'flag'
                    : (p.type === 'trap' ? 'trap' : 'piece');
                if (kind === 'piece') {
                    type = p.pieceType;
                }
            } else if (p.immobilized) {
                // A hidden, immobile piece can only be a spent trap.
                kind = 'trap';
            } else {
                kind = 'piece';
                belief = mem.beliefs.get(p.id) || uniformBelief();
                type = argmaxBelief(belief);
                hidden = true;
            }
            opp.push({
                id: p.id,
                side: 'opp',
                kind,
                type,
                hidden,
                belief,
                row: p.row,
                col: p.col,
                alive: true,
                immob: !!p.immobilized,
                revealed: !!p.revealed
            });
        }

        const occ = new Array(WIDTH * HEIGHT).fill(null);
        for (const p of me) {
            occ[p.row * WIDTH + p.col] = p;
        }
        for (const p of opp) {
            occ[p.row * WIDTH + p.col] = p;
        }
        return { me, opp, occ, result: 0 };
    }

    function cloneState(s) {
        const me = new Array(s.me.length);
        for (let i = 0; i < s.me.length; i++) {
            me[i] = { ...s.me[i] };
        }
        const opp = new Array(s.opp.length);
        for (let i = 0; i < s.opp.length; i++) {
            opp[i] = { ...s.opp[i] };
        }
        const occ = new Array(WIDTH * HEIGHT).fill(null);
        for (const p of me) {
            if (p.alive) {
                occ[p.row * WIDTH + p.col] = p;
            }
        }
        for (const p of opp) {
            if (p.alive) {
                occ[p.row * WIDTH + p.col] = p;
            }
        }
        return { me, opp, occ, result: s.result };
    }

    function pointMass(t) {
        return {
            rock: t === 'rock' ? 1 : 0,
            paper: t === 'paper' ? 1 : 0,
            scissors: t === 'scissors' ? 1 : 0
        };
    }

    // Expected win / lose probability for `attacker` striking `defender`,
    // marginalised over whichever side's identity is still uncertain.
    function attackProbs(attacker, defender) {
        const aD = attacker.hidden ? attacker.belief : pointMass(attacker.type);
        const dD = defender.hidden ? defender.belief : pointMass(defender.type);
        let pW = 0;
        let pL = 0;
        for (const a of TYPES) {
            const pa = aD[a];
            if (!pa) {
                continue;
            }
            for (const d of TYPES) {
                const pd = dD[d];
                if (!pd) {
                    continue;
                }
                const r = resolveRPS(a, d);
                if (r === 'win') {
                    pW += pa * pd;
                } else if (r === 'lose') {
                    pL += pa * pd;
                }
            }
        }
        return { pW, pL };
    }

    function pieceById(state, side, id) {
        const arr = state[side];
        for (const p of arr) {
            if (p.alive && p.id === id) {
                return p;
            }
        }
        return null;
    }

    // True if I have another (non-flag) piece adjacent to the target cell that
    // could recapture there after a lost exchange.
    function hasAllySupport(state, r, c, attackerId) {
        for (const p of state.me) {
            if (!p.alive || p.immob || p.kind === 'flag') {
                continue;
            }
            if (p.id === attackerId) {
                continue;
            }
            if (cheb(p.row, p.col, r, c) <= 1) {
                return true;
            }
        }
        return false;
    }

    function genMoves(state, side) {
        const moves = [];
        const arr = state[side];
        for (const p of arr) {
            if (!p.alive || p.immob) {
                continue;
            }
            if (p.kind === 'flag') {
                // Opponent is modelled as guarding its flag; my flag only flees.
                if (side === 'opp' || p.revealed) {
                    continue;
                }
            }
            for (const d of DIRS) {
                const nr = p.row + d[0];
                const nc = p.col + d[1];
                if (nr < 0 || nr >= HEIGHT || nc < 0 || nc >= WIDTH) {
                    continue;
                }
                const t = state.occ[nr * WIDTH + nc];
                if (p.kind === 'flag') {
                    if (t !== null) {
                        continue;
                    }
                    moves.push({ id: p.id, side, toR: nr, toC: nc, cap: false });
                    continue;
                }
                if (t === null) {
                    moves.push({ id: p.id, side, toR: nr, toC: nc, cap: false });
                } else if (t.side !== side) {
                    moves.push({ id: p.id, side, toR: nr, toC: nc, cap: true });
                }
            }
        }
        return moves;
    }

    function applyMove(state, mv) {
        const attacker = pieceById(state, mv.side, mv.id);
        if (!attacker) {
            return;
        }
        const fromIdx = attacker.row * WIDTH + attacker.col;
        const toIdx = mv.toR * WIDTH + mv.toC;
        const target = state.occ[toIdx];
        state.occ[fromIdx] = null;

        if (target === null) {
            attacker.row = mv.toR;
            attacker.col = mv.toC;
            state.occ[toIdx] = attacker;
            return;
        }

        if (target.kind === 'flag') {
            state.result = attacker.side === 'me' ? 1 : -1;
            target.alive = false;
            attacker.row = mv.toR;
            attacker.col = mv.toC;
            state.occ[toIdx] = attacker;
            return;
        }

        if (target.kind === 'trap') {
            attacker.alive = false;
            target.immob = true;
            state.occ[toIdx] = target;
            return;
        }

        if (attacker.kind === 'trap') {
            target.alive = false;
            attacker.row = mv.toR;
            attacker.col = mv.toC;
            attacker.immob = true;
            state.occ[toIdx] = attacker;
            return;
        }

        // Expected-value combat: only commit to a capture (or accept a loss)
        // when the belief clearly favours it; otherwise it is a coin flip and we
        // model it as a stand-off so the search does not chase 33% gambles.
        const pr = attackProbs(attacker, target);
        const edge = pr.pW - pr.pL;
        if (edge >= 0.20) {
            target.alive = false;
            attacker.row = mv.toR;
            attacker.col = mv.toC;
            state.occ[toIdx] = attacker;
        } else if (edge <= -0.20) {
            attacker.alive = false;
            state.occ[toIdx] = target;
        } else {
            // Uncertain exchange: keep both pieces in place (no material swing).
            state.occ[fromIdx] = attacker;
            state.occ[toIdx] = target;
        }
    }

    // ------------------------------------------------------------------
    //  EVALUATION (from my perspective; higher is better for me)
    // ------------------------------------------------------------------
    function findFlag(state, side) {
        for (const p of state[side]) {
            if (p.alive && p.kind === 'flag') {
                return p;
            }
        }
        return null;
    }

    function evaluate(state, mem) {
        const mine = [];
        const opp = [];
        let myFlag = null;
        for (const p of state.me) {
            if (!p.alive) {
                continue;
            }
            mine.push(p);
            if (p.kind === 'flag') {
                myFlag = p;
            }
        }
        for (const p of state.opp) {
            if (p.alive) {
                opp.push(p);
            }
        }

        if (!myFlag) {
            return -WIN_SCORE;
        }

        let score = 0;

        // Material.
        for (const p of mine) {
            if (p.kind === 'piece') {
                score += 100;
            } else if (p.kind === 'trap' && !p.immob) {
                score += 45;
            }
        }
        for (const p of opp) {
            if (p.kind === 'piece') {
                score -= 100;
            } else if (p.kind === 'trap' && !p.immob) {
                score -= 30;
            }
        }

        score += flagSafety(state, myFlag, mine, opp);
        score += offense(mine, opp, mem);
        score += tactics(mine, opp, mem);
        return score;
    }

    function flagSafety(state, flag, mine, opp) {
        let sc = 0;

        let nearestEnemy = 99;
        for (const e of opp) {
            if (e.kind === 'flag' || e.immob) {
                continue;
            }
            const d = cheb(e.row, e.col, flag.row, flag.col);
            if (d < nearestEnemy) {
                nearestEnemy = d;
            }
            if (d <= 1) {
                sc -= 9000;
            } else if (d === 2) {
                sc -= 800;
            } else if (d === 3) {
                sc -= 180;
            } else if (d === 4) {
                sc -= 50;
            }
        }

        // Wall: the flag's own neighbour cells. In a corner there are only three
        // of them, so filling them with my pieces makes the flag physically
        // unreachable — the enemy must first defeat a wall guard.
        let wall = 0;
        let openNear = 0;
        let ringDefenders = 0;
        for (const d of DIRS) {
            const nr = flag.row + d[0];
            const nc = flag.col + d[1];
            if (nr < 0 || nr >= HEIGHT || nc < 0 || nc >= WIDTH) {
                continue;
            }
            const cell = state.occ[nr * WIDTH + nc];
            if (cell && cell.side === 'me' && cell.kind !== 'flag') {
                wall += 1;
            } else if (cell === null) {
                openNear += 1;
            }
        }
        for (const p of mine) {
            if (p.kind === 'flag' || p.immob) {
                continue;
            }
            if (cheb(p.row, p.col, flag.row, flag.col) === 2) {
                ringDefenders += 1;
            }
        }
        // How many flag-neighbour cells exist at all (three in a corner).
        let maxWall = 0;
        for (const d of DIRS) {
            const nr = flag.row + d[0];
            const nc = flag.col + d[1];
            if (nr >= 0 && nr < HEIGHT && nc >= 0 && nc < WIDTH) {
                maxWall += 1;
            }
        }

        sc += wall * 190;
        sc += Math.min(ringDefenders, 3) * 60;
        if (nearestEnemy <= 5) {
            let openPenalty = 55;
            if (nearestEnemy <= 2) {
                openPenalty = 180;
            } else if (nearestEnemy <= 4) {
                openPenalty = 90;
            }
            sc -= openNear * openPenalty;
        }

        // A diverse rock/paper/scissors wall can punish whatever tries the flag:
        // whichever type E beats a guard of type G, the two remaining wall types
        // always include BEATS[G], which beats E — so a full RPS trio guarantees a
        // recapture. Keeping that complete trio is the top defensive priority.
        const coreTypes = fistScore(flag, mine);
        if (wall >= maxWall && coreTypes >= 3) {
            sc += 320;
        } else if (coreTypes >= 3) {
            sc += 170;
        } else if (coreTypes === 2) {
            sc += 70;
        }

        // Recapture readiness: a revealed enemy that has pushed up to the flag
        // must be answerable. Reward keeping a piece of the countering type right
        // next to it (guaranteed recapture), punish having no answer.
        for (const e of opp) {
            if (e.kind !== 'piece' || !e.revealed || !e.type || e.immob) {
                continue;
            }
            const df = cheb(e.row, e.col, flag.row, flag.col);
            if (df > 2) {
                continue;
            }
            const counter = beatenByOf(e.type);
            let haveAnswer = false;
            for (const p of mine) {
                if (p.kind !== 'piece' || p.type !== counter) {
                    continue;
                }
                if (cheb(p.row, p.col, e.row, e.col) === 1) {
                    haveAnswer = true;
                    break;
                }
            }
            const weight = df <= 1 ? 600 : 180;
            sc += haveAnswer ? weight : -weight;
        }

        if (flag.row === 0) {
            sc += 300;
        }
        if (flag.col === 0 || flag.col === 7) {
            sc += 220;
        }
        if (flag.revealed) {
            sc -= 900;
        } else {
            sc += 150;
        }
        return sc;
    }

    function offense(mine, opp, mem) {
        let sc = 0;
        const mode = mem ? mem.mode : 'normal';
        // When stalling for a saving draw, offence is switched off entirely.
        if (mode === 'seekDraw') {
            return 0;
        }

        let myFlag = null;
        for (const p of mine) {
            if (p.kind === 'flag') {
                myFlag = p;
                break;
            }
        }

        let target = null;
        let targetP = 0;
        if (mem && mem.suspFlagId) {
            for (const e of opp) {
                if (e.id === mem.suspFlagId) {
                    target = e;
                    targetP = mem.suspFlagP || 0;
                    break;
                }
            }
        }
        // Forward drive; stronger when pressing to avoid a draw we can win.
        let advW = 2;
        if (mode === 'avoidDraw') {
            advW = 7;
        } else if (mem && mem.mwc >= 12) {
            advW = 5;
        }

        for (const p of mine) {
            if (p.kind !== 'piece') {
                continue;
            }
            // Never reward pulling the flag's close guards forward: defence is the
            // priority, so only free-roaming attackers earn the advance bonus.
            const isGuard = myFlag
                && cheb(p.row, p.col, myFlag.row, myFlag.col) <= 2;
            if (!isGuard) {
                sc += p.row * advW;
                if (target) {
                    // Pull the assault toward the most probable enemy-flag cell,
                    // weighted by how confident that guess is.
                    const d = cheb(p.row, p.col, target.row, target.col);
                    sc += Math.max(0, 6 - d) * (8 + targetP * 40);
                }
            }
        }
        return sc;
    }

    // Count how many distinct RPS types sit within a small cluster around a
    // piece. A rock+paper+scissors trio ("fist") can answer any single defender,
    // so keeping the three together is rewarded both for attack and defence.
    function fistScore(anchor, mine) {
        const seen = { rock: false, paper: false, scissors: false };
        if (anchor.kind === 'piece' && anchor.type) {
            seen[anchor.type] = true;
        }
        for (const q of mine) {
            if (q === anchor || q.kind !== 'piece' || !q.type) {
                continue;
            }
            if (cheb(q.row, q.col, anchor.row, anchor.col) <= 1) {
                seen[q.type] = true;
            }
        }
        let distinct = 0;
        for (const t of TYPES) {
            if (seen[t]) {
                distinct += 1;
            }
        }
        return distinct;
    }

    function tactics(mine, opp, mem) {
        let sc = 0;
        const mode = mem ? mem.mode : 'normal';
        let engageBoost = 1;
        if (mode === 'avoidDraw') {
            engageBoost = 1.7;
        } else if (mode === 'seekDraw') {
            engageBoost = 0.15;
        }

        for (const p of mine) {
            if (p.kind === 'flag') {
                continue;
            }

            // Fist synergy: reward a diverse rock/paper/scissors cluster so a
            // lost fight can be answered by a neighbour of the countering type.
            const distinct = fistScore(p, mine);
            if (distinct >= 3) {
                sc += 26;
            } else if (distinct === 2) {
                sc += 10;
            }

            if (p.kind !== 'piece') {
                continue;
            }
            if (!p.revealed) {
                sc += 4;
            }

            for (const e of opp) {
                if (e.kind === 'flag' || e.immob) {
                    continue;
                }
                if (cheb(p.row, p.col, e.row, e.col) !== 1) {
                    continue;
                }
                // Risk: this enemy could strike my piece next.
                const risk = attackProbs(e, p);
                sc -= (risk.pW - risk.pL) * 55;
                // Opportunity: I could strike this enemy on a favourable edge.
                if (e.kind === 'piece') {
                    const opp2 = attackProbs(p, e);
                    sc += (opp2.pW - opp2.pL) * 42 * engageBoost;
                }
            }
        }
        return sc;
    }

    // ------------------------------------------------------------------
    //  SEARCH (minimax + alpha-beta over the assumed-type model)
    // ------------------------------------------------------------------
    function orderMoves(state, moves, side) {
        const myFlag = findFlag(state, 'me');
        const scored = moves.map(mv => {
            let s = 0;
            if (mv.cap) {
                s += 1000;
            }
            if (side === 'me') {
                s += mv.toR * 3;
            } else if (myFlag) {
                const d = cheb(mv.toR, mv.toC, myFlag.row, myFlag.col);
                s += (7 - d) * 5;
            }
            return { mv, s };
        });
        scored.sort((a, b) => b.s - a.s);
        return scored.map(x => x.mv);
    }

    function minimax(state, depth, maximizing, mem, alpha, beta) {
        if (state.result !== 0) {
            return state.result * (WIN_SCORE - (10 - depth));
        }
        if (depth === 0) {
            return evaluate(state, mem);
        }

        const side = maximizing ? 'me' : 'opp';
        const moves = genMoves(state, side);
        if (moves.length === 0) {
            // No legal move for the side to act -> that side is lost.
            return maximizing ? -WIN_SCORE : WIN_SCORE;
        }
        const ordered = orderMoves(state, moves, side);
        const cap = Math.min(ordered.length, maximizing ? MY_BRANCH : OPP_BRANCH);

        if (maximizing) {
            let best = -Infinity;
            for (let i = 0; i < cap; i++) {
                const c = cloneState(state);
                applyMove(c, ordered[i]);
                const v = minimax(c, depth - 1, false, mem, alpha, beta);
                if (v > best) {
                    best = v;
                }
                if (best > alpha) {
                    alpha = best;
                }
                if (alpha >= beta) {
                    break;
                }
            }
            return best;
        }

        let best = Infinity;
        for (let i = 0; i < cap; i++) {
            const c = cloneState(state);
            applyMove(c, ordered[i]);
            const v = minimax(c, depth - 1, true, mem, alpha, beta);
            if (v < best) {
                best = v;
            }
            if (best < beta) {
                beta = best;
            }
            if (alpha >= beta) {
                break;
            }
        }
        return best;
    }

    function chooseBest(view, mem) {
        const state = buildState(view, mem);
        const moves = genMoves(state, 'me');
        if (moves.length === 0) {
            return null;
        }

        // Hard rule: capturing a revealed enemy flag wins instantly.
        for (const mv of moves) {
            if (!mv.cap) {
                continue;
            }
            const t = state.occ[mv.toR * WIDTH + mv.toC];
            if (t && t.kind === 'flag') {
                return mv;
            }
        }

        const ordered = orderMoves(state, moves, 'me');
        const budget = view.devMode ? TIME_BUDGET_DEV : TIME_BUDGET_LIVE;
        const start = Date.now();
        let best = null;
        let bestVal = -Infinity;
        let alpha = -Infinity;

        const mwc = mem ? mem.mwc : 0;
        const mode = mem ? mem.mode : 'normal';
        let myCount = 0;
        let oppCount = 0;
        for (const p of state.me) {
            if (p.alive && p.kind === 'piece') {
                myCount += 1;
            }
        }
        for (const p of state.opp) {
            if (p.alive && p.kind === 'piece') {
                oppCount += 1;
            }
        }
        const haveLead = myCount >= oppCount;

        // Is my own flag under pressure? If so, no piece may leave for a gamble.
        const myFlagNow = findFlag(state, 'me');
        let ownFlagSafe = true;
        if (myFlagNow) {
            for (const e of state.opp) {
                if (!e.alive || e.kind === 'flag' || e.immob) {
                    continue;
                }
                if (cheb(e.row, e.col, myFlagNow.row, myFlagNow.col) <= 3) {
                    ownFlagSafe = false;
                    break;
                }
            }
        }
        const adv = mem ? mem.adv : 0;

        for (const mv of ordered) {
            const c = cloneState(state);
            applyMove(c, mv);
            let v;
            if (c.result !== 0) {
                v = c.result * (WIN_SCORE - 1);
            } else {
                v = minimax(c, SEARCH_DEPTH, false, mem, alpha, Infinity);
            }

            // Tempo / reconnaissance: EV-neutral exchanges are invisible to the
            // material search, yet initiating an even-or-better fight breaks
            // fortress stalemates and forces reveals that sharpen beliefs. Reward
            // it mildly, and much more as the no-capture draw clock ticks down.
            // While stalling for a saving draw we do the opposite and shun fights.
            if (mv.cap && mode !== 'seekDraw') {
                const t = state.occ[mv.toR * WIDTH + mv.toC];
                const atk = pieceById(state, 'me', mv.id);
                if (t && t.side === 'opp' && t.kind === 'piece' && atk) {
                    const pr = attackProbs(atk, t);
                    const edge = pr.pW - pr.pL;
                    // Only initiate a coin-flip fight when it is backed: a nearby
                    // ally can recapture, I already hold a material lead, or the
                    // draw clock forces action. Lone probes into a fortress bleed
                    // material, so they get no encouragement.
                    const supported = hasAllySupport(state, mv.toR, mv.toC, mv.id);
                    const pressing = mode === 'avoidDraw';
                    const backed = supported
                        || haveLead
                        || pressing
                        || mwc >= 12;
                    if (edge >= -0.03 && backed) {
                        v += 5
                            + edge * 90
                            + (supported ? 10 : 0)
                            + (pressing ? 26 : 0)
                            + (mwc >= 8 ? 12 : 0)
                            + (mwc >= 15 ? 24 : 0);
                    }
                    // Calculated flag hunt: striking the most probable enemy-flag
                    // cell risks a trap, so only with a real lead, local support
                    // and my own flag safe. The upside is an instant win.
                    const fp = mem && mem.flagProb ? (mem.flagProb.get(t.id) || 0) : 0;
                    if (fp >= 0.30 && supported && adv >= 2 && ownFlagSafe) {
                        v += fp * 220;
                    }
                }
            }

            v += (Math.random() * 2 - 1) * 0.5;
            if (v > bestVal) {
                bestVal = v;
                best = mv;
            }
            if (bestVal > alpha) {
                alpha = bestVal;
            }
            if (Date.now() - start > budget) {
                break;
            }
        }
        return best || ordered[0];
    }

    // ------------------------------------------------------------------
    //  SAFE FALLBACK (guarantees a legal move; never a flag suicide)
    // ------------------------------------------------------------------
    function anyLegalMove(view) {
        const mine = (view.aiPieces || []).filter(
            p => !p.removed && p.row >= 0 && !p.immobilized
        );
        for (const p of mine) {
            if (p.type === 'flag') {
                continue;
            }
            const ms = API ? API.getLegalMoves(p, view) : [];
            if (ms.length > 0) {
                return { piece: p, row: ms[0].row, col: ms[0].col };
            }
        }
        for (const p of mine) {
            if (p.type !== 'flag' || p.revealed) {
                continue;
            }
            const ms = (API ? API.getLegalMoves(p, view) : [])
                .filter(m => !view.board[m.row][m.col]);
            if (ms.length > 0) {
                return { piece: p, row: ms[0].row, col: ms[0].col };
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    //  PUBLIC BOT OBJECT
    // ------------------------------------------------------------------
    return {
        id: 'utenok',
        name: 'Утёнок',
        emoji: '✨',
        avatar: 'js/bots/utenok/avatar-min.png',

        shortDescription: 'Байес-модель мотивов + поиск',
        longDescription: 'Оценивает вероятные типы врага по его поведению, '
            + 'считает ходы вперёд, прячет флаг в крепости и атакует организованно.',

        algorithmLabel: 'Байес-мотивы + minimax αβ',
        tier: 'easy',
        stars: 1,
        difficultyLabel: 'Лёгкий',
        tags: ['search', 'bayesian', 'adaptive', 'defensive', 'champion'],

        move(view) {
            try {
                const mem = getMem(view);

                const myCount = (view.aiPieces || []).filter(
                    p => !p.removed && p.row >= 0
                ).length;
                if (myCount > mem.lastMyCount) {
                    // A fresh army appeared -> a new game started; forget the old one.
                    const key = sideKeyOf(view);
                    MEM[key] = freshSide();
                }
                const liveMem = getMem(view);
                liveMem.lastMyCount = myCount;
                liveMem.mwc = view.movesWithoutCapture || 0;

                updatePerception(view, liveMem);
                updateDrawPolicy(view, liveMem);

                const decision = chooseBest(view, liveMem);
                if (decision) {
                    const vp = (view.aiPieces || []).find(p => p.id === decision.id);
                    if (vp) {
                        return { piece: vp, row: decision.toR, col: decision.toC };
                    }
                }
                return anyLegalMove(view);
            } catch (err) {
                console.error('[utenok] move() failed:', err);
                try {
                    return anyLegalMove(view);
                } catch (e) {
                    return null;
                }
            }
        },

        chooseFlagAndTrap() {
            // Fortress placement: the flag hides in a back-row corner with a
            // bodyguard right beside it. Variety keeps the setup unpredictable
            // while never leaving the flag in the open center.
            const dens = [
                { flagIndex: 0, trapIndex: 9 },   // A1 flag, B2 trap (diagonal)
                { flagIndex: 0, trapIndex: 8 },   // A1 flag, A2 trap (front)
                { flagIndex: 0, trapIndex: 1 },   // A1 flag, B1 trap (flank)
                { flagIndex: 7, trapIndex: 14 },  // H1 flag, G2 trap (diagonal)
                { flagIndex: 7, trapIndex: 15 },  // H1 flag, H2 trap (front)
                { flagIndex: 7, trapIndex: 6 }    // H1 flag, G1 trap (flank)
            ];
            return dens[Math.floor(Math.random() * dens.length)];
        },

        getSmartTieChoice(currentType, opponentRevealed, opponentType, view) {
            // Opponent's reroll is fresh, so use their historical habit as a weak
            // prior over what they might throw next.
            const agg = { rock: 0, paper: 0, scissors: 0 };
            for (const k of ['ai', 'player']) {
                const m = MEM[k];
                if (!m) {
                    continue;
                }
                agg.rock += m.enemyThrows.rock || 0;
                agg.paper += m.enemyThrows.paper || 0;
                agg.scissors += m.enemyThrows.scissors || 0;
            }
            let sum = agg.rock + agg.paper + agg.scissors;
            const prob = {};
            for (const t of TYPES) {
                prob[t] = sum > 0 ? agg[t] / sum : 1 / 3;
            }

            // Local support: which allied types stand next to the contested cell.
            // Whoever wins this reroll ends up on (newRow,newCol), so a neighbour
            // of the right type can recapture on the next turn.
            const support = { rock: false, paper: false, scissors: false };
            const bs = view && view.battleState;
            if (bs && typeof bs.newRow === 'number') {
                const br = bs.newRow;
                const bc = bs.newCol;
                const myId = bs.attacker && bs.defender
                    ? [bs.attacker.id, bs.defender.id]
                    : [];
                for (const p of (view.aiPieces || [])) {
                    if (p.removed || p.row < 0 || p.type !== 'piece') {
                        continue;
                    }
                    if (myId.indexOf(p.id) >= 0) {
                        continue;
                    }
                    if (cheb(p.row, p.col, br, bc) === 1 && p.pieceType) {
                        support[p.pieceType] = true;
                    }
                }
            }

            let best = null;
            let bestScore = -Infinity;
            for (const x of TYPES) {
                const yWin = BEATS[x];        // opponent type x defeats -> I win
                const yLose = beatenByOf(x);  // opponent type that defeats x
                let score = prob[yWin] * 100 - prob[yLose] * 100;
                // If a neighbour of type BEATS[x] guards the cell, a loss to yLose
                // can be recaptured, so the downside is much cheaper.
                if (support[BEATS[x]]) {
                    score += prob[yLose] * 65;
                }
                score += Math.random() * 3;
                if (score > bestScore) {
                    bestScore = score;
                    best = x;
                }
            }
            return best || TYPES[Math.floor(Math.random() * TYPES.length)];
        }
    };
})();

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(utenokBot);
} else {
    throw new Error('[utenok] RPSBotAPI is required');
}
