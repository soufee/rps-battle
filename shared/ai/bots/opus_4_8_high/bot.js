/**
 * Opus 4.8 High — Anthropic Championship Engine
 *
 * Author: Claude Opus 4.8 (Anthropic)
 *
 * Concept: An honest, belief-first engine for imperfect-information warfare.
 * It never peeks at the true type of a hidden enemy — every decision over an
 * unknown piece flows through a Bayesian opponent model and expected value.
 * On top of that sits a deterministic alpha-beta search (with quiescence and a
 * transposition table) that reasons about revealed-piece tactics, flag races
 * and spatial control, while a paranoid flag-safety layer guards the one piece
 * whose loss ends the game in a single move.
 *
 * "This bot is a demonstration of what Claude Opus 4.8 can build for complex
 * imperfect-information games: calm, calculated, information-greedy, and almost
 * impossible to bait into losing its flag. Named in honor of its creator."
 *
 * Architecture (top to bottom of the decision stack):
 *   1. Shared tactical core   — forced captures, flag defence, certain kills.
 *   2. Paranoid flag safety   — react to hidden + revealed threats with EV.
 *   3. Belief-driven flag hunt — high / mid confidence pursuit of the suspect.
 *   4. Root expectimax        — every legal move scored; attacks on hidden
 *                               enemies expanded as Bayesian chance nodes,
 *                               quiet / revealed lines via deterministic α-β.
 *   5. Safety overlay         — prefer a near-equal move that does not expose
 *                               the flag; reject negative-EV gambles.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[opus_4_8_high] bot-api.js must be loaded BEFORE this bot');
}

const opus48HighBot = (() => {
    'use strict';

    // =====================================================================
    //  TUNING CONSTANTS
    // =====================================================================

    const WIN_SCORE = 1000000;

    const TIME_BUDGET_MS         = 600;
    const TIME_BUDGET_ENDGAME_MS = 900;
    const SEARCH_DEPTH           = 3;
    const SEARCH_DEPTH_ENDGAME   = 5;
    const QUIESCENCE_DEPTH       = 3;
    const MY_BRANCH_LIMIT        = 12;
    const OPP_BRANCH_LIMIT       = 8;

    const HIGH_CONF_FLAG = 0.82;
    const MID_CONF_FLAG  = 0.60;
    const HUNT_HORIZON   = 4;

    // Material values (our side). Hidden pieces are worth more because the
    // opponent still cannot read them — information is an asset.
    const VAL_MY_HIDDEN     = 420;
    const VAL_MY_REVEALED   = 320;
    const VAL_MY_TRAP       = 900;
    const VAL_MY_TRAP_SPENT = 280;

    const VAL_OPP_HIDDEN    = 360;
    const VAL_OPP_REVEALED  = 470;
    const VAL_OPP_TRAP      = 320;
    const VAL_OPP_TRAP_SPENT = 110;

    // Asymmetry factor: losing one of our pieces hurts more than the raw value
    // of an unknown enemy we might remove. Keeps the bot from cheap trades.
    const LOSS_AVERSION = 1.3;

    const UNIFORM_BELIEF = {
        rock: 0.30, paper: 0.30, scissors: 0.30, flag: 0.05, trap: 0.05
    };

    // =====================================================================
    //  EPHEMERAL STATE
    //  Everything that must survive across games lives in the shared engine
    //  modules (which dev-mode slot-swaps correctly). Our own per-move scratch
    //  is rebuilt every turn so two Opus instances cannot corrupt each other.
    // =====================================================================

    const scratch = {
        transposition: new Map(),
        killers: [],
        deadline: 0,
        suspectId: null,
        suspectPFlag: 0,
        nodes: 0
    };

    // =====================================================================
    //  SMALL HELPERS
    // =====================================================================

    function cheb(aRow, aCol, bRow, bCol) {
        return Math.max(Math.abs(aRow - bRow), Math.abs(aCol - bCol));
    }

    function chebP(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    }

    function getMyFlag(gs) {
        return (gs.aiPieces || []).find(p => p.type === FLAG && !p.removed) || null;
    }

    function getEnemyFlag(gs) {
        return (gs.playerPieces || []).find(p => p.type === FLAG && !p.removed) || null;
    }

    function beatenByOf(type) {
        if (type === 'rock') {
            return 'paper';
        }
        if (type === 'paper') {
            return 'scissors';
        }
        return 'rock';
    }

    function beatsOf(type) {
        if (type === 'rock') {
            return 'scissors';
        }
        if (type === 'paper') {
            return 'rock';
        }
        return 'paper';
    }

    function hasBeliefs() {
        return typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && typeof aiBeliefs.getProbDistribution === 'function';
    }

    /**
     * Belief distribution for an enemy piece. Falls back to a uniform prior
     * when no belief exists yet (e.g. right after a memory reset).
     */
    function beliefOf(pieceId) {
        if (hasBeliefs()) {
            const dist = aiBeliefs.getProbDistribution(pieceId);
            if (dist) {
                return dist;
            }
        }
        return UNIFORM_BELIEF;
    }

    /**
     * The type the searching agent (us) is allowed to know for a piece:
     * our own pieces are always known; the opponent's only once revealed.
     * Returns null when the type is genuinely hidden from us — this is the
     * single rule that keeps the engine honest about imperfect information.
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

    /**
     * Top-N enemy pieces by P(flag). Routed through the Bayesian model, with a
     * stillness-based fallback for the opening before beliefs have any signal.
     */
    function flagCandidates(gs, n) {
        const topN = n || 3;
        if (hasBeliefs() && typeof aiBeliefs.getFlagCandidates === 'function') {
            const list = aiBeliefs.getFlagCandidates(gs, topN);
            if (list && list.length > 0) {
                return list.map(c => ({ piece: c.piece, pFlag: c.pFlag }));
            }
        }
        const suspected = aiEngine.getSuspectedFlagCandidates(gs);
        const out = [];
        let sum = 0;
        for (const entry of suspected) {
            sum += Math.max(1, entry.score + 1);
        }
        for (let i = 0; i < Math.min(suspected.length, topN); i++) {
            const score = Math.max(1, suspected[i].score + 1);
            out.push({ piece: suspected[i].piece, pFlag: sum > 0 ? score / sum : 0 });
        }
        return out;
    }

    /**
     * Adapter so the shared tactical core can use our Bayesian deducer.
     */
    function deducerForCore(gs) {
        const candidates = flagCandidates(gs, 3);
        const hiddenCount = (gs.playerPieces || []).filter(p =>
            !p.removed && p.row >= 0 && !p.revealed && p.type !== TRAP
        ).length;
        return {
            candidates: candidates.map(c => ({ piece: c.piece, prob: c.pFlag })),
            hiddenCount: hiddenCount
        };
    }

    // =====================================================================
    //  PLACEMENT
    //  A flag tucked into (or one step off) a corner, with the trap covering
    //  the diagonal cell — the hardest square for an attacker to reach without
    //  walking past a defender. Several templates plus randomisation keep the
    //  layout unmemorable across a long match series.
    // =====================================================================

    function chooseFlagAndTrap() {
        const templates = [
            { flag: 0,  trap: 9 },
            { flag: 7,  trap: 14 },
            { flag: 1,  trap: 8 },
            { flag: 6,  trap: 15 },
            { flag: 0,  trap: 1 },
            { flag: 7,  trap: 6 },
            { flag: 1,  trap: 10 },
            { flag: 6,  trap: 13 }
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
            if (e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
                continue;
            }
            if (cheb(e.row, e.col, flagRow, flagCol) <= radius) {
                out.push(e);
            }
        }
        return out;
    }

    function safeToLeave(gs, piece) {
        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && typeof aiTacticalCore.safeToLeave === 'function') {
            return aiTacticalCore.safeToLeave(gs, piece);
        }
        return true;
    }

    // =====================================================================
    //  EXPECTED-VALUE COMBAT ARITHMETIC
    //  All reasoning about attacking an unknown enemy is funnelled through
    //  the belief distribution — we never read a hidden piece's real type.
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
            return -VAL_MY_REVEALED * LOSS_AVERSION;
        }
        if (attacker.type === TRAP) {
            return VAL_OPP_REVEALED;
        }
        if (attacker.type !== 'piece' || !attacker.pieceType) {
            return 0;
        }
        const verdict = RPSBotAPI.resolveBattle(attacker.pieceType, tType);
        if (verdict === 'win') {
            return VAL_OPP_REVEALED;
        }
        if (verdict === 'lose') {
            return -VAL_MY_REVEALED * LOSS_AVERSION;
        }
        return -30;
    }

    function hiddenAttackValue(attacker, target) {
        const belief = beliefOf(target.id);
        const pFlag = belief.flag || 0;
        const pTrap = belief.trap || 0;
        let ev = 0;

        ev += pFlag * WIN_SCORE;
        ev += pTrap * (-VAL_MY_HIDDEN * LOSS_AVERSION);

        if (attacker.type === 'piece' && attacker.pieceType) {
            const beats = beatsOf(attacker.pieceType);
            const beatenBy = beatenByOf(attacker.pieceType);
            const pWin = belief[beats] || 0;
            const pLose = belief[beatenBy] || 0;
            const pDraw = belief[attacker.pieceType] || 0;
            ev += pWin * VAL_OPP_HIDDEN;
            ev += pLose * (-VAL_MY_HIDDEN * LOSS_AVERSION);
            ev += pDraw * (-18);
        } else if (attacker.type === TRAP) {
            const rpsMass = (belief.rock || 0) + (belief.paper || 0) + (belief.scissors || 0);
            ev += rpsMass * VAL_OPP_HIDDEN * 0.65;
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
        for (const p of gs.aiPieces || []) {
            const c = clonePiece(p);
            aiPieces.push(c);
            if (!c.removed && c.row >= 0) {
                board[c.row][c.col] = c;
            }
        }
        for (const p of gs.playerPieces || []) {
            const c = clonePiece(p);
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
     * move is either quiet or a capture we are certain to win (revealed target
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
        for (const piece of pieces) {
            if (piece.removed || piece.immobilized || piece.row < 0) {
                continue;
            }
            const attackerType = knownType(piece);
            for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
                const nr = piece.row + dr;
                const nc = piece.col + dc;
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
                // Paranoid asymmetry: we always assume the opponent can take our
                // flag if it can reach its square (even while hidden), so the
                // search actively defends it. We only chase THEIR flag when we
                // have actually identified it (revealed).
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
                if (RPSBotAPI.resolveBattle(attackerType, tType) === 'win') {
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
        score += scoreCoordination(state);
        score += scoreProgression(state);
        score += scoreBeliefThreats(state);
        return score;
    }

    function scoreMaterial(state) {
        let s = 0;
        for (const p of state.aiPieces) {
            if (p.removed || p.row < 0) {
                continue;
            }
            if (p.type === FLAG) {
                continue;
            }
            if (p.type === TRAP) {
                s += p.immobilized ? VAL_MY_TRAP_SPENT : VAL_MY_TRAP;
            } else {
                s += p.revealed ? VAL_MY_REVEALED : VAL_MY_HIDDEN;
            }
        }
        for (const p of state.playerPieces) {
            if (p.removed || p.row < 0) {
                continue;
            }
            if (p.type === FLAG) {
                continue;
            }
            if (p.type === TRAP) {
                s -= p.immobilized ? VAL_OPP_TRAP_SPENT : VAL_OPP_TRAP;
            } else {
                s -= p.revealed ? VAL_OPP_REVEALED : VAL_OPP_HIDDEN;
            }
        }
        return s;
    }

    function scoreFlagSafety(state, myFlag) {
        let s = 0;

        let escapes = 0;
        for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
            const r = myFlag.row + dr;
            const c = myFlag.col + dc;
            if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                continue;
            }
            if (!state.board[r][c]) {
                escapes++;
            }
        }
        s += escapes * 16;

        let nearest = Infinity;
        for (const e of state.playerPieces) {
            if (e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
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

        let defenders = 0;
        const types = new Set();
        let hasTrap = false;
        for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
            const r = myFlag.row + dr;
            const c = myFlag.col + dc;
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
        s += types.size * 80;
        if (hasTrap) {
            s += 360;
        }
        if (nearest <= 3 && defenders === 0 && !hasTrap) {
            s -= 1200;
        }
        return s;
    }

    function scoreEnemyFlagPressure(state, enemyFlag) {
        let s = 0;
        const attackers = state.aiPieces.filter(p =>
            !p.removed && p.row >= 0 && !p.immobilized && p.type === 'piece'
        );

        if (enemyFlag.revealed) {
            for (const a of attackers) {
                s += (6 - Math.min(6, chebP(a, enemyFlag))) * 55;
            }
            return s;
        }

        if (!scratch.suspectId || scratch.suspectPFlag < 0.25) {
            return 0;
        }
        const suspect = state.playerPieces.find(p =>
            p.id === scratch.suspectId && !p.removed && p.row >= 0
        );
        if (!suspect) {
            return 0;
        }
        for (const a of attackers) {
            s += (6 - Math.min(6, chebP(a, suspect))) * 34 * scratch.suspectPFlag;
        }
        return s;
    }

    function scoreCoordination(state) {
        const attackers = [];
        for (const p of state.aiPieces) {
            if (!p.removed && p.row >= 0 && p.type === 'piece') {
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
        for (const p of state.aiPieces) {
            if (p.removed || p.row < 0 || p.type !== 'piece') {
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
     * "always keep a counter in range".
     */
    /**
     * Reward standing next to hidden enemies we likely beat (in EV) and punish
     * standing next to hidden enemies that likely beat us — the spatial echo of
     * "always keep a counter in range".
     */
    function scoreBeliefThreats(state) {
        if (!hasBeliefs()) {
            return 0;
        }
        let s = 0;
        for (const ally of state.aiPieces) {
            if (ally.removed || ally.row < 0 || ally.type !== 'piece' || !ally.pieceType) {
                continue;
            }
            const beats = beatsOf(ally.pieceType);
            const beatenBy = beatenByOf(ally.pieceType);
            for (const e of state.playerPieces) {
                if (e.removed || e.row < 0 || e.immobilized || e.revealed) {
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
                    s -= belief.trap * 38;
                }
            }
        }
        return s;
    }

    // =====================================================================
    //  MOVE ORDERING (alpha-beta acceleration)
    // =====================================================================

    function orderMoves(state, moves, owner) {
        const scored = moves.map(m => {
            let pri = Math.random() * 2;
            if (m.capture) {
                pri += 800;
                const target = state.board[m.row][m.col];
                if (target && knownType(target) === FLAG) {
                    pri += 9000;
                }
            }
            for (const k of scratch.killers) {
                if (k
                    && k.id === m.piece.id
                    && k.row === m.row
                    && k.col === m.col) {
                    pri += 500;
                    break;
                }
            }
            pri += owner === COMPUTER ? m.row * 5 : (BOARD_HEIGHT - m.row) * 5;
            return { m, pri };
        });
        scored.sort((a, b) => b.pri - a.pri);
        return scored.map(x => x.m);
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
        const moves = genDeterministicMoves(state, owner).filter(m => m.capture);
        if (moves.length === 0) {
            return standPat;
        }
        const ordered = orderMoves(state, moves, owner);
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
            p.row === move.row && p.col === move.col && !p.removed
        );
        if (!target) {
            return -Infinity;
        }
        const belief = beliefOf(target.id);
        const pFlag = belief.flag || 0;
        const pTrap = belief.trap || 0;

        let ev = pFlag * WIN_SCORE;

        // Trap branch: our attacker dies, the trap is immobilised.
        {
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
                // A draw reveals both pieces and re-rolls; positions are
                // unchanged. Treat it as a mildly negative tempo event.
                const drawState = cloneState(gs);
                const tg = drawState.playerPieces.find(p => p.id === target.id);
                if (tg) {
                    tg.revealed = true;
                }
                ev += pDraw * (evaluate(drawState) - 25);
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
        for (const piece of available) {
            const moves = aiEngine.getMovesForPiece(piece, gs);
            for (const m of moves) {
                candidates.push({ piece, row: m.row, col: m.col });
            }
        }
        if (candidates.length === 0) {
            return null;
        }

        let best = null;
        let bestScore = -Infinity;
        for (const move of candidates) {
            if (Date.now() > scratch.deadline && best) {
                break;
            }
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
     * Root-only shaping that the deep search cannot express well: anti-shuttle,
     * over-activity, cluster risk, and a nudge toward keeping the army honest.
     */
    function rootShaping(gs, move, myFlag) {
        let s = 0;
        // Discourage wandering the flag out of a safe square for no reason —
        // the emergency layer owns deliberate flag escapes.
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
        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && typeof aiTacticalCore.clusterPenalty === 'function') {
            s -= aiTacticalCore.clusterPenalty(gs, move.piece, move);
        }
        if (myFlag && move.piece.id !== myFlag.id) {
            const before = chebP(move.piece, myFlag);
            const after = cheb(move.row, move.col, myFlag.row, myFlag.col);
            const threats = threatsToFlag(gs, myFlag.row, myFlag.col, 2);
            if (threats.length > 0 && before <= 1 && after > before) {
                if (!safeToLeave(gs, move.piece)) {
                    s -= 600;
                }
            }
        }
        return s;
    }

    // =====================================================================
    //  PARANOID FLAG SAFETY
    //  The tactical core handles a revealed enemy adjacent to our flag. We add
    //  protection against the quieter killer: a hidden enemy that just stepped
    //  next to our flag and can take it on its next move.
    // =====================================================================

    /**
     * Number of mobile (can-attack) enemies adjacent to a cell.
     */
    function mobileEnemiesAdjacent(gs, row, col) {
        return threatsToFlag(gs, row, col, 1).length;
    }

    /**
     * Find the flag's safest legal escape square. Returns the candidate with
     * the fewest adjacent mobile enemies, breaking ties by defender coverage
     * and raw distance from the nearest enemy. Never lands on an occupied cell.
     */
    function bestFlagEscape(gs, myFlag) {
        const moves = aiEngine.getMovesForPiece(myFlag, gs);
        let best = null;
        let bestKey = null;
        for (const m of moves) {
            if (gs.board[m.row][m.col]) {
                continue;
            }
            const adj = mobileEnemiesAdjacent(gs, m.row, m.col);
            const coverage = aiEngine.computeRPSCoverage(m.row, m.col, gs);
            let nearest = Infinity;
            for (const e of gs.playerPieces) {
                if (e.removed || e.row < 0 || e.immobilized || e.type === FLAG) {
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
                best = { piece: myFlag, row: m.row, col: m.col, adj: adj };
            }
        }
        return best;
    }

    /**
     * Best guaranteed neutralisation of a single adjacent threat:
     * a trap that can eat it, or a revealed piece we are certain to beat.
     */
    function guaranteedCaptureOf(gs, available, threat) {
        let trapMove = null;
        let winMove = null;
        for (const piece of available) {
            if (piece.type === FLAG) {
                continue;
            }
            if (cheb(piece.row, piece.col, threat.row, threat.col) !== 1) {
                continue;
            }
            if (piece.type === TRAP) {
                trapMove = { piece, row: threat.row, col: threat.col };
                continue;
            }
            if (threat.revealed
                && threat.type === 'piece'
                && piece.type === 'piece'
                && piece.pieceType
                && RPSBotAPI.resolveBattle(piece.pieceType, threat.pieceType) === 'win') {
                winMove = { piece, row: threat.row, col: threat.col };
            }
        }
        return trapMove || winMove;
    }

    /**
     * Highest-expectation capture of a threat when no guaranteed option exists.
     * Only returned as a last resort — gambling the defence is worse than a
     * clean escape, so callers try escape first.
     */
    function bestEvCaptureOf(gs, available, threat) {
        let best = null;
        let bestEv = -Infinity;
        for (const piece of available) {
            if (piece.type === FLAG) {
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
     * The core flag-protection protocol. Priority is survival certainty:
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
                    return gamble;
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
     * is not already shielded by a trap, plug the shared approach cell with a
     * defender (preferring one that keeps balanced coverage). This stops the
     * enemy from ever reaching adjacency.
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
        for (const piece of available) {
            if (piece.type === FLAG) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, gs);
            for (const m of moves) {
                if (gs.board[m.row][m.col]) {
                    continue;
                }
                if (cheb(m.row, m.col, myFlag.row, myFlag.col) !== 1) {
                    continue;
                }
                let covers = 0;
                for (const e of near) {
                    if (cheb(m.row, m.col, e.row, e.col) === 1) {
                        covers++;
                    }
                }
                if (covers === 0) {
                    continue;
                }
                if (!safeToLeave(gs, piece)) {
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
        if (top.pFlag < MID_CONF_FLAG) {
            return null;
        }
        const target = top.piece;
        if (!target || target.row < 0) {
            return null;
        }

        // High confidence and a piece is adjacent: strike now.
        if (top.pFlag >= HIGH_CONF_FLAG) {
            let strike = null;
            let strikeScore = -Infinity;
            for (const piece of available) {
                if (piece.type === FLAG) {
                    continue;
                }
                if (cheb(piece.row, piece.col, target.row, target.col) !== 1) {
                    continue;
                }
                if (!safeToLeave(gs, piece)) {
                    continue;
                }
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

        // Otherwise close the distance with the nearest safe hunter.
        const chasers = available
            .filter(p => p.type === 'piece' && !p.immobilized && p.row >= 0)
            .sort((a, b) => chebP(a, target) - chebP(b, target));
        const pool = chasers.slice(0, Math.min(4, chasers.length));

        let best = null;
        let bestScore = -Infinity;
        for (const chaser of pool) {
            if (!safeToLeave(gs, chaser)) {
                continue;
            }
            const curDist = chebP(chaser, target);
            if (curDist <= 1) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(chaser, gs);
            for (const m of moves) {
                const occ = gs.board[m.row][m.col];
                if (occ && occ.owner === PLAYER && occ.revealed) {
                    if (occ.type === TRAP) {
                        continue;
                    }
                    if (occ.type === 'piece'
                        && chaser.pieceType
                        && RPSBotAPI.resolveBattle(chaser.pieceType, occ.pieceType) !== 'win') {
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
                const score = (curDist - newDist) * 600 * top.pFlag
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
    //  SAFETY OVERLAY
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
        return safeToLeave(gs, move.piece);
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
        const scored = all.map(m => ({ m, v: aiEngine.evaluateMoveV2(m, gs) }));
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

            const top = flagCandidates(gameState, 1)[0];
            scratch.suspectId = top ? top.piece.id : null;
            scratch.suspectPFlag = top ? top.pFlag : 0;

            const available = aiEngine.getActivePieces(gameState);
            if (available.length === 0) {
                return null;
            }

            // Winning move always comes first: take a flag we can actually see.
            const capture = aiEngine.findFlagCaptureMoves(gameState, available);
            if (capture.length > 0) {
                const grab = aiEngine.pickBestScored(capture, gameState);
                if (grab) {
                    aiEngine.recordAIMove(grab);
                    return grab;
                }
            }

            // Flag survival is the next absolute priority — resolved with
            // guaranteed-safe responses before any gambling tactic.
            const emergency = tryFlagEmergency(gameState, available);
            if (emergency) {
                aiEngine.recordAIMove(emergency);
                return emergency;
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

            const hunt = tryFlagHunt(gameState, available);
            if (hunt) {
                aiEngine.recordAIMove(hunt);
                return hunt;
            }

            const searched = searchBestMove(gameState, available);
            const picked = pickWithSafetyOverlay(gameState, available, searched);
            if (picked) {
                aiEngine.recordAIMove(picked);
                return picked;
            }

            const fallback = fallbackMove(gameState, available);
            if (fallback) {
                aiEngine.recordAIMove(fallback);
                return fallback;
            }
            return null;
        } catch (e) {
            console.error('[opus_4_8_high] move() failed:', e);
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
    //  PUBLIC DESCRIPTOR
    // =====================================================================

    return {
        id: 'opus_4_8_high',
        name: 'Opus 4.8',
        emoji: '✦',
        avatar: 'js/bots/opus_4_8_high/avatar-min.png',

        shortDescription: 'Честный байес, expectimax и защита флага',
        longDescription: 'Честный байес, α-β и expectimax. Закрывает флаг от скрытых угроз.',

        algorithmLabel: 'Байес + expectimax + α-β + quiescence',
        modelAuthor: 'Anthropic · Claude Opus 4.8',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['anthropic', 'claude', 'opus', 'bayesian', 'expectimax',
               'alpha-beta', 'quiescence', 'flag-paranoia', 'championship'],

        move: move,
        chooseFlagAndTrap: chooseFlagAndTrap
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = opus48HighBot;
}

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(opus48HighBot);
} else {
    throw new Error('[opus_4_8_high] RPSBotAPI.defineBot is required (load bot-api.js first)');
}
