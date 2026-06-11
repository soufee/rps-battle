import { BOARD_HEIGHT, BOARD_WIDTH, FLAG, TRAP, PLAYER, COMPUTER } from '../game-config.js';

/**
 * Экспертный Ёжик (moveLevel3)
 *
 * Использует:
 *   - aiBeliefs (вероятностная модель типов фигур игрока),
 *   - aiStrategy (долгосрочный план с ролями fist/defenders/scouts),
 *   - aiEngine (вспомогательные функции: defense/capture/kills/minimax-хелперы),
 *   - собственный итеративно-углубляемый α/β поиск с move ordering и quiescence.
 *
 * Принципы выбора хода (приоритеты):
 *   1. Захват раскрытого флага игрока.
 *   2. Критическая защита нашего флага.
 *   3. Прямая атака кандидата с P(flag) ≥ 0.5 (если в R1 нашей сильной фигуры).
 *   4. Гарантированные убийства раскрытых фигур (только если EV > 0).
 *   5. Глубокий поиск (iterative deepening + quiescence).
 *
 * Fallback: при отсутствии разумного хода — делегирует в aiEngine.moveLevel2.
 */

const aiExpert = {
    debug: false,
    
    TIME_BUDGET_MS: 5000,
    TIME_BUDGET_ENDGAME_MS: 7000,
    MAX_DEPTH: 6,
    MAX_DEPTH_ENDGAME: 7,
    START_DEPTH: 3,
    QUIESCENCE_MAX: 3,
    QUIESCENCE_MAX_ENDGAME: 6,
    
    FORK_FLAG_CANDIDATE_THRESHOLD: 0.3,
    
    // Probability above which a hidden piece is treated as "basically the flag":
    // we chase it, corner it and attack with anything non-suicidal.
    CONFIRMED_FLAG_THRESHOLD: 0.85,
    // Probability above which an R1 attack on the suspect is already worth trying.
    ATTACK_SUSPECT_THRESHOLD: 0.5,
    // Range within which a revealed enemy piece is considered a looming threat
    // for our flag and triggers preemptive defense.
    PREEMPTIVE_DEFENSE_RANGE: 3,
    
    ATTACK_WIN_VALUE: 1200,
    PIECE_LOSS_VALUE: 900,
    TRAP_HIT_VALUE: 950,
    FLAG_CAPTURE_VALUE: 100000,
    FLAG_SUSPECT_BONUS: 80,
    
    FIST_CONNECTED_BONUS: 120,
    FIST_PROXIMITY_WEIGHT: 4,
    FIST_CONNECTED_RADIUS: 3,
    DEFENDER_BONUS: 30,
    ISOLATED_PENALTY: 25,
    
    // ==========================================================================
    //  MAIN ENTRY
    // ==========================================================================
    
    move(gameState) {
        // Global belief constraints first: collapse remaining probabilities using
        // uniqueness (only one flag / one trap on the player side). This is what
        // lets us realise "that last hidden piece HAS to be the flag" once every
        // other enemy piece has been revealed.
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.applyConstraints === 'function') {
            aiBeliefs.applyConstraints(gameState);
        }
        
        if (typeof aiStrategy !== 'undefined' && aiStrategy && typeof aiStrategy.update === 'function') {
            aiStrategy.update(gameState, (typeof aiBeliefs !== 'undefined' ? aiBeliefs : null), aiEngine.aiTurnCounter);
        }
        
        const availablePieces = aiEngine.getActivePieces(gameState);
        if (availablePieces.length === 0) {
            return null;
        }
        
        // P1: capture revealed flag
        const flagCapture = aiEngine.findFlagCaptureMoves(gameState, availablePieces);
        if (flagCapture.length > 0) {
            if (this.debug) {
                console.debug('[aiExpert] P1 flag capture');
            }
            return aiEngine.pickBestScored(flagCapture, gameState);
        }
        
        // P1.5: a hidden piece is effectively confirmed as the flag — attack
        // or close in. This is the fix for "bot sees only one hidden piece
        // left and ignores it".
        const confirmedStrike = this._tryConfirmedFlagStrike(gameState, availablePieces);
        if (confirmedStrike) {
            if (this.debug) {
                console.debug('[aiExpert] P1.5 confirmed flag strike/chase');
            }
            return confirmedStrike;
        }
        
        // P2: defend our flag against an R1 threat
        const flagDefense = aiEngine.findFlagDefenseMoves(gameState, availablePieces);
        if (flagDefense.length > 0) {
            if (this.debug) {
                console.debug('[aiExpert] P2 flag defense');
            }
            return aiEngine.pickBestScored(flagDefense, gameState);
        }
        
        // P2.5: preemptive flag defense — a revealed enemy that beats our
        // current flag ring is closing in (R2-R3). Pull a counter piece in
        // or walk the flag to safer cover before the actual R1 emergency.
        const preemptive = this._tryPreemptiveFlagDefense(gameState, availablePieces);
        if (preemptive) {
            if (this.debug) {
                console.debug('[aiExpert] P2.5 preemptive defense');
            }
            return preemptive;
        }
        
        // P3: attack a high-P(flag) candidate if we can reach it with a safe piece
        const flagStrike = this._tryAttackFlagCandidate(gameState);
        if (flagStrike) {
            if (this.debug) {
                console.debug('[aiExpert] P3 strike on suspected flag');
            }
            return flagStrike;
        }
        
        // P3.5: create a double threat that includes a suspected flag target
        const doubleThreat = this.findDoubleThreats(gameState);
        if (doubleThreat) {
            if (this.debug) {
                console.debug('[aiExpert] P3.5 double threat', doubleThreat);
            }
            return doubleThreat;
        }
        
        // P4: guaranteed kills on revealed pieces
        const kills = aiEngine.findGuaranteedKills(gameState, availablePieces);
        if (kills.length > 0) {
            if (this.debug) {
                console.debug('[aiExpert] P4 guaranteed kill');
            }
            return aiEngine.pickBestScored(kills, gameState);
        }
        
        // P4.5: create a fork on any 2+ enemies
        const fork = this.findForks(gameState);
        if (fork) {
            if (this.debug) {
                console.debug('[aiExpert] P4.5 fork', fork);
            }
            return fork;
        }
        
        // P4.7: false weakness bait — only useful while we still don't know where the flag is
        if (typeof aiStrategy !== 'undefined' && aiStrategy && aiStrategy.currentPlan
            && aiStrategy.currentPlan.mode === aiStrategy.MODES.RECON) {
            const bait = aiEngine.tryFalseWeakness(gameState);
            if (bait) {
                if (this.debug) {
                    console.debug('[aiExpert] P4.7 false weakness');
                }
                return bait;
            }
        }
        
        // P5: iterative deepening search
        const { move: searchMove } = this._iterativeDeepeningSearch(gameState);
        
        if (searchMove
            && !aiEngine.isShuttlePosition(searchMove.piece.id, searchMove.row, searchMove.col)
            && aiEngine.countRecentMovesOfPiece(searchMove.piece.id, 4) < 2) {
            if (this.debug) {
                console.debug('[aiExpert] P5 search move', searchMove);
            }
            return searchMove;
        }
        
        if (this.debug) {
            console.debug('[aiExpert] fallback to moveLevel2');
        }
        return aiEngine.moveLevel2(gameState);
    },
    
    // ==========================================================================
    //  PRIORITY 1.5: CONFIRMED FLAG — ATTACK OR CHASE
    // ==========================================================================
    
    /**
     * A candidate with P(flag) ≥ CONFIRMED_FLAG_THRESHOLD is "effectively
     * confirmed" as the flag. In that case we:
     *   1) Strike immediately if any of our non-flag/trap pieces is adjacent —
     *      any RPS piece beats a flag.
     *   2) Otherwise, advance the closest safe piece toward the candidate,
     *      preferring moves that push the candidate toward a corner (reducing
     *      its escape mobility).
     *
     * This is the fix for situations where the bot can reach the confirmed
     * flag in 2-3 moves but keeps chasing revealed combat pieces instead.
     */
    _tryConfirmedFlagStrike(gameState, availablePieces) {
        if (typeof aiBeliefs === 'undefined' || !aiBeliefs || typeof aiBeliefs.getFlagCandidates !== 'function') {
            return null;
        }
        const candidates = aiBeliefs.getFlagCandidates(gameState, 3);
        if (candidates.length === 0) {
            return null;
        }
        const top = candidates[0];
        if (!top || top.pFlag < this.CONFIRMED_FLAG_THRESHOLD) {
            return null;
        }
        const target = top.piece;
        if (!target || target.row < 0) {
            return null;
        }
        
        // Step 1: if anyone is already adjacent, go for the kill. Against a
        // confirmed flag any RPS piece wins; the flag cannot fight back.
        let bestAttack = null;
        let bestAttackScore = -Infinity;
        for (const ai of availablePieces) {
            if (ai.type !== 'piece' || ai.immobilized) {
                continue;
            }
            const dist = Math.max(Math.abs(target.row - ai.row), Math.abs(target.col - ai.col));
            if (dist !== 1) {
                continue;
            }
            // Score by how "safe" the approaching piece is afterwards — prefer
            // pieces that are themselves defended (or irrelevant if we capture
            // the flag now, because that ends the game).
            const score = 1000 + ai.row; // rough: prefer advanced pieces
            if (score > bestAttackScore) {
                bestAttackScore = score;
                bestAttack = { piece: ai, row: target.row, col: target.col };
            }
        }
        if (bestAttack) {
            return bestAttack;
        }
        
        // Step 2: chase. Pick the closest non-flag/non-trap piece and take the
        // best step toward the target. Prefer moves that (a) reduce our Chebyshev
        // distance, (b) push the flag candidate toward a corner (cornerPressure),
        // (c) don't walk into a lethal revealed enemy.
        const chasers = availablePieces.filter(p =>
            p.type === 'piece' && !p.immobilized && p.row >= 0
        );
        if (chasers.length === 0) {
            return null;
        }
        
        const distToTarget = (piece) => Math.max(
            Math.abs(target.row - piece.row),
            Math.abs(target.col - piece.col)
        );
        chasers.sort((a, b) => distToTarget(a) - distToTarget(b));
        
        let bestChaseMove = null;
        let bestChaseScore = -Infinity;
        
        // Try the closest 3 chasers; that's enough to find a reasonable path and
        // keeps the work bounded.
        const pool = chasers.slice(0, Math.min(3, chasers.length));
        for (const chaser of pool) {
            const currentDist = distToTarget(chaser);
            if (currentDist <= 0) {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(chaser, gameState);
            for (const move of moves) {
                const occupant = gameState.board[move.row] && gameState.board[move.row][move.col];
                // Don't walk into a losing fight just to close distance.
                if (occupant && occupant.owner !== chaser.owner) {
                    if (occupant.revealed && occupant.type === 'piece') {
                        const r = aiEngine.resolveBattle(chaser.pieceType, occupant.pieceType);
                        if (r !== 'win') {
                            continue;
                        }
                    } else if (occupant.revealed && occupant.type === 'trap') {
                        continue;
                    }
                }
                const newDist = Math.max(
                    Math.abs(target.row - move.row),
                    Math.abs(target.col - move.col)
                );
                if (newDist >= currentDist) {
                    continue;
                }
                // Corner pressure: how "cornered" the target becomes if we end
                // up at (move.row, move.col). Count how many of the 8 neighbour
                // cells of target are either off-board or occupied by us.
                const cornerPressure = this._cornerPressureAround(target, chaser, move, gameState);
                // Shuttle avoidance.
                if (aiEngine.isShuttlePosition(chaser.id, move.row, move.col)) {
                    continue;
                }
                const score = (currentDist - newDist) * 1000
                    + cornerPressure * 50
                    - aiEngine.countRecentMovesOfPiece(chaser.id, 4) * 30;
                if (score > bestChaseScore) {
                    bestChaseScore = score;
                    bestChaseMove = { piece: chaser, row: move.row, col: move.col };
                }
            }
        }
        
        return bestChaseMove;
    },
    
    /**
     * Count how many of the 8 neighbour cells of `target` are blocked for the
     * target after we (hypothetically) move `chaser` to (move.row, move.col).
     * A cell is "blocked" if it's off-board, contains our own piece, or is
     * threatened by at least one of our pieces in R1 that beats (or equals)
     * any RPS type — i.e. a cell the flag clearly wouldn't want to step onto.
     * Higher pressure = better — the flag has fewer escapes.
     */
    _cornerPressureAround(target, chaser, move, gameState) {
        let pressure = 0;
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) {
                    continue;
                }
                const r = target.row + dr;
                const c = target.col + dc;
                if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
                    pressure += 1;
                    continue;
                }
                // Our hypothetical new position covers this cell.
                if (r === move.row && c === move.col) {
                    pressure += 1;
                    continue;
                }
                const occ = gameState.board[r] && gameState.board[r][c];
                if (occ && occ.owner === COMPUTER && occ.id !== chaser.id) {
                    pressure += 1;
                    continue;
                }
                // Any of our other pieces threaten this cell.
                for (const ai of gameState.aiPieces) {
                    if (ai.removed || ai.immobilized || ai.row < 0) {
                        continue;
                    }
                    if (ai.id === chaser.id) {
                        continue;
                    }
                    if (ai.type !== 'piece') {
                        continue;
                    }
                    const d = Math.max(Math.abs(ai.row - r), Math.abs(ai.col - c));
                    if (d === 1) {
                        pressure += 0.5;
                        break;
                    }
                }
            }
        }
        return pressure;
    },
    
    // ==========================================================================
    //  PRIORITY 2.5: PREEMPTIVE FLAG DEFENSE
    // ==========================================================================
    
    /**
     * Reacts to revealed enemy pieces closing in on our flag BEFORE they reach
     * R1 (where findFlagDefenseMoves would kick in).
     *
     * Dangerous setup = a revealed non-trap enemy within PREEMPTIVE_DEFENSE_RANGE
     * of our flag against which our current "flag ring" (R1 defenders) has no
     * RPS-winning piece.
     *
     * Response priority:
     *   1) Move a counter piece (RPS-winner or an unrevealed piece that is
     *      provably the counter type) to R1 of the flag.
     *   2) If we have no counter reachable, walk the flag toward safer cover:
     *      a cell whose R1 neighbours contain pieces that dominate the known
     *      threats.
     *
     * Returns a move, or null if either no threat or no safe response.
     */
    _tryPreemptiveFlagDefense(gameState, availablePieces) {
        const aiFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!aiFlag || aiFlag.row < 0) {
            return null;
        }
        
        const threats = this._findLoomingThreats(gameState, aiFlag);
        if (threats.length === 0) {
            return null;
        }
        
        // Does our current R1 ring already handle every revealed threat?
        if (this._flagRingCovers(gameState, aiFlag, threats)) {
            return null;
        }
        
        // Step 1: try to PULL a counter piece to an R1 cell of the flag.
        const reinforce = this._findReinforcementMove(gameState, availablePieces, aiFlag, threats);
        if (reinforce) {
            return reinforce;
        }
        
        // Step 2: last resort — walk the flag to a square with a better ring.
        const flagEscape = this._findFlagEscape(gameState, aiFlag, threats);
        if (flagEscape) {
            return flagEscape;
        }
        
        return null;
    },
    
    /**
     * Revealed enemy pieces within PREEMPTIVE_DEFENSE_RANGE that can actually
     * move (not immobilised) and aren't a flag.
     */
    _findLoomingThreats(gameState, aiFlag) {
        const threats = [];
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) {
                continue;
            }
            if (enemy.immobilized) {
                continue;
            }
            if (!enemy.revealed) {
                continue;
            }
            if (enemy.type === FLAG) {
                continue;
            }
            if (enemy.type !== 'piece') {
                continue;
            }
            const d = Math.max(Math.abs(enemy.row - aiFlag.row), Math.abs(enemy.col - aiFlag.col));
            if (d <= this.PREEMPTIVE_DEFENSE_RANGE && d >= 2) {
                threats.push({ piece: enemy, distance: d });
            }
        }
        return threats;
    },
    
    /**
     * Does the R1 ring around our flag already contain at least one piece that
     * beats every revealed threat (or a live trap)?
     */
    _flagRingCovers(gameState, aiFlag, threats) {
        const ring = [];
        for (const ai of gameState.aiPieces) {
            if (ai.removed || ai.row < 0 || ai.immobilized) {
                continue;
            }
            if (ai.id === aiFlag.id) {
                continue;
            }
            const d = Math.max(Math.abs(ai.row - aiFlag.row), Math.abs(ai.col - aiFlag.col));
            if (d <= 1) {
                ring.push(ai);
            }
        }
        if (ring.length === 0) {
            return false;
        }
        
        for (const t of threats) {
            let covered = false;
            for (const r of ring) {
                if (r.type === TRAP && !r.immobilized) {
                    covered = true;
                    break;
                }
                if (r.type !== 'piece') {
                    continue;
                }
                const res = aiEngine.resolveBattle(r.pieceType, t.piece.pieceType);
                if (res === 'win') {
                    covered = true;
                    break;
                }
            }
            if (!covered) {
                return false;
            }
        }
        return true;
    },
    
    /**
     * Try to bring a counter piece to a cell adjacent to our flag that also
     * blocks (or at least reaches) the most dangerous threat.
     */
    _findReinforcementMove(gameState, availablePieces, aiFlag, threats) {
        // Pick the most dangerous threat: closest first, then highest-priority
        // piece type (arbitrary but stable).
        const sorted = threats.slice().sort((a, b) => a.distance - b.distance);
        
        let best = null;
        let bestScore = -Infinity;
        
        for (const threatInfo of sorted) {
            const threat = threatInfo.piece;
            for (const ai of availablePieces) {
                if (ai.type !== 'piece' || ai.immobilized) {
                    continue;
                }
                if (ai.id === aiFlag.id) {
                    continue;
                }
                // A piece is a counter if: it is revealed and beats the threat,
                // OR it is unrevealed (the player doesn't know what it is, and
                // belief says RPS; we'll still prefer pieces we know beat the
                // threat).
                let counterScore = 0;
                if (ai.type === 'piece' && ai.pieceType) {
                    const res = aiEngine.resolveBattle(ai.pieceType, threat.pieceType);
                    if (res === 'win') {
                        counterScore = 200;
                    } else if (res === 'draw') {
                        counterScore = 50;
                    } else {
                        counterScore = -150;
                    }
                }
                // Hidden pieces are "neutral" reinforcements — better than
                // nothing, but we prefer known counters.
                if (!ai.revealed) {
                    counterScore += 20;
                }
                
                if (counterScore <= 0) {
                    continue;
                }
                
                const moves = aiEngine.getMovesForPiece(ai, gameState);
                for (const move of moves) {
                    const occ = gameState.board[move.row] && gameState.board[move.row][move.col];
                    if (occ && occ.owner !== ai.owner) {
                        // Don't walk into a losing combat just to reinforce.
                        if (occ.revealed && occ.type === 'piece' && ai.pieceType) {
                            const r = aiEngine.resolveBattle(ai.pieceType, occ.pieceType);
                            if (r !== 'win') {
                                continue;
                            }
                        } else if (occ.revealed && occ.type === 'trap') {
                            continue;
                        }
                    }
                    if (aiEngine.isShuttlePosition(ai.id, move.row, move.col)) {
                        continue;
                    }
                    const distToFlag = Math.max(
                        Math.abs(move.row - aiFlag.row),
                        Math.abs(move.col - aiFlag.col)
                    );
                    // Strongly prefer landing next to the flag.
                    if (distToFlag > 1) {
                        continue;
                    }
                    const distToThreat = Math.max(
                        Math.abs(move.row - threat.row),
                        Math.abs(move.col - threat.col)
                    );
                    const score = counterScore + 300 - distToThreat * 20;
                    if (score > bestScore) {
                        bestScore = score;
                        best = { piece: ai, row: move.row, col: move.col };
                    }
                }
            }
            // If we already have a good counter for the closest threat, commit
            // to it rather than spreading defence thin.
            if (best && bestScore >= 300) {
                return best;
            }
        }
        
        return best;
    },
    
    /**
     * Walk the flag one step to a square with a stronger ring. Only returns a
     * move if the new ring is measurably better than the current one (otherwise
     * shuffling the flag just for the sake of it is its own problem).
     */
    _findFlagEscape(gameState, aiFlag, threats) {
        const currentRing = this._ringScore(gameState, aiFlag.row, aiFlag.col, aiFlag.id, threats);
        const moves = aiEngine.getMovesForPiece(aiFlag, gameState);
        let best = null;
        let bestScore = currentRing + 20; // require a real improvement
        for (const move of moves) {
            const occ = gameState.board[move.row] && gameState.board[move.row][move.col];
            if (occ) {
                continue;
            }
            // Don't move the flag into an R1 of any revealed threat we can't beat.
            const threatAdjacent = threats.some(t => {
                const d = Math.max(
                    Math.abs(t.piece.row - move.row),
                    Math.abs(t.piece.col - move.col)
                );
                return d <= 1;
            });
            if (threatAdjacent) {
                continue;
            }
            if (aiEngine.isShuttlePosition(aiFlag.id, move.row, move.col)) {
                continue;
            }
            const score = this._ringScore(gameState, move.row, move.col, aiFlag.id, threats);
            if (score > bestScore) {
                bestScore = score;
                best = { piece: aiFlag, row: move.row, col: move.col };
            }
        }
        return best;
    },
    
    _ringScore(gameState, flagRow, flagCol, flagId, threats) {
        let score = 0;
        const ring = [];
        for (const ai of gameState.aiPieces) {
            if (ai.removed || ai.immobilized || ai.row < 0) {
                continue;
            }
            if (ai.id === flagId) {
                continue;
            }
            const d = Math.max(Math.abs(ai.row - flagRow), Math.abs(ai.col - flagCol));
            if (d <= 1) {
                ring.push(ai);
            }
        }
        score += ring.length * 5;
        // Bonus for pieces that beat each revealed threat.
        for (const t of threats) {
            for (const r of ring) {
                if (r.type === TRAP) {
                    score += 30;
                    break;
                }
                if (r.type !== 'piece') {
                    continue;
                }
                const res = aiEngine.resolveBattle(r.pieceType, t.piece.pieceType);
                if (res === 'win') {
                    score += 40;
                    break;
                } else if (res === 'draw') {
                    score += 10;
                }
            }
        }
        // Penalty for distance to nearest threat — we want the flag farther
        // from any revealed attacker.
        let minThreatDist = Infinity;
        for (const t of threats) {
            const d = Math.max(Math.abs(t.piece.row - flagRow), Math.abs(t.piece.col - flagCol));
            if (d < minThreatDist) {
                minThreatDist = d;
            }
        }
        if (isFinite(minThreatDist)) {
            score += minThreatDist * 15;
        }
        // Prefer staying near the back row / corners.
        const backRowDistance = flagRow; // 0 is our back row for the COMPUTER side
        score -= backRowDistance * 3;
        // Prefer corners slightly (a flag tucked in a corner is easier to ring).
        if (flagCol <= 1 || flagCol >= BOARD_WIDTH - 2) {
            score += 4;
        }
        return score;
    },
    
    // ==========================================================================
    //  PRIORITY 3: STRIKE ON SUSPECTED FLAG (weaker candidates, still attack
    //  if the expected value justifies it)
    // ==========================================================================
    
    _tryAttackFlagCandidate(gameState) {
        if (typeof aiBeliefs === 'undefined' || !aiBeliefs || typeof aiBeliefs.getFlagCandidates !== 'function') {
            return null;
        }
        const candidates = aiBeliefs.getFlagCandidates(gameState, 3);
        if (candidates.length === 0) {
            return null;
        }
        const top = candidates[0];
        if (!top || top.pFlag < this.ATTACK_SUSPECT_THRESHOLD) {
            return null;
        }
        
        const target = top.piece;
        let best = null;
        let bestEV = -Infinity;
        for (const ai of gameState.aiPieces) {
            if (ai.removed || ai.type !== 'piece' || ai.immobilized) {
                continue;
            }
            if (ai.row < 0) {
                continue;
            }
            const dr = target.row - ai.row;
            const dc = target.col - ai.col;
            const dist = Math.max(Math.abs(dr), Math.abs(dc));
            if (dist !== 1) {
                continue;
            }
            const ev = this.computeEV(ai, target, gameState);
            if (ev > bestEV) {
                bestEV = ev;
                best = { piece: ai, row: target.row, col: target.col };
            }
        }
        
        // Attack threshold scales with confidence: the closer P(flag) is to 1,
        // the less EV we require from the RPS side. Near-certain candidates
        // (P(flag) ≥ 0.8) are captured even if the expected piece swap is
        // slightly negative — an unknown piece going in trades for a confirmed
        // flag, and capturing the flag ends the game.
        const confidence = top.pFlag;
        const evFloor = this.FLAG_CAPTURE_VALUE * Math.max(0.05, 0.35 * (1 - confidence));
        if (best && bestEV >= evFloor) {
            return best;
        }
        return null;
    },
    
    // ==========================================================================
    //  PRIORITY 5: ITERATIVE DEEPENING SEARCH
    // ==========================================================================
    
    _iterativeDeepeningSearch(gameState) {
        const endgame = this._isEndgame();
        const timeBudget = endgame ? this.TIME_BUDGET_ENDGAME_MS : this.TIME_BUDGET_MS;
        const maxDepth = endgame ? this.MAX_DEPTH_ENDGAME : this.MAX_DEPTH;
        const startTime = Date.now();
        const deadline = startTime + timeBudget;
        
        let bestMove = null;
        let bestScore = -Infinity;
        let reachedDepth = 0;
        
        for (let depth = this.START_DEPTH; depth <= maxDepth; depth++) {
            if (Date.now() >= deadline) {
                break;
            }
            const result = this._alphaBetaRoot(gameState, depth, deadline, bestMove);
            if (result && result.move) {
                bestMove = result.move;
                bestScore = result.score;
                reachedDepth = depth;
            }
            if (bestScore >= 50000 || bestScore <= -50000) {
                break;
            }
        }
        
        if (this.debug) {
            console.debug('[aiExpert] search done', { reachedDepth, bestScore, elapsed: Date.now() - startTime });
        }
        return { move: bestMove, score: bestScore };
    },
    
    _alphaBetaRoot(state, depth, deadline, preferredMove) {
        const rawMoves = aiEngine.getAllPossibleMoves(state, COMPUTER);
        if (rawMoves.length === 0) {
            return { score: -Infinity, move: null };
        }
        // Drop shuttle moves at the root: minimax cannot see our own move history,
        // so without this the search happily picks "optimal-looking" A↔B bouncing.
        const allMoves = aiEngine.filterOutShuttleMoves(rawMoves);
        const moves = this._orderMoves(allMoves, state, preferredMove);
        
        let bestMove = null;
        let bestScore = -Infinity;
        let alpha = -Infinity;
        const beta = Infinity;
        
        for (const move of moves) {
            if (Date.now() >= deadline) {
                break;
            }
            const newState = aiEngine.makeVirtualMove(state, move);
            const noisy = this._isNoisyMove(state, move);
            const score = this._alphaBeta(newState, depth - 1, alpha, beta, false, deadline, noisy);
            if (score > bestScore) {
                bestScore = score;
                bestMove = move;
            }
            if (score > alpha) {
                alpha = score;
            }
        }
        return { move: bestMove, score: bestScore };
    },
    
    _alphaBeta(state, depth, alpha, beta, isMax, deadline, lastWasNoisy) {
        if (Date.now() >= deadline) {
            return this.evaluateExpertPosition(state);
        }
        if (aiEngine.isGameOver(state)) {
            return this.evaluateExpertPosition(state);
        }
        if (depth <= 0) {
            if (lastWasNoisy) {
                const qMax = this._isEndgame() ? this.QUIESCENCE_MAX_ENDGAME : this.QUIESCENCE_MAX;
                return this._quiescence(state, qMax, alpha, beta, isMax, deadline);
            }
            return this.evaluateExpertPosition(state);
        }
        
        const owner = isMax ? COMPUTER : PLAYER;
        const rawMoves = aiEngine.getAllPossibleMoves(state, owner);
        if (rawMoves.length === 0) {
            return this.evaluateExpertPosition(state);
        }
        const moves = isMax ? this._orderMoves(rawMoves, state, null) : rawMoves;
        
        if (isMax) {
            let best = -Infinity;
            for (const move of moves) {
                if (Date.now() >= deadline) {
                    break;
                }
                const newState = aiEngine.makeVirtualMove(state, move);
                const noisy = this._isNoisyMove(state, move);
                const val = this._alphaBeta(newState, depth - 1, alpha, beta, false, deadline, noisy);
                if (val > best) {
                    best = val;
                }
                if (val > alpha) {
                    alpha = val;
                }
                if (beta <= alpha) {
                    break;
                }
            }
            return best;
        }
        
        let best = Infinity;
        for (const move of moves) {
            if (Date.now() >= deadline) {
                break;
            }
            const newState = aiEngine.makeVirtualMove(state, move);
            const noisy = this._isNoisyMove(state, move);
            const val = this._alphaBeta(newState, depth - 1, alpha, beta, true, deadline, noisy);
            if (val < best) {
                best = val;
            }
            if (val < beta) {
                beta = val;
            }
            if (beta <= alpha) {
                break;
            }
        }
        return best;
    },
    
    _quiescence(state, remaining, alpha, beta, isMax, deadline) {
        const standPat = this.evaluateExpertPosition(state);
        if (remaining <= 0 || aiEngine.isGameOver(state) || Date.now() >= deadline) {
            return standPat;
        }
        const owner = isMax ? COMPUTER : PLAYER;
        const allMoves = aiEngine.getAllPossibleMoves(state, owner);
        const noisy = allMoves.filter(m => this._isNoisyMove(state, m));
        if (noisy.length === 0) {
            return standPat;
        }
        
        if (isMax) {
            let best = standPat;
            if (best >= beta) {
                return best;
            }
            if (best > alpha) {
                alpha = best;
            }
            for (const move of this._orderMoves(noisy, state, null)) {
                if (Date.now() >= deadline) {
                    break;
                }
                const newState = aiEngine.makeVirtualMove(state, move);
                const val = this._quiescence(newState, remaining - 1, alpha, beta, false, deadline);
                if (val > best) {
                    best = val;
                }
                if (best > alpha) {
                    alpha = best;
                }
                if (beta <= alpha) {
                    break;
                }
            }
            return best;
        }
        
        let best = standPat;
        if (best <= alpha) {
            return best;
        }
        if (best < beta) {
            beta = best;
        }
        for (const move of noisy) {
            if (Date.now() >= deadline) {
                break;
            }
            const newState = aiEngine.makeVirtualMove(state, move);
            const val = this._quiescence(newState, remaining - 1, alpha, beta, true, deadline);
            if (val < best) {
                best = val;
            }
            if (best < beta) {
                beta = best;
            }
            if (beta <= alpha) {
                break;
            }
        }
        return best;
    },
    
    // ==========================================================================
    //  MOVE ORDERING
    // ==========================================================================
    
    _orderMoves(moves, state, preferredMove) {
        const scored = moves.map(m => ({ move: m, s: this._moveOrderScore(m, state) }));
        scored.sort((a, b) => b.s - a.s);
        if (preferredMove) {
            const idx = scored.findIndex(x =>
                x.move.piece && preferredMove.piece
                && x.move.piece.id === preferredMove.piece.id
                && x.move.row === preferredMove.row
                && x.move.col === preferredMove.col
            );
            if (idx > 0) {
                const [best] = scored.splice(idx, 1);
                scored.unshift(best);
            }
        }
        return scored.map(x => x.move);
    },
    
    _moveOrderScore(move, state) {
        const target = state.board[move.row] && state.board[move.row][move.col];
        
        if (target && target.owner !== move.piece.owner) {
            if (target.type === 'flag' && target.revealed) {
                return 1e9;
            }
            if (move.piece.type === 'piece' && target.revealed && target.type === 'piece') {
                const r = aiEngine.resolveBattle(move.piece.pieceType, target.pieceType);
                if (r === 'win') {
                    return 1e6;
                }
                if (r === 'lose') {
                    return -1e6;
                }
            }
            return 500 + this.computeEV(move.piece, target, state);
        }
        
        // Forward toward the target area
        if (typeof aiStrategy !== 'undefined' && aiStrategy && aiStrategy.currentPlan && aiStrategy.currentPlan.targetArea) {
            const ta = aiStrategy.currentPlan.targetArea;
            const before = Math.max(Math.abs(move.piece.row - ta.row), Math.abs(move.piece.col - ta.col));
            const after = Math.max(Math.abs(move.row - ta.row), Math.abs(move.col - ta.col));
            return 100 * (before - after);
        }
        return 0;
    },
    
    _isNoisyMove(state, move) {
        const target = state.board[move.row] && state.board[move.row][move.col];
        return !!(target && target.owner !== move.piece.owner);
    },
    
    // ==========================================================================
    //  EV AND POSITION EVALUATION
    // ==========================================================================
    
    computeEV(attacker, target, state) {
        if (!attacker || !target) {
            return 0;
        }
        const atkType = attacker.type === 'piece' ? attacker.pieceType : attacker.type;
        
        if (target.revealed) {
            const tgtType = target.type === 'piece' ? target.pieceType : target.type;
            if (tgtType === 'trap') {
                return -this.TRAP_HIT_VALUE;
            }
            if (tgtType === 'flag') {
                return this.FLAG_CAPTURE_VALUE;
            }
            const r = aiEngine.resolveBattle(atkType, tgtType);
            if (r === 'win') {
                return this.ATTACK_WIN_VALUE;
            }
            if (r === 'lose') {
                return -this.PIECE_LOSS_VALUE;
            }
            return 0;
        }
        
        if (typeof aiBeliefs === 'undefined' || !aiBeliefs || typeof aiBeliefs.getProbDistribution !== 'function') {
            return 0;
        }
        const probs = aiBeliefs.getProbDistribution(target.id);
        if (!probs) {
            return 0;
        }
        
        let ev = 0;
        ev += (probs.flag || 0) * this.FLAG_CAPTURE_VALUE;
        ev += (probs.trap || 0) * (-this.TRAP_HIT_VALUE);
        for (const rpsType of ['rock', 'paper', 'scissors']) {
            const p = probs[rpsType] || 0;
            if (p === 0) {
                continue;
            }
            const r = aiEngine.resolveBattle(atkType, rpsType);
            if (r === 'win') {
                ev += p * this.ATTACK_WIN_VALUE;
            } else if (r === 'lose') {
                ev += p * (-this.PIECE_LOSS_VALUE);
            }
        }
        return ev;
    },
    
    evaluateExpertPosition(state) {
        let score = aiEngine.evaluatePositionV2(state);
        score += this._evaluateFlagPressure(state);
        score += this._evaluateFistCohesion(state);
        score += this._evaluateDefenders(state);
        score += this._evaluateIsolation(state);
        return score;
    },
    
    _evaluateFlagPressure(state) {
        if (typeof aiBeliefs === 'undefined' || !aiBeliefs) {
            return 0;
        }
        let bonus = 0;
        for (const ai of state.aiPieces) {
            if (ai.removed || ai.type !== 'piece' || ai.immobilized) {
                continue;
            }
            if (ai.row < 0) {
                continue;
            }
            for (const enemy of state.playerPieces) {
                if (enemy.removed || enemy.row < 0 || enemy.revealed) {
                    continue;
                }
                const d = Math.max(Math.abs(ai.row - enemy.row), Math.abs(ai.col - enemy.col));
                if (d > 3) {
                    continue;
                }
                const probs = aiBeliefs.getProbDistribution(enemy.id);
                if (!probs || probs.flag < 0.2) {
                    continue;
                }
                // Proximity: R1 full, R2 half, R3 quarter. Multiplier boost when
                // flag probability is very high — we strongly reward closing in
                // on the confirmed flag even at R2/R3 so alpha-beta chases it.
                let distMult;
                if (d === 1) { distMult = 1.0; }
                else if (d === 2) { distMult = 0.5; }
                else { distMult = 0.25; }
                const confidenceBoost = probs.flag >= 0.85 ? 3.5 : (probs.flag >= 0.5 ? 1.5 : 1.0);
                bonus += probs.flag * this.FLAG_SUSPECT_BONUS * distMult * confidenceBoost;
            }
        }
        return bonus;
    },
    
    _evaluateFistCohesion(state) {
        if (typeof aiStrategy === 'undefined' || !aiStrategy || !aiStrategy.currentPlan) {
            return 0;
        }
        const plan = aiStrategy.currentPlan;
        if (!plan.fist || plan.fist.length === 0 || !plan.targetArea) {
            return 0;
        }
        
        let score = 0;
        const positions = [];
        let totalDist = 0;
        let count = 0;
        for (const id of plan.fist) {
            const p = state.aiPieces.find(x => x.id === id && !x.removed && x.row >= 0);
            if (!p) {
                continue;
            }
            const d = Math.max(
                Math.abs(p.row - plan.targetArea.row),
                Math.abs(p.col - plan.targetArea.col)
            );
            totalDist += d;
            count++;
            positions.push({ row: p.row, col: p.col });
        }
        if (count > 0) {
            const avgDist = totalDist / count;
            const reachBonus = (BOARD_HEIGHT + BOARD_WIDTH) - avgDist;
            score += reachBonus * this.FIST_PROXIMITY_WEIGHT;
        }
        
        if (positions.length >= 2) {
            let connected = true;
            for (let i = 0; i < positions.length && connected; i++) {
                for (let j = i + 1; j < positions.length && connected; j++) {
                    const d = Math.max(
                        Math.abs(positions[i].row - positions[j].row),
                        Math.abs(positions[i].col - positions[j].col)
                    );
                    if (d > this.FIST_CONNECTED_RADIUS) {
                        connected = false;
                    }
                }
            }
            if (connected) {
                score += this.FIST_CONNECTED_BONUS;
            }
        }
        return score;
    },
    
    _evaluateDefenders(state) {
        if (typeof aiStrategy === 'undefined' || !aiStrategy || !aiStrategy.currentPlan) {
            return 0;
        }
        const defenders = aiStrategy.currentPlan.defenders || [];
        if (defenders.length === 0) {
            return 0;
        }
        const ourFlag = state.aiPieces.find(p => p.type === 'flag' && !p.removed);
        if (!ourFlag) {
            return 0;
        }
        let bonus = 0;
        for (const id of defenders) {
            const p = state.aiPieces.find(x => x.id === id && !x.removed);
            if (!p) {
                continue;
            }
            const d = Math.max(Math.abs(p.row - ourFlag.row), Math.abs(p.col - ourFlag.col));
            if (d <= 1) {
                bonus += this.DEFENDER_BONUS;
            } else if (d <= 2) {
                bonus += this.DEFENDER_BONUS * 0.5;
            }
        }
        return bonus;
    },
    
    _evaluateIsolation(state) {
        let penalty = 0;
        const halfLine = Math.floor(BOARD_HEIGHT / 2);
        for (const ai of state.aiPieces) {
            if (ai.removed || ai.type !== 'piece') {
                continue;
            }
            if (ai.row < halfLine) {
                continue;
            }
            let hasAlly = false;
            for (const ally of state.aiPieces) {
                if (ally.removed || ally.id === ai.id) {
                    continue;
                }
                const d = Math.max(Math.abs(ai.row - ally.row), Math.abs(ai.col - ally.col));
                if (d <= 2) {
                    hasAlly = true;
                    break;
                }
            }
            if (!hasAlly) {
                penalty -= this.ISOLATED_PENALTY;
            }
        }
        return penalty;
    },
    
    _isEndgame() {
        if (typeof aiStrategy === 'undefined' || !aiStrategy || !aiStrategy.currentPlan) {
            return false;
        }
        return aiStrategy.currentPlan.mode === aiStrategy.MODES.ENDGAME;
    },
    
    // ==========================================================================
    //  TACTICAL PATTERNS: DOUBLE THREATS AND FORKS
    // ==========================================================================
    
    /**
     * Find a move that creates ≥2 valuable threats after it resolves.
     * A valuable threat is:
     *   - adjacency to a revealed enemy flag, or
     *   - adjacency to a piece with P(flag) ≥ FORK_FLAG_CANDIDATE_THRESHOLD, or
     *   - adjacency to a revealed enemy piece that we would beat in combat.
     * Returns the move with the highest threat count (ties broken by EV).
     */
    findDoubleThreats(gameState) {
        return this._findMultiThreatMove(gameState, { requireFlagContext: true });
    },
    
    /**
     * Generic fork finder: a move that places us in R1 of ≥2 enemy pieces at all.
     * Less strict than findDoubleThreats — used as a secondary tactic.
     */
    findForks(gameState) {
        return this._findMultiThreatMove(gameState, { requireFlagContext: false });
    },
    
    _findMultiThreatMove(gameState, opts) {
        const requireFlagContext = !!(opts && opts.requireFlagContext);
        const availablePieces = aiEngine.getActivePieces(gameState);
        if (availablePieces.length === 0) {
            return null;
        }
        
        let bestMove = null;
        let bestCount = 1;
        let bestEV = 0;
        
        for (const piece of availablePieces) {
            if (piece.type !== 'piece') {
                continue;
            }
            const moves = aiEngine.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row] && gameState.board[move.row][move.col];
                if (target) {
                    // Only pure reposition moves — attacks are handled by earlier priorities.
                    continue;
                }
                
                const newState = aiEngine.makeVirtualMove(gameState, { piece, row: move.row, col: move.col });
                const newPiece = newState.aiPieces.find(p => p.id === piece.id && !p.removed);
                if (!newPiece) {
                    continue;
                }
                
                let threatCount = 0;
                let totalEV = 0;
                let hasFlagContext = false;
                
                for (const enemy of newState.playerPieces) {
                    if (enemy.removed || enemy.row < 0) {
                        continue;
                    }
                    const d = Math.max(
                        Math.abs(enemy.row - newPiece.row),
                        Math.abs(enemy.col - newPiece.col)
                    );
                    if (d !== 1) {
                        continue;
                    }
                    
                    const ev = this.computeEV(newPiece, enemy, newState);
                    if (ev <= 0) {
                        continue;
                    }
                    
                    threatCount += 1;
                    totalEV += ev;
                    
                    if (enemy.revealed && enemy.type === 'flag') {
                        hasFlagContext = true;
                    } else if (!enemy.revealed && typeof aiBeliefs !== 'undefined' && aiBeliefs) {
                        const probs = aiBeliefs.getProbDistribution(enemy.id);
                        if (probs && probs.flag >= this.FORK_FLAG_CANDIDATE_THRESHOLD) {
                            hasFlagContext = true;
                        }
                    }
                }
                
                if (threatCount < 2) {
                    continue;
                }
                if (requireFlagContext && !hasFlagContext) {
                    continue;
                }
                if (threatCount > bestCount || (threatCount === bestCount && totalEV > bestEV)) {
                    bestCount = threatCount;
                    bestEV = totalEV;
                    bestMove = { piece, row: move.row, col: move.col };
                }
            }
        }
        
        return bestMove;
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.aiExpert = aiExpert;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = aiExpert;
}

