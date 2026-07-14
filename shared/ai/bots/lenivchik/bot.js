/**
 * Ленивчик — Grok / xAI
 *
 * Deceptively patient. Internally a full decision architecture:
 *   1. Bayesian world model over every hidden enemy (RPS + flag + trap)
 *   2. Motive / behaviour inference (flee, approach, stillness, clustering)
 *   3. Expected-value combat math under uncertainty
 *   4. Multi-piece coordination (fists, redoubts, pincer lines)
 *   5. Selective 2-ply lookahead with capture quiescence
 *   6. Deception: bait, delayed reveals, misdirection
 *   7. Flag-hunt targeting by posterior probability mass
 *
 * Fair-play only: fog-of-war view, no peeking other bots, no illegal state access.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[lenivchik] bot-api.js must be loaded BEFORE this bot');
}

var RPS = (typeof window !== 'undefined' && window.RPSBotAPI)
    ? window.RPSBotAPI
    : (typeof RPSBotAPI !== 'undefined' ? RPSBotAPI : null);

if (!RPS) {
    throw new Error('[lenivchik] RPSBotAPI is required');
}

var RULES = RPS.RULES;
var resolveBattle = RPS.resolveBattle;
var getLegalMoves = RPS.getLegalMoves;
var canAttack = RPS.canAttack;

var W = RULES.BOARD.WIDTH;
var H = RULES.BOARD.HEIGHT;
var FLAG = RULES.SPECIAL_TYPES.FLAG;
var TRAP = RULES.SPECIAL_TYPES.TRAP;
var RPS_TYPES = RULES.PIECE_TYPES.slice();
var DIRS = RULES.DIRECTIONS;

var BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
var LOSES_TO = { rock: 'paper', paper: 'scissors', scissors: 'rock' };

var DRAW_LIMIT = 20;
var LOOKAHEAD_CANDIDATES = 14;
var EPS = 1e-9;

// ---------------------------------------------------------------------------
//  Math helpers
// ---------------------------------------------------------------------------

function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
}

function chebyshev(r1, c1, r2, c2) {
    return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
}

function manhattan(r1, c1, r2, c2) {
    return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

function keyRC(r, c) {
    return r + ',' + c;
}

function battle(a, b) {
    if (!a || !b) return 'draw';
    if (a === b) return 'draw';
    if (b === FLAG) return 'win';
    if (b === TRAP) return 'lose';
    if (a === FLAG) return 'lose';
    if (a === TRAP) return 'win';
    if (resolveBattle) return resolveBattle(a, b);
    return BEATS[a] === b ? 'win' : 'lose';
}

function normalize5(p) {
    var s = p.rock + p.paper + p.scissors + p.flag + p.trap;
    if (s <= EPS) {
        return { rock: 0.28, paper: 0.28, scissors: 0.28, flag: 0.08, trap: 0.08 };
    }
    return {
        rock: p.rock / s,
        paper: p.paper / s,
        scissors: p.scissors / s,
        flag: p.flag / s,
        trap: p.trap / s
    };
}

function cloneProbs(p) {
    return {
        rock: p.rock, paper: p.paper, scissors: p.scissors,
        flag: p.flag, trap: p.trap
    };
}

function softMaxMul(p, key, factor) {
    p[key] = Math.max(EPS, p[key] * factor);
}

// ---------------------------------------------------------------------------
//  Board / piece helpers (self-contained, fair view only)
// ---------------------------------------------------------------------------

function activeOf(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p && !p.removed && p.row >= 0 && p.col >= 0) out.push(p);
    }
    return out;
}

function myPieces(gs) { return activeOf(gs.aiPieces); }
function enPieces(gs) { return activeOf(gs.playerPieces); }

function myFlag(gs) {
    var mine = myPieces(gs);
    for (var i = 0; i < mine.length; i++) {
        if (mine[i].type === FLAG) return mine[i];
    }
    return null;
}

function isCombat(p) {
    return p && p.type === 'piece' && !p.immobilized;
}

function isHidden(p) {
    return p && !p.revealed && !p.removed;
}

function pieceWeapon(p) {
    if (!p) return null;
    if (p.type === FLAG || p.type === TRAP) return p.type;
    return p.pieceType || null;
}

function legalMoves(piece, gs) {
    if (!piece || piece.immobilized || piece.removed || piece.row < 0) return [];
    if (getLegalMoves) {
        var raw = getLegalMoves(piece, gs) || [];
        var filtered = [];
        for (var i = 0; i < raw.length; i++) {
            var m = raw[i];
            var target = gs.board[m.row] && gs.board[m.row][m.col];
            // Flag never attacks
            if (piece.type === FLAG) {
                if (!target) filtered.push(m);
                continue;
            }
            // Never walk into a known hopeless fight
            if (target && target.owner === 'player' && target.revealed) {
                if (target.type === TRAP) continue;
                if (target.type === 'piece' && piece.pieceType) {
                    if (battle(piece.pieceType, target.pieceType) === 'lose') continue;
                }
            }
            if (target && target.owner === piece.owner) continue;
            if (canAttack && target && !canAttack(piece, target) && piece.type === FLAG) continue;
            filtered.push(m);
        }
        return filtered;
    }
    // Fallback king-step
    var moves = [];
    for (var d = 0; d < DIRS.length; d++) {
        var nr = piece.row + DIRS[d][0];
        var nc = piece.col + DIRS[d][1];
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        var t = gs.board[nr] && gs.board[nr][nc];
        if (t && t.owner === piece.owner) continue;
        if (piece.type === FLAG && t) continue;
        moves.push({ row: nr, col: nc });
    }
    return moves;
}

function cellEmpty(gs, r, c) {
    return !(gs.board[r] && gs.board[r][c]);
}

// ---------------------------------------------------------------------------
//  BOT
// ---------------------------------------------------------------------------

var lenivchikBot = {
    id: 'lenivchik',
    name: 'Ленивчик',
    emoji: '🦥',
    avatar: 'js/bots/lenivchik/avatar-min.png',

    shortDescription: 'Медленная реактивная стратегия',
    longDescription:
        'Глубокая вероятностная модель скрытых фигур, вывод мотивов соперника, ' +
        'организованные кулаки, оборонительные редуты, 2-ply lookahead и обманные манёвры. ' +
        'Кажется медленным — считает на несколько ходов вперёд.',
    algorithmLabel: 'Bayesian motives + EV + redoubts + 2-ply',
    tier: 'easy',
    stars: 1,
    difficultyLabel: 'Лёгкий',
    tags: [
        'bayesian', 'motives', 'expected-value', 'redoubt',
        'coordination', 'deception', 'lookahead', 'flag-hunt'
    ],

    // Persistent match memory
    _mem: null,

    // =====================================================================
    //  Lifecycle
    // =====================================================================

    chooseFlagAndTrap() {
        this._resetMemory();

        // Fortified corner / edge templates: flag deep, trap covering approach
        var templates = [
            { flagIndex: 0, trapIndex: 9 },   // A6 flag, B5 trap
            { flagIndex: 7, trapIndex: 14 },  // H6 flag, G5 trap
            { flagIndex: 0, trapIndex: 8 },   // A6, A5
            { flagIndex: 7, trapIndex: 15 },  // H6, H5
            { flagIndex: 1, trapIndex: 9 },   // B6, B5
            { flagIndex: 6, trapIndex: 14 },  // G6, G5
            { flagIndex: 0, trapIndex: 1 },   // A6, B6 (trap same rank)
            { flagIndex: 7, trapIndex: 6 },   // H6, G6
            { flagIndex: 2, trapIndex: 10 },  // C6, C5
            { flagIndex: 5, trapIndex: 13 }   // F6, F5
        ];
        var pick = templates[Math.floor(Math.random() * templates.length)];
        this._mem.setup = pick;
        return { flagIndex: pick.flagIndex, trapIndex: pick.trapIndex };
    },

    move(gameState) {
        try {
            if (!this._mem) this._resetMemory();
            this._mem.turn++;

            this._observe(gameState);
            this._updateBeliefs(gameState);
            this._inferMotives(gameState);
            this._renormalizeGlobals(gameState);

            var mine = myPieces(gameState).filter(function (p) {
                return !p.immobilized;
            });
            if (mine.length === 0) return null;

            var urgency = this._passivityUrgency(gameState);
            var plan = this._buildPlan(gameState, urgency);

            // --- Hard tactical overrides (must-do) ---
            var forced = this._forcedTactics(gameState, mine, plan, urgency);
            if (forced) return this._commit(forced, gameState);

            // --- Score every legal candidate, then refine top ones with lookahead ---
            var candidates = this._generateCandidates(gameState, mine, plan, urgency);
            if (candidates.length === 0) return this._emergencyMove(gameState, mine);

            candidates.sort(function (a, b) { return b.score - a.score; });

            var topN = Math.min(LOOKAHEAD_CANDIDATES, candidates.length);
            var best = candidates[0];
            for (var i = 0; i < topN; i++) {
                var refined = this._lookaheadScore(gameState, candidates[i], plan, urgency);
                candidates[i].score = refined;
                if (refined > best.score) best = candidates[i];
            }

            // Anti-oscillation: slight preference for a different piece
            if (this._mem.lastMovedId && candidates.length > 1) {
                for (var j = 0; j < Math.min(6, candidates.length); j++) {
                    if (candidates[j].piece.id !== this._mem.lastMovedId
                        && candidates[j].score >= best.score - 18) {
                        best = candidates[j];
                        break;
                    }
                }
            }

            return this._commit(best, gameState);
        } catch (err) {
            console.error('[lenivchik] move() crashed:', err);
            return this._emergencyMove(gameState, myPieces(gameState));
        }
    },

    getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
        if (!this._mem) this._resetMemory();

        // counter(x) = the type that beats x (rock loses to paper, …)
        function counterOf(t) {
            return LOSES_TO[t] || null;
        }

        // Prefer counter to historically most common enemy reveal; diversify.
        var hist = this._mem.enemyTypeHist;
        var counts = { rock: hist.rock || 0, paper: hist.paper || 0, scissors: hist.scissors || 0 };
        var total = counts.rock + counts.paper + counts.scissors;

        var bestType = null;
        var bestCount = -1;
        for (var i = 0; i < RPS_TYPES.length; i++) {
            var t = RPS_TYPES[i];
            if (counts[t] > bestCount) {
                bestCount = counts[t];
                bestType = t;
            }
        }

        // opponentType is the piece's public identity (not the hidden re-roll).
        // Weight it as a prior they may stick with the same symbol.
        var mix = { rock: 1, paper: 1, scissors: 1 };
        if (opponentType && mix[opponentType] != null) {
            mix[opponentType] += 2;
        }
        if (total >= 1 && bestType) {
            mix[bestType] += bestCount;
        }
        // Soft-max pick with exploration
        var keys = RPS_TYPES;
        var weights = [];
        var sumW = 0;
        for (var k = 0; k < keys.length; k++) {
            // Score for choosing this = how often it counters expected enemy mix
            var choice = keys[k];
            var w = 0.15; // exploration floor
            for (var e = 0; e < keys.length; e++) {
                var enemy = keys[e];
                if (battle(choice, enemy) === 'win') w += mix[enemy];
                else if (battle(choice, enemy) === 'draw') w += mix[enemy] * 0.25;
            }
            // Slight anti-mirror: avoid always copying our board type
            if (choice === currentType) w *= 0.9;
            weights.push(w);
            sumW += w;
        }
        var r = Math.random() * sumW;
        for (var pi = 0; pi < weights.length; pi++) {
            r -= weights[pi];
            if (r <= 0) return keys[pi];
        }
        return counterOf(bestType) || RPS_TYPES[(RPS_TYPES.indexOf(currentType) + 1) % 3];
    },

    // =====================================================================
    //  Memory
    // =====================================================================

    _resetMemory() {
        this._mem = {
            turn: 0,
            setup: null,
            beliefs: new Map(),          // id -> {probs, moved, still, firstMovedTurn, lastR, lastC, approaches, flees}
            enemyTypeHist: { rock: 0, paper: 0, scissors: 0 },
            revealedIds: new Set(),
            deadEnemyTypes: { rock: 0, paper: 0, scissors: 0, flag: 0, trap: 0 },
            lastEnemySnapshot: new Map(), // id -> {r,c,revealed,type,pieceType}
            lastMovedId: null,
            ourHistory: [],               // {id, from, to, turn}
            loopHits: new Map(),          // id -> count of recent 2-cell shuttles
            motiveProfile: {
                aggression: 0.5,
                caution: 0.5,
                flagHiding: 0.5,
                trapGuarding: 0.5
            },
            suspectedFlagIds: [],
            suspectedTrapIds: [],
            zoneHeat: null,               // 6x8 attack heat from posteriors
            decoyArmed: false,
            campaign: { mode: 'probe', focusCol: 3, since: 0 }
        };
    },

    // =====================================================================
    //  Perception
    // =====================================================================

    _observe(gs) {
        var enemies = enPieces(gs);
        var prev = this._mem.lastEnemySnapshot;
        var next = new Map();

        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            var before = prev.get(e.id);
            var bel = this._ensureBelief(e, gs);

            // Movement tracking
            if (before) {
                if (before.r !== e.row || before.c !== e.col) {
                    bel.moved = true;
                    bel.still = 0;
                    bel.lastMoveTurn = this._mem.turn;
                    if (bel.firstMovedTurn == null) bel.firstMovedTurn = this._mem.turn;
                    bel.trail.push({ r: e.row, c: e.col, t: this._mem.turn });
                    if (bel.trail.length > 12) bel.trail.shift();
                } else {
                    bel.still++;
                }
            }

            bel.lastR = e.row;
            bel.lastC = e.col;

            // Reveals
            if (e.revealed) {
                if (!this._mem.revealedIds.has(e.id)) {
                    this._mem.revealedIds.add(e.id);
                    if (e.type === 'piece' && e.pieceType) {
                        this._mem.enemyTypeHist[e.pieceType] =
                            (this._mem.enemyTypeHist[e.pieceType] || 0) + 1;
                    }
                }
                // Hard assign
                if (e.type === FLAG) {
                    bel.probs = { rock: 0, paper: 0, scissors: 0, flag: 1, trap: 0 };
                } else if (e.type === TRAP) {
                    bel.probs = { rock: 0, paper: 0, scissors: 0, flag: 0, trap: 1 };
                } else if (e.pieceType) {
                    bel.probs = { rock: 0, paper: 0, scissors: 0, flag: 0, trap: 0 };
                    bel.probs[e.pieceType] = 1;
                }
            }

            next.set(e.id, {
                r: e.row, c: e.col,
                revealed: !!e.revealed,
                type: e.type,
                pieceType: e.pieceType || null
            });
        }

        // Detect removals (deaths) from previous snapshot
        prev.forEach(function (snap, id) {
            if (!next.has(id)) {
                // Piece vanished — if we knew type, record
                if (snap.revealed) {
                    var k = snap.type === 'piece' ? snap.pieceType : snap.type;
                    if (k && this._mem.deadEnemyTypes[k] != null) {
                        this._mem.deadEnemyTypes[k]++;
                    }
                }
                this._mem.beliefs.delete(id);
            }
        }.bind(this));

        this._mem.lastEnemySnapshot = next;
    },

    _ensureBelief(e, gs) {
        var b = this._mem.beliefs.get(e.id);
        if (b) return b;

        // Priors: back row (player row 5) more flag/trap; front (4) more combat
        var pFlag = e.row >= 5 ? 0.14 : (e.row >= 4 ? 0.04 : 0.02);
        var pTrap = e.row >= 5 ? 0.10 : (e.row >= 4 ? 0.05 : 0.03);
        // Corners slightly more flag-like
        if (e.col === 0 || e.col === 7) pFlag *= 1.35;
        if (e.col === 1 || e.col === 6) pTrap *= 1.2;
        var rest = Math.max(0.05, 1 - pFlag - pTrap);
        var third = rest / 3;

        b = {
            probs: {
                rock: third, paper: third, scissors: third,
                flag: pFlag, trap: pTrap
            },
            moved: false,
            still: 0,
            firstMovedTurn: null,
            lastMoveTurn: null,
            lastR: e.row,
            lastC: e.col,
            trail: [],
            fleeFrom: { rock: 0, paper: 0, scissors: 0 },
            approachTo: { rock: 0, paper: 0, scissors: 0 },
            ignoreOpen: { rock: 0, paper: 0, scissors: 0 },
            attackedUs: 0,
            nearFlagScore: 0
        };
        this._mem.beliefs.set(e.id, b);
        return b;
    },

    // =====================================================================
    //  Bayesian updates + motive inference
    // =====================================================================

    _updateBeliefs(gs) {
        var mine = myPieces(gs);
        var enemies = enPieces(gs);

        // Open (revealed) combat pieces of ours that enemies can "see"
        var openUs = [];
        for (var i = 0; i < mine.length; i++) {
            var m = mine[i];
            if (m.type === 'piece' && m.revealed && m.pieceType) {
                openUs.push(m);
            }
        }

        for (var ei = 0; ei < enemies.length; ei++) {
            var e = enemies[ei];
            if (e.revealed) continue;
            var bel = this._ensureBelief(e, gs);
            var p = bel.probs;

            // --- Stillness → flag / trap prior boost ---
            if (!bel.moved) {
                softMaxMul(p, 'flag', 1.04 + Math.min(bel.still, 10) * 0.01);
                softMaxMul(p, 'trap', 1.02 + Math.min(bel.still, 8) * 0.008);
            } else {
                // Moved pieces almost never flags (flag can move but rarely does for smart players)
                softMaxMul(p, 'flag', 0.55);
                // Trap almost never moves before springing (immobilized after)
                softMaxMul(p, 'trap', 0.35);
                // Combat prior up
                softMaxMul(p, 'rock', 1.08);
                softMaxMul(p, 'paper', 1.08);
                softMaxMul(p, 'scissors', 1.08);
            }

            // Early movers from back rank → almost certainly combat scouts
            if (bel.firstMovedTurn != null && bel.firstMovedTurn <= 4 && e.row <= 3) {
                softMaxMul(p, 'flag', 0.2);
                softMaxMul(p, 'trap', 0.25);
            }

            // Deep back + never moved after mid-game → strong flag candidate
            if (!bel.moved && this._mem.turn >= 6 && e.row >= 5) {
                softMaxMul(p, 'flag', 1.25);
            }

            // --- Motive: reaction to our open weapons ---
            for (var oi = 0; oi < openUs.length; oi++) {
                var us = openUs[oi];
                var dist = chebyshev(e.row, e.col, us.row, us.col);
                var ourType = us.pieceType;
                if (!ourType) continue;

                // Adjacent and stayed put / moved away / moved closer
                if (dist === 1) {
                    // They stand next to our open piece without attacking
                    var whatLoses = BEATS[ourType]; // what ourType beats = what they would be if scared
                    // If they don't attack an open rock, maybe they are scissors (lose to rock)
                    // OR trap/flag. Boost lose-type and trap/flag slightly.
                    softMaxMul(p, whatLoses, 1.12);
                    softMaxMul(p, 'trap', 1.05);
                    softMaxMul(p, 'flag', 1.03);
                    // Reduce the type that would greedily attack us
                    var whatBeatsUs = LOSES_TO[ourType];
                    softMaxMul(p, whatBeatsUs, 0.88);
                    bel.ignoreOpen[ourType] = (bel.ignoreOpen[ourType] || 0) + 1;
                }

                // Trail-based flee / approach (last step)
                if (bel.trail.length >= 2) {
                    var prev = bel.trail[bel.trail.length - 2];
                    var now = bel.trail[bel.trail.length - 1];
                    var dPrev = chebyshev(prev.r, prev.c, us.row, us.col);
                    var dNow = chebyshev(now.r, now.c, us.row, us.col);
                    if (dNow > dPrev && dPrev <= 2) {
                        // Fled from our open type → likely loses to it
                        softMaxMul(p, BEATS[ourType], 1.22);
                        softMaxMul(p, LOSES_TO[ourType], 0.82);
                        bel.fleeFrom[ourType] = (bel.fleeFrom[ourType] || 0) + 1;
                    } else if (dNow < dPrev && dNow <= 2) {
                        // Approached our open type → likely beats it, or probing
                        softMaxMul(p, LOSES_TO[ourType], 1.18);
                        softMaxMul(p, BEATS[ourType], 0.85);
                        bel.approachTo[ourType] = (bel.approachTo[ourType] || 0) + 1;
                    }
                }
            }

            // Cluster of motionless back-row pieces: one is flag, neighbour trap
            if (!bel.moved && e.row >= 4) {
                var neighboursStill = 0;
                for (var nj = 0; nj < enemies.length; nj++) {
                    var o = enemies[nj];
                    if (o.id === e.id || o.revealed) continue;
                    var ob = this._mem.beliefs.get(o.id);
                    if (ob && !ob.moved && chebyshev(e.row, e.col, o.row, o.col) === 1) {
                        neighboursStill++;
                    }
                }
                if (neighboursStill >= 1) {
                    softMaxMul(p, 'flag', 1.06);
                    softMaxMul(p, 'trap', 1.08);
                }
            }

            bel.probs = normalize5(p);
        }
    },

    _inferMotives(gs) {
        var enemies = enPieces(gs);
        var advanced = 0;
        var total = enemies.length || 1;
        var stillBack = 0;
        var attacks = 0;

        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            var bel = this._mem.beliefs.get(e.id);
            if (e.row <= 2) advanced++;
            if (bel && !bel.moved && e.row >= 4) stillBack++;
            if (bel) attacks += bel.attackedUs || 0;
        }

        var m = this._mem.motiveProfile;
        m.aggression = clamp(0.3 + (advanced / total) * 0.7 + attacks * 0.05, 0, 1);
        m.caution = clamp(1 - m.aggression + stillBack * 0.03, 0, 1);
        m.flagHiding = clamp(stillBack / Math.max(3, total * 0.4), 0, 1);
        m.trapGuarding = clamp(m.flagHiding * 0.8 + m.caution * 0.2, 0, 1);

        // Campaign mode
        if (this._mem.turn < 5) {
            this._mem.campaign.mode = 'probe';
        } else if (m.aggression > 0.65) {
            this._mem.campaign.mode = 'counter';
        } else if (this._mem.turn > 12 || this._passivityUrgency(gs) >= 3) {
            this._mem.campaign.mode = 'blitz';
        } else {
            this._mem.campaign.mode = 'siege';
        }

        // Focus column = centroid of high flag posterior
        var wSum = 0;
        var cSum = 0;
        enemies.forEach(function (e) {
            var bel = this._mem.beliefs.get(e.id);
            if (!bel) return;
            var w = bel.probs.flag;
            wSum += w;
            cSum += e.col * w;
        }.bind(this));
        if (wSum > EPS) this._mem.campaign.focusCol = Math.round(cSum / wSum);
    },

    _renormalizeGlobals(gs) {
        // Exactly one flag and one trap among all living enemy pieces.
        var enemies = enPieces(gs);
        var flagKnown = null;
        var trapKnown = null;
        var hidden = [];

        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            if (e.revealed && e.type === FLAG) flagKnown = e.id;
            else if (e.revealed && e.type === TRAP) trapKnown = e.id;
            else if (!e.revealed) hidden.push(e);
        }

        if (flagKnown) {
            hidden.forEach(function (h) {
                var b = this._mem.beliefs.get(h.id);
                if (b) { b.probs.flag = 0; b.probs = normalize5(b.probs); }
            }.bind(this));
        } else {
            this._redistributeMass(hidden, 'flag', 1);
        }

        if (trapKnown) {
            hidden.forEach(function (h) {
                var b = this._mem.beliefs.get(h.id);
                if (b) { b.probs.trap = 0; b.probs = normalize5(b.probs); }
            }.bind(this));
        } else {
            this._redistributeMass(hidden, 'trap', 1);
        }

        // Rank suspects
        var flagRank = hidden.map(function (h) {
            var b = this._mem.beliefs.get(h.id);
            return { id: h.id, p: b ? b.probs.flag : 0, piece: h };
        }.bind(this)).sort(function (a, b) { return b.p - a.p; });

        var trapRank = hidden.map(function (h) {
            var b = this._mem.beliefs.get(h.id);
            return { id: h.id, p: b ? b.probs.trap : 0, piece: h };
        }.bind(this)).sort(function (a, b) { return b.p - a.p; });

        this._mem.suspectedFlagIds = flagRank.slice(0, 4);
        this._mem.suspectedTrapIds = trapRank.slice(0, 4);

        // Zone heat: sum of flag+combat posteriors projected on board
        var heat = [];
        for (var r = 0; r < H; r++) {
            heat[r] = [];
            for (var c = 0; c < W; c++) heat[r][c] = 0;
        }
        for (var hi = 0; hi < hidden.length; hi++) {
            var hp = hidden[hi];
            var bel = this._mem.beliefs.get(hp.id);
            if (!bel) continue;
            var mass = bel.probs.flag * 3 + bel.probs.rock + bel.probs.paper + bel.probs.scissors + bel.probs.trap * 0.5;
            heat[hp.row][hp.col] += mass;
            // Spread one step
            for (var d = 0; d < DIRS.length; d++) {
                var rr = hp.row + DIRS[d][0];
                var cc = hp.col + DIRS[d][1];
                if (rr >= 0 && rr < H && cc >= 0 && cc < W) heat[rr][cc] += mass * 0.25;
            }
        }
        this._mem.zoneHeat = heat;
    },

    _redistributeMass(hidden, key, targetSum) {
        if (hidden.length === 0) return;
        var weights = [];
        var sum = 0;
        for (var i = 0; i < hidden.length; i++) {
            var b = this._mem.beliefs.get(hidden[i].id);
            var w = b ? Math.max(EPS, b.probs[key]) : EPS;
            weights.push(w);
            sum += w;
        }
        if (sum <= EPS) {
            var eq = targetSum / hidden.length;
            for (var j = 0; j < hidden.length; j++) {
                var bj = this._mem.beliefs.get(hidden[j].id);
                if (!bj) continue;
                bj.probs[key] = eq;
                bj.probs = normalize5(bj.probs);
            }
            return;
        }
        for (var k = 0; k < hidden.length; k++) {
            var bk = this._mem.beliefs.get(hidden[k].id);
            if (!bk) continue;
            bk.probs[key] = (weights[k] / sum) * targetSum;
            // Keep other mass proportional in remaining 1-key
            var restKeys = ['rock', 'paper', 'scissors', 'flag', 'trap'].filter(function (x) {
                return x !== key;
            });
            var restSum = 0;
            for (var ri = 0; ri < restKeys.length; ri++) restSum += bk.probs[restKeys[ri]];
            var need = Math.max(EPS, 1 - bk.probs[key]);
            if (restSum <= EPS) {
                var eqr = need / restKeys.length;
                for (var r2 = 0; r2 < restKeys.length; r2++) bk.probs[restKeys[r2]] = eqr;
            } else {
                for (var r3 = 0; r3 < restKeys.length; r3++) {
                    bk.probs[restKeys[r3]] = bk.probs[restKeys[r3]] / restSum * need;
                }
            }
        }
    },

    // =====================================================================
    //  Plan snapshot (derived state for this turn)
    // =====================================================================

    _buildPlan(gs, urgency) {
        var flag = myFlag(gs);
        var enemies = enPieces(gs);
        var threats = [];
        var flagDanger = 0;

        if (flag) {
            for (var i = 0; i < enemies.length; i++) {
                var e = enemies[i];
                if (e.type === FLAG) continue;
                var d = chebyshev(e.row, e.col, flag.row, flag.col);
                if (d <= 3) {
                    var bel = this._mem.beliefs.get(e.id);
                    var combatP = 1;
                    if (bel && !e.revealed) {
                        combatP = 1 - bel.probs.flag - bel.probs.trap * 0.3;
                    }
                    if (e.revealed && e.type === TRAP) combatP = 0.15;
                    var threat = (4 - d) * combatP * 40;
                    if (d <= 1) threat += 200;
                    else if (d === 2) threat += 80;
                    threats.push({ enemy: e, dist: d, score: threat });
                    flagDanger += threat;
                }
            }
        }

        threats.sort(function (a, b) { return b.score - a.score; });

        var topFlag = this._mem.suspectedFlagIds[0] || null;
        var topTrap = this._mem.suspectedTrapIds[0] || null;

        return {
            flag: flag,
            threats: threats,
            flagDanger: flagDanger,
            topFlagSuspect: topFlag,
            topTrapSuspect: topTrap,
            mode: this._mem.campaign.mode,
            focusCol: this._mem.campaign.focusCol,
            urgency: urgency,
            motives: this._mem.motiveProfile
        };
    },

    _passivityUrgency(gs) {
        var mwc = gs.movesWithoutCapture || 0;
        var u = 0;
        if (mwc >= Math.floor(DRAW_LIMIT * 0.4)) u += 1;
        if (mwc >= Math.floor(DRAW_LIMIT * 0.55)) u += 2;
        if (mwc >= Math.floor(DRAW_LIMIT * 0.7)) u += 3;
        if (mwc >= Math.floor(DRAW_LIMIT * 0.85)) u += 4;
        return u;
    },

    // =====================================================================
    //  Forced tactics
    // =====================================================================

    _forcedTactics(gs, mine, plan, urgency) {
        // 1. Capture revealed enemy flag — instant win
        var cap = this._findFlagCapture(gs, mine);
        if (cap) { cap.score = 1e9; return cap; }

        // 2. Immediate threat on our flag: block / kill / flee flag
        if (plan.flagDanger >= 180) {
            var def = this._criticalDefense(gs, mine, plan);
            if (def) return def;
        }

        // 3. Guaranteed winning capture on revealed combat piece
        var kill = this._findGuaranteedKill(gs, mine);
        if (kill) { kill.score = 5e5; return kill; }

        // 4. Extremely high-EV attack on hidden piece that is almost certainly flag
        if (plan.topFlagSuspect && plan.topFlagSuspect.p >= 0.45) {
            var hunt = this._adjacentCaptureOf(gs, mine, plan.topFlagSuspect.piece);
            if (hunt) {
                // Prefer expendable / less critical attacker
                hunt.score = 4e5;
                return hunt;
            }
        }

        return null;
    },

    _findFlagCapture(gs, mine) {
        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.type === FLAG || p.immobilized) continue;
            var moves = legalMoves(p, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                var t = gs.board[m.row] && gs.board[m.row][m.col];
                if (t && t.owner === 'player' && t.revealed && t.type === FLAG) {
                    return { piece: p, row: m.row, col: m.col, tag: 'flag-cap' };
                }
            }
        }
        return null;
    },

    _findGuaranteedKill(gs, mine) {
        var best = null;
        var bestV = -1;
        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.type !== 'piece' || !p.pieceType) continue;
            var moves = legalMoves(p, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                var t = gs.board[m.row] && gs.board[m.row][m.col];
                if (!t || t.owner !== 'player' || !t.revealed) continue;
                if (t.type !== 'piece') continue;
                if (battle(p.pieceType, t.pieceType) !== 'win') continue;
                // Prefer kills deeper in enemy territory / threatening our flag less trade
                var v = 100 + t.row * 5;
                if (this._hasSupport(gs, p, m.row, m.col)) v += 30;
                if (v > bestV) {
                    bestV = v;
                    best = { piece: p, row: m.row, col: m.col, tag: 'guaranteed' };
                }
            }
        }
        return best;
    },

    _adjacentCaptureOf(gs, mine, target) {
        if (!target) return null;
        var best = null;
        var bestS = -1e9;
        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.type === FLAG || p.immobilized) continue;
            if (chebyshev(p.row, p.col, target.row, target.col) !== 1) continue;
            // Legal?
            var moves = legalMoves(p, gs);
            var ok = false;
            for (var j = 0; j < moves.length; j++) {
                if (moves[j].row === target.row && moves[j].col === target.col) {
                    ok = true;
                    break;
                }
            }
            if (!ok) continue;
            var s = 0;
            // Prefer trap as sacrifice for high-prob flag? Trap attacking flag wins but trap is valuable.
            // Prefer cheap combat piece, prefer paper/scissors/rock equally for flag.
            if (p.type === TRAP) s -= 40;
            if (this._isRedoubtGuardian(gs, p)) s -= 25;
            s += (5 - p.row); // prefer pieces already advanced
            if (s > bestS) {
                bestS = s;
                best = { piece: p, row: target.row, col: target.col, tag: 'suspect-flag' };
            }
        }
        return best;
    },

    _criticalDefense(gs, mine, plan) {
        var flag = plan.flag;
        if (!flag) return null;

        // a) Capture the nearest threat if we win / good EV
        for (var i = 0; i < plan.threats.length; i++) {
            var th = plan.threats[i];
            if (th.dist > 2) break;
            var e = th.enemy;
            for (var j = 0; j < mine.length; j++) {
                var p = mine[j];
                if (p.type === FLAG || p.immobilized) continue;
                if (chebyshev(p.row, p.col, e.row, e.col) !== 1) continue;
                var moves = legalMoves(p, gs);
                for (var k = 0; k < moves.length; k++) {
                    if (moves[k].row === e.row && moves[k].col === e.col) {
                        var ev = this._attackEV(p, e, gs);
                        if (ev > -15 || th.dist === 1) {
                            return { piece: p, row: e.row, col: e.col, score: 3e5 + ev, tag: 'def-kill' };
                        }
                    }
                }
            }
        }

        // b) Interpose: move a piece onto a square adjacent to flag that blocks approach
        var block = this._findRedoubtMove(gs, mine, plan, true);
        if (block) {
            block.score = 2.5e5;
            return block;
        }

        // c) Flag flight — only if empty adjacent away from threats
        if (flag && !flag.immobilized) {
            var fmoves = legalMoves(flag, gs);
            var bestF = null;
            var bestFS = -1e9;
            for (var fi = 0; fi < fmoves.length; fi++) {
                var fm = fmoves[fi];
                if (gs.board[fm.row] && gs.board[fm.row][fm.col]) continue;
                var safety = this._cellSafety(gs, fm.row, fm.col, flag.id);
                // Prefer deeper home / edge
                safety += (H - 1 - fm.row) * 3;
                if ((fm.col === 0 || fm.col === 7)) safety += 8;
                // Don't run into enemies
                for (var ti = 0; ti < plan.threats.length; ti++) {
                    safety -= (3 - Math.min(3, chebyshev(fm.row, fm.col, plan.threats[ti].enemy.row, plan.threats[ti].enemy.col))) * 20;
                }
                if (safety > bestFS) {
                    bestFS = safety;
                    bestF = { piece: flag, row: fm.row, col: fm.col, tag: 'flag-flee' };
                }
            }
            if (bestF && bestFS > -50) {
                bestF.score = 2.2e5 + bestFS;
                return bestF;
            }
        }

        return null;
    },

    // =====================================================================
    //  Candidate generation + scoring
    // =====================================================================

    _generateCandidates(gs, mine, plan, urgency) {
        var out = [];
        var seen = new Set();

        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.immobilized) continue;
            var moves = legalMoves(p, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                var id = p.id + '>' + m.row + ',' + m.col;
                if (seen.has(id)) continue;
                seen.add(id);

                if (this._isLoopMove(p, m)) continue;

                var scored = this._scoreMove(gs, p, m, plan, urgency);
                if (scored <= -8000) continue; // hard discard

                out.push({
                    piece: p,
                    row: m.row,
                    col: m.col,
                    score: scored,
                    tag: 'eval'
                });
            }
        }
        return out;
    },

    _scoreMove(gs, piece, m, plan, urgency) {
        var target = gs.board[m.row] && gs.board[m.row][m.col];
        var score = 0;
        var isCap = !!(target && target.owner === 'player');

        // ---- Capture evaluation ----
        if (isCap) {
            if (target.revealed && target.type === FLAG) return 1e6;
            if (target.revealed && target.type === TRAP) return -1e5; // suicide
            if (target.revealed && target.type === 'piece' && piece.pieceType) {
                var res = battle(piece.pieceType, target.pieceType);
                if (res === 'win') score += 520;
                else if (res === 'draw') score += 40 + urgency * 25;
                else score -= 400;
            } else if (!target.revealed) {
                var ev = this._attackEV(piece, target, gs);
                score += ev;
            }

            // Support / gang bonus
            if (this._hasSupport(gs, piece, m.row, m.col)) score += 55;
            // Fist synergy
            score += this._fistBonus(gs, piece, m.row, m.col) * 20;

            // Attacking high-prob flag zone
            var bel = this._mem.beliefs.get(target.id);
            if (bel) {
                score += bel.probs.flag * 380;
                score -= bel.probs.trap * 220;
            }
        } else {
            // ---- Quiet move ----
            // Forward progress (home is top: +row is forward)
            var forward = m.row - piece.row;
            score += forward * (28 + urgency * 10);

            // Toward focus column / flag suspects
            if (plan.topFlagSuspect && plan.topFlagSuspect.piece) {
                var fp = plan.topFlagSuspect.piece;
                var d0 = chebyshev(piece.row, piece.col, fp.row, fp.col);
                var d1 = chebyshev(m.row, m.col, fp.row, fp.col);
                score += (d0 - d1) * (45 + plan.topFlagSuspect.p * 80);
            } else {
                score += (Math.abs(piece.col - plan.focusCol) - Math.abs(m.col - plan.focusCol)) * 8;
            }

            // Zone heat attraction
            if (this._mem.zoneHeat) {
                score += (this._mem.zoneHeat[m.row][m.col] || 0) * 35;
            }

            // Don't retreat early without reason
            if (forward < 0 && piece.row <= 2 && plan.flagDanger < 100) {
                score -= 50;
            }

            // Horizontal shuttle tax
            if (forward === 0 && !isCap) score -= 35;
        }

        // ---- Defense / redoubt ----
        if (plan.flag) {
            score += this._redoubtScore(gs, piece, m, plan);

            // Leaving flag under-defended
            if (this._isRedoubtGuardian(gs, piece) && !isCap) {
                var stillGuarding = chebyshev(m.row, m.col, plan.flag.row, plan.flag.col) <= 2;
                if (!stillGuarding && plan.flagDanger > 60) score -= 70;
            }
        }

        // ---- Safety of destination ----
        score += this._cellSafety(gs, m.row, m.col, piece.id) * 0.6;

        // After quiet move, do we step adjacent to a deadly open enemy?
        if (!isCap && piece.type === 'piece' && piece.pieceType) {
            score += this._exposurePenalty(gs, piece, m.row, m.col);
        }

        // ---- Mode modifiers ----
        if (plan.mode === 'probe') {
            if (isCap && target && !target.revealed) score += 30;
            if (forward > 0 && piece.row <= 2) score += 15;
        } else if (plan.mode === 'siege') {
            if (plan.topFlagSuspect) {
                var tfp = plan.topFlagSuspect.piece;
                if (tfp && chebyshev(m.row, m.col, tfp.row, tfp.col) <= 2) score += 40;
            }
            score += this._pincerBonus(gs, piece, m, plan);
        } else if (plan.mode === 'blitz') {
            score += forward * 25 + urgency * 20;
            if (isCap) score += 40 + urgency * 15;
        } else if (plan.mode === 'counter') {
            // Prefer killing advanced invaders
            if (isCap && target && target.row <= 2) score += 70;
        }

        // ---- Deception ----
        score += this._deceptionScore(gs, piece, m, plan);

        // ---- Trap usage discipline ----
        if (piece.type === TRAP) {
            if (!isCap) score -= 60; // keep trap planted near flag
            if (isCap && target) {
                var tb = this._mem.beliefs.get(target.id);
                var flagP = tb ? tb.probs.flag : 0.05;
                score += flagP * 300 - 80; // only spring trap for likely flag / critical
            }
        }

        // ---- Flag move discipline ----
        if (piece.type === FLAG) {
            if (isCap) return -1e6;
            if (plan.flagDanger < 120) score -= 200; // lazy flag stays put
            else score += 50; // allowed to slip away
        }

        // ---- Piece diversity: don't thrash one unit ----
        if (piece.id === this._mem.lastMovedId) score -= 12;

        // Small jitter to break ties unpredictably (not pure random play)
        score += (this._stableNoise(piece.id, m.row, m.col) - 0.5) * 4;

        return score;
    },

    _attackEV(attacker, defender, gs) {
        // Expected value of attacking defender under belief distribution.
        // win ~ +100, draw ~ +10, lose ~ -90, flag ~ +10000, trap ~ -200
        if (!attacker || !defender) return 0;
        if (defender.revealed) {
            if (defender.type === FLAG) return 10000;
            if (defender.type === TRAP) return -250;
            if (defender.type === 'piece' && attacker.pieceType) {
                var r = battle(attacker.pieceType, defender.pieceType);
                if (r === 'win') return 110;
                if (r === 'draw') return 15;
                return -95;
            }
            return 0;
        }

        var bel = this._mem.beliefs.get(defender.id);
        var probs = bel ? bel.probs : { rock: 0.28, paper: 0.28, scissors: 0.28, flag: 0.08, trap: 0.08 };
        var atk = attacker.pieceType;
        if (attacker.type === TRAP) {
            // Trap "wins" combat but dies / immobilizes — value as removal of target
            return probs.flag * 900 + probs.trap * (-20)
                + (probs.rock + probs.paper + probs.scissors) * 40 - 50;
        }
        if (!atk) return -10;

        var ev = 0;
        ev += probs.flag * 950;
        ev += probs.trap * (-220);
        for (var i = 0; i < RPS_TYPES.length; i++) {
            var defT = RPS_TYPES[i];
            var res = battle(atk, defT);
            var pay = res === 'win' ? 100 : (res === 'draw' ? 12 : -95);
            ev += probs[defT] * pay;
        }

        // Behavioural confirmation: if motive says they flee from us, EV up
        if (bel && bel.fleeFrom && bel.fleeFrom[atk] > 0) {
            ev += 18 * Math.min(3, bel.fleeFrom[atk]);
        }
        // If they approach us, higher chance they beat us
        if (bel && bel.approachTo && bel.approachTo[atk] > 0) {
            ev -= 15 * Math.min(3, bel.approachTo[atk]);
        }
        // Standing still next to our open rock and not attacking → scissors-ish
        if (bel && bel.ignoreOpen && attacker.revealed) {
            // Already folded into beliefs; mild extra
            ev += 5;
        }

        // Support reduces lose cost (recapture chance)
        if (this._hasSupport(gs, attacker, defender.row, defender.col)) {
            ev += 22;
        }

        return ev;
    },

    _hasSupport(gs, attacker, r, c) {
        var mine = myPieces(gs);
        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.id === attacker.id || p.immobilized) continue;
            if (p.type === FLAG) continue;
            if (chebyshev(p.row, p.col, r, c) <= 1) return true;
        }
        return false;
    },

    _fistBonus(gs, attacker, r, c) {
        // Diversity of nearby ally weapons (rock+paper+scissors cluster)
        var mine = myPieces(gs);
        var types = {};
        var n = 0;
        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.id === attacker.id || p.type !== 'piece') continue;
            if (chebyshev(p.row, p.col, r, c) <= 2) {
                n++;
                if (p.pieceType) types[p.pieceType] = true;
            }
        }
        if (attacker.pieceType) types[attacker.pieceType] = true;
        var diversity = Object.keys(types).length;
        if (n >= 2 && diversity >= 2) return 1 + diversity * 0.5;
        return 0;
    },

    _isRedoubtGuardian(gs, piece) {
        var flag = myFlag(gs);
        if (!flag || !piece) return false;
        return chebyshev(piece.row, piece.col, flag.row, flag.col) <= 2
            && piece.type !== FLAG;
    },

    _redoubtScore(gs, piece, m, plan) {
        if (!plan.flag) return 0;
        var fr = plan.flag.row;
        var fc = plan.flag.col;
        var d0 = chebyshev(piece.row, piece.col, fr, fc);
        var d1 = chebyshev(m.row, m.col, fr, fc);
        var s = 0;

        // Build a shell: occupy cells at dist 1 from flag when danger
        if (plan.flagDanger > 40) {
            if (d1 === 1 && d0 !== 1) s += 55 + Math.min(plan.flagDanger, 200) * 0.15;
            if (d1 === 1 && this._coversApproach(m.row, m.col, plan)) s += 35;
        }

        // When safe, free guardians for offense
        if (plan.flagDanger < 30 && d0 <= 1 && d1 > d0 && piece.type === 'piece') {
            s += 20; // release
        }

        return s;
    },

    _coversApproach(r, c, plan) {
        for (var i = 0; i < plan.threats.length; i++) {
            var e = plan.threats[i].enemy;
            // Cell between threat and flag
            if (chebyshev(r, c, e.row, e.col) <= 1) return true;
        }
        return false;
    },

    _findRedoubtMove(gs, mine, plan, critical) {
        if (!plan.flag) return null;
        var best = null;
        var bestS = -1e9;
        var fr = plan.flag.row;
        var fc = plan.flag.col;

        for (var i = 0; i < mine.length; i++) {
            var p = mine[i];
            if (p.type === FLAG || p.immobilized) continue;
            var moves = legalMoves(p, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                if (gs.board[m.row] && gs.board[m.row][m.col]) continue;
                var d = chebyshev(m.row, m.col, fr, fc);
                if (d > 2) continue;
                var s = 0;
                if (d === 1) s += 40;
                if (this._coversApproach(m.row, m.col, plan)) s += 50;
                s += this._cellSafety(gs, m.row, m.col, p.id) * 0.3;
                // Prefer pieces that are not already perfect guardians
                if (chebyshev(p.row, p.col, fr, fc) > 2) s += 15;
                if (s > bestS) {
                    bestS = s;
                    best = { piece: p, row: m.row, col: m.col, tag: 'redoubt' };
                }
            }
        }
        if (critical && bestS < 20) return null;
        return best;
    },

    _pincerBonus(gs, piece, m, plan) {
        if (!plan.topFlagSuspect || !plan.topFlagSuspect.piece) return 0;
        var fp = plan.topFlagSuspect.piece;
        // Reward occupying opposite side of suspect relative to an ally
        var mine = myPieces(gs);
        var bonus = 0;
        for (var i = 0; i < mine.length; i++) {
            var a = mine[i];
            if (a.id === piece.id || a.type === FLAG) continue;
            if (chebyshev(a.row, a.col, fp.row, fp.col) > 3) continue;
            // Different side of the suspect
            var sideA = Math.sign(a.col - fp.col) || Math.sign(a.row - fp.row);
            var sideM = Math.sign(m.col - fp.col) || Math.sign(m.row - fp.row);
            if (sideA !== 0 && sideM !== 0 && sideA !== sideM) {
                if (chebyshev(m.row, m.col, fp.row, fp.col) <= 2) bonus += 25;
            }
        }
        return bonus;
    },

    _deceptionScore(gs, piece, m, plan) {
        // Keep some pieces unrevealed as long as possible near midfield —
        // but occasionally step a strong piece sideways as bait.
        var s = 0;
        if (piece.type === 'piece' && !piece.revealed) {
            // Hidden advance is good (info asymmetry)
            if (m.row > piece.row) s += 8;
        }
        if (piece.revealed && piece.pieceType && plan.mode === 'siege') {
            // Offer an open piece as bait: step near enemy hidden units
            var enemies = enPieces(gs);
            for (var i = 0; i < enemies.length; i++) {
                var e = enemies[i];
                if (e.revealed) continue;
                var d = chebyshev(m.row, m.col, e.row, e.col);
                if (d === 2) {
                    // Bait at distance 2 (invite them in)
                    var bel = this._mem.beliefs.get(e.id);
                    if (bel && bel.probs[BEATS[piece.pieceType]] > 0.35) {
                        // They might be what we beat — good bait
                        s += 18;
                    }
                }
            }
        }
        return s;
    },

    _cellSafety(gs, r, c, ignoreId) {
        // Higher is safer. Penalize adjacency to revealed enemies that beat us
        // (caller may not know our type if ignore is flag). Generic danger:
        var danger = 0;
        var enemies = enPieces(gs);
        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            if (e.id === ignoreId) continue;
            var d = chebyshev(e.row, e.col, r, c);
            if (d === 1) {
                if (e.revealed && e.type === 'piece') danger += 25;
                else if (e.revealed && e.type === TRAP) danger += 5;
                else danger += 12;
            } else if (d === 2) {
                danger += 4;
            }
        }
        // Ally density comfort
        var allies = 0;
        var mine = myPieces(gs);
        for (var j = 0; j < mine.length; j++) {
            if (mine[j].id === ignoreId) continue;
            if (chebyshev(mine[j].row, mine[j].col, r, c) <= 1) allies++;
        }
        return allies * 10 - danger;
    },

    _exposurePenalty(gs, piece, r, c) {
        var pen = 0;
        var enemies = enPieces(gs);
        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            if (chebyshev(e.row, e.col, r, c) !== 1) continue;
            if (e.revealed && e.type === 'piece' && e.pieceType) {
                if (battle(e.pieceType, piece.pieceType) === 'win') pen -= 90;
                else if (battle(piece.pieceType, e.pieceType) === 'win') pen += 15;
            } else if (!e.revealed) {
                var bel = this._mem.beliefs.get(e.id);
                if (bel) {
                    // Prob they beat us
                    var beatUs = LOSES_TO[piece.pieceType];
                    pen -= (bel.probs[beatUs] || 0) * 70;
                    pen -= (bel.probs.trap || 0) * 40;
                    pen += (bel.probs.flag || 0) * 20;
                }
            }
        }
        return pen;
    },

    _isLoopMove(piece, m) {
        var hist = this._mem.ourHistory;
        if (hist.length < 2) return false;
        var same = 0;
        for (var i = hist.length - 1; i >= 0 && i >= hist.length - 6; i--) {
            var h = hist[i];
            if (h.id !== piece.id) continue;
            if (h.to.r === m.row && h.to.c === m.col) same++;
            // A->B->A pattern
            if (h.from.r === m.row && h.from.c === m.col
                && h.to.r === piece.row && h.to.c === piece.col) {
                return true;
            }
        }
        return same >= 2;
    },

    _stableNoise(pieceId, r, c) {
        // Deterministic pseudo-noise from turn + ids (stable within turn)
        var s = (this._mem.turn * 73856093) ^ (String(pieceId).length * 19349663) ^ (r * 83492791) ^ (c * 39916801);
        s = (s >>> 0) % 1000;
        return s / 1000;
    },

    // =====================================================================
    //  Selective lookahead (1 opponent reply + our quiet capture check)
    // =====================================================================

    _lookaheadScore(gs, move, plan, urgency) {
        var base = move.score;
        // Shallow simulation: apply move on a lightweight clone, estimate
        // opponent's best immediate capture / approach, and our reply EV.
        var sim = this._cloneLite(gs);
        if (!this._applyMoveLite(sim, move)) return base - 50;

        // Instant win?
        var t = gs.board[move.row] && gs.board[move.row][move.col];
        if (t && t.revealed && t.type === FLAG) return base + 5000;

        var oppReply = this._estimateWorstOpponentReply(sim, move, plan);
        var adjusted = base - oppReply.threat * 0.85 + oppReply.opportunity * 0.4;

        // If our move is a capture with positive EV, boost under blitz
        if (t && t.owner === 'player' && !t.revealed) {
            adjusted += urgency * 8;
        }

        // Prefer positions that raise our flag safety
        if (plan.flag) {
            var dangerAfter = this._flagDangerLite(sim, plan.flag.id);
            adjusted += (plan.flagDanger - dangerAfter) * 0.35;
        }

        return adjusted;
    },

    _cloneLite(gs) {
        // Minimal structural clone for 1-ply static estimates (not full rules engine)
        var board = [];
        for (var r = 0; r < H; r++) {
            board[r] = [];
            for (var c = 0; c < W; c++) {
                var cell = gs.board[r] && gs.board[r][c];
                board[r][c] = cell ? {
                    id: cell.id,
                    type: cell.type,
                    pieceType: cell.pieceType,
                    owner: cell.owner,
                    row: cell.row,
                    col: cell.col,
                    revealed: cell.revealed,
                    immobilized: cell.immobilized,
                    removed: cell.removed
                } : null;
            }
        }
        var mapPiece = function (p) {
            return {
                id: p.id, type: p.type, pieceType: p.pieceType, owner: p.owner,
                row: p.row, col: p.col, revealed: p.revealed,
                immobilized: p.immobilized, removed: p.removed
            };
        };
        return {
            board: board,
            aiPieces: (gs.aiPieces || []).map(mapPiece),
            playerPieces: (gs.playerPieces || []).map(mapPiece),
            movesWithoutCapture: gs.movesWithoutCapture || 0
        };
    },

    _applyMoveLite(sim, move) {
        var piece = null;
        for (var i = 0; i < sim.aiPieces.length; i++) {
            if (sim.aiPieces[i].id === move.piece.id) {
                piece = sim.aiPieces[i];
                break;
            }
        }
        if (!piece || piece.removed || piece.immobilized) return false;
        var tr = move.row;
        var tc = move.col;
        var target = sim.board[tr][tc];

        // Clear origin
        if (sim.board[piece.row] && sim.board[piece.row][piece.col]
            && sim.board[piece.row][piece.col].id === piece.id) {
            sim.board[piece.row][piece.col] = null;
        }

        if (target && target.owner === 'player') {
            // Simplified: if EV-ish win or flag — remove target; if trap — remove us
            if (target.revealed && target.type === TRAP) {
                piece.removed = true;
                piece.row = -1;
                return true;
            }
            if (target.revealed && target.type === 'piece' && piece.pieceType
                && battle(piece.pieceType, target.pieceType) === 'lose') {
                piece.removed = true;
                piece.row = -1;
                return true;
            }
            // Assume we take (or coin-flip not modeled deeply)
            target.removed = true;
            target.row = -1;
            for (var j = 0; j < sim.playerPieces.length; j++) {
                if (sim.playerPieces[j].id === target.id) {
                    sim.playerPieces[j].removed = true;
                    sim.playerPieces[j].row = -1;
                }
            }
            sim.board[tr][tc] = piece;
            piece.row = tr;
            piece.col = tc;
            if (!piece.revealed && piece.type === 'piece') piece.revealed = true;
            return true;
        }

        sim.board[tr][tc] = piece;
        piece.row = tr;
        piece.col = tc;
        return true;
    },

    _estimateWorstOpponentReply(sim, ourMove, plan) {
        var threat = 0;
        var opportunity = 0;
        var flag = null;
        for (var i = 0; i < sim.aiPieces.length; i++) {
            if (sim.aiPieces[i].type === FLAG && !sim.aiPieces[i].removed) {
                flag = sim.aiPieces[i];
                break;
            }
        }
        var enemies = activeOf(sim.playerPieces);
        var ours = activeOf(sim.aiPieces);

        for (var ei = 0; ei < enemies.length; ei++) {
            var e = enemies[ei];
            if (e.immobilized || e.type === FLAG) continue;
            // Can they step on our flag?
            if (flag && chebyshev(e.row, e.col, flag.row, flag.col) === 1) {
                threat += 220;
            }
            // Can they capture a hanging revealed piece of ours?
            for (var oi = 0; oi < ours.length; oi++) {
                var o = ours[oi];
                if (o.type === FLAG) continue;
                if (chebyshev(e.row, e.col, o.row, o.col) !== 1) continue;
                if (o.revealed && o.pieceType && e.revealed && e.pieceType) {
                    if (battle(e.pieceType, o.pieceType) === 'win') threat += 90;
                    else if (battle(o.pieceType, e.pieceType) === 'win') opportunity += 25;
                } else if (!e.revealed && o.revealed && o.pieceType) {
                    var bel = this._mem.beliefs.get(e.id);
                    if (bel) {
                        var beat = LOSES_TO[o.pieceType];
                        threat += (bel.probs[beat] || 0) * 70;
                    } else {
                        threat += 20;
                    }
                }
            }
        }

        // Opportunity: our move approached a high flag-prob cell
        if (this._mem.zoneHeat) {
            opportunity += (this._mem.zoneHeat[ourMove.row][ourMove.col] || 0) * 15;
        }

        return { threat: threat, opportunity: opportunity };
    },

    _flagDangerLite(sim, flagId) {
        var flag = null;
        for (var i = 0; i < sim.aiPieces.length; i++) {
            if (sim.aiPieces[i].id === flagId && !sim.aiPieces[i].removed) {
                flag = sim.aiPieces[i];
                break;
            }
        }
        if (!flag) return 0;
        var dng = 0;
        var enemies = activeOf(sim.playerPieces);
        for (var j = 0; j < enemies.length; j++) {
            var e = enemies[j];
            if (e.type === FLAG) continue;
            var d = chebyshev(e.row, e.col, flag.row, flag.col);
            if (d <= 3) dng += (4 - d) * 40;
            if (d === 1) dng += 200;
        }
        return dng;
    },

    // =====================================================================
    //  Commit / emergency
    // =====================================================================

    _commit(move, gs) {
        if (!move || !move.piece) return null;
        this._mem.lastMovedId = move.piece.id;
        this._mem.ourHistory.push({
            id: move.piece.id,
            from: { r: move.piece.row, c: move.piece.col },
            to: { r: move.row, c: move.col },
            turn: this._mem.turn
        });
        if (this._mem.ourHistory.length > 40) this._mem.ourHistory.shift();

        if (typeof aiEngine !== 'undefined' && aiEngine && typeof aiEngine.recordAIMove === 'function') {
            aiEngine.recordAIMove(move);
        }
        return { piece: move.piece, row: move.row, col: move.col };
    },

    _emergencyMove(gs, mine) {
        var list = mine || myPieces(gs);
        var best = null;
        var bestS = -1e12;
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (!p || p.immobilized || p.type === FLAG) continue;
            var moves = legalMoves(p, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                var t = gs.board[m.row] && gs.board[m.row][m.col];
                var s = (m.row - p.row) * 30;
                if (t && t.owner === 'player') {
                    if (t.revealed && t.type === FLAG) s += 10000;
                    else if (t.revealed && t.type === TRAP) s -= 500;
                    else s += 40;
                }
                if (s > bestS) {
                    bestS = s;
                    best = { piece: p, row: m.row, col: m.col };
                }
            }
        }
        if (best) return this._commit(best, gs);
        return null;
    }
};

// Register
if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(lenivchikBot);
} else if (typeof window !== 'undefined' && window.RPSBotAPI && typeof window.RPSBotAPI.defineBot === 'function') {
    window.RPSBotAPI.defineBot(lenivchikBot);
} else {
    throw new Error('[lenivchik] RPSBotAPI is required');
}
