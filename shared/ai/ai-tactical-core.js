import { GAME_CONFIG, PLAYER, COMPUTER, FLAG, TRAP } from '../game-config.js';

/**
 * aiTacticalCore — shared "hard rules" every bot obeys before running its own
 * brain. Returns a forced move when the position demands it (capture, flag
 * defence, guaranteed kill, hunt on last hidden enemy). Also exposes helpers
 * every bot uses: flag deduction baseline, anti-cluster, safe-to-leave,
 * "hunt vs kill" arbitration.
 *
 * Why a separate module: Fox/Wolf/Lion have fundamentally different search
 * styles, but they share the same obligations ("don't ignore a free kill",
 * "defend the flag", "know that a single hidden enemy must be the flag").
 * Keeping these rules central prevents regressions and lets each bot stay
 * focused on its unique playstyle.
 *
 * Usage pattern in a bot:
 *   const mandatory = aiTacticalCore.getMandatoryMove(state, {
 *       deducer: this._deduceFlag.bind(this),
 *       flagHuntHorizon: 3,
 *       antiCluster: true
 *   });
 *   if (mandatory) { return mandatory; }
 *   // ... bot-specific logic ...
 */

const aiTacticalCore = {

    // =====================================================================
    //  PUBLIC ENTRY POINT
    // =====================================================================

    /**
     * Return a forced tactical move if the position demands it, else null.
     * Rule priority (top to bottom):
     *   R1  Capture a revealed enemy flag.
     *   R2  Stop a revealed enemy adjacent to our flag.
     *   R3  Preemptive flag defence — revealed enemy within 2 cells, our
     *       flag has no counter nearby.
     *   R4  Guaranteed kill on a revealed enemy piece (checked against
     *       flag safety and cluster penalty).
     *   R5  Hunt the last plausible flag candidate — when the deducer is
     *       ≥90% sure about a piece AND we have a safe winner in reach.
     *
     * @param {object} state       — current gameState
     * @param {object} [options]   — { deducer, flagHuntHorizon, antiCluster }
     * @returns {{piece,row,col}|null}
     */
    getMandatoryMove(state, options) {
        const opts = options || {};
        const available = aiEngine.getActivePieces(state);
        if (available.length === 0) {
            return null;
        }

        const capture = this._tryCaptureRevealedFlag(state, available);
        if (capture) {
            return capture;
        }

        const directDefence = this._tryDirectFlagDefence(state, available);
        if (directDefence) {
            return directDefence;
        }

        const preempt = this._tryPreemptiveFlagDefence(state, available);
        if (preempt) {
            return preempt;
        }

        const kill = this._tryGuaranteedKill(state, available, opts);
        const hunt = this._tryHuntLikelyFlag(state, available, opts);

        if (hunt && kill) {
            return this._preferHunt(state, hunt, kill, opts) ? hunt : kill;
        }
        if (kill) {
            return kill;
        }
        if (hunt) {
            return hunt;
        }

        return null;
    },

    // =====================================================================
    //  R1 — CAPTURE REVEALED FLAG
    // =====================================================================

    _tryCaptureRevealedFlag(state, available) {
        const captures = aiEngine.findFlagCaptureMoves(state, available);
        if (captures.length === 0) {
            return null;
        }
        return aiEngine.pickBestScored(captures, state);
    },

    // =====================================================================
    //  R2 — STOP DIRECT FLAG THREAT
    // =====================================================================

    _tryDirectFlagDefence(state, available) {
        const moves = aiEngine.findFlagDefenseMoves(state, available);
        if (moves.length === 0) {
            return null;
        }
        return aiEngine.pickBestScored(moves, state);
    },

    // =====================================================================
    //  R3 — PREEMPTIVE FLAG DEFENCE
    //  A revealed enemy is 2 cells away from our flag and we do NOT have
    //  a counter / trap defender in range. We need to plug the gap before
    //  the enemy closes in next turn.
    // =====================================================================

    _tryPreemptiveFlagDefence(state, available) {
        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!aiFlag) {
            return null;
        }

        const incoming = aiEngine.getNearFlagThreats(state).filter(e => e.revealed);
        if (incoming.length === 0) {
            return null;
        }

        const threat = incoming[0];
        const threatType = this._visibleType(threat);
        if (!threatType) {
            return null;
        }

        const counterType = this._counterType(threatType);
        if (!counterType) {
            return null;
        }

        const coverage = aiEngine.computeRPSCoverage(aiFlag.row, aiFlag.col, state);
        const alreadySafe = coverage.hasTrap
            || (counterType === 'rock' && coverage.hasRock)
            || (counterType === 'paper' && coverage.hasPaper)
            || (counterType === 'scissors' && coverage.hasScissors);
        if (alreadySafe) {
            return null;
        }

        const candidates = [];
        for (const piece of available) {
            if (piece.type !== 'piece' || piece.pieceType !== counterType) {
                continue;
            }
            if (piece.immobilized) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, state);
            for (const move of moves) {
                const target = state.board[move.row][move.col];
                if (target) {
                    continue;
                }
                const distToFlag = Math.max(
                    Math.abs(move.row - aiFlag.row),
                    Math.abs(move.col - aiFlag.col)
                );
                if (distToFlag !== 1) {
                    continue;
                }
                const distToThreatAfter = Math.max(
                    Math.abs(move.row - threat.row),
                    Math.abs(move.col - threat.col)
                );
                if (distToThreatAfter > 2) {
                    continue;
                }
                const priority = 200 - distToThreatAfter * 10;
                candidates.push({ piece, row: move.row, col: move.col, priority });
            }
        }

        if (candidates.length === 0) {
            return null;
        }
        candidates.sort((a, b) => b.priority - a.priority);
        const pick = candidates[0];
        return { piece: pick.piece, row: pick.row, col: pick.col };
    },

    // =====================================================================
    //  R4 — GUARANTEED KILL (with flag-safety and cluster filters)
    // =====================================================================

    _tryGuaranteedKill(state, available, opts) {
        const kills = aiEngine.findGuaranteedKills(state, available);
        if (kills.length === 0) {
            return null;
        }

        const scored = [];
        for (const kill of kills) {
            if (!this.safeToLeave(state, kill.piece)) {
                continue;
            }
            let score = 100;
            const target = state.board[kill.row][kill.col];
            if (target && target.owner === PLAYER) {
                score += target.revealed ? 50 : 20;
            }
            if (opts && opts.antiCluster !== false) {
                score -= this.clusterPenalty(state, kill.piece, kill);
            }
            scored.push({ move: kill, score });
        }

        if (scored.length === 0) {
            return null;
        }
        scored.sort((a, b) => b.score - a.score);
        const pick = scored[0].move;
        return { piece: pick.piece, row: pick.row, col: pick.col };
    },

    // =====================================================================
    //  R5 — HUNT LIKELY FLAG
    //  If the deducer tells us a piece is almost certainly the flag AND we
    //  have a non-flag, non-trap attacker within reach, launch the chase.
    // =====================================================================

    _tryHuntLikelyFlag(state, available, opts) {
        const deducer = opts && typeof opts.deducer === 'function'
            ? opts.deducer
            : this.deducers.simple;
        const deduction = deducer(state) || { candidates: [], hiddenCount: 0 };

        if (!deduction.candidates || deduction.candidates.length === 0) {
            return null;
        }

        const top = deduction.candidates[0];
        const threshold = deduction.hiddenCount === 1 ? 0.999 : 0.85;
        if (top.prob < threshold) {
            return null;
        }

        const target = top.piece;
        const hunter = this._pickHunter(state, available, target);
        if (!hunter) {
            return null;
        }
        const step = this._stepToward(state, hunter, target);
        if (!step) {
            return null;
        }

        if (!this.safeToLeave(state, hunter)) {
            return null;
        }

        return step;
    },

    _pickHunter(state, available, target) {
        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        let best = null;
        let bestDist = Infinity;

        for (const piece of available) {
            if (piece.type !== 'piece' || piece.immobilized) {
                continue;
            }
            if (piece === aiFlag) {
                continue;
            }
            const dist = Math.max(
                Math.abs(piece.row - target.row),
                Math.abs(piece.col - target.col)
            );
            if (dist < bestDist) {
                bestDist = dist;
                best = piece;
            }
        }
        return best;
    },

    _stepToward(state, piece, target) {
        const moves = aiEngine.getMovesForPiece(piece, state);
        if (moves.length === 0) {
            return null;
        }

        const baseDist = Math.max(
            Math.abs(piece.row - target.row),
            Math.abs(piece.col - target.col)
        );

        let best = null;
        let bestScore = -Infinity;
        for (const m of moves) {
            const cell = state.board[m.row] && state.board[m.row][m.col];
            if (cell && cell.owner === PLAYER && cell.revealed) {
                if (cell.type === TRAP) {
                    continue;
                }
                if (cell.type === 'piece' && piece.pieceType
                    && aiEngine.resolveBattle(piece.pieceType, cell.pieceType) === 'lose') {
                    continue;
                }
            }

            const newDist = Math.max(
                Math.abs(m.row - target.row),
                Math.abs(m.col - target.col)
            );
            let score = (baseDist - newDist) * 100;
            if (newDist === 0) {
                score += 500;
            }
            if (aiEngine.isShuttlePosition(piece.id, m.row, m.col)) {
                score -= 400;
            }
            if (score > bestScore) {
                bestScore = score;
                best = { piece, row: m.row, col: m.col };
            }
        }
        return best;
    },

    // =====================================================================
    //  ARBITRATION — kill vs. hunt
    // =====================================================================

    _preferHunt(state, hunt, kill, opts) {
        const horizon = (opts && opts.flagHuntHorizon) || 3;

        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        const hunter = hunt.piece;
        if (!aiFlag || !hunter) {
            return false;
        }

        const deducer = opts && typeof opts.deducer === 'function'
            ? opts.deducer
            : this.deducers.simple;
        const deduction = deducer(state) || { candidates: [] };
        const top = deduction.candidates[0];
        if (!top) {
            return false;
        }

        const distToFlag = Math.max(
            Math.abs(hunter.row - top.piece.row),
            Math.abs(hunter.col - top.piece.col)
        );
        if (distToFlag > horizon) {
            return false;
        }

        const killTarget = state.board[kill.row][kill.col];
        const killGain = killTarget && killTarget.type === 'piece' ? 100 : 60;
        const huntGain = top.prob * 1000;

        return huntGain > killGain + 150;
    },

    // =====================================================================
    //  PUBLIC HELPER: isClusterRisky
    //  "Lining up three identical pieces in a row/column/diagonal is weak:
    //  a single enemy winner sweeps the whole line."
    // =====================================================================

    clusterPenalty(state, piece, move) {
        if (!piece || piece.type !== 'piece' || !piece.pieceType) {
            return 0;
        }
        if (!move) {
            return 0;
        }
        return this._clusterPenaltyAt(state, piece, move.row, move.col);
    },

    _clusterPenaltyAt(state, piece, row, col) {
        const myType = piece.pieceType;
        const dirs = [
            [[0, -1], [0, 1]],
            [[-1, 0], [1, 0]],
            [[-1, -1], [1, 1]],
            [[-1, 1], [1, -1]]
        ];

        let worst = 0;
        for (const axis of dirs) {
            let count = 1;
            for (const [dRow, dCol] of axis) {
                let r = row + dRow;
                let c = col + dCol;
                while (aiEngine.isValidPosition(r, c)) {
                    const ally = state.board[r][c];
                    if (ally && ally.id === piece.id) {
                        r += dRow;
                        c += dCol;
                        continue;
                    }
                    if (!ally || ally.owner !== COMPUTER || ally.type !== 'piece') {
                        break;
                    }
                    if (!ally.revealed) {
                        break;
                    }
                    if (ally.pieceType !== myType) {
                        break;
                    }
                    count++;
                    r += dRow;
                    c += dCol;
                }
            }
            if (count >= 3) {
                worst = Math.max(worst, (count - 2) * 40);
            }
        }
        return worst;
    },

    isClusterRisky(state, piece, move) {
        return this.clusterPenalty(state, piece, move) >= 40;
    },

    // =====================================================================
    //  PUBLIC HELPER: safeToLeave
    //  Virtually remove `piece` from the board and check whether our flag
    //  becomes attackable on the opponent's next ply. If yes, this piece
    //  is essentially pinned as a defender and should not walk away.
    // =====================================================================

    safeToLeave(state, piece) {
        if (!piece) {
            return true;
        }
        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!aiFlag) {
            return true;
        }

        const distToFlag = Math.max(
            Math.abs(piece.row - aiFlag.row),
            Math.abs(piece.col - aiFlag.col)
        );
        if (distToFlag > 2) {
            return true;
        }

        const hadCellPiece = state.board[piece.row][piece.col];
        state.board[piece.row][piece.col] = null;

        let safe = true;
        for (const enemy of state.playerPieces) {
            if (!safe) {
                break;
            }
            if (enemy.removed || enemy.row < 0) {
                continue;
            }
            if (enemy.immobilized || enemy.type === FLAG) {
                continue;
            }
            const distEnemyFlag = Math.max(
                Math.abs(enemy.row - aiFlag.row),
                Math.abs(enemy.col - aiFlag.col)
            );
            if (distEnemyFlag > 2) {
                continue;
            }

            if (distEnemyFlag === 1 && enemy.revealed) {
                safe = false;
                break;
            }

            for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
                const nr = enemy.row + dRow;
                const nc = enemy.col + dCol;
                if (!aiEngine.isValidPosition(nr, nc)) {
                    continue;
                }
                const distAfter = Math.max(
                    Math.abs(nr - aiFlag.row),
                    Math.abs(nc - aiFlag.col)
                );
                if (distAfter !== 1) {
                    continue;
                }
                const cell = state.board[nr][nc];
                if (cell && cell.owner === PLAYER) {
                    continue;
                }
                if (cell && cell.owner === COMPUTER) {
                    if (cell.type === FLAG) {
                        safe = false;
                        break;
                    }
                    if (cell.type === TRAP) {
                        continue;
                    }
                    if (cell.revealed
                        && cell.type === 'piece'
                        && enemy.type === 'piece'
                        && enemy.revealed
                        && enemy.pieceType) {
                        const r = aiEngine.resolveBattle(enemy.pieceType, cell.pieceType);
                        if (r !== 'win') {
                            continue;
                        }
                    }
                }
                safe = false;
                break;
            }
        }

        state.board[piece.row][piece.col] = hadCellPiece;
        return safe;
    },

    // =====================================================================
    //  PUBLIC HELPER: opportunityToKillNear
    //  "We have a revealed enemy piece nearby we can beat. Should we go for
    //  the kill right now instead of grinding a longer plan?" — returns
    //  a suggested move or null.
    // =====================================================================

    findOpportunisticKill(state, available) {
        const kills = aiEngine.findGuaranteedKills(state, available);
        if (kills.length === 0) {
            return null;
        }

        const viable = kills.filter(k => this.safeToLeave(state, k.piece));
        const pool = viable.length > 0 ? viable : kills;
        return aiEngine.pickBestScored(pool, state);
    },

    // =====================================================================
    //  PUBLIC HELPER: deducers.simple — baseline flag-probability
    // =====================================================================

    deducers: {
        simple(state) {
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

            const suspected = aiEngine.getSuspectedFlagCandidates(state);
            const map = new Map();
            let sum = 0;
            for (const entry of suspected) {
                const score = Math.max(1, entry.score + 1);
                map.set(entry.piece.id, score);
                sum += score;
            }
            for (const piece of hidden) {
                if (!map.has(piece.id)) {
                    map.set(piece.id, 1);
                    sum += 1;
                }
            }

            const candidates = hidden
                .map(p => ({ piece: p, prob: (map.get(p.id) || 1) / (sum || 1) }))
                .sort((a, b) => b.prob - a.prob);

            return { candidates, hiddenCount: hidden.length };
        }
    },

    // =====================================================================
    //  PUBLIC HELPER: adjust a bot score map with cluster penalty
    // =====================================================================

    applyAntiClusterAdjustment(state, move, baseScore) {
        const piece = move && move.piece;
        if (!piece) {
            return baseScore;
        }
        const penalty = this.clusterPenalty(state, piece, move);
        return baseScore - penalty;
    },

    // =====================================================================
    //  INTERNAL UTILITIES
    // =====================================================================

    _visibleType(piece) {
        if (!piece) {
            return null;
        }
        if (piece.type === 'piece') {
            return piece.revealed ? piece.pieceType : null;
        }
        return piece.type;
    },

    _counterType(enemyType) {
        if (enemyType === 'rock') {
            return 'paper';
        }
        if (enemyType === 'paper') {
            return 'scissors';
        }
        if (enemyType === 'scissors') {
            return 'rock';
        }
        return null;
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.aiTacticalCore = aiTacticalCore;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = aiTacticalCore;
}

