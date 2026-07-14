/**
 * Grok Build — easy bot that actually tries to win.
 *
 * Core idea: push forward, probe hidden enemies, capture when possible.
 * Hard-bans pieces that oscillate between 2–3 cells (3+ turns sidelined).
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[lenivchik] bot-api.js must be loaded BEFORE this bot');
}

var RPS = (typeof window !== 'undefined' && window.RPSBotAPI)
    ? window.RPSBotAPI
    : (typeof RPSBotAPI !== 'undefined' ? RPSBotAPI : null);

var RULES = RPS ? RPS.RULES : null;
var resolveBattle = RPS ? RPS.resolveBattle : null;

var BOT_FLAG = (RULES && RULES.SPECIAL_TYPES && RULES.SPECIAL_TYPES.FLAG) || 'flag';
var BOT_TRAP = (RULES && RULES.SPECIAL_TYPES && RULES.SPECIAL_TYPES.TRAP) || 'trap';

var LOOP_BAN_TURNS = 5;

function chebyshev(r1, c1, r2, c2) {
    return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
}

function safeResolve(type1, type2) {
    if (resolveBattle && typeof resolveBattle === 'function') {
        return resolveBattle(type1, type2);
    }
    if (!type1 || !type2) return 'draw';
    if (type1 === type2) return 'draw';
    var wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    return (wins[type1] === type2) ? 'win' : 'lose';
}

function getActivePieces(gs, owner) {
    var pieces = (owner === 'computer') ? (gs.aiPieces || []) : (gs.playerPieces || []);
    var out = [];
    for (var i = 0; i < pieces.length; i++) {
        var p = pieces[i];
        if (p && !p.removed && p.row >= 0) out.push(p);
    }
    return out;
}

function getMyFlag(gs) {
    var my = getActivePieces(gs, 'computer');
    for (var i = 0; i < my.length; i++) {
        if (my[i].type === BOT_FLAG) return my[i];
    }
    return null;
}

var lenivchikBot = {
    id: 'lenivchik',
    name: 'Ленивчик',
    emoji: '🛠️',
    avatar: 'js/bots/lenivchik/avatar-min.png',

    shortDescription: 'Давит вперёд, атакует и не зацикливается',
    longDescription: 'Продвигается в сторону противника, провоцирует бои со скрытыми фигурами и жёстко блокирует шаттл между 2–3 клетками.',

    algorithmLabel: 'Продвижение + провокация боёв + анти-цикл',
    tier: 'easy',
    stars: 1,
    difficultyLabel: 'Лёгкий',
    tags: ['aggressive', 'forward', 'anti-loop', 'probing'],

    _turn: 0,
    _currentCampaign: null,
    _pieceBanUntil: new Map(),
    _lastMovedPieceId: null,

    _register() {
        var api = (typeof RPSBotAPI !== 'undefined') ? RPSBotAPI : window.RPSBotAPI;
        if (api && typeof api.defineBot === 'function') {
            api.defineBot(this);
        } else {
            throw new Error('[lenivchik] RPSBotAPI.defineBot is required');
        }
    },

    chooseFlagAndTrap() {
        this._turn = 0;
        this._currentCampaign = null;
        this._pieceBanUntil = new Map();
        this._lastMovedPieceId = null;

        var templates = [
            { flag: 0, trap: 9 },
            { flag: 7, trap: 14 },
            { flag: 1, trap: 8 },
            { flag: 6, trap: 15 },
            { flag: 2, trap: 9 },
            { flag: 5, trap: 14 },
            { flag: 0, trap: 8 },
            { flag: 7, trap: 13 }
        ];
        var pick = templates[Math.floor(Math.random() * templates.length)];
        return { flagIndex: pick.flag, trapIndex: pick.trap };
    },

    move(gameState) {
        var self = this;
        try {
            self._turn = (self._turn || 0) + 1;
            self._updateLoopBans();

            if (typeof aiEngine !== 'undefined' && aiEngine) {
                aiEngine.positionCache.clear();
                if (typeof aiEngine.analyzePlayerPattern === 'function') aiEngine.analyzePlayerPattern(gameState);
                if (typeof aiEngine.trackEnemyStillness === 'function') aiEngine.trackEnemyStillness(gameState);
                if (typeof aiEngine.updateStrategicTargets === 'function') aiEngine.updateStrategicTargets(gameState);
            }

            var allAvailable = (typeof aiEngine !== 'undefined' && aiEngine.getActivePieces)
                ? aiEngine.getActivePieces(gameState)
                : getActivePieces(gameState, 'computer');

            if (allAvailable.length === 0) return null;

            var available = self._getMovePool(allAvailable);
            var urgency = self._getPassivityUrgency(gameState);

            // === P0: Mandatory tactical (respects loop ban) ===
            if (typeof aiTacticalCore !== 'undefined' && aiTacticalCore && typeof aiTacticalCore.getMandatoryMove === 'function') {
                var mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                    deducer: self._deduceEnemyFlag.bind(self),
                    flagHuntHorizon: 3,
                    antiCluster: true
                });
                if (mandatory && mandatory.piece && !self._isPieceBanned(mandatory.piece.id)) {
                    var mandFiltered = self._strictFilterMoves([mandatory], gameState);
                    if (mandFiltered.length > 0) {
                        return self._commitMove(mandFiltered[0]);
                    }
                }
            }

            // === 1. Flag capture ===
            if (typeof aiEngine !== 'undefined' && aiEngine.findFlagCaptureMoves) {
                var flagCaps = aiEngine.findFlagCaptureMoves(gameState, available);
                if (flagCaps.length > 0) {
                    var cap = self._pickBestFiltered(flagCaps, gameState);
                    if (cap) return self._commitMove(cap);
                }
            }

            // === 2. Guaranteed kills ===
            if (typeof aiEngine !== 'undefined' && aiEngine.findGuaranteedKills) {
                var kills = aiEngine.findGuaranteedKills(gameState, available);
                if (kills.length > 0) {
                    var killMove = self._pickBestFiltered(kills, gameState);
                    if (killMove) return self._commitMove(killMove);
                }
            }

            // === 3. Safe captures on revealed enemies ===
            var safeEat = self._findRevealedEat(gameState, available, false);
            if (safeEat) return self._commitMove(safeEat);

            // === 4. Probe attack — adjacent hidden/revealed enemies (KEY FIX) ===
            var probe = self._findProbeAttack(gameState, available, urgency);
            if (probe) return self._commitMove(probe);

            // === 5. Urgent flag defense ===
            var urgentDefense = self._findUrgentFlagDefense(gameState, available);
            if (urgentDefense) return self._commitMove(urgentDefense);

            // === 6. Always push forward (not only when stalled) ===
            var pushMove = self._findForwardPush(gameState, available, urgency);
            if (pushMove) return self._commitMove(pushMove);

            // === 7. Flag hunt ===
            var huntMove = self._findFlagHuntMove(gameState, available);
            if (huntMove) return self._commitMove(huntMove);

            // === 8. Fist attack ===
            var fistMove = self._tryFistAttack(gameState, available);
            if (fistMove) return self._commitMove(fistMove);

            // === 9. Campaign (secondary — never blocks aggression) ===
            self._updateCampaign(gameState);
            var campaignMove = self._pursueCampaign(gameState, available);
            if (campaignMove) return self._commitMove(campaignMove);

            // === 10. Panic: любая атака / продвижение с любой фигуры ===
            var panic = self._findAnyAggressiveMove(gameState, allAvailable, urgency);
            if (panic) return self._commitMove(panic);

            // === 11. Heuristic fallback — never unfiltered shuttle ===
            return self._heuristicFallback(gameState, allAvailable);

        } catch (err) {
            console.error('[lenivchik] move() crashed:', err);
            return self._heuristicFallback(gameState, getActivePieces(gameState, 'computer'));
        }
    },

    // =========================================================================
    //  LOOP BAN & MOVE POOL
    // =========================================================================

    _updateLoopBans() {
        if (typeof aiEngine === 'undefined' || !aiEngine.isPieceInPositionLoop) return;
        var all = aiEngine.moveHistory || [];
        var seen = {};
        for (var i = 0; i < all.length; i++) {
            seen[all[i].pieceId] = true;
        }
        var self = this;
        Object.keys(seen).forEach(function (pid) {
            if (aiEngine.isPieceInPositionLoop(pid)) {
                self._pieceBanUntil.set(pid, self._turn + LOOP_BAN_TURNS);
            }
        });
    },

    _isPieceBanned(pieceId) {
        var until = this._pieceBanUntil.get(pieceId);
        return until !== undefined && this._turn < until;
    },

    _getMovePool(pieces) {
        var pool = pieces.filter(function (p) {
            return p && !p.immobilized && !lenivchikBot._isPieceBanned(p.id);
        });

        if (typeof aiEngine !== 'undefined' && aiEngine.filterOutLoopingPieces) {
            pool = aiEngine.filterOutLoopingPieces(pool);
        }

        if (pool.length === 0) {
            // Absolute last resort: allow non-banned first, then anyone
            var nonBanned = pieces.filter(function (p) {
                return p && !p.immobilized && !lenivchikBot._isPieceBanned(p.id);
            });
            return nonBanned.length > 0 ? nonBanned : pieces;
        }
        return pool;
    },

    _getPassivityUrgency(gs) {
        var base = 0;
        var drawLimit = (typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.GAME && GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT) || 20;
        if (gs.movesWithoutCapture >= Math.floor(drawLimit * 0.5)) base += 2;
        if (gs.movesWithoutCapture >= Math.floor(drawLimit * 0.75)) base += 2;
        if (typeof aiEngine !== 'undefined' && aiEngine.isAttackStalled && aiEngine.isAttackStalled(gs)) {
            base += 2;
        }
        return base;
    },

    _commitMove(move) {
        if (move && move.piece) {
            this._lastMovedPieceId = move.piece.id;
        }
        if (typeof aiEngine !== 'undefined' && aiEngine.recordAIMove) {
            aiEngine.recordAIMove(move);
        }
        return move;
    },

    _getMovesForPiece(piece, gs) {
        if (typeof aiEngine !== 'undefined' && aiEngine.getMovesForPiece) {
            return aiEngine.getMovesForPiece(piece, gs);
        }
        return [];
    },

    _isBadMove(piece, m, gs) {
        if (!piece || !m) return true;
        var target = gs.board[m.row] && gs.board[m.row][m.col];

        // Character "the sloth": the flag is far too lazy to wander. It never
        // attacks (it loses every battle) and only stirs to slip one step onto an
        // empty cell when an enemy is standing right next to it.
        if (piece.type === 'flag') {
            if (target) {
                return true;
            }
            var enemies = gs.playerPieces || [];
            var adjacentThreat = false;
            for (var e = 0; e < enemies.length; e++) {
                var foe = enemies[e];
                if (!foe || foe.removed || foe.row < 0 || foe.immobilized || foe.type === 'flag') {
                    continue;
                }
                if (Math.max(Math.abs(foe.row - piece.row), Math.abs(foe.col - piece.col)) === 1) {
                    adjacentThreat = true;
                    break;
                }
            }
            return !adjacentThreat;
        }

        var isCapture = !!(target && target.owner === 'player');

        // Жёсткий запрет горизонтального шаттла без взятия (E4↔F4 и т.п.)
        if (!isCapture && m.row === piece.row) return true;

        // Запрет отступа в свой тыл без взятия
        if (!isCapture && m.row < piece.row && piece.row <= 2) return true;

        if (typeof aiEngine !== 'undefined' && aiEngine) {
            if (aiEngine.isShuttlePosition(piece.id, m.row, m.col)) return true;
            if (aiEngine.isPieceInPositionLoop(piece.id, 2)) {
                var loopCells = aiEngine.getPieceLoopCells(piece.id);
                if (loopCells.has(m.row + ',' + m.col)) return true;
            }
        }
        return false;
    },

    _strictFilterMoves(moves, gs) {
        if (!Array.isArray(moves)) return [];
        var out = [];
        for (var i = 0; i < moves.length; i++) {
            var m = moves[i];
            if (!m || !m.piece) continue;
            if (this._isPieceBanned(m.piece.id)) continue;
            if (this._isBadMove(m.piece, m, gs)) continue;
            out.push(m);
        }
        return out;
    },

    _filterPassiveMoves(moves, gs) {
        if (gs) return this._strictFilterMoves(moves, gs);
        return this._strictFilterMoves(moves, { board: [] });
    },

    _pickBestFiltered(moves, gs) {
        var pool = this._strictFilterMoves(moves, gs);
        if (pool.length === 0) return null;

        // Prefer a different piece than last turn
        if (this._lastMovedPieceId) {
            var alt = pool.filter(function (m) {
                return m.piece && m.piece.id !== lenivchikBot._lastMovedPieceId;
            });
            if (alt.length > 0) pool = alt;
        }

        if (typeof aiEngine !== 'undefined' && aiEngine.pickBestScored) {
            return aiEngine.pickBestScored(pool, gs);
        }
        return pool[0];
    },

    // =========================================================================
    //  ATTACKS
    // =========================================================================

    _findRevealedEat(gs, available, allowRisky) {
        var en = getActivePieces(gs, 'player');
        var candidates = [];

        for (var i = 0; i < en.length; i++) {
            var enemy = en[i];
            if (!enemy.revealed || enemy.type === BOT_FLAG || enemy.type === BOT_TRAP || enemy.removed) continue;

            for (var j = 0; j < available.length; j++) {
                var piece = available[j];
                if (piece.type === BOT_FLAG || piece.immobilized) continue;
                if (chebyshev(piece.row, piece.col, enemy.row, enemy.col) !== 1) continue;

                if (safeResolve(piece.pieceType || piece.type, enemy.pieceType) !== 'win') continue;

                if (allowRisky || this._hasCompensationSupport(gs, piece, enemy.row, enemy.col, enemy)) {
                    candidates.push({
                        piece: piece,
                        row: enemy.row,
                        col: enemy.col,
                        priority: 80 + (enemy.row >= 3 ? 20 : 0)
                    });
                }
            }
        }

        if (candidates.length === 0) return null;
        return this._pickBestFiltered(candidates, gs);
    },

    /**
     * Attack adjacent enemies including HIDDEN ones — the main fix for passive draws.
     */
    _findProbeAttack(gs, available, urgency) {
        var candidates = [];

        for (var i = 0; i < available.length; i++) {
            var piece = available[i];
            if (piece.type !== 'piece' || piece.immobilized) continue;

            var moves = this._getMovesForPiece(piece, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                var target = gs.board[m.row] && gs.board[m.row][m.col];
                if (!target || target.owner !== 'player') continue;
                if (target.type === BOT_FLAG) continue;
                if (target.revealed && target.type === BOT_TRAP) continue;
                if (target.revealed && target.type === 'piece'
                    && safeResolve(piece.pieceType, target.pieceType) === 'lose') continue;

                var score = 40 + urgency * 25;
                if (target.revealed && target.type === 'piece'
                    && safeResolve(piece.pieceType, target.pieceType) === 'win') {
                    score += 120;
                } else if (!target.revealed) {
                    score += 35 + urgency * 15;
                }
                if (m.row > piece.row) score += 20;
                if (this._hasCompensationSupport(gs, piece, m.row, m.col, target)) score += 30;

                if (typeof aiEngine !== 'undefined' && aiEngine.evaluateMoveV2) {
                    score += aiEngine.evaluateMoveV2({ piece: piece, row: m.row, col: m.col }, gs) * 0.3;
                }

                candidates.push({ piece: piece, row: m.row, col: m.col, priority: score });
            }
        }

        if (candidates.length === 0) return null;
        candidates.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
        return this._pickBestFiltered(candidates, gs);
    },

    _hasCompensationSupport(gs, attacker, toR, toC) {
        var myPieces = getActivePieces(gs, 'computer');
        for (var i = 0; i < myPieces.length; i++) {
            var p = myPieces[i];
            if (p.id === attacker.id || p.immobilized || p.row < 0) continue;
            if (chebyshev(p.row, p.col, toR, toC) <= 1) return true;
        }
        return false;
    },

    _getWhatBeats(type) {
        if (type === 'rock') return 'paper';
        if (type === 'paper') return 'scissors';
        if (type === 'scissors') return 'rock';
        return null;
    },

    // =========================================================================
    //  DEFENCE & ADVANCE
    // =========================================================================

    _deduceEnemyFlag(gs) {
        var en = getActivePieces(gs, 'player');
        var best = null;
        var bestScore = -1;

        for (var i = 0; i < en.length; i++) {
            var p = en[i];
            if (p.revealed || p.type === BOT_FLAG || p.removed) continue;

            var score = 10;
            if (typeof aiEngine !== 'undefined' && aiEngine.enemyStillness) {
                var info = aiEngine.enemyStillness.get(p.id);
                if (info) {
                    if (!info.hasMovedOnce) score += 25;
                    score += Math.min(info.stillnessScore || 0, 8) * 4;
                }
            }
            if (p.row >= 4) score += 15;
            if (p.row === 5) score += 10;

            if (score > bestScore) {
                bestScore = score;
                best = p;
            }
        }
        return best;
    },

    _findUrgentFlagDefense(gs, available) {
        var myFlag = getMyFlag(gs);
        if (!myFlag) return null;

        var threats = [];
        var en = getActivePieces(gs, 'player');
        for (var i = 0; i < en.length; i++) {
            var e = en[i];
            if (e.removed || e.row < 0 || e.type === BOT_FLAG) continue;
            if (chebyshev(e.row, e.col, myFlag.row, myFlag.col) <= 2) {
                threats.push(e);
            }
        }
        if (threats.length === 0) return null;

        var candidates = [];
        for (var j = 0; j < available.length; j++) {
            var piece = available[j];
            if (piece.type === BOT_FLAG || piece.immobilized) continue;

            var moves = this._getMovesForPiece(piece, gs);
            for (var k = 0; k < moves.length; k++) {
                var m = moves[k];
                var target = gs.board[m.row] && gs.board[m.row][m.col];
                if (target && target.owner === 'player' && target.type !== BOT_FLAG) {
                    if (this._hasCompensationSupport(gs, piece, m.row, m.col)) {
                        candidates.push({ piece: piece, row: m.row, col: m.col, priority: 100 });
                    }
                }
            }
        }
        return this._pickBestFiltered(candidates, gs);
    },

    _findForwardPush(gs, available, urgency) {
        var candidates = [];
        var playerHalf = 3;

        for (var i = 0; i < available.length; i++) {
            var piece = available[i];
            if (piece.type === BOT_FLAG || piece.immobilized) continue;

            var moves = this._getMovesForPiece(piece, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                if (this._isBadMove(piece, m, gs)) continue;

                var target = gs.board[m.row] && gs.board[m.row][m.col];
                if (target && target.owner === 'player') continue;

                var score = 0;
                var forward = m.row - piece.row;
                if (forward <= 0) continue;

                score += 70 + urgency * 20 + forward * 25;
                if (m.row >= playerHalf) score += 40;

                var en = getActivePieces(gs, 'player');
                for (var k = 0; k < en.length; k++) {
                    if (chebyshev(m.row, m.col, en[k].row, en[k].col) <= 2) {
                        score += 25;
                        break;
                    }
                }

                candidates.push({ piece: piece, row: m.row, col: m.col, priority: score });
            }
        }

        if (candidates.length === 0) return null;
        return this._pickBestFiltered(candidates, gs);
    },

    /**
     * Когда ничего не сработало — ищем ЛЮБОЙ допустимый агрессивный ход со ЛЮБОЙ фигуры.
     */
    _findAnyAggressiveMove(gs, allPieces, urgency) {
        var candidates = [];

        for (var i = 0; i < allPieces.length; i++) {
            var piece = allPieces[i];
            if (!piece || piece.immobilized || piece.type === BOT_FLAG) continue;
            if (this._isPieceBanned(piece.id)) continue;

            var moves = this._getMovesForPiece(piece, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                if (this._isBadMove(piece, m, gs)) continue;

                var target = gs.board[m.row] && gs.board[m.row][m.col];
                var score = 0;

                if (target && target.owner === 'player' && target.type !== BOT_FLAG) {
                    score = 150 + urgency * 30;
                    if (!target.revealed) score += 40;
                } else if (m.row > piece.row) {
                    score = 60 + (m.row - piece.row) * 30 + urgency * 15;
                } else {
                    continue;
                }

                candidates.push({ piece: piece, row: m.row, col: m.col, priority: score });
            }
        }

        if (candidates.length === 0) return null;
        candidates.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
        return this._pickBestFiltered(candidates, gs);
    },

    _findFlagHuntMove(gs, available) {
        var suspect = this._deduceEnemyFlag(gs);
        if (!suspect) return null;

        var candidates = [];
        for (var i = 0; i < available.length; i++) {
            var piece = available[i];
            if (piece.type === BOT_FLAG || piece.immobilized) continue;

            var moves = this._getMovesForPiece(piece, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                if (this._isBadMove(piece, m, gs)) continue;
                var distNow = chebyshev(piece.row, piece.col, suspect.row, suspect.col);
                var distNew = chebyshev(m.row, m.col, suspect.row, suspect.col);
                if (distNew < distNow) {
                    var score = (distNow - distNew) * 45;
                    if (m.row > piece.row) score += 30;
                    candidates.push({ piece: piece, row: m.row, col: m.col, priority: score });
                }
            }
        }

        if (candidates.length === 0) return null;
        return this._pickBestFiltered(candidates, gs);
    },

    _tryFistAttack(gs, available) {
        var myPieces = getActivePieces(gs, 'computer');
        var groups = this._findSmallFists(gs, myPieces);
        var candidates = [];

        for (var i = 0; i < groups.length; i++) {
            var group = groups[i];
            for (var j = 0; j < group.length; j++) {
                var piece = group[j];
                if (!available.find(function (p) { return p.id === piece.id; })) continue;

                var moves = this._getMovesForPiece(piece, gs);
                for (var k = 0; k < moves.length; k++) {
                    var m = moves[k];
                    var target = gs.board[m.row] && gs.board[m.row][m.col];
                    if (target && target.owner === 'player' && target.type !== BOT_FLAG) {
                        if (this._hasCompensationSupport(gs, piece, m.row, m.col)) {
                            candidates.push({ piece: piece, row: m.row, col: m.col, priority: 90 });
                        }
                    }
                }
            }
        }

        if (candidates.length === 0) return null;
        return this._pickBestFiltered(candidates, gs);
    },

    _findSmallFists(gs, myPieces) {
        var fists = [];
        for (var i = 0; i < myPieces.length; i++) {
            var center = myPieces[i];
            if (center.type !== 'piece') continue;

            var cluster = [center];
            var types = {};
            types[center.pieceType] = true;

            for (var j = 0; j < myPieces.length; j++) {
                var other = myPieces[j];
                if (other.id === center.id || other.type !== 'piece') continue;
                if (chebyshev(center.row, center.col, other.row, other.col) <= 2) {
                    cluster.push(other);
                    if (other.pieceType) types[other.pieceType] = true;
                }
            }
            if (cluster.length >= 3 && Object.keys(types).length >= 2) {
                fists.push(cluster);
            }
        }
        return fists;
    },

    // =========================================================================
    //  CAMPAIGN (low priority)
    // =========================================================================

    _updateCampaign(gs) {
        var now = this._turn;
        if (!this._currentCampaign || (now - this._currentCampaign.createdTurn > 5)) {
            this._currentCampaign = { type: 'advance', createdTurn: now };
        }
    },

    _pursueCampaign(gs, available) {
        if (!this._currentCampaign) return null;
        return this._findForwardPush(gs, available, 0);
    },

    // =========================================================================
    //  FALLBACK
    // =========================================================================

    _heuristicFallback(gs, available) {
        var self = this;

        if (typeof aiEngine !== 'undefined' && aiEngine.getAllFilteredMoves) {
            var allMoves = aiEngine.getAllFilteredMoves(gs, available);
            var pool = self._strictFilterMoves(allMoves, gs);

            var forward = pool.filter(function (m) {
                return m.piece && m.row > m.piece.row;
            });
            if (forward.length > 0) pool = forward;

            if (pool.length > 0) {
                var best = self._pickBestFiltered(pool, gs);
                if (best) return self._commitMove(best);
            }
        }

        var bestFallback = null;
        var bestScore = -99999;

        for (var i = 0; i < available.length; i++) {
            var p = available[i];
            if (p.immobilized || p.type === BOT_FLAG || self._isPieceBanned(p.id)) continue;
            var moves = self._getMovesForPiece(p, gs);
            for (var j = 0; j < moves.length; j++) {
                var m = moves[j];
                if (self._isBadMove(p, m, gs)) continue;

                var target = gs.board[m.row] && gs.board[m.row][m.col];
                if (target && target.owner === 'player') continue;

                var score = (m.row - p.row) * 50;
                if (p.id === self._lastMovedPieceId) score -= 40;
                if (score > bestScore) {
                    bestScore = score;
                    bestFallback = { piece: p, row: m.row, col: m.col };
                }
            }
        }

        if (bestFallback) return self._commitMove(bestFallback);
        return null;
    }
};

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(lenivchikBot);
} else if (typeof window !== 'undefined' && window.RPSBotAPI && typeof window.RPSBotAPI.defineBot === 'function') {
    window.RPSBotAPI.defineBot(lenivchikBot);
} else {
    throw new Error('[lenivchik] RPSBotAPI is required');
}