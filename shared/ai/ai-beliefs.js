import { BOARD_HEIGHT } from '../game-config.js';

/**
 * Вероятностная модель типов фигур игрока (Beliefs)
 *
 * Для каждой неизвестной фигуры игрока хранится распределение вероятностей
 * по пяти типам: rock, paper, scissors, trap, flag. Распределение обновляется
 * по двум каналам:
 *   1. Базовые наблюдения (этап 2): сам факт движения, начальная позиция,
 *      факт раскрытия в бою.
 *   2. Тонкие байесовские сигналы (этап 3): кто куда ушёл относительно наших
 *      открытых фигур, фланговая активность, и т.п.
 *
 * Используется только экспертным Ёжиком (moveLevel3). Енот и Заяц его не дёргают.
 *
 * Правила начального априора:
 *   - Задний ряд игрока (row 5): P(flag) = 0.12, P(trap) = 0.08, RPS ≈ 0.267.
 *   - Передний ряд игрока (row 4): P(flag) = 0.03, P(trap) = 0.03, RPS ≈ 0.313.
 *   - После init() сумма P(flag) по всем 16 фигурам нормализуется к 1,
 *     сумма P(trap) — тоже к 1 (у игрока ровно один флаг и один капкан).
 */

const aiBeliefs = {
    // pieceId -> {
    //   probs: {rock, paper, scissors, trap, flag},
    //   moved: boolean,
    //   stillTurns: number,
    //   lastMoveTurn: number | null,
    //   firstMoveTurn: number | null,
    //   lastKnownRow, lastKnownCol,
    //   battles: [{turn, revealedType, outcome}]
    // }
    beliefs: new Map(),
    
    // Monotonic turn counter (every new AI turn ticks +1)
    turn: 0,
    
    // Positional priors (row-based). Player back row is row 5, front row is row 4.
    // Normalized in init() so that Σ P(flag) = 1 and Σ P(trap) = 1 over all 16 pieces.
    FLAG_PRIOR_BY_ROW: { 5: 0.12, 4: 0.03 },
    TRAP_PRIOR_BY_ROW: { 5: 0.08, 4: 0.03 },
    
    // How many player moves started from each flank (only used in early game).
    flankActivity: { left: 0, center: 0, right: 0 },
    
    // Debug toggle: when true, belief updates are logged to the console.
    debug: false,
    
    /**
     * Initialize beliefs for every piece the player owns.
     * Call once at the start of a game, after placePlayerPieces + placeComputerPieces.
     */
    init(gameState) {
        this.beliefs.clear();
        this.turn = 0;
        
        const pieces = (gameState && gameState.playerPieces) || [];
        if (pieces.length === 0) {
            return;
        }
        
        let flagSum = 0;
        let trapSum = 0;
        for (const p of pieces) {
            flagSum += this.FLAG_PRIOR_BY_ROW[p.row] || 0.04;
            trapSum += this.TRAP_PRIOR_BY_ROW[p.row] || 0.04;
        }
        if (flagSum <= 0) { flagSum = 1; }
        if (trapSum <= 0) { trapSum = 1; }
        
        for (const piece of pieces) {
            const pFlag = (this.FLAG_PRIOR_BY_ROW[piece.row] || 0.04) / flagSum;
            const pTrap = (this.TRAP_PRIOR_BY_ROW[piece.row] || 0.04) / trapSum;
            const rest = Math.max(1 - pFlag - pTrap, 0.03);
            const pRps = rest / 3;
            
            this.beliefs.set(piece.id, {
                probs: {
                    rock: pRps,
                    paper: pRps,
                    scissors: pRps,
                    trap: pTrap,
                    flag: pFlag
                },
                moved: false,
                stillTurns: 0,
                lastMoveTurn: null,
                firstMoveTurn: null,
                lastKnownRow: piece.row,
                lastKnownCol: piece.col,
                battles: []
            });
        }
        
        if (this.debug) {
            console.debug('[aiBeliefs] init with', pieces.length, 'pieces');
        }
    },
    
    /**
     * Wipe all state. Called from aiEngine.resetMemory on newGame.
     */
    reset() {
        this.beliefs.clear();
        this.turn = 0;
        this.flankActivity = { left: 0, center: 0, right: 0 };
    },
    
    /**
     * Called at the start of every AI turn.
     * Increments turn counter and bumps stillTurns for all pieces that
     * haven't moved since the last tick.
     */
    tick(turn) {
        if (typeof turn === 'number') {
            this.turn = turn;
        } else {
            this.turn += 1;
        }
        for (const b of this.beliefs.values()) {
            if (!b.moved || b.lastMoveTurn !== this.turn) {
                b.stillTurns += 1;
            }
        }
    },
    
    /**
     * Record a player move. Basic update: moving makes trap very unlikely
     * and flag less likely. Tonкие сигналы накладываются в этапе 3 через
     * applyMovementSignals(...) — сейчас он вызывается внутри.
     */
    onPlayerMove(pieceId, fromRow, fromCol, toRow, toCol, gameState) {
        const b = this.beliefs.get(pieceId);
        if (!b) {
            return;
        }
        
        const wasFirstMove = (b.firstMoveTurn == null);
        if (wasFirstMove) {
            b.firstMoveTurn = this.turn;
        }
        b.lastMoveTurn = this.turn;
        b.moved = true;
        b.stillTurns = 0;
        b.lastKnownRow = toRow;
        b.lastKnownCol = toCol;
        
        // Any movement is strong evidence against trap (trap never moves by choice
        // in logical play: it wants to stay close to the flag as a shield).
        // Movement is mild evidence against flag.
        b.probs.trap *= 0.2;
        b.probs.flag *= 0.5;
        
        if (!wasFirstMove) {
            // Moving a second time — trap is essentially ruled out and flag is very unlikely.
            b.probs.trap = 0;
            b.probs.flag *= 0.3;
        }
        
        this.applyMovementSignals(b, fromRow, fromCol, toRow, toCol, gameState);
        this._normalize(b.probs);
        
        // Update flank activity counter and rebalance flag P across still pieces.
        const flank = this._flankOf(fromCol);
        this.flankActivity[flank] += 1;
        this.applyFlankActivity(gameState);
        
        // Global uniqueness / survivability constraints: exactly one flag and
        // one trap can live among the player's hidden pieces. After every
        // movement update, redistribute flag/trap mass so that Σ P(flag) = 1
        // (if the flag is still alive and hidden) and Σ P(trap) = 1 similarly.
        this.applyConstraints(gameState);
        
        if (this.debug) {
            console.debug('[aiBeliefs] onPlayerMove', pieceId, fromRow, fromCol, '->', toRow, toCol, b.probs);
        }
    },
    
    /**
     * Called after a battle where one of the player's pieces was revealed.
     * revealedType — actual type ('rock'|'paper'|'scissors'|'trap'|'flag') or null
     * if no reveal happened (shouldn't happen in RPS, kept for safety).
     */
    onBattle(pieceId, revealedType, outcome, turn) {
        const b = this.beliefs.get(pieceId);
        if (!b) {
            return;
        }
        b.battles.push({ turn: turn != null ? turn : this.turn, revealedType, outcome });
        if (revealedType) {
            for (const k of Object.keys(b.probs)) {
                b.probs[k] = (k === revealedType) ? 1 : 0;
            }
        }
    },
    
    /**
     * Drop belief for a removed piece so it doesn't pollute flag candidates.
     */
    onPieceRemoved(pieceId) {
        this.beliefs.delete(pieceId);
    },
    
    /**
     * Return a fresh copy of the probability distribution for a piece.
     */
    getProbDistribution(pieceId) {
        const b = this.beliefs.get(pieceId);
        if (!b) {
            return null;
        }
        return { ...b.probs };
    },
    
    /**
     * Return the internal belief object (readonly intent).
     */
    getBelief(pieceId) {
        return this.beliefs.get(pieceId) || null;
    },
    
    /**
     * Return top-N player pieces sorted by P(flag), only considering still-alive,
     * not-yet-revealed (or revealed as flag) pieces on the board.
     */
    getFlagCandidates(gameState, topN) {
        const n = topN || 3;
        const list = [];
        const pieces = (gameState && gameState.playerPieces) || [];
        for (const piece of pieces) {
            if (piece.removed || piece.row < 0) {
                continue;
            }
            if (piece.revealed && piece.type !== FLAG) {
                continue;
            }
            const b = this.beliefs.get(piece.id);
            const pFlag = b ? b.probs.flag : 0;
            list.push({ piece, pieceId: piece.id, pFlag });
        }
        list.sort((a, b) => b.pFlag - a.pFlag);
        return list.slice(0, n);
    },
    
    /**
     * Return argmax type for a piece. 'unknown' if no belief.
     */
    getMostLikelyType(pieceId) {
        const b = this.beliefs.get(pieceId);
        if (!b) {
            return 'unknown';
        }
        let best = 'rock';
        let bestP = -1;
        for (const k of Object.keys(b.probs)) {
            if (b.probs[k] > bestP) {
                bestP = b.probs[k];
                best = k;
            }
        }
        return best;
    },
    
    /**
     * Bayesian update for a specific move: interprets "retreat from our revealed
     * piece" and "approach to our revealed piece" patterns. Only revealed RPS
     * pieces of ours produce signals — trap/flag of ours don't.
     */
    applyMovementSignals(belief, fromRow, fromCol, toRow, toCol, gameState) {
        const ourPieces = (gameState && gameState.aiPieces) || [];
        for (const ours of ourPieces) {
            if (ours.removed || ours.row < 0) {
                continue;
            }
            if (!ours.revealed) {
                continue;
            }
            if (ours.type !== 'piece') {
                continue;
            }
            if (!ours.pieceType) {
                continue;
            }
            const distOld = Math.max(Math.abs(ours.row - fromRow), Math.abs(ours.col - fromCol));
            const distNew = Math.max(Math.abs(ours.row - toRow), Math.abs(ours.col - toCol));
            const inOld = (distOld === 1);
            const inNew = (distNew === 1);
            if (inOld && !inNew) {
                this._applyRetreatSignal(belief.probs, ours.pieceType);
            } else if (!inOld && inNew) {
                this._applyApproachSignal(belief.probs, ours.pieceType);
            }
        }
    },
    
    /**
     * Player moved AWAY from our revealed piece of type ourType.
     * Most likely interpretations:
     *   - Piece was the RPS type that ourType beats (so it was losing).
     *   - Piece might be the flag (flags always want to stay safe).
     *   - Piece being the RPS type that beats ourType is unlikely — it would attack instead.
     */
    _applyRetreatSignal(probs, ourType) {
        if (ourType === 'rock') {
            probs.scissors *= 2.0;
            probs.flag *= 1.4;
            probs.paper *= 0.5;
        } else if (ourType === 'paper') {
            probs.rock *= 2.0;
            probs.flag *= 1.4;
            probs.scissors *= 0.5;
        } else if (ourType === 'scissors') {
            probs.paper *= 2.0;
            probs.flag *= 1.4;
            probs.rock *= 0.5;
        }
    },
    
    /**
     * Player moved TOWARD our revealed piece of type ourType.
     * Most likely interpretations:
     *   - Piece is the RPS type that beats ourType (confident attack).
     *   - It's almost certainly not the flag (flag doesn't initiate).
     */
    _applyApproachSignal(probs, ourType) {
        if (ourType === 'rock') {
            probs.paper *= 2.5;
            probs.flag *= 0.1;
            probs.scissors *= 0.3;
        } else if (ourType === 'paper') {
            probs.scissors *= 2.5;
            probs.flag *= 0.1;
            probs.rock *= 0.3;
        } else if (ourType === 'scissors') {
            probs.rock *= 2.5;
            probs.flag *= 0.1;
            probs.paper *= 0.3;
        }
    },
    
    /**
     * Flank of a column: left (0-2), center (3-4), right (5-7).
     */
    _flankOf(col) {
        if (col <= 2) { return 'left'; }
        if (col >= 5) { return 'right'; }
        return 'center';
    },
    
    /**
     * If the player has shown strong activity on one flank in the opening
     * (first ~10 moves, ≥3 moves from a flank), the flag is more likely to be
     * on the quiet flank.
     */
    applyFlankActivity(gameState) {
        if (this.turn > 10) {
            return;
        }
        const threshold = 3;
        const leftActive = this.flankActivity.left >= threshold;
        const rightActive = this.flankActivity.right >= threshold;
        if (!leftActive && !rightActive) {
            return;
        }
        const pieces = (gameState && gameState.playerPieces) || [];
        const backRow = BOARD_HEIGHT - 1;
        for (const piece of pieces) {
            if (piece.removed || piece.row < 0) {
                continue;
            }
            const b = this.beliefs.get(piece.id);
            if (!b || b.moved) {
                continue;
            }
            if (piece.row !== backRow) {
                continue;
            }
            const flank = this._flankOf(piece.col);
            let flagMult = 1;
            if (flank === 'left') {
                if (leftActive) { flagMult *= 0.4; }
                if (rightActive && !leftActive) { flagMult *= 1.5; }
            } else if (flank === 'right') {
                if (rightActive) { flagMult *= 0.4; }
                if (leftActive && !rightActive) { flagMult *= 1.5; }
            }
            if (flagMult !== 1) {
                b.probs.flag *= flagMult;
                this._normalize(b.probs);
            }
        }
    },
    
    _normalize(probs) {
        let s = 0;
        for (const k of Object.keys(probs)) {
            if (probs[k] < 0 || !isFinite(probs[k])) {
                probs[k] = 0;
            }
            s += probs[k];
        }
        if (s <= 0) {
            probs.rock = 1 / 3;
            probs.paper = 1 / 3;
            probs.scissors = 1 / 3;
            probs.flag = 0;
            probs.trap = 0;
            return;
        }
        for (const k of Object.keys(probs)) {
            probs[k] = probs[k] / s;
        }
    },
    
    /**
     * Global uniqueness constraints. The player's side has exactly one flag
     * and exactly one trap. Over the pool of hidden (not-revealed, not-removed)
     * player pieces, Σ P(flag) must equal 1 while the flag is still hidden,
     * and Σ P(trap) must equal 1 while the trap is hidden.
     *
     * Method:
     *   1) Zero out categories that are known to be outside the hidden pool.
     *   2) If only one hidden piece remains, collapse it: everything it can
     *      still be by (1) is its certain type. In practice that means one
     *      hidden piece + flag alive + trap dead => it's the flag with P = 1.
     *   3) Otherwise run IPF (12 iterations is enough for this board size) with
     *      a final "snap" step: if a piece holds ≥ 99% of the flag mass, it
     *      becomes the flag and every other hidden piece gets P(flag) = 0.
     *
     * Call this after every belief update (onPlayerMove does it automatically)
     * and at the start of each AI turn before taking decisions.
     */
    applyConstraints(gameState) {
        if (!gameState) {
            return;
        }
        const pieces = gameState.playerPieces || [];
        
        let flagAlive = true;
        let trapAlive = true;
        for (const p of pieces) {
            if (p.removed) {
                if (p.type === 'flag') { flagAlive = false; }
                if (p.type === 'trap') { trapAlive = false; }
                continue;
            }
            if (p.revealed) {
                if (p.type === 'flag') { flagAlive = false; }
                if (p.type === 'trap') { trapAlive = false; }
            }
        }
        
        const hidden = [];
        for (const p of pieces) {
            if (p.removed || p.row < 0 || p.revealed) {
                continue;
            }
            const b = this.beliefs.get(p.id);
            if (!b) {
                continue;
            }
            hidden.push(b);
        }
        if (hidden.length === 0) {
            return;
        }
        
        // Zero out impossible categories.
        for (const b of hidden) {
            if (!flagAlive) { b.probs.flag = 0; }
            if (!trapAlive) { b.probs.trap = 0; }
        }
        
        // Fast path: single hidden piece. It must be whichever categories are
        // still alive. If only one lives, it's deterministic.
        if (hidden.length === 1) {
            const b = hidden[0];
            const aliveTypes = [];
            if (flagAlive) { aliveTypes.push('flag'); }
            if (trapAlive) { aliveTypes.push('trap'); }
            aliveTypes.push('rock', 'paper', 'scissors');
            // If only the flag can be "hidden" here, snap to flag.
            // The RPS types are never "outside the pool" in a strict uniqueness
            // sense (there's no "exactly one rock" rule), so they remain as
            // possibilities unless movement/battle evidence already killed them.
            // Preserve current RPS probabilities, ensure flag mass = 1 if alive
            // and the piece still has any non-zero belief about being something
            // other than RPS.
            if (flagAlive) {
                // In practice, if every other piece has been revealed or
                // removed, the player's single remaining hidden piece is the
                // flag (since flag is always exactly 1 and cannot be any RPS
                // without contradicting uniqueness when the game is still
                // running). Snap P(flag) = 1.
                for (const k of Object.keys(b.probs)) {
                    b.probs[k] = (k === 'flag') ? 1 : 0;
                }
            } else {
                // Flag already revealed — this lone hidden piece is an RPS or
                // (theoretically) a trap. Renormalize what's left.
                this._normalize(b.probs);
            }
            return;
        }
        
        // Row + column normalization (IPF) for the general case. 30 iterations
        // converges tightly even in pathological 2-hidden setups where flag
        // and trap constraints compete for the same probability mass.
        for (let iter = 0; iter < 30; iter++) {
            for (const b of hidden) {
                this._normalize(b.probs);
            }
            if (flagAlive) {
                let s = 0;
                for (const b of hidden) { s += (b.probs.flag || 0); }
                if (s > 0 && Math.abs(s - 1) > 1e-6) {
                    const k = 1 / s;
                    for (const b of hidden) { b.probs.flag *= k; }
                } else if (s <= 0) {
                    // Everyone's P(flag) got zeroed out — distribute uniformly
                    // among pieces that moved the least.
                    const stills = hidden.map(x => x.stillTurns || 0);
                    const maxStill = Math.max(...stills);
                    const pool = hidden.filter(x => (x.stillTurns || 0) === maxStill);
                    const bucket = pool.length > 0 ? pool : hidden;
                    const per = 1 / bucket.length;
                    for (const b of bucket) { b.probs.flag = per; }
                }
            }
            if (trapAlive) {
                let s = 0;
                for (const b of hidden) { s += (b.probs.trap || 0); }
                if (s > 0 && Math.abs(s - 1) > 1e-6) {
                    const k = 1 / s;
                    for (const b of hidden) { b.probs.trap *= k; }
                }
            }
        }
        
        // "Snap" step for flag: if a single piece carries essentially all of
        // the flag mass, commit — P(flag) = 1 for it and 0 for everyone else.
        if (flagAlive) {
            const best = this._argmaxFlag(hidden);
            if (best.idx >= 0 && best.value >= 0.99) {
                for (let i = 0; i < hidden.length; i++) {
                    if (i === best.idx) {
                        for (const k of Object.keys(hidden[i].probs)) {
                            hidden[i].probs[k] = (k === 'flag') ? 1 : 0;
                        }
                    } else {
                        hidden[i].probs.flag = 0;
                    }
                }
            }
        }
        
        // Final row normalization so each piece's distribution sums to 1.
        for (const b of hidden) {
            this._normalize(b.probs);
        }
    },
    
    _argmaxFlag(hidden) {
        let maxFlag = 0;
        let maxIdx = -1;
        for (let i = 0; i < hidden.length; i++) {
            const pf = hidden[i].probs.flag || 0;
            if (pf > maxFlag) {
                maxFlag = pf;
                maxIdx = i;
            }
        }
        return { idx: maxIdx, value: maxFlag };
        
        if (this.debug) {
            const flagOnes = hidden.filter(b => b.probs.flag > 0.95).length;
            if (flagOnes > 0) {
                console.debug('[aiBeliefs] constraints: pieces with P(flag) > 0.95 =', flagOnes);
            }
        }
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.aiBeliefs = aiBeliefs;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = aiBeliefs;
}

