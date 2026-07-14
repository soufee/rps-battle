/**
 * Orlenok — the honour-and-pride engine.
 *
 * A complete rewrite. The bot is built around six layered capabilities that
 * combine into the most sophisticated play I could design without ever peeking
 * at the opponent's true hidden types:
 *
 *   1. Bayesian world model  — every hidden enemy carries a 5-way posterior
 *      {rock, paper, scissors, flag, trap} maintained by the shared aiBeliefs
 *      engine. Orlenok only reads PUBLIC information: positions, moves,
 *      reveals. It never touches a hidden piece's real type.
 *
 *   2. Motive inference      — on top of the belief base, Orlenok tracks WHY
 *      an enemy moves the way it does: retreat from a revealed piece of ours
 *      (= likely the type we beat, or the flag), approach (= likely the type
 *      that beats us), stillness in the back rank (= likely flag/trap),
 *      sacrificial luring (= probably a trap-backed decoy). These motives
 *      modulate attack EV and flag-hunt confidence.
 *
 *   3. Defensive redoubt     — the flag is anchored by a trap placed at setup
 *      diagonally adjacent to it. During play Orlenok pulls a balanced
 *      rock/paper/scissors trio into the flag's ring, building a "redoubt"
 *      where every plausible attacker is met by a counter or the trap.
 *
 *   4. Organized assault     — a 3-piece RPS-balanced "fist" advances on the
 *      most probable enemy flag location (posterior-weighted centroid), while
 *      a scout probes the opposite flank to misdirect the opponent's defence.
 *
 *   5. Expectimax + α-β      — root moves are scored by a deterministic
 *      alpha-beta search with quiescence; attacks on hidden enemies are
 *      expanded as Bayesian chance nodes so gambles are judged by true EV.
 *
 *   6. Draw & deception mgr  — Orlenok knows the 20-no-capture draw rule. When
 *      it is winning it presses for captures; when losing it stalls and
 *      shelters to force the draw. It occasionally offers a "false weakness"
 *      bait with a hidden counter lying in wait.
 *
 * Fair play: fog-of-war view only, no peeking hidden types, no copying other
 * bots' algorithms. This bot is my honour — it plays what it can see.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[orlenok] bot-api.js must be loaded BEFORE this bot');
}

const orlenokBot = (() => {
    'use strict';

    // =====================================================================
    //  TUNING CONSTANTS
    // =====================================================================

    const WIN_SCORE = 1000000;

    const TIME_BUDGET_MS = 700;
    const TIME_BUDGET_ENDGAME_MS = 1100;
    const SEARCH_DEPTH = 3;
    const SEARCH_DEPTH_ENDGAME = 5;
    const QUIESCENCE_DEPTH = 3;
    const MY_BRANCH_LIMIT = 14;
    const OPP_BRANCH_LIMIT = 9;
    const ROOT_BRANCH_LIMIT = 24;

    // Flag-hunt confidence thresholds.
    const FLAG_PROB_HIGH = 0.82;   // strike if adjacent
    const FLAG_PROB_MID = 0.55;    // close in
    const FLAG_PROB_ATTACK = 0.42; // EV-gated attack on suspect

    // Material values. Hidden pieces are worth more to us because the
    // opponent still cannot read them — information is an asset.
    const V_MY_HIDDEN = 430;
    const V_MY_REVEALED = 330;
    const V_MY_TRAP = 920;
    const V_MY_TRAP_SPENT = 280;
    const V_OPP_HIDDEN = 380;
    const V_OPP_REVEALED = 480;
    const V_OPP_TRAP = 330;
    const V_OPP_TRAP_SPENT = 120;
    const LOSS_AVERSION = 1.3;

    const DRAW_LIMIT = 20;
    const UNIFORM_BELIEF = { rock: 0.3, paper: 0.3, scissors: 0.3, flag: 0.05, trap: 0.05 };

    // =====================================================================
    //  EPHEMERAL PER-MOVE SCRATCH
    //  Rebuilt every turn so two Orlenok instances cannot corrupt each other
    //  through shared mutable search state.
    // =====================================================================

    const scratch = {
        deadline: 0,
        nodes: 0,
        killers: [],
        tt: new Map(),
        suspectId: null,
        suspectPFlag: 0,
        motives: null,
        myFlagRef: null
    };

    // =====================================================================
    //  SMALL PURE HELPERS
    // =====================================================================

    function cheb(r1, c1, r2, c2) {
        const dr = r1 - r2 < 0 ? r2 - r1 : r1 - r2;
        const dc = c1 - c2 < 0 ? c2 - c1 : c1 - c2;
        return dr > dc ? dr : dc;
    }

    function chebP(a, b) {
        return cheb(a.row, a.col, b.row, b.col);
    }

    function beatsOf(t) {
        if (t === 'rock') {
            return 'scissors';
        }
        if (t === 'paper') {
            return 'rock';
        }
        if (t === 'scissors') {
            return 'paper';
        }
        return null;
    }

    function beatenByOf(t) {
        if (t === 'rock') {
            return 'paper';
        }
        if (t === 'paper') {
            return 'scissors';
        }
        if (t === 'scissors') {
            return 'rock';
        }
        return null;
    }

    function battleResult(att, def) {
        if (!att || !def) {
            return 'draw';
        }
        if (att === def) {
            return 'draw';
        }
        if (def === FLAG) {
            return 'win';
        }
        if (def === TRAP) {
            return 'lose';
        }
        if (att === FLAG) {
            return 'lose';
        }
        if (att === TRAP) {
            return 'win';
        }
        return RPSBotAPI.resolveBattle(att, def);
    }

    function getMyFlag(gs) {
        const list = gs.aiPieces || [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (p && p.type === FLAG && !p.removed && p.row >= 0) {
                return p;
            }
        }
        return null;
    }

    function getEnemyFlag(gs) {
        const list = gs.playerPieces || [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (p && p.type === FLAG && !p.removed && p.row >= 0) {
                return p;
            }
        }
        return null;
    }

    function hasBeliefs() {
        return typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && typeof aiBeliefs.getProbDistribution === 'function';
    }

    function beliefOf(pieceId) {
        if (hasBeliefs()) {
            const d = aiBeliefs.getProbDistribution(pieceId);
            if (d) {
                return d;
            }
        }
        return { rock: UNIFORM_BELIEF.rock, paper: UNIFORM_BELIEF.paper,
            scissors: UNIFORM_BELIEF.scissors, flag: UNIFORM_BELIEF.flag,
            trap: UNIFORM_BELIEF.trap };
    }

    /**
     * The type that the searching agent (us) is allowed to know for a piece:
     * our own pieces are always known; an opponent's only after it is revealed.
     * Returns null when the type is genuinely hidden — the single rule that
     * keeps the engine honest about imperfect information.
     */
    function knownType(piece) {
        if (!piece) {
            return null;
        }
        if (piece.owner === COMPUTER || piece.revealed) {
            return piece.type === 'piece' ? piece.pieceType : piece.type;
        }
        return null;
    }

    function safeToLeaveCheck(gs, piece) {
        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && typeof aiTacticalCore.safeToLeave === 'function') {
            return aiTacticalCore.safeToLeave(gs, piece);
        }
        return true;
    }

    function clusterPenaltyOf(gs, piece, move) {
        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && typeof aiTacticalCore.clusterPenalty === 'function') {
            return aiTacticalCore.clusterPenalty(gs, piece, move);
        }
        return 0;
    }

    // =====================================================================
    //  PLACEMENT
    //  Flag tucked into a corner of the back rank with the trap covering the
    //  diagonal approach cell. Several templates + randomisation keep the
    //  layout unmemorable across a long match series.
    // =====================================================================

    function chooseFlagAndTrap() {
        // Each template: flag in/near a corner, trap adjacent (ideally diagonal)
        // so it covers the most direct approach while the flag sits behind it.
        const templates = [
            { flag: 0, trap: 9 },   // flag (0,0), trap (1,1) — diagonal cover
            { flag: 7, trap: 14 },  // flag (0,7), trap (1,6) — mirror
            { flag: 0, trap: 1 },   // flag (0,0), trap (0,1) — direct block
            { flag: 7, trap: 6 },   // flag (0,7), trap (0,6) — mirror
            { flag: 1, trap: 8 },   // flag (0,1), trap (1,0) — off-corner
            { flag: 6, trap: 15 },  // flag (0,6), trap (1,7) — mirror
            { flag: 1, trap: 10 },  // flag (0,1), trap (1,2) — diagonal
            { flag: 6, trap: 13 },  // flag (0,6), trap (1,5) — mirror
            { flag: 8, trap: 1 },   // flag (1,0), trap (0,1) — flag forward
            { flag: 15, trap: 6 }   // flag (1,7), trap (0,6) — mirror
        ];
        const pick = templates[Math.floor(Math.random() * templates.length)];
        return { flagIndex: pick.flag, trapIndex: pick.trap };
    }

    // =====================================================================
    //  THREAT ANALYSIS
    // =====================================================================

    function threatsToFlag(gs, flagRow, flagCol, radius) {
        const out = [];
        const enemies = gs.playerPieces || [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e || e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
                continue;
            }
            if (cheb(e.row, e.col, flagRow, flagCol) <= radius) {
                out.push(e);
            }
        }
        return out;
    }

    function mobileEnemiesAdjacent(gs, row, col) {
        return threatsToFlag(gs, row, col, 1).length;
    }

    // =====================================================================
    //  MOTIVE INFERENCE
    //  Augments the Bayesian belief with behavioural read-outs: how does this
    //  enemy treat our revealed pieces, how still is it, where does it live?
    //  Returns a map pieceId -> { flee, approach, still, backRank, corner,
    //  guarded, aggression, flagLikelihood, trapLikelihood }.
    // =====================================================================

    function buildMotives(gs) {
        const motives = new Map();
        if (!hasBeliefs()) {
            return motives;
        }
        const ourRevealed = [];
        const ours = gs.aiPieces || [];
        for (let i = 0; i < ours.length; i++) {
            const o = ours[i];
            if (o && !o.removed && o.row >= 0 && o.revealed
                && o.type === 'piece' && o.pieceType) {
                ourRevealed.push(o);
            }
        }

        const enemies = gs.playerPieces || [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e || e.removed || e.row < 0) {
                continue;
            }
            const belief = aiBeliefs.getBelief(e.id);
            const stillness = (typeof aiEngine !== 'undefined'
                && aiEngine.enemyStillness
                && aiEngine.enemyStillness.get(e.id))
                || { stillnessScore: 0, hasMovedOnce: false };
            const backRank = e.row === BOARD_HEIGHT - 1;
            const corner = backRank && (e.col === 0 || e.col === BOARD_WIDTH - 1);

            // Count our revealed pieces this enemy has retreated from / approached
            // over its observed lifetime. aiBeliefs doesn't expose a per-piece
            // log, so we approximate using its current position relative to each
            // of our revealed pieces plus its stillness/moved flags.
            let flee = 0;
            let approach = 0;
            for (let j = 0; j < ourRevealed.length; j++) {
                const o = ourRevealed[j];
                const d = cheb(e.row, e.col, o.row, o.col);
                if (d > 3) {
                    continue;
                }
                // A moved piece staying at d>=2 from a revealed piece it could
                // have engaged looks evasive; a moved piece at d==1 looks bold.
                if (belief && belief.moved) {
                    if (d >= 2) {
                        flee++;
                    } else if (d === 1) {
                        approach++;
                    }
                }
            }

            // "Guarded" = has another enemy neighbour in the back rank. Flags
            // and traps are commonly sheltered behind a screen of pieces.
            let guarded = 0;
            for (let k = 0; k < enemies.length; k++) {
                const g = enemies[k];
                if (!g || g === e || g.removed || g.row < 0) {
                    continue;
                }
                if (cheb(e.row, e.col, g.row, g.col) === 1) {
                    guarded++;
                }
            }

            const still = belief ? belief.stillTurns : stillness.stillnessScore;
            const moved = belief ? belief.moved : stillness.hasMovedOnce;

            // Combine into per-type likelihood multipliers applied on top of
            // the belief posterior. These are SOFT nudges, not overrides.
            let flagMul = 1;
            let trapMul = 1;
            if (!moved) {
                flagMul *= 1.25;
                trapMul *= 1.35;
            }
            if (backRank) {
                flagMul *= 1.2;
                trapMul *= 1.15;
            }
            if (corner) {
                flagMul *= 1.15;
            }
            if (guarded >= 2) {
                flagMul *= 1.1;
                trapMul *= 1.1;
            }
            if (approach > 0) {
                flagMul *= 0.5;
                trapMul *= 0.4;
            }
            if (flee > 0) {
                flagMul *= 1.15;
            }
            if (still >= 4) {
                flagMul *= 1.1;
                trapMul *= 1.12;
            }

            motives.set(e.id, {
                flee,
                approach,
                still,
                backRank,
                corner,
                guarded,
                moved: !!moved,
                flagMul,
                trapMul
            });
        }
        return motives;
    }

    /**
     * Posterior probability that an enemy piece is the flag, combining the
     * Bayesian belief with the motive multipliers. NOT used to write back into
     * aiBeliefs — only for Orlenok's own decisions.
     */
    function adjustedFlagProb(pieceId) {
        const base = beliefOf(pieceId);
        let pFlag = base.flag || 0;
        if (scratch.motives) {
            const m = scratch.motives.get(pieceId);
            if (m) {
                pFlag *= m.flagMul;
            }
        }
        return pFlag > 1 ? 1 : pFlag;
    }

    function adjustedTrapProb(pieceId) {
        const base = beliefOf(pieceId);
        let pTrap = base.trap || 0;
        if (scratch.motives) {
            const m = scratch.motives.get(pieceId);
            if (m) {
                pTrap *= m.trapMul;
            }
        }
        return pTrap > 1 ? 1 : pTrap;
    }

    /**
     * Top-N enemy pieces by adjusted P(flag). Routes through the Bayesian model
     * and layers our motive nudges on top.
     */
    function flagCandidates(gs, n) {
        const topN = n || 3;
        const list = [];
        const enemies = gs.playerPieces || [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e || e.removed || e.row < 0) {
                continue;
            }
            if (e.revealed && e.type !== FLAG) {
                continue;
            }
            if (e.revealed && e.type === FLAG) {
                list.push({ piece: e, pFlag: 1 });
                continue;
            }
            list.push({ piece: e, pFlag: adjustedFlagProb(e.id) });
        }
        list.sort((a, b) => b.pFlag - a.pFlag);
        return list.slice(0, topN);
    }

    /**
     * Adapter so the shared tactical core can use our motive-aware deducer.
     */
    function deducerForCore(gs) {
        const candidates = flagCandidates(gs, 3);
        let hiddenCount = 0;
        const enemies = gs.playerPieces || [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (e && !e.removed && e.row >= 0 && !e.revealed && e.type !== TRAP) {
                hiddenCount++;
            }
        }
        return {
            candidates: candidates.map(c => ({ piece: c.piece, prob: c.pFlag })),
            hiddenCount
        };
    }

    // =====================================================================
    //  EXPECTED-VALUE COMBAT ARITHMETIC
    //  All reasoning about attacking an unknown enemy flows through the belief
    //  distribution — we never read a hidden piece's real type.
    // =====================================================================

    function expectedAttackValue(attacker, target) {
        if (!attacker || !target) {
            return 0;
        }
        const tType = knownType(target);
        if (tType !== null) {
            return revealedAttackValue(attacker, target, tType);
        }
        return hiddenAttackValue(attacker, target);
    }

    function revealedAttackValue(attacker, target, tType) {
        if (tType === FLAG) {
            return WIN_SCORE;
        }
        if (tType === TRAP) {
            return -V_MY_REVEALED * LOSS_AVERSION;
        }
        if (attacker.type === TRAP) {
            return V_OPP_REVEALED;
        }
        if (attacker.type !== 'piece' || !attacker.pieceType) {
            return 0;
        }
        const verdict = battleResult(attacker.pieceType, tType);
        if (verdict === 'win') {
            return V_OPP_REVEALED;
        }
        if (verdict === 'lose') {
            return -V_MY_REVEALED * LOSS_AVERSION;
        }
        return -25;
    }

    function hiddenAttackValue(attacker, target) {
        const belief = beliefOf(target.id);
        const pFlag = belief.flag || 0;
        const pTrap = belief.trap || 0;
        let ev = 0;
        ev += pFlag * WIN_SCORE;
        ev += pTrap * (-V_MY_HIDDEN * LOSS_AVERSION);

        if (attacker.type === 'piece' && attacker.pieceType) {
            const beats = beatsOf(attacker.pieceType);
            const beatenBy = beatenByOf(attacker.pieceType);
            const pWin = belief[beats] || 0;
            const pLose = belief[beatenBy] || 0;
            const pDraw = belief[attacker.pieceType] || 0;
            ev += pWin * V_OPP_HIDDEN;
            ev += pLose * (-V_MY_HIDDEN * LOSS_AVERSION);
            ev += pDraw * (-15);
        } else if (attacker.type === TRAP) {
            const rpsMass = (belief.rock || 0)
                + (belief.paper || 0)
                + (belief.scissors || 0);
            ev += rpsMass * V_OPP_HIDDEN * 0.65;
        }
        return ev;
    }

    // =====================================================================
    //  LIGHTWEIGHT STATE CLONE + DETERMINISTIC TRANSITIONS
    //  Used by the deep search. We clone only the fields the engine needs and
    //  rebuild the board so mutation never touches the live game state.
    // =====================================================================

    function clonePiece(p) {
        return {
            id: p.id,
            type: p.type,
            pieceType: p.pieceType,
            owner: p.owner,
            row: p.row,
            col: p.col,
            revealed: p.revealed,
            immobilized: p.immobilized,
            removed: p.removed
        };
    }

    function cloneState(gs) {
        const aiPieces = [];
        const playerPieces = [];
        const board = [];
        for (let r = 0; r < BOARD_HEIGHT; r++) {
            board.push(new Array(BOARD_WIDTH).fill(null));
        }
        const src1 = gs.aiPieces || [];
        for (let i = 0; i < src1.length; i++) {
            const c = clonePiece(src1[i]);
            aiPieces.push(c);
            if (!c.removed && c.row >= 0) {
                board[c.row][c.col] = c;
            }
        }
        const src2 = gs.playerPieces || [];
        for (let i = 0; i < src2.length; i++) {
            const c = clonePiece(src2[i]);
            playerPieces.push(c);
            if (!c.removed && c.row >= 0) {
                board[c.row][c.col] = c;
            }
        }
        return { board, aiPieces, playerPieces };
    }

    function removeFromArray(arr, piece) {
        const idx = arr.indexOf(piece);
        if (idx > -1) {
            arr.splice(idx, 1);
        }
    }

    /**
     * Apply a deterministic move on a cloned state. The caller guarantees the
     * move is either quiet or a capture with a known outcome (revealed target
     * we beat, or a revealed flag). Combat against unknown pieces is never
     * routed here — it lives in the root chance layer.
     */
    function applyDeterministic(state, piece, row, col) {
        const target = state.board[row][col];
        state.board[piece.row][piece.col] = null;
        if (target) {
            const arr = target.owner === COMPUTER ? state.aiPieces : state.playerPieces;
            removeFromArray(arr, target);
            piece.revealed = true;
        }
        piece.row = row;
        piece.col = col;
        state.board[row][col] = piece;
    }

    function isTerminal(state) {
        const myFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        const enemyFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);
        return !myFlag || !enemyFlag;
    }

    /**
     * Generate deterministic edges for `owner`: quiet steps for any mobile
     * piece, captures of a revealed enemy we beat, and capture of a revealed
     * enemy flag. Attacks on pieces of unknown type are deliberately omitted.
     */
    function genDeterministicMoves(state, owner) {
        const pieces = owner === COMPUTER ? state.aiPieces : state.playerPieces;
        const moves = [];
        for (let i = 0; i < pieces.length; i++) {
            const piece = pieces[i];
            if (!piece || piece.removed || piece.immobilized || piece.row < 0) {
                continue;
            }
            const attackerType = knownType(piece);
            for (let d = 0; d < GAME_CONFIG.DIRECTIONS.length; d++) {
                const dir = GAME_CONFIG.DIRECTIONS[d];
                const nr = piece.row + dir[0];
                const nc = piece.col + dir[1];
                if (nr < 0 || nr >= BOARD_HEIGHT || nc < 0 || nc >= BOARD_WIDTH) {
                    continue;
                }
                const target = state.board[nr][nc];
                if (!target) {
                    moves.push({ piece, row: nr, col: nc, capture: false });
                    continue;
                }
                if (target.owner === owner) {
                    continue;
                }
                if (piece.type === FLAG) {
                    continue;
                }
                // Paranoid asymmetry: assume the opponent can take our flag any
                // time it is reachable, even from a hidden piece. We only chase
                // THEIR flag once it is actually revealed.
                if (owner === PLAYER && target.owner === COMPUTER && target.type === FLAG) {
                    moves.push({ piece, row: nr, col: nc, capture: true });
                    continue;
                }
                const tType = knownType(target);
                if (tType === null) {
                    continue;
                }
                if (tType === FLAG) {
                    moves.push({ piece, row: nr, col: nc, capture: true });
                    continue;
                }
                if (tType === TRAP) {
                    continue;
                }
                if (piece.type === TRAP) {
                    moves.push({ piece, row: nr, col: nc, capture: true });
                    continue;
                }
                if (attackerType === null) {
                    continue;
                }
                if (battleResult(attackerType, tType) === 'win') {
                    moves.push({ piece, row: nr, col: nc, capture: true });
                }
            }
        }
        return moves;
    }

    // =====================================================================
    //  STATIC EVALUATION (from COMPUTER's perspective; higher == better)
    // =====================================================================

    function evaluate(state) {
        const myFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!myFlag) {
            return -WIN_SCORE;
        }
        const enemyFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);
        if (!enemyFlag) {
            return WIN_SCORE;
        }
        let score = 0;
        score += scoreMaterial(state);
        score += scoreFlagSafety(state, myFlag);
        score += scoreEnemyFlagPressure(state, enemyFlag);
        score += scoreRedoubt(state, myFlag);
        score += scoreCoordination(state);
        score += scoreProgression(state);
        score += scoreBeliefThreats(state);
        return score;
    }

    function scoreMaterial(state) {
        let s = 0;
        const ai = state.aiPieces;
        for (let i = 0; i < ai.length; i++) {
            const p = ai[i];
            if (!p || p.removed || p.row < 0) {
                continue;
            }
            if (p.type === FLAG) {
                continue;
            }
            if (p.type === TRAP) {
                s += p.immobilized ? V_MY_TRAP_SPENT : V_MY_TRAP;
            } else {
                s += p.revealed ? V_MY_REVEALED : V_MY_HIDDEN;
            }
        }
        const pl = state.playerPieces;
        for (let i = 0; i < pl.length; i++) {
            const p = pl[i];
            if (!p || p.removed || p.row < 0) {
                continue;
            }
            if (p.type === FLAG) {
                continue;
            }
            if (p.type === TRAP) {
                s -= p.immobilized ? V_OPP_TRAP_SPENT : V_OPP_TRAP;
            } else {
                s -= p.revealed ? V_OPP_REVEALED : V_OPP_HIDDEN;
            }
        }
        return s;
    }

    function scoreFlagSafety(state, myFlag) {
        let s = 0;
        let escapes = 0;
        for (let d = 0; d < GAME_CONFIG.DIRECTIONS.length; d++) {
            const dir = GAME_CONFIG.DIRECTIONS[d];
            const r = myFlag.row + dir[0];
            const c = myFlag.col + dir[1];
            if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                continue;
            }
            if (!state.board[r][c]) {
                escapes++;
            }
        }
        s += escapes * 14;

        let nearest = Infinity;
        const enemies = state.playerPieces;
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e || e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
                continue;
            }
            const d = cheb(e.row, e.col, myFlag.row, myFlag.col);
            if (d < nearest) {
                nearest = d;
            }
            if (d <= 3) {
                const revealedMult = e.revealed ? 1.7 : 1.0;
                s -= (4 - d) * 300 * revealedMult;
                if (d === 1) {
                    s -= e.revealed ? 7000 : 1500;
                }
            }
        }

        // Defender ring: count unique RPS types and trap among our pieces
        // adjacent to the flag — the core of the redoubt.
        let defenders = 0;
        const types = new Set();
        let hasTrap = false;
        for (let d = 0; d < GAME_CONFIG.DIRECTIONS.length; d++) {
            const dir = GAME_CONFIG.DIRECTIONS[d];
            const r = myFlag.row + dir[0];
            const c = myFlag.col + dir[1];
            if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                continue;
            }
            const ally = state.board[r][c];
            if (!ally || ally.owner !== COMPUTER || ally.type === FLAG || ally.immobilized) {
                continue;
            }
            defenders++;
            if (ally.type === TRAP) {
                hasTrap = true;
            } else if (ally.type === 'piece' && ally.pieceType) {
                types.add(ally.pieceType);
            }
        }
        s += types.size * 90;
        if (hasTrap) {
            s += 380;
        }
        if (nearest <= 3 && defenders === 0 && !hasTrap) {
            s -= 1200;
        }
        return s;
    }

    function scoreEnemyFlagPressure(state, enemyFlag) {
        let s = 0;
        const attackers = [];
        const ai = state.aiPieces;
        for (let i = 0; i < ai.length; i++) {
            const p = ai[i];
            if (p && !p.removed && p.row >= 0 && !p.immobilized && p.type === 'piece') {
                attackers.push(p);
            }
        }

        if (enemyFlag.revealed) {
            for (let i = 0; i < attackers.length; i++) {
                s += (6 - Math.min(6, chebP(attackers[i], enemyFlag))) * 55;
            }
            return s;
        }

        // Hidden enemy flag: pull our attackers toward the current suspect.
        if (!scratch.suspectId || scratch.suspectPFlag < 0.25) {
            return 0;
        }
        const suspect = state.playerPieces.find(p =>
            p && p.id === scratch.suspectId && !p.removed && p.row >= 0);
        if (!suspect) {
            return 0;
        }
        for (let i = 0; i < attackers.length; i++) {
            s += (6 - Math.min(6, chebP(attackers[i], suspect))) * 34 * scratch.suspectPFlag;
        }
        return s;
    }

    /**
     * Redoubt bonus: a near-complete or complete redoubt (trap + 3 RPS types
     * in the flag's ring) is a powerful fortress. Reward partial progress too
     * so the eval nudges the bot to build it.
     */
    function scoreRedoubt(state, myFlag) {
        let types = 0;
        let hasTrap = false;
        const seen = new Set();
        for (let d = 0; d < GAME_CONFIG.DIRECTIONS.length; d++) {
            const dir = GAME_CONFIG.DIRECTIONS[d];
            const r = myFlag.row + dir[0];
            const c = myFlag.col + dir[1];
            if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                continue;
            }
            const ally = state.board[r][c];
            if (!ally || ally.owner !== COMPUTER || ally.type === FLAG || ally.immobilized) {
                continue;
            }
            if (ally.type === TRAP) {
                hasTrap = true;
            } else if (ally.type === 'piece' && ally.pieceType && !seen.has(ally.pieceType)) {
                seen.add(ally.pieceType);
                types++;
            }
        }
        let s = 0;
        s += types * 40;
        if (hasTrap) {
            s += 60;
        }
        if (hasTrap && types >= 3) {
            s += 250; // complete redoubt
        } else if (hasTrap && types >= 2) {
            s += 110;
        } else if (types >= 3) {
            s += 80;
        }
        return s;
    }

    /**
     * Coordination: reward 3-RPS fists (rock+paper+scissors within radius 2)
     * and penalise stacking the same type — a single enemy winner sweeps a
     * mono-type cluster.
     */
    function scoreCoordination(state) {
        const attackers = [];
        const ai = state.aiPieces;
        for (let i = 0; i < ai.length; i++) {
            const p = ai[i];
            if (p && !p.removed && p.row >= 0 && p.type === 'piece') {
                attackers.push(p);
            }
        }
        let s = 0;
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
                if (chebP(ally, other) > 2) {
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
            const uniq = (hasRock ? 1 : 0) + (hasPaper ? 1 : 0) + (hasScissors ? 1 : 0);
            if (uniq === 3) {
                s += 70;
            } else if (uniq === 2) {
                s += 24;
            }
            if (sameNearby >= 2) {
                s -= sameNearby * 28;
            }
        }
        return s;
    }

    function scoreProgression(state) {
        let s = 0;
        const ai = state.aiPieces;
        for (let i = 0; i < ai.length; i++) {
            const p = ai[i];
            if (!p || p.removed || p.row < 0 || p.type !== 'piece') {
                continue;
            }
            s += p.row * 10;
            s += (4 - Math.abs(p.col - 3.5)) * 4;
        }
        return s;
    }

    /**
     * Reward standing next to hidden enemies we likely beat (in EV) and punish
     * standing next to hidden enemies that likely beat us — the spatial echo of
     * "always keep a counter in range". Trap-aware.
     */
    function scoreBeliefThreats(state) {
        if (!hasBeliefs()) {
            return 0;
        }
        let s = 0;
        const ai = state.aiPieces;
        for (let i = 0; i < ai.length; i++) {
            const ally = ai[i];
            if (!ally || ally.removed || ally.row < 0 || ally.type !== 'piece' || !ally.pieceType) {
                continue;
            }
            const beats = beatsOf(ally.pieceType);
            const beatenBy = beatenByOf(ally.pieceType);
            const enemies = state.playerPieces;
            for (let j = 0; j < enemies.length; j++) {
                const e = enemies[j];
                if (!e || e.removed || e.row < 0 || e.immobilized || e.revealed) {
                    continue;
                }
                const d = chebP(ally, e);
                if (d > 2) {
                    continue;
                }
                const belief = beliefOf(e.id);
                const winP = belief[beats] || 0;
                const loseP = belief[beatenBy] || 0;
                const fact = d === 1 ? 26 : 11;
                s += (winP - loseP * 1.25) * fact;
                if (belief.trap && d === 1) {
                    s -= belief.trap * 40;
                }
            }
        }
        return s;
    }

    // =====================================================================
    //  MOVE ORDERING (alpha-beta acceleration)
    // =====================================================================

    function orderMoves(state, moves, owner) {
        const scored = [];
        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            let pri = Math.random() * 2;
            if (m.capture) {
                pri += 800;
                const target = state.board[m.row][m.col];
                if (target && knownType(target) === FLAG) {
                    pri += 9000;
                }
            }
            for (let k = 0; k < scratch.killers.length; k++) {
                const kk = scratch.killers[k];
                if (kk && kk.id === m.piece.id && kk.row === m.row && kk.col === m.col) {
                    pri += 500;
                    break;
                }
            }
            pri += owner === COMPUTER ? m.row * 5 : (BOARD_HEIGHT - m.row) * 5;
            scored.push({ m, pri });
        }
        scored.sort((a, b) => b.pri - a.pri);
        const out = [];
        for (let i = 0; i < scored.length; i++) {
            out.push(scored[i].m);
        }
        return out;
    }

    function recordKiller(m) {
        if (!m || !m.piece) {
            return;
        }
        scratch.killers.unshift({ id: m.piece.id, row: m.row, col: m.col });
        if (scratch.killers.length > 6) {
            scratch.killers.length = 6;
        }
    }

    // =====================================================================
    //  QUIESCENCE + ALPHA-BETA over deterministic transitions
    // =====================================================================

    function quiescence(state, alpha, beta, maximizing, qdepth) {
        const standPat = evaluate(state);
        if (qdepth <= 0 || Date.now() > scratch.deadline || isTerminal(state)) {
            return standPat;
        }
        if (maximizing) {
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
        const owner = maximizing ? COMPUTER : PLAYER;
        const all = genDeterministicMoves(state, owner);
        const captures = [];
        for (let i = 0; i < all.length; i++) {
            if (all[i].capture) {
                captures.push(all[i]);
            }
        }
        if (captures.length === 0) {
            return standPat;
        }
        const ordered = orderMoves(state, captures, owner);
        const limit = Math.min(ordered.length, 6);
        for (let i = 0; i < limit; i++) {
            if (Date.now() > scratch.deadline) {
                break;
            }
            const child = cloneState(state);
            const piece = (owner === COMPUTER ? child.aiPieces : child.playerPieces)
                .find(p => p.id === ordered[i].piece.id);
            if (!piece) {
                continue;
            }
            applyDeterministic(child, piece, ordered[i].row, ordered[i].col);
            const v = quiescence(child, alpha, beta, !maximizing, qdepth - 1);
            if (maximizing) {
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
        return maximizing ? alpha : beta;
    }

    function alphaBeta(state, depth, alpha, beta, maximizing) {
        scratch.nodes++;
        if (Date.now() > scratch.deadline || isTerminal(state)) {
            return evaluate(state);
        }
        if (depth <= 0) {
            return quiescence(state, alpha, beta, maximizing, QUIESCENCE_DEPTH);
        }
        const owner = maximizing ? COMPUTER : PLAYER;
        let moves = genDeterministicMoves(state, owner);
        if (moves.length === 0) {
            return evaluate(state);
        }
        moves = orderMoves(state, moves, owner);
        const limit = maximizing ? MY_BRANCH_LIMIT : OPP_BRANCH_LIMIT;
        if (moves.length > limit) {
            moves = moves.slice(0, limit);
        }
        let best = maximizing ? -Infinity : Infinity;
        for (let i = 0; i < moves.length; i++) {
            if (Date.now() > scratch.deadline) {
                break;
            }
            const child = cloneState(state);
            const piece = (owner === COMPUTER ? child.aiPieces : child.playerPieces)
                .find(p => p.id === moves[i].piece.id);
            if (!piece) {
                continue;
            }
            applyDeterministic(child, piece, moves[i].row, moves[i].col);
            const v = alphaBeta(child, depth - 1, alpha, beta, !maximizing);
            if (maximizing) {
                if (v > best) {
                    best = v;
                }
                if (best > alpha) {
                    alpha = best;
                }
            } else {
                if (v < best) {
                    best = v;
                }
                if (best < beta) {
                    beta = best;
                }
            }
            if (beta <= alpha) {
                recordKiller(moves[i]);
                break;
            }
        }
        return best;
    }

    // =====================================================================
    //  ROOT EXPECTIMAX
    //  Every legal move is scored. Quiet / revealed lines descend into the
    //  deterministic alpha-beta. An attack on an unknown enemy is expanded as
    //  a Bayesian chance node so the gamble is judged by its true expectation.
    // =====================================================================

    function rootValueQuietOrRevealed(gs, depth, move) {
        const child = cloneState(gs);
        const piece = child.aiPieces.find(p => p.id === move.piece.id);
        if (!piece) {
            return -Infinity;
        }
        const target = child.board[move.row][move.col];
        if (target && target.owner === PLAYER) {
            const tType = knownType(target);
            if (tType === FLAG) {
                return WIN_SCORE;
            }
        }
        applyDeterministic(child, piece, move.row, move.col);
        return alphaBeta(child, depth - 1, -Infinity, Infinity, false);
    }

    function rootValueHiddenAttack(gs, depth, move) {
        const attacker = move.piece;
        const target = gs.playerPieces.find(p =>
            p && p.row === move.row && p.col === move.col && !p.removed);
        if (!target) {
            return -Infinity;
        }
        const belief = beliefOf(target.id);
        const pFlag = belief.flag || 0;
        const pTrap = belief.trap || 0;
        let ev = pFlag * WIN_SCORE;

        // Trap branch: our attacker dies, the trap is immobilised.
        if (pTrap > 0) {
            const trapState = cloneState(gs);
            const me = trapState.aiPieces.find(p => p.id === attacker.id);
            const tg = trapState.playerPieces.find(p => p.id === target.id);
            if (me && tg) {
                removeFromArray(trapState.aiPieces, me);
                trapState.board[me.row][me.col] = null;
                tg.immobilized = true;
                tg.revealed = true;
                ev += pTrap * evaluate(trapState);
            }
        }

        if (attacker.type === 'piece' && attacker.pieceType) {
            const beats = beatsOf(attacker.pieceType);
            const beatenBy = beatenByOf(attacker.pieceType);
            const pWin = belief[beats] || 0;
            const pLose = belief[beatenBy] || 0;
            const pDraw = belief[attacker.pieceType] || 0;

            if (pWin > 0) {
                const winState = cloneState(gs);
                const me = winState.aiPieces.find(p => p.id === attacker.id);
                const tg = winState.board[move.row][move.col];
                if (me && tg) {
                    applyDeterministic(winState, me, move.row, move.col);
                }
                ev += pWin * alphaBeta(winState, depth - 1, -Infinity, Infinity, false);
            }
            if (pLose > 0) {
                const loseState = cloneState(gs);
                const me = loseState.aiPieces.find(p => p.id === attacker.id);
                if (me) {
                    removeFromArray(loseState.aiPieces, me);
                    loseState.board[me.row][me.col] = null;
                }
                ev += pLose * alphaBeta(loseState, depth - 1, -Infinity, Infinity, false);
            }
            if (pDraw > 0) {
                // A draw reveals both pieces and re-rolls; positions unchanged.
                // Treat it as a mildly negative tempo event with a follow-up
                // evaluation that accounts for the lost hidden value.
                const drawState = cloneState(gs);
                const me = drawState.aiPieces.find(p => p.id === attacker.id);
                const tg = drawState.playerPieces.find(p => p.id === target.id);
                if (me) {
                    me.revealed = true;
                }
                if (tg) {
                    tg.revealed = true;
                }
                ev += pDraw * (evaluate(drawState) - 60);
            }
        }
        return ev;
    }

    function searchBestMove(gs, available) {
        const myFlag = getMyFlag(gs);
        const totalPieces = (gs.aiPieces || []).filter(p => !p.removed).length
            + (gs.playerPieces || []).filter(p => !p.removed).length;
        const endgame = totalPieces <= 9;

        let budget = endgame ? TIME_BUDGET_ENDGAME_MS : TIME_BUDGET_MS;
        if (typeof window !== 'undefined' && typeof window.__RPS_TIME_BUDGET === 'number') {
            budget = window.__RPS_TIME_BUDGET;
        }
        scratch.deadline = Date.now() + budget;
        const depth = endgame ? SEARCH_DEPTH_ENDGAME : SEARCH_DEPTH;
        scratch.killers = [];
        scratch.nodes = 0;

        const candidates = [];
        for (let i = 0; i < available.length; i++) {
            const piece = available[i];
            const moves = aiEngine.getMovesForPiece(piece, gs);
            for (let j = 0; j < moves.length; j++) {
                candidates.push({ piece, row: moves[j].row, col: moves[j].col });
            }
        }
        if (candidates.length === 0) {
            return null;
        }

        // Shuffle candidates lightly so equal-scored moves don't bias toward a
        // fixed piece order. Then sort by a cheap prior so the time-bounded
        // loop examines strong moves first (better when deadline truncates).
        for (let i = 0; i < candidates.length; i++) {
            const j = i + Math.floor(Math.random() * (candidates.length - i));
            const tmp = candidates[i];
            candidates[i] = candidates[j];
            candidates[j] = tmp;
        }
        candidates.sort((a, b) => cheapPrior(gs, b, myFlag) - cheapPrior(gs, a, myFlag));
        const ordered = candidates.slice(0, Math.min(ROOT_BRANCH_LIMIT, candidates.length));

        let best = null;
        let bestScore = -Infinity;
        for (let i = 0; i < ordered.length; i++) {
            if (Date.now() > scratch.deadline && best) {
                break;
            }
            const move = ordered[i];
            const target = gs.board[move.row][move.col];
            const hiddenAttack = target
                && target.owner === PLAYER
                && knownType(target) === null;
            let value;
            if (hiddenAttack) {
                value = rootValueHiddenAttack(gs, depth, move);
            } else {
                value = rootValueQuietOrRevealed(gs, depth, move);
            }
            value += rootShaping(gs, move, myFlag);
            if (value > bestScore) {
                bestScore = value;
                best = move;
            }
        }
        return best ? { move: best, score: bestScore } : null;
    }

    /**
     * Cheap prior for root ordering: captures > advances > everything else.
     * Keeps the time-bounded root loop focused on plausible moves.
     */
    function cheapPrior(gs, move, myFlag) {
        let pri = 0;
        const target = gs.board[move.row][move.col];
        if (target && target.owner === PLAYER) {
            pri += 600;
            if (target.revealed && target.type === FLAG) {
                pri += 100000;
            }
            pri += expectedAttackValue(move.piece, target) * 0.05;
        }
        pri += move.row * 4;
        if (myFlag && move.piece.id !== myFlag.id) {
            // Prefer pieces not currently serving as flag defenders.
            const d = chebP(move.piece, myFlag);
            if (d <= 1) {
                pri -= 80;
            }
        }
        return pri;
    }

    /**
     * Root-only shaping that the deep search cannot express well: anti-shuttle,
     * over-activity, cluster risk, trap discipline, draw management, and a
     * nudge toward keeping the army honest.
     */
    function rootShaping(gs, move, myFlag) {
        let s = 0;
        // The flag moves only when the emergency layer demands it.
        if (myFlag && move.piece.id === myFlag.id) {
            const adjNow = mobileEnemiesAdjacent(gs, myFlag.row, myFlag.col);
            const adjAfter = mobileEnemiesAdjacent(gs, move.row, move.col);
            if (adjNow === 0) {
                s -= 400;
            } else if (adjAfter >= adjNow) {
                s -= 250;
            }
        }
        // The trap is the flag's last-ditch guardian. Keep it home unless it is
        // springing on an enemy that has reached the flag's neighbourhood.
        if (move.piece.type === TRAP && myFlag) {
            const before = chebP(move.piece, myFlag);
            const after = cheb(move.row, move.col, myFlag.row, myFlag.col);
            const target = gs.board[move.row][move.col];
            const springing = target && target.owner === PLAYER;
            if (after > before && !springing) {
                s -= 700;
            }
        }
        if (aiEngine.isShuttlePosition(move.piece.id, move.row, move.col)) {
            s -= 240;
        }
        const recent = aiEngine.countRecentMovesOfPiece(move.piece.id, 4);
        if (recent >= 2) {
            s -= 70 * (recent - 1);
        }
        s -= clusterPenaltyOf(gs, move.piece, move);
        if (myFlag && move.piece.id !== myFlag.id) {
            const before = chebP(move.piece, myFlag);
            const after = cheb(move.row, move.col, myFlag.row, myFlag.col);
            const threats = threatsToFlag(gs, myFlag.row, myFlag.col, 2);
            if (threats.length > 0 && before <= 1 && after > before) {
                if (!safeToLeaveCheck(gs, move.piece)) {
                    s -= 600;
                }
            }
        }
        // Draw-pressure shaping: when the no-capture counter is high, push the
        // bot toward or away from contact depending on whether it is winning.
        s += drawPressureShaping(gs, move);
        // Deception nudge: a hidden piece stepping adjacent to a revealed
        // enemy (with a hidden counter behind it) is a classic bait.
        s += deceptionNudge(gs, move);
        return s;
    }

    /**
     * Draw management. The 20-no-capture rule triggers a draw. When Orlenok is
     * winning it must press for captures; when losing it can stall for the
     * draw. The shape of the pressure scales with how close the counter is.
     */
    function drawPressureShaping(gs, move) {
        const movesWithout = gs.movesWithoutCapture || 0;
        const ratio = movesWithout / DRAW_LIMIT;
        if (ratio < 0.5) {
            return 0;
        }
        const losing = typeof aiEngine.isLosingPosition === 'function'
            ? aiEngine.isLosingPosition(gs)
            : false;
        const target = gs.board[move.row][move.col];
        const isAttack = !!(target && target.owner === PLAYER);
        const isForward = move.row > move.piece.row;

        if (losing) {
            // Shelter: reward passive / retreating moves, penalise attacks.
            if (isAttack) {
                return -300 - ratio * 400;
            }
            if (move.piece.type === 'piece' && move.row < move.piece.row) {
                return 80 + ratio * 120;
            }
            // Standing still near our flag is also fine.
            return 20;
        }

        // Winning or neutral: press forward, reward captures.
        let bonus = 0;
        if (ratio >= 0.9) {
            bonus = isAttack ? 800 : (isForward ? 300 : -200);
        } else if (ratio >= 0.75) {
            bonus = isAttack ? 450 : (isForward ? 150 : -120);
        } else {
            bonus = isAttack ? 220 : (isForward ? 70 : -60);
        }
        // Engagement drive: reward closing the gap to the nearest enemy so the
        // armies actually meet instead of patrolling their own halves.
        if (typeof aiEngine.nearestEnemyDistance === 'function') {
            const nearest = aiEngine.nearestEnemyDistance(move.piece.row, move.piece.col, gs);
            if (nearest.dist >= 0) {
                const nextDist = cheb(move.row, move.col, nearest.row, nearest.col);
                const closing = nearest.dist - nextDist;
                const engageScale = ratio >= 0.9 ? 300 : (ratio >= 0.75 ? 200 : 120);
                bonus += closing * engageScale;
            }
        }
        return bonus;
    }

    /**
     * Deception nudge. If a hidden piece of ours steps adjacent to a revealed
     * enemy that it COULD lose to (looking like easy prey), and we have a
     * hidden counter 1-2 cells behind, reward the bait — the opponent is
     * invited to attack into our counter.
     */
    function deceptionNudge(gs, move) {
        const piece = move.piece;
        if (!piece || piece.type !== 'piece' || piece.revealed) {
            return 0;
        }
        const target = gs.board[move.row][move.col];
        if (target && target.owner === PLAYER) {
            return 0; // not a bait if we're the attacker
        }
        // Look for a revealed enemy adjacent to the destination cell.
        let baitEnemy = null;
        for (let d = 0; d < GAME_CONFIG.DIRECTIONS.length; d++) {
            const dir = GAME_CONFIG.DIRECTIONS[d];
            const r = move.row + dir[0];
            const c = move.col + dir[1];
            if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                continue;
            }
            const e = gs.board[r][c];
            if (e && e.owner === PLAYER && e.revealed && e.type === 'piece') {
                baitEnemy = e;
                break;
            }
        }
        if (!baitEnemy) {
            return 0;
        }
        // Is there a hidden counter of ours within 2 cells of the destination
        // that beats the bait enemy?
        const counterType = beatsOf(baitEnemy.pieceType);
        const ai = gs.aiPieces || [];
        for (let i = 0; i < ai.length; i++) {
            const ally = ai[i];
            if (!ally || ally.removed || ally.id === piece.id) {
                continue;
            }
            if (ally.type !== 'piece' || ally.revealed) {
                continue;
            }
            if (ally.pieceType !== counterType) {
                continue;
            }
            const d = cheb(ally.row, ally.col, move.row, move.col);
            if (d <= 2) {
                return 60;
            }
        }
        return 0;
    }

    // =====================================================================
    //  PARANOID FLAG SAFETY
    //  The tactical core handles a revealed enemy adjacent to our flag. We add
    //  protection against the quieter killer: a hidden enemy that just stepped
    //  next to our flag and can take it on its next move.
    // =====================================================================

    function bestFlagEscape(gs, myFlag) {
        const moves = aiEngine.getMovesForPiece(myFlag, gs);
        let best = null;
        let bestKey = null;
        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            if (gs.board[m.row][m.col]) {
                continue;
            }
            const adj = mobileEnemiesAdjacent(gs, m.row, m.col);
            const coverage = aiEngine.computeRPSCoverage(m.row, m.col, gs);
            let nearest = Infinity;
            const enemies = gs.playerPieces || [];
            for (let j = 0; j < enemies.length; j++) {
                const e = enemies[j];
                if (!e || e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
                    continue;
                }
                const d = cheb(e.row, e.col, m.row, m.col);
                if (d < nearest) {
                    nearest = d;
                }
            }
            const key = adj * -10000
                + (coverage.hasTrap ? 400 : 0)
                + coverage.typeCount * 120
                + Math.min(nearest, 5) * 50;
            if (bestKey === null || key > bestKey) {
                bestKey = key;
                best = { piece: myFlag, row: m.row, col: m.col, adj };
            }
        }
        return best;
    }

    function guaranteedCaptureOf(gs, available, threat) {
        let trapMove = null;
        let winMove = null;
        for (let i = 0; i < available.length; i++) {
            const piece = available[i];
            if (!piece || piece.type === FLAG) {
                continue;
            }
            if (cheb(piece.row, piece.col, threat.row, threat.col) !== 1) {
                continue;
            }
            if (piece.type === TRAP) {
                trapMove = { piece, row: threat.row, col: threat.col };
                continue;
            }
            if (threat.revealed && threat.type === 'piece' && piece.type === 'piece'
                && piece.pieceType
                && battleResult(piece.pieceType, threat.pieceType) === 'win') {
                winMove = { piece, row: threat.row, col: threat.col };
            }
        }
        return trapMove || winMove;
    }

    function bestEvCaptureOf(gs, available, threat) {
        let best = null;
        let bestEv = -Infinity;
        for (let i = 0; i < available.length; i++) {
            const piece = available[i];
            if (!piece || piece.type === FLAG) {
                continue;
            }
            if (cheb(piece.row, piece.col, threat.row, threat.col) !== 1) {
                continue;
            }
            const ev = expectedAttackValue(piece, threat);
            if (ev > bestEv) {
                bestEv = ev;
                best = { piece, row: threat.row, col: threat.col };
            }
        }
        return best;
    }

    /**
     * Core flag-protection protocol. Priority is survival certainty:
     *   1. A single adjacent threat we can capture for sure (trap / sure win).
     *   2. Escape the flag to a square with no adjacent mobile enemy.
     *   3. Reduce exposure: escape to the least-threatened square.
     *   4. Only then gamble a capture, since losing it dooms the flag anyway.
     *   5. Pre-emptively interpose a defender against a distance-2 approach.
     */
    function tryFlagEmergency(gs, available) {
        const myFlag = getMyFlag(gs);
        if (!myFlag) {
            return null;
        }
        const adjacent = threatsToFlag(gs, myFlag.row, myFlag.col, 1);
        if (adjacent.length > 0) {
            if (adjacent.length === 1) {
                const sure = guaranteedCaptureOf(gs, available, adjacent[0]);
                if (sure) {
                    return sure;
                }
            }
            const escape = bestFlagEscape(gs, myFlag);
            if (escape && escape.adj === 0) {
                return escape;
            }
            if (escape && escape.adj < adjacent.length) {
                return escape;
            }
            if (adjacent.length === 1) {
                const gamble = bestEvCaptureOf(gs, available, adjacent[0]);
                if (gamble) {
                    // Only gamble if the EV is positive or the flag is cornered.
                    const ev = expectedAttackValue(gamble.piece, adjacent[0]);
                    if (ev > 0 || !escape) {
                        return gamble;
                    }
                }
            }
            if (escape) {
                return escape;
            }
            return null;
        }
        return tryPreemptiveFlagDefence(gs, available, myFlag);
    }

    /**
     * Distance-2 prevention: when a mobile enemy is two cells away and our flag
     * is not already shielded by a balanced ring, plug the shared approach cell
     * with a defender. Stops the enemy from ever reaching adjacency.
     */
    function tryPreemptiveFlagDefence(gs, available, myFlag) {
        const near = threatsToFlag(gs, myFlag.row, myFlag.col, 2)
            .filter(e => cheb(e.row, e.col, myFlag.row, myFlag.col) === 2);
        if (near.length === 0) {
            return null;
        }
        const coverage = aiEngine.computeRPSCoverage(myFlag.row, myFlag.col, gs);
        if (coverage.hasTrap && coverage.typeCount >= 2) {
            return null;
        }
        let best = null;
        let bestScore = -Infinity;
        for (let i = 0; i < available.length; i++) {
            const piece = available[i];
            if (!piece || piece.type === FLAG) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, gs);
            for (let j = 0; j < moves.length; j++) {
                const m = moves[j];
                if (gs.board[m.row][m.col]) {
                    continue;
                }
                if (cheb(m.row, m.col, myFlag.row, myFlag.col) !== 1) {
                    continue;
                }
                let covers = 0;
                for (let k = 0; k < near.length; k++) {
                    if (cheb(m.row, m.col, near[k].row, near[k].col) === 1) {
                        covers++;
                    }
                }
                if (covers === 0) {
                    continue;
                }
                if (!safeToLeaveCheck(gs, piece)) {
                    continue;
                }
                const score = covers * 100
                    + (piece.type === TRAP ? 80 : 0)
                    + (piece.revealed ? 0 : 15);
                if (score > bestScore) {
                    bestScore = score;
                    best = { piece, row: m.row, col: m.col };
                }
            }
        }
        return best;
    }

    // =====================================================================
    //  BELIEF-DRIVEN FLAG HUNT
    // =====================================================================

    function tryFlagHunt(gs, available) {
        const candidates = flagCandidates(gs, 1);
        if (candidates.length === 0) {
            return null;
        }
        const top = candidates[0];
        if (top.pFlag < FLAG_PROB_MID) {
            return null;
        }
        const target = top.piece;
        if (!target || target.row < 0) {
            return null;
        }

        // High confidence and a piece is adjacent: strike now. Any non-flag,
        // non-trap attacker beats a flag.
        if (top.pFlag >= FLAG_PROB_HIGH) {
            let strike = null;
            let strikeScore = -Infinity;
            for (let i = 0; i < available.length; i++) {
                const piece = available[i];
                if (!piece || piece.type === FLAG) {
                    continue;
                }
                if (cheb(piece.row, piece.col, target.row, target.col) !== 1) {
                    continue;
                }
                if (!safeToLeaveCheck(gs, piece)) {
                    continue;
                }
                // If the target is revealed as the flag, any piece wins.
                // If hidden, we still strike because P(flag) is very high.
                const score = 1000 + piece.row;
                if (score > strikeScore) {
                    strikeScore = score;
                    strike = { piece, row: target.row, col: target.col };
                }
            }
            if (strike) {
                return strike;
            }
        }

        // Mid confidence: close the distance with the nearest safe hunter,
        // preferring moves that corner the suspect (reduce its escape mobility).
        const chasers = [];
        for (let i = 0; i < available.length; i++) {
            const p = available[i];
            if (p && p.type === 'piece' && !p.immobilized && p.row >= 0) {
                chasers.push(p);
            }
        }
        chasers.sort((a, b) => chebP(a, target) - chebP(b, target));
        const pool = chasers.slice(0, Math.min(4, chasers.length));

        let best = null;
        let bestScore = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const chaser = pool[i];
            if (!safeToLeaveCheck(gs, chaser)) {
                continue;
            }
            const curDist = chebP(chaser, target);
            if (curDist <= 1) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(chaser, gs);
            for (let j = 0; j < moves.length; j++) {
                const m = moves[j];
                const occ = gs.board[m.row][m.col];
                if (occ && occ.owner === PLAYER && occ.revealed) {
                    if (occ.type === TRAP) {
                        continue;
                    }
                    if (occ.type === 'piece' && chaser.pieceType
                        && battleResult(chaser.pieceType, occ.pieceType) !== 'win') {
                        continue;
                    }
                }
                const newDist = cheb(m.row, m.col, target.row, target.col);
                if (newDist >= curDist) {
                    continue;
                }
                if (aiEngine.isShuttlePosition(chaser.id, m.row, m.col)) {
                    continue;
                }
                // Corner pressure: reward cutting the suspect's escape squares.
                let corner = 0;
                for (let d = 0; d < GAME_CONFIG.DIRECTIONS.length; d++) {
                    const dir = GAME_CONFIG.DIRECTIONS[d];
                    const r = target.row + dir[0];
                    const c = target.col + dir[1];
                    if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                        corner++;
                        continue;
                    }
                    if (r === m.row && c === m.col) {
                        corner++;
                        continue;
                    }
                    const cell = gs.board[r][c];
                    if (cell && cell.owner === COMPUTER) {
                        corner++;
                    }
                }
                const score = (curDist - newDist) * 600 * top.pFlag
                    + corner * 30
                    - aiEngine.countRecentMovesOfPiece(chaser.id, 4) * 25
                    + chaser.row;
                if (score > bestScore) {
                    bestScore = score;
                    best = { piece: chaser, row: m.row, col: m.col };
                }
            }
        }
        return best;
    }

    // =====================================================================
    //  EV-GATED ATTACK ON A SUSPECTED FLAG
    //  When the top flag candidate is reachable and P(flag) is high enough,
    //  attack it even if it costs us a piece — capturing the flag ends the
    //  game, so the EV floor scales with confidence.
    // =====================================================================

    function trySuspectStrike(gs, available) {
        const candidates = flagCandidates(gs, 1);
        if (candidates.length === 0) {
            return null;
        }
        const top = candidates[0];
        if (top.pFlag < FLAG_PROB_ATTACK) {
            return null;
        }
        const target = top.piece;
        if (!target || target.row < 0) {
            return null;
        }
        let best = null;
        let bestEv = -Infinity;
        for (let i = 0; i < available.length; i++) {
            const piece = available[i];
            if (!piece || piece.type === FLAG || piece.type === TRAP) {
                continue;
            }
            if (cheb(piece.row, piece.col, target.row, target.col) !== 1) {
                continue;
            }
            if (!safeToLeaveCheck(gs, piece)) {
                continue;
            }
            const ev = expectedAttackValue(piece, target);
            if (ev > bestEv) {
                bestEv = ev;
                best = { piece, row: target.row, col: target.col };
            }
        }
        if (!best) {
            return null;
        }
        // Confidence-scaled EV floor: at pFlag ~ 1 we accept almost any swap;
        // at pFlag ~ 0.42 we need a strongly positive EV.
        const confidence = top.pFlag;
        const evFloor = WIN_SCORE * Math.max(0.05, 0.35 * (1 - confidence));
        if (bestEv >= evFloor) {
            return best;
        }
        return null;
    }

    // =====================================================================
    //  SAFETY OVERLAY
    //  Prefer a near-equal move that does not expose the flag over a slightly
    //  better one that does.
    // =====================================================================

    function isSafeForFlag(gs, move) {
        if (!move) {
            return true;
        }
        const myFlag = getMyFlag(gs);
        if (!myFlag) {
            return true;
        }
        if (move.piece.id === myFlag.id) {
            const after = threatsToFlag(gs, move.row, move.col, 1);
            return after.length === 0;
        }
        return safeToLeaveCheck(gs, move.piece);
    }

    function pickWithSafetyOverlay(gs, available, searched) {
        if (!searched || !searched.move) {
            return null;
        }
        if (isSafeForFlag(gs, searched.move)) {
            return searched.move;
        }
        const myFlag = getMyFlag(gs);
        if (!myFlag || threatsToFlag(gs, myFlag.row, myFlag.col, 2).length === 0) {
            return searched.move;
        }
        const all = aiEngine.getAllFilteredMoves(gs, available);
        const scored = [];
        for (let i = 0; i < all.length; i++) {
            scored.push({ m: all[i], v: aiEngine.evaluateMoveV2(all[i], gs) });
        }
        scored.sort((a, b) => b.v - a.v);
        for (let i = 0; i < Math.min(8, scored.length); i++) {
            if (isSafeForFlag(gs, scored[i].m)) {
                return scored[i].m;
            }
        }
        return searched.move;
    }

    function fallbackMove(gs, available) {
        const all = aiEngine.getAllFilteredMoves(gs, available);
        if (all.length === 0) {
            return null;
        }
        const pool = aiEngine.filterOutShuttleMoves(all);
        return aiEngine.pickFromTopK(pool.length > 0 ? pool : all, gs, 3);
    }

    // =====================================================================
    //  ENTRY POINT
    // =====================================================================

    function move(gameState) {
        try {
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

            // Build the motive profile for this turn — used by the flag hunt,
            // the suspect strike, and the belief-threat evaluator.
            scratch.motives = buildMotives(gameState);

            const top = flagCandidates(gameState, 1)[0];
            scratch.suspectId = top ? top.piece.id : null;
            scratch.suspectPFlag = top ? top.pFlag : 0;
            scratch.myFlagRef = getMyFlag(gameState);

            const available = aiEngine.getActivePieces(gameState);
            if (available.length === 0) {
                return null;
            }

            // 1. Winning move always comes first: take a flag we can see.
            const capture = aiEngine.findFlagCaptureMoves(gameState, available);
            if (capture.length > 0) {
                const grab = aiEngine.pickBestScored(capture, gameState);
                if (grab) {
                    aiEngine.recordAIMove(grab);
                    return grab;
                }
            }

            // 2. Flag survival is the next absolute priority — resolved with
            //    guaranteed-safe responses before any gambling tactic.
            const emergency = tryFlagEmergency(gameState, available);
            if (emergency) {
                aiEngine.recordAIMove(emergency);
                return emergency;
            }

            // 3. Shared tactical core: forced captures / flag defence / hunt on
            //    a near-certain flag candidate. Routed through our motive-aware
            //    deducer so it benefits from the same Bayesian + motive read.
            const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                deducer: deducerForCore,
                flagHuntHorizon: 4,
                antiCluster: true
            });
            if (mandatory) {
                aiEngine.recordAIMove(mandatory);
                return mandatory;
            }

            // 4. EV-gated strike on the most probable flag candidate.
            const strike = trySuspectStrike(gameState, available);
            if (strike) {
                aiEngine.recordAIMove(strike);
                return strike;
            }

            // 5. Belief-driven flag hunt (close in on a mid-confidence suspect).
            const hunt = tryFlagHunt(gameState, available);
            if (hunt) {
                aiEngine.recordAIMove(hunt);
                return hunt;
            }

            // 6. Deep expectimax + alpha-beta search with safety overlay.
            const searched = searchBestMove(gameState, available);
            const picked = pickWithSafetyOverlay(gameState, available, searched);
            if (picked) {
                aiEngine.recordAIMove(picked);
                return picked;
            }

            // 7. Last-resort fallback.
            const fallback = fallbackMove(gameState, available);
            if (fallback) {
                aiEngine.recordAIMove(fallback);
                return fallback;
            }
            return null;
        } catch (e) {
            console.error('[orlenok] move() failed:', e);
            try {
                const pieces = aiEngine.getActivePieces(gameState);
                const fb = fallbackMove(gameState, pieces);
                if (fb) {
                    aiEngine.recordAIMove(fb);
                    return fb;
                }
            } catch (_) {}
            return null;
        }
    }

    // =====================================================================
    //  TIE-BREAK CHOICE (RPS re-roll after a draw)
    //  Orlenok picks the re-roll type that maximises coverage against the
    //  opponent's likely next pick AND keeps a backup counter nearby. This is
    //  exactly the "if I have a rock neighbour, pick paper" reasoning: paper
    //  beats rock (opponent might re-pick the neighbour's type), and if the
    //  opponent picks scissors instead, our rock neighbour counters.
    // =====================================================================

    /**
     * Determine which side Orlenok is playing in this tie view. In a normal
     * game Orlenok is always COMPUTER (top). In dev-mode bot-vs-bot, the bottom
     * bot receives a tie view where its own pieces are in playerPieces. We
     * detect the side by checking which half of the view has no hidden enemies
     * — our own pieces are always unmasked to us.
     */
    function determineMyOwner(view) {
        const hasHiddenEnemy = (arr) => {
            for (let i = 0; i < arr.length; i++) {
                const p = arr[i];
                if (p && !p.removed && p.type === 'piece'
                    && (p.pieceType === null || p.pieceType === undefined)
                    && !p.revealed) {
                    return true;
                }
            }
            return false;
        };
        if (!hasHiddenEnemy(view.aiPieces || [])) {
            return COMPUTER;
        }
        if (!hasHiddenEnemy(view.playerPieces || [])) {
            return PLAYER;
        }
        return COMPUTER;
    }

    function getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
        try {
            const available = aiEngine.getTieBreakAvailableChoices();
            if (!available || available.length === 0) {
                return 'rock';
            }

            const bs = gameState && gameState.battleState;
            const battleRow = bs ? bs.newRow : -1;
            const battleCol = bs ? bs.newCol : -1;
            const myOwner = determineMyOwner(gameState || {});
            const myPieces = myOwner === COMPUTER
                ? (gameState.aiPieces || [])
                : (gameState.playerPieces || []);

            // Our backup types: our RPS pieces adjacent to the battle cell,
            // excluding the piece that is currently in the battle.
            const inBattleIds = new Set();
            if (bs) {
                if (bs.attacker) {
                    inBattleIds.add(bs.attacker.id);
                }
                if (bs.defender) {
                    inBattleIds.add(bs.defender.id);
                }
            }
            const backupTypes = [];
            if (battleRow >= 0) {
                for (let i = 0; i < myPieces.length; i++) {
                    const p = myPieces[i];
                    if (!p || p.removed || p.immobilized) {
                        continue;
                    }
                    if (p.type !== 'piece' || !p.pieceType) {
                        continue;
                    }
                    if (inBattleIds.has(p.id)) {
                        continue;
                    }
                    if (p.owner !== myOwner) {
                        continue;
                    }
                    if (cheb(p.row, p.col, battleRow, battleCol) === 1) {
                        backupTypes.push(p.pieceType);
                    }
                }
            }

            // Predict the opponent's next pick. Humans rarely repeat a losing
            // or drawing throw; they tend to shift to what beats the type that
            // just beat (or drew with) them. We model both common patterns.
            let predictedPick = null;
            if (opponentRevealed && opponentType) {
                // Default cautious assumption: opponent picks what beats our
                // current type (since our current type drew with theirs, the
                // counter to ours is a natural "upgrade").
                predictedPick = beatenByOf(currentType);
            }
            if (bs && bs.lastRound) {
                const theirLast = bs.lastRound.playerChoice
                    || bs.lastRound.opponentChoice;
                if (theirLast) {
                    // If they lost or drew last round with theirLast, a common
                    // human shift is to the type that beats theirLast's counter.
                    // Blend: 50% assume they switch to what beats our current,
                    // 50% assume they re-pick what beats their last pick.
                    const shiftFromLast = beatenByOf(theirLast);
                    if (shiftFromLast && Math.random() < 0.5) {
                        predictedPick = shiftFromLast;
                    }
                }
            }

            // Score each available choice. The DOMINANT term is fist-formation
            // coverage: for every opponent RPS type, +200 if our choice beats
            // it, +100 if a backup neighbour beats it. This is exactly the
            // user's "rock neighbour -> pick paper" principle — paper beats
            // rock (opp might re-pick the neighbour's type) and if the opponent
            // picks scissors instead, the rock neighbour counters. Prediction
            // and anti-repeat are smaller tiebreakers on top.
            let best = available[0];
            let bestScore = -Infinity;
            for (let i = 0; i < available.length; i++) {
                const choice = available[i];
                let score = 0;

                // Fist-formation coverage (dominant term).
                for (let r = 0; r < 3; r++) {
                    const opp = ['rock', 'paper', 'scissors'][r];
                    if (beatsOf(choice) === opp) {
                        score += 200;
                    } else if (backupTypes.some(bt => beatsOf(bt) === opp)) {
                        score += 100;
                    } else {
                        score -= 30;
                    }
                }

                // Safety net: if our choice loses to some type, can a backup
                // counter it? Reinforces the fist principle — losing our paper
                // to scissors is fine when a rock is right there to retaliate.
                const kryptonite = beatenByOf(choice);
                if (backupTypes.some(bt => beatsOf(bt) === kryptonite)) {
                    score += 40;
                } else {
                    score -= 25;
                }

                // Prediction tiebreaker (smaller than coverage): reward beating
                // the opponent's most likely next pick.
                if (predictedPick && beatsOf(choice) === predictedPick) {
                    score += 60;
                }
                // Slight reward for beating the opponent's current type (they
                // might not switch).
                if (opponentType && beatsOf(choice) === opponentType) {
                    score += 25;
                }

                // Slight preference for not repeating our own last pick —
                // keeps the opponent guessing.
                if (choice === currentType) {
                    score -= 8;
                }
                // Tie-break by how many backups share this choice's type — a
                // thicker wall of the same type means a stronger counter-attack
                // if the opponent picks the type we beat.
                let sameBackups = 0;
                for (let b = 0; b < backupTypes.length; b++) {
                    if (backupTypes[b] === choice) {
                        sameBackups++;
                    }
                }
                score += sameBackups * 4;

                if (score > bestScore) {
                    bestScore = score;
                    best = choice;
                }
            }
            return best;
        } catch (e) {
            console.error('[orlenok] getSmartTieChoice failed:', e);
            return 'rock';
        }
    }

    // =====================================================================
    //  PUBLIC DESCRIPTOR
    // =====================================================================

    return {
        id: 'orlenok',
        name: 'Орлёнок',
        emoji: '✦',
        avatar: 'js/bots/orlenok/avatar-min.png',

        shortDescription: 'Байес + мотивы + редуты + expectimax',
        longDescription: 'Байесовская модель мотивов соперника, оборонительные редуты, ' +
            'организованный кулак атаки, expectimax с α-β и шанс-узлами, ' +
            'управление ничьёй и умный переброс при ничьей.',

        algorithmLabel: 'Байес-мотивы + expectimax + α-β + redoubt',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['anthropic', 'claude', 'opus', 'bayesian', 'motive-inference',
            'expectimax', 'alpha-beta', 'quiescence', 'redoubt', 'flag-paranoia',
            'draw-management', 'deception', 'championship'],

        move: move,
        chooseFlagAndTrap: chooseFlagAndTrap,
        getSmartTieChoice: getSmartTieChoice
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = orlenokBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(orlenokBot);
} else {
    throw new Error('[orlenok] RPSBotAPI.defineBot is required (load bot-api.js first)');
}
