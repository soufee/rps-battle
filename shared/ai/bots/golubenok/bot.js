/**
 * Golubenok — a fair imperfect-information strategy engine.
 *
 * The bot deliberately uses only the sanitized BotView and the public
 * RPSBotAPI contract. Hidden identities are represented as probabilities and
 * are never read from engine internals.
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[golubenok] bot-api.js must be loaded BEFORE this bot');
}

const golubenokBot = (() => {
    'use strict';

    let api = null;
    if (typeof RPSBotAPI !== 'undefined') {
        api = RPSBotAPI;
    } else if (typeof globalThis !== 'undefined') {
        api = globalThis.RPSBotAPI;
    }

    if (!api
        || !api.RULES
        || typeof api.getLegalMoves !== 'function'
        || typeof api.resolveBattle !== 'function') {
        throw new Error('[golubenok] Complete RPSBotAPI v1 contract is required');
    }

    const RULES = api.RULES;
    const WIDTH = RULES.BOARD.WIDTH;
    const HEIGHT = RULES.BOARD.HEIGHT;
    const DIRECTIONS = RULES.DIRECTIONS;
    const FLAG = RULES.SPECIAL_TYPES.FLAG;
    const TRAP = RULES.SPECIAL_TYPES.TRAP;
    const RPS_TYPES = RULES.PIECE_TYPES.slice();
    const WIN_AGAINST = RULES.WIN_CONDITIONS;
    const COUNTER = {
        rock: 'paper',
        paper: 'scissors',
        scissors: 'rock'
    };

    const WIN_SCORE = 100000000;
    const FLAG_DANGER_SCORE = 2200000;
    const FLAG_NEAR_SCORE = 160000;
    const MATERIAL_SCORE = 1500;
    const MAX_HISTORY = 36;
    const MAX_CACHE = 1800;
    const DEV_BUDGET_MS = 105;
    const NORMAL_BUDGET_MS = 240;

    const contexts = new Map();
    let setupCounter = 0;

    function clamp(value, low, high) {
        return Math.max(low, Math.min(high, value));
    }

    function chebyshev(aRow, aCol, bRow, bCol) {
        return Math.max(Math.abs(aRow - bRow), Math.abs(aCol - bCol));
    }

    function boardIndex(row, col) {
        return row * WIDTH + col;
    }

    function cellKey(row, col) {
        return `${row},${col}`;
    }

    function isInside(row, col) {
        return row >= 0
            && row < HEIGHT
            && col >= 0
            && col < WIDTH;
    }

    function isActive(piece) {
        return !!piece
            && !piece.removed
            && piece.row >= 0
            && piece.col >= 0;
    }

    function actualPieceType(piece) {
        if (!piece) {
            return null;
        }
        if (piece.type === 'piece') {
            return piece.pieceType;
        }
        return piece.type;
    }

    function hashText(text) {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function mix32(value) {
        let mixed = value >>> 0;
        mixed ^= mixed << 13;
        mixed ^= mixed >>> 17;
        mixed ^= mixed << 5;
        return mixed >>> 0;
    }

    function nextRandom(context) {
        context.seed = mix32(context.seed);
        return context.seed / 4294967296;
    }

    function makeContextSeed(key, gameState) {
        const ownIds = (gameState.aiPieces || [])
            .map((piece) => piece.id)
            .sort()
            .join('|');
        const randomPart = Math.floor(Math.random() * 0xffffffff);
        return mix32(hashText(`${key}:${ownIds}`) ^ randomPart);
    }

    function weightedPick(items, getWeight, randomValue) {
        let total = 0;
        for (const item of items) {
            total += Math.max(0, getWeight(item));
        }
        if (total <= 0) {
            return items.length > 0 ? items[0] : null;
        }

        let cursor = randomValue * total;
        for (const item of items) {
            cursor -= Math.max(0, getWeight(item));
            if (cursor <= 0) {
                return item;
            }
        }
        return items[items.length - 1] || null;
    }

    function getContextKey(gameState) {
        const own = (gameState.aiPieces || []).find(isActive);
        if (own && typeof own.id === 'string') {
            const separator = own.id.indexOf('_');
            if (separator > 0) {
                return own.id.slice(0, separator);
            }
            return own.id;
        }
        return `slot:${gameState.botId || 'golubenok'}`;
    }

    function snapshotPieces(pieces) {
        const snapshot = new Map();
        for (const piece of pieces || []) {
            if (!isActive(piece)) {
                continue;
            }
            snapshot.set(piece.id, {
                id: piece.id,
                row: piece.row,
                col: piece.col,
                type: piece.type,
                pieceType: piece.pieceType,
                revealed: !!piece.revealed,
                immobilized: !!piece.immobilized
            });
        }
        return snapshot;
    }

    function snapshotBoard(snapshot) {
        const board = new Map();
        for (const piece of snapshot.values()) {
            board.set(cellKey(piece.row, piece.col), piece);
        }
        return board;
    }

    function makeInitialWeights(piece) {
        let flagWeight = piece.row >= HEIGHT - 1 ? 1.7 : 1.05;
        if (piece.col === 0 || piece.col === WIDTH - 1) {
            flagWeight *= 1.2;
        }
        return {
            flag: flagWeight,
            trap: piece.row >= HEIGHT - 2 ? 1.15 : 0.9,
            rock: 4.7,
            paper: 4.7,
            scissors: 4.7
        };
    }

    function createBelief(piece) {
        return {
            id: piece.id,
            weights: makeInitialWeights(piece),
            probs: {
                flag: 1 / 16,
                trap: 1 / 16,
                rock: 14 / 48,
                paper: 14 / 48,
                scissors: 14 / 48
            },
            movedCount: 0,
            forwardMoves: 0,
            retreatMoves: 0,
            attacks: 0,
            stillTurns: 0,
            lastRow: piece.row,
            lastCol: piece.col,
            revealedType: null
        };
    }

    function createContext(key, gameState) {
        const context = {
            key,
            seed: makeContextSeed(key, gameState),
            turn: 0,
            beliefs: new Map(),
            previousEnemies: new Map(),
            previousOwn: new Map(),
            expectedOwn: null,
            moveHistory: [],
            ownMoveCounts: new Map(),
            visits: new Map(),
            searchCache: new Map(),
            doctrine: null,
            opponent: {
                aggression: 0.5,
                retreat: 0.2,
                attackRate: 0.2,
                flagPressure: 0.2,
                repetition: 0,
                left: 1,
                center: 1,
                right: 1
            },
            tieCounts: {
                rock: 1,
                paper: 1,
                scissors: 1
            },
            tieTransitions: new Map(),
            tieSeen: new Set(),
            tieOwnChoices: []
        };

        const doctrines = ['bastion', 'elastic', 'counterpunch', 'double_feint'];
        const doctrineIndex = Math.floor(nextRandom(context) * doctrines.length);
        context.doctrine = doctrines[doctrineIndex];

        for (const enemy of gameState.playerPieces || []) {
            if (isActive(enemy)) {
                context.beliefs.set(enemy.id, createBelief(enemy));
            }
        }
        context.previousEnemies = snapshotPieces(gameState.playerPieces);
        context.previousOwn = snapshotPieces(gameState.aiPieces);
        return context;
    }

    function looksLikeFreshGame(gameState, context) {
        if (!context || context.turn === 0) {
            return false;
        }

        const own = (gameState.aiPieces || []).filter(isActive);
        const enemies = (gameState.playerPieces || []).filter(isActive);
        if (own.length !== 16 || enemies.length !== 16) {
            return false;
        }

        const allOwnHome = own.every((piece) => piece.row <= 1);
        const enemiesNearHome = enemies.filter((piece) => piece.row >= 3).length;
        if (!allOwnHome || enemiesNearHome < 15) {
            return false;
        }

        if (!context.expectedOwn) {
            return true;
        }
        const expected = own.find((piece) => piece.id === context.expectedOwn.id);
        const expectedPresent = expected
            && expected.row === context.expectedOwn.row
            && expected.col === context.expectedOwn.col;
        if (expectedPresent && context.turn <= 5) {
            return false;
        }
        return true;
    }

    function getContext(gameState) {
        const key = getContextKey(gameState);
        let context = contexts.get(key);
        if (!context || looksLikeFreshGame(gameState, context)) {
            context = createContext(key, gameState);
            contexts.set(key, context);
        }
        return context;
    }

    function ensureBelief(context, piece) {
        let belief = context.beliefs.get(piece.id);
        if (!belief) {
            belief = createBelief(piece);
            context.beliefs.set(piece.id, belief);
        }
        return belief;
    }

    function multiplyWeight(belief, type, factor) {
        if (!belief.weights[type]) {
            belief.weights[type] = 0.0001;
        }
        belief.weights[type] = clamp(belief.weights[type] * factor, 0.00001, 1000000);
    }

    function collapseBelief(belief, type) {
        belief.revealedType = type;
        for (const candidate of [FLAG, TRAP, ...RPS_TYPES]) {
            belief.probs[candidate] = candidate === type ? 1 : 0;
            belief.weights[candidate] = candidate === type ? 1 : 0.00001;
        }
    }

    function probabilityFor(context, pieceId) {
        const belief = context.beliefs.get(pieceId);
        if (belief) {
            return belief.probs;
        }
        return {
            flag: 1 / 16,
            trap: 1 / 16,
            rock: 14 / 48,
            paper: 14 / 48,
            scissors: 14 / 48
        };
    }

    function normalizeBeliefs(gameState, context) {
        const activeEnemies = (gameState.playerPieces || []).filter(isActive);
        const hidden = [];
        let knownFlag = false;
        let knownTrap = false;

        for (const enemy of activeEnemies) {
            const belief = ensureBelief(context, enemy);
            if (enemy.revealed) {
                const type = actualPieceType(enemy);
                collapseBelief(belief, type);
                knownFlag = knownFlag || type === FLAG;
                knownTrap = knownTrap || type === TRAP;
            } else {
                hidden.push({ piece: enemy, belief });
            }
        }

        let flagTotal = 0;
        for (const entry of hidden) {
            flagTotal += Math.max(0.00001, entry.belief.weights.flag);
        }
        for (const entry of hidden) {
            const raw = Math.max(0.00001, entry.belief.weights.flag);
            entry.belief.probs.flag = knownFlag || flagTotal <= 0
                ? 0
                : raw / flagTotal;
        }

        let trapTotal = 0;
        for (const entry of hidden) {
            const exclusion = Math.pow(1 - entry.belief.probs.flag, 2);
            const raw = Math.max(0.00001, entry.belief.weights.trap) * exclusion;
            entry.trapRaw = raw;
            trapTotal += raw;
        }
        for (const entry of hidden) {
            entry.belief.probs.trap = knownTrap || trapTotal <= 0
                ? 0
                : entry.trapRaw / trapTotal;

            const special = entry.belief.probs.flag
                + entry.belief.probs.trap;
            const remainder = Math.max(0, 1 - special);
            let rpsTotal = 0;
            for (const type of RPS_TYPES) {
                rpsTotal += Math.max(0.00001, entry.belief.weights[type]);
            }
            for (const type of RPS_TYPES) {
                const raw = Math.max(0.00001, entry.belief.weights[type]);
                entry.belief.probs[type] = rpsTotal > 0
                    ? remainder * raw / rpsTotal
                    : remainder / RPS_TYPES.length;
            }
        }
    }

    function revealedOwnNear(snapshot, row, col) {
        let nearest = null;
        let nearestDistance = Infinity;
        for (const piece of snapshot.values()) {
            if (!piece.revealed || piece.type !== 'piece' || !piece.pieceType) {
                continue;
            }
            const distance = chebyshev(row, col, piece.row, piece.col);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = piece;
            }
        }
        return {
            piece: nearest,
            distance: nearestDistance
        };
    }

    function updateReactionEvidence(belief, ownType, oldDistance, newDistance, attacked) {
        if (!ownType || !WIN_AGAINST[ownType] || !COUNTER[ownType]) {
            return;
        }

        const vulnerable = WIN_AGAINST[ownType];
        const threatening = COUNTER[ownType];
        if (attacked) {
            multiplyWeight(belief, threatening, 1.65);
            multiplyWeight(belief, vulnerable, 0.72);
            multiplyWeight(belief, FLAG, 0.12);
            belief.attacks += 1;
            return;
        }

        if (oldDistance <= 1 && newDistance > oldDistance) {
            multiplyWeight(belief, vulnerable, 2.05);
            multiplyWeight(belief, ownType, 1.16);
            multiplyWeight(belief, threatening, 0.68);
            multiplyWeight(belief, FLAG, 1.18);
        } else if (newDistance < oldDistance && newDistance <= 1) {
            multiplyWeight(belief, threatening, 1.48);
            multiplyWeight(belief, vulnerable, 0.82);
            multiplyWeight(belief, FLAG, 0.72);
        }
    }

    function blend(previous, observation, rate) {
        return previous * (1 - rate)
            + observation * rate;
    }

    function updateOpponentLane(model, col) {
        if (col <= 2) {
            model.left += 1;
        } else if (col >= 5) {
            model.right += 1;
        } else {
            model.center += 1;
        }
    }

    function findOwnFlag(gameState) {
        return (gameState.aiPieces || []).find((piece) => {
            return isActive(piece) && piece.type === FLAG;
        }) || null;
    }

    function observeOpponent(gameState, context) {
        const currentEnemies = snapshotPieces(gameState.playerPieces);
        const currentOwn = snapshotPieces(gameState.aiPieces);
        const previousOwnBoard = snapshotBoard(context.previousOwn);
        const ownFlag = findOwnFlag(gameState);

        let movedId = null;
        const lastMove = gameState.lastMove;
        if (lastMove && lastMove.from && lastMove.to) {
            const fromKey = cellKey(lastMove.from[0], lastMove.from[1]);
            for (const enemy of context.previousEnemies.values()) {
                if (cellKey(enemy.row, enemy.col) === fromKey) {
                    movedId = enemy.id;
                    break;
                }
            }
        }

        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy)) {
                continue;
            }
            const belief = ensureBelief(context, enemy);
            if (enemy.revealed) {
                collapseBelief(belief, actualPieceType(enemy));
            }

            const previous = context.previousEnemies.get(enemy.id);
            if (!previous) {
                belief.lastRow = enemy.row;
                belief.lastCol = enemy.col;
                continue;
            }

            const moved = previous.row !== enemy.row
                || previous.col !== enemy.col;
            if (!moved) {
                belief.stillTurns += 1;
                if (belief.stillTurns <= 10) {
                    multiplyWeight(belief, FLAG, 1.08);
                    multiplyWeight(belief, TRAP, 1.045);
                }
                continue;
            }

            belief.stillTurns = 0;
            belief.movedCount += 1;
            movedId = enemy.id;
            const rowDelta = previous.row - enemy.row;
            if (rowDelta > 0) {
                belief.forwardMoves += 1;
                multiplyWeight(belief, FLAG, 0.66);
                multiplyWeight(belief, TRAP, 0.88);
                context.opponent.aggression = blend(
                    context.opponent.aggression,
                    1,
                    0.18
                );
            } else if (rowDelta < 0) {
                belief.retreatMoves += 1;
                multiplyWeight(belief, FLAG, 1.14);
                context.opponent.retreat = blend(context.opponent.retreat, 1, 0.18);
            }

            const destinationKey = cellKey(enemy.row, enemy.col);
            const attacked = previousOwnBoard.has(destinationKey);
            context.opponent.attackRate = blend(
                context.opponent.attackRate,
                attacked ? 1 : 0,
                0.2
            );
            if (attacked) {
                multiplyWeight(belief, FLAG, 0.04);
                belief.attacks += 1;
            }

            const oldVisible = revealedOwnNear(
                context.previousOwn,
                previous.row,
                previous.col
            );
            if (oldVisible.piece) {
                const newDistance = chebyshev(
                    enemy.row,
                    enemy.col,
                    oldVisible.piece.row,
                    oldVisible.piece.col
                );
                updateReactionEvidence(
                    belief,
                    oldVisible.piece.pieceType,
                    oldVisible.distance,
                    newDistance,
                    attacked
                );
            }

            if (ownFlag) {
                const oldFlagDistance = chebyshev(
                    previous.row,
                    previous.col,
                    ownFlag.row,
                    ownFlag.col
                );
                const newFlagDistance = chebyshev(
                    enemy.row,
                    enemy.col,
                    ownFlag.row,
                    ownFlag.col
                );
                const pressure = newFlagDistance < oldFlagDistance ? 1 : 0;
                context.opponent.flagPressure = blend(
                    context.opponent.flagPressure,
                    pressure,
                    0.2
                );
            }

            updateOpponentLane(context.opponent, enemy.col);
            belief.lastRow = enemy.row;
            belief.lastCol = enemy.col;
        }

        if (movedId) {
            for (const previous of context.previousEnemies.values()) {
                if (previous.id === movedId) {
                    continue;
                }
                const belief = context.beliefs.get(previous.id);
                if (!belief || belief.revealedType) {
                    continue;
                }
                const visible = revealedOwnNear(
                    context.previousOwn,
                    previous.row,
                    previous.col
                );
                if (visible.piece && visible.distance === 1) {
                    const vulnerable = WIN_AGAINST[visible.piece.pieceType];
                    if (vulnerable) {
                        multiplyWeight(belief, vulnerable, 1.035);
                    }
                    multiplyWeight(belief, FLAG, 1.018);
                }
            }
        }

        if (context.turn >= 3) {
            for (const enemy of gameState.playerPieces || []) {
                if (!isActive(enemy) || enemy.revealed) {
                    continue;
                }
                let guards = 0;
                for (const other of gameState.playerPieces || []) {
                    if (!isActive(other) || other.id === enemy.id) {
                        continue;
                    }
                    const distance = chebyshev(
                        enemy.row,
                        enemy.col,
                        other.row,
                        other.col
                    );
                    if (distance <= 1) {
                        guards += 1;
                    }
                }
                const belief = ensureBelief(context, enemy);
                if (guards >= 3 && enemy.row >= HEIGHT - 2) {
                    multiplyWeight(belief, FLAG, 1.06);
                }
                if (guards >= 2) {
                    multiplyWeight(belief, TRAP, 1.018);
                }
            }
        }

        normalizeBeliefs(gameState, context);
        context.currentEnemies = currentEnemies;
        context.currentOwn = currentOwn;
    }

    function beliefEntropy(probs) {
        let entropy = 0;
        for (const type of [FLAG, TRAP, ...RPS_TYPES]) {
            const probability = probs[type] || 0;
            if (probability > 0.000001) {
                entropy -= probability * Math.log(probability);
            }
        }
        return entropy;
    }

    function getFlagCandidates(gameState, context) {
        const candidates = [];
        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy)) {
                continue;
            }
            const probs = probabilityFor(context, enemy.id);
            candidates.push({
                piece: enemy,
                probability: probs.flag || 0,
                trapProbability: probs.trap || 0
            });
        }
        candidates.sort((left, right) => {
            return right.probability - left.probability;
        });
        return candidates;
    }

    function chooseClosestByType(pieces, type, flag, excluded) {
        let best = null;
        let bestScore = Infinity;
        for (const piece of pieces) {
            if (excluded.has(piece.id) || piece.pieceType !== type) {
                continue;
            }
            const distance = chebyshev(piece.row, piece.col, flag.row, flag.col);
            const revealedPenalty = piece.revealed ? 0.3 : 0;
            const score = distance + revealedPenalty;
            if (score < bestScore) {
                bestScore = score;
                best = piece;
            }
        }
        return best;
    }

    function opponentFlagBeliefs(gameState, context) {
        const candidates = [];
        let total = 0;
        for (const piece of gameState.aiPieces || []) {
            if (!isActive(piece) || piece.revealed) {
                continue;
            }
            const moves = context.ownMoveCounts.get(piece.id) || 0;
            let weight = piece.row === 0 ? 1.8 : 0.8;
            if (piece.col === 0 || piece.col === WIDTH - 1) {
                weight *= 1.2;
            }
            weight /= 1 + moves * 0.45;
            candidates.push({ id: piece.id, weight });
            total += weight;
        }

        const result = new Map();
        for (const candidate of candidates) {
            const probability = total > 0 ? candidate.weight / total : 0;
            result.set(candidate.id, probability);
        }
        return result;
    }

    function buildStrategicPlan(gameState, context) {
        const flag = findOwnFlag(gameState);
        const fighters = (gameState.aiPieces || []).filter((piece) => {
            return isActive(piece)
                && !piece.immobilized
                && piece.type === 'piece'
                && !!piece.pieceType;
        });

        const defenders = new Set();
        if (flag) {
            for (const type of RPS_TYPES) {
                const selected = chooseClosestByType(fighters, type, flag, defenders);
                if (selected) {
                    defenders.add(selected.id);
                }
            }
            const nearest = fighters.slice().sort((left, right) => {
                const leftDistance = chebyshev(
                    left.row,
                    left.col,
                    flag.row,
                    flag.col
                );
                const rightDistance = chebyshev(
                    right.row,
                    right.col,
                    flag.row,
                    flag.col
                );
                return leftDistance - rightDistance;
            });
            for (const piece of nearest) {
                if (defenders.size >= 4) {
                    break;
                }
                defenders.add(piece.id);
            }
        }

        const fist = new Set();
        for (const type of RPS_TYPES) {
            const typed = fighters
                .filter((piece) => piece.pieceType === type && !defenders.has(piece.id))
                .sort((left, right) => right.row - left.row);
            if (typed.length > 0) {
                fist.add(typed[0].id);
            }
        }

        const candidates = getFlagCandidates(gameState, context);
        const primary = candidates.length > 0 ? candidates[0] : null;
        const secondary = candidates.length > 1 ? candidates[1] : primary;
        const ownFlagModel = opponentFlagBeliefs(gameState, context);

        let feintColumn = context.doctrine === 'double_feint' ? 0 : WIDTH - 1;
        if (primary && primary.piece.col >= WIDTH / 2) {
            feintColumn = 0;
        } else if (primary) {
            feintColumn = WIDTH - 1;
        }

        return {
            flag,
            defenders,
            fist,
            primary,
            secondary,
            feintColumn,
            ownFlagModel
        };
    }

    function generateLegalMoves(gameState) {
        const moves = [];
        for (const piece of gameState.aiPieces || []) {
            if (!isActive(piece) || piece.immobilized) {
                continue;
            }
            if (piece.type === FLAG && piece.revealed) {
                continue;
            }

            const destinations = api.getLegalMoves(piece, gameState);
            for (const destination of destinations) {
                const row = destination.row;
                const col = destination.col;
                const target = gameState.board[row] && gameState.board[row][col];
                if (piece.type === FLAG && target && target.owner !== piece.owner) {
                    continue;
                }
                moves.push({
                    piece,
                    row,
                    col,
                    target: target || null
                });
            }
        }
        return moves;
    }

    function attackSuccessProbability(move, context) {
        const target = move.target;
        if (!target) {
            return 1;
        }
        if (target.revealed && target.type === FLAG) {
            return 1;
        }
        if (target.revealed && target.type === TRAP) {
            return 0;
        }
        if (move.piece.type === TRAP) {
            return target.type === TRAP ? 0 : 1;
        }
        if (move.piece.type !== 'piece' || !move.piece.pieceType) {
            return 0;
        }

        if (target.revealed && target.type === 'piece' && target.pieceType) {
            const result = api.resolveBattle(move.piece.pieceType, target.pieceType);
            if (result === 'win') {
                return 1;
            }
            if (result === 'draw') {
                return 0.49;
            }
            return 0;
        }

        const probs = probabilityFor(context, target.id);
        const ownType = move.piece.pieceType;
        const beaten = WIN_AGAINST[ownType];
        return (probs.flag || 0)
            + (probs[beaten] || 0)
            + (probs[ownType] || 0) * 0.49;
    }

    function emergencyRisk(gameState, context, move) {
        const currentFlag = findOwnFlag(gameState);
        if (!currentFlag) {
            return 1;
        }

        const flagRow = move.piece.id === currentFlag.id ? move.row : currentFlag.row;
        const flagCol = move.piece.id === currentFlag.id ? move.col : currentFlag.col;
        let noThreatProbability = 1;
        let nearThreats = 0;

        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy) || enemy.immobilized) {
                continue;
            }
            const distance = chebyshev(flagRow, flagCol, enemy.row, enemy.col);
            if (distance === 1) {
                let removalProbability = 0;
                if (move.target && move.target.id === enemy.id) {
                    removalProbability = attackSuccessProbability(move, context);
                }
                noThreatProbability *= removalProbability;
            } else if (distance === 2) {
                nearThreats += 1;
            }
        }

        const immediate = 1 - noThreatProbability;
        const horizon = Math.min(0.32, nearThreats * 0.055);
        return clamp(immediate + horizon, 0, 1);
    }

    function currentFlagRisk(gameState) {
        const flag = findOwnFlag(gameState);
        if (!flag) {
            return 1;
        }
        let adjacent = 0;
        let near = 0;
        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy) || enemy.immobilized) {
                continue;
            }
            const distance = chebyshev(flag.row, flag.col, enemy.row, enemy.col);
            if (distance === 1) {
                adjacent += 1;
            } else if (distance === 2) {
                near += 1;
            }
        }
        if (adjacent > 0) {
            return 1;
        }
        return Math.min(0.4, near * 0.08);
    }

    function expectedDangerAt(gameState, context, piece, row, col) {
        if (piece.type === FLAG) {
            for (const enemy of gameState.playerPieces || []) {
                if (!isActive(enemy) || enemy.immobilized) {
                    continue;
                }
                if (chebyshev(row, col, enemy.row, enemy.col) === 1) {
                    return 1;
                }
            }
            return 0;
        }

        if (piece.type !== 'piece' || !piece.pieceType) {
            return 0.25;
        }

        let survival = 1;
        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy) || enemy.immobilized) {
                continue;
            }
            if (chebyshev(row, col, enemy.row, enemy.col) !== 1) {
                continue;
            }

            let danger = 0;
            if (enemy.revealed) {
                const type = actualPieceType(enemy);
                if (type === TRAP) {
                    danger = 1;
                } else if (type === FLAG) {
                    danger = 0;
                } else if (type && api.resolveBattle(type, piece.pieceType) === 'win') {
                    danger = 1;
                }
            } else {
                const probs = probabilityFor(context, enemy.id);
                const predator = COUNTER[piece.pieceType];
                danger = (probs[predator] || 0)
                    + (probs.trap || 0);
            }
            survival *= 1 - clamp(danger, 0, 1);
        }
        return 1 - survival;
    }

    function combatHeuristic(move, context) {
        const target = move.target;
        if (!target) {
            return 0;
        }
        if (target.revealed && target.type === FLAG) {
            return WIN_SCORE;
        }
        if (target.revealed && target.type === TRAP) {
            return -14000;
        }
        if (move.piece.type === TRAP) {
            return 2600;
        }
        if (move.piece.type !== 'piece' || !move.piece.pieceType) {
            return -WIN_SCORE;
        }

        if (target.revealed && target.type === 'piece' && target.pieceType) {
            const result = api.resolveBattle(move.piece.pieceType, target.pieceType);
            if (result === 'win') {
                return 3300;
            }
            if (result === 'draw') {
                return 180;
            }
            return -5200;
        }

        const probs = probabilityFor(context, target.id);
        const ownType = move.piece.pieceType;
        const beaten = WIN_AGAINST[ownType];
        const predator = COUNTER[ownType];
        const winProbability = probs[beaten] || 0;
        const loseProbability = (probs[predator] || 0)
            + (probs.trap || 0);
        const drawProbability = probs[ownType] || 0;
        const flagProbability = probs.flag || 0;
        const information = beliefEntropy(probs);
        return flagProbability * 520000
            + winProbability * 2600
            + drawProbability * 120
            - loseProbability * 2300
            + information * 95;
    }

    function countAlliesNearAfterMove(gameState, move, range) {
        let count = 0;
        for (const ally of gameState.aiPieces || []) {
            if (!isActive(ally) || ally.id === move.piece.id) {
                continue;
            }
            const distance = chebyshev(move.row, move.col, ally.row, ally.col);
            if (distance <= range) {
                count += 1;
            }
        }
        return count;
    }

    function hasCounterSupport(gameState, move) {
        if (move.piece.type !== 'piece' || !move.piece.pieceType) {
            return false;
        }
        const predator = COUNTER[move.piece.pieceType];
        const needed = COUNTER[predator];
        for (const ally of gameState.aiPieces || []) {
            if (!isActive(ally) || ally.id === move.piece.id) {
                continue;
            }
            if (ally.type !== 'piece' || ally.pieceType !== needed) {
                continue;
            }
            if (chebyshev(move.row, move.col, ally.row, ally.col) <= 1) {
                return true;
            }
        }
        return false;
    }

    function recentVisitPenalty(context, move) {
        let penalty = 0;
        const history = context.moveHistory
            .filter((entry) => entry.id === move.piece.id)
            .slice(-4);
        for (let index = 0; index < history.length; index++) {
            const entry = history[index];
            if (entry.fromRow === move.row && entry.fromCol === move.col) {
                penalty += 180 * (history.length - index);
            }
            if (entry.toRow === move.row && entry.toCol === move.col) {
                penalty += 90 * (history.length - index);
            }
        }
        return penalty;
    }

    function distanceToCandidate(move, candidate) {
        if (!candidate) {
            return 0;
        }
        return chebyshev(
            move.row,
            move.col,
            candidate.piece.row,
            candidate.piece.col
        );
    }

    function positionalHeuristic(gameState, context, plan, move) {
        const piece = move.piece;
        const flag = plan.flag;
        let score = combatHeuristic(move, context);

        const moveRisk = emergencyRisk(gameState, context, move);
        score -= moveRisk * FLAG_DANGER_SCORE;

        const danger = expectedDangerAt(gameState, context, piece, move.row, move.col);
        score -= danger * (piece.revealed ? 1500 : 1050);
        score -= recentVisitPenalty(context, move);

        if (piece.type === FLAG) {
            const currentRisk = currentFlagRisk(gameState);
            score -= currentRisk < 0.5 ? 18000 : 400;
            score += (currentRisk - moveRisk) * FLAG_DANGER_SCORE;
            return score;
        }

        if (piece.type === TRAP) {
            if (flag) {
                const oldDistance = chebyshev(
                    piece.row,
                    piece.col,
                    flag.row,
                    flag.col
                );
                const newDistance = chebyshev(
                    move.row,
                    move.col,
                    flag.row,
                    flag.col
                );
                score += (oldDistance - newDistance) * 520;
                if (!move.target && newDistance > 1) {
                    score -= 1700;
                }
            }
            if (move.target) {
                score += currentFlagRisk(gameState) > 0.4 ? 3800 : 350;
            }
            return score;
        }

        if (flag && plan.defenders.has(piece.id)) {
            const oldDistance = chebyshev(
                piece.row,
                piece.col,
                flag.row,
                flag.col
            );
            const newDistance = chebyshev(
                move.row,
                move.col,
                flag.row,
                flag.col
            );
            const pressure = context.opponent.flagPressure;
            score += (oldDistance - newDistance) * (420 + pressure * 430);
            if (newDistance <= 1) {
                score += 520;
            } else if (newDistance > 2) {
                score -= 900;
            }
        } else {
            const forward = move.row - piece.row;
            score += forward * (155 + context.opponent.retreat * 75);

            if (plan.primary) {
                const oldDistance = chebyshev(
                    piece.row,
                    piece.col,
                    plan.primary.piece.row,
                    plan.primary.piece.col
                );
                const newDistance = distanceToCandidate(move, plan.primary);
                const confidence = plan.primary.probability;
                score += (oldDistance - newDistance) * (260 + confidence * 1200);
            }
        }

        if (plan.fist.has(piece.id)) {
            const support = countAlliesNearAfterMove(gameState, move, 1);
            score += Math.min(3, support) * 160;
            if (hasCounterSupport(gameState, move)) {
                score += 380;
            }
        }

        const allies = countAlliesNearAfterMove(gameState, move, 1);
        if (allies >= 5) {
            score -= (allies - 4) * 240;
        }

        if (!plan.defenders.has(piece.id)
            && plan.secondary
            && piece.revealed
            && Math.abs(move.col - plan.feintColumn) < Math.abs(piece.col - plan.feintColumn)) {
            score += context.doctrine === 'double_feint' ? 210 : 75;
        }

        if (move.target && !move.target.revealed && hasCounterSupport(gameState, move)) {
            score += 520;
        }

        const centerDistance = Math.abs(move.col - 3.5);
        score += (3.5 - centerDistance) * 22;

        const drawCounter = gameState.movesWithoutCapture || 0;
        if (drawCounter >= 10) {
            const ratio = drawCounter / 20;
            if (move.target) {
                score += 700 * ratio;
            } else if (move.row > piece.row) {
                score += 260 * ratio;
            }
        }

        return score;
    }

    function selectRootMoves(gameState, context, plan, legalMoves) {
        const scored = legalMoves.map((move) => {
            return {
                move,
                heuristic: positionalHeuristic(gameState, context, plan, move),
                risk: emergencyRisk(gameState, context, move)
            };
        });
        scored.sort((left, right) => right.heuristic - left.heuristic);

        const presentRisk = currentFlagRisk(gameState);
        if (presentRisk >= 0.4) {
            let minimumRisk = 1;
            for (const entry of scored) {
                minimumRisk = Math.min(minimumRisk, entry.risk);
            }
            const safe = scored.filter((entry) => {
                return entry.risk <= minimumRisk + 0.015;
            });
            return safe.slice(0, 22);
        }

        const selected = scored.slice(0, gameState.devMode ? 17 : 21);
        for (const entry of scored) {
            const tactical = entry.move.target
                || entry.move.piece.type === FLAG
                || entry.risk < 0.02;
            if (!tactical) {
                continue;
            }
            const exists = selected.some((candidate) => {
                return sameMove(candidate.move, entry.move);
            });
            if (!exists) {
                selected.push(entry);
            }
            if (selected.length >= 25) {
                break;
            }
        }
        return selected;
    }

    function sameMove(left, right) {
        return left.piece.id === right.piece.id
            && left.row === right.row
            && left.col === right.col;
    }

    function scenarioRandom(rng) {
        rng.value = mix32(rng.value);
        return rng.value / 4294967296;
    }

    function chooseScenarioPiece(entries, field, rng, excluded) {
        const available = entries.filter((entry) => {
            return !excluded.has(entry.piece.id);
        });
        return weightedPick(
            available,
            (entry) => entry.probs[field] || 0.00001,
            scenarioRandom(rng)
        );
    }

    function sampleRpsType(probs, rng) {
        return weightedPick(
            RPS_TYPES,
            (type) => probs[type] || 0.00001,
            scenarioRandom(rng)
        ) || 'rock';
    }

    function simPieceFromPublic(piece, side, kind, rpsType) {
        return {
            id: piece.id,
            side,
            kind,
            rps: rpsType,
            row: piece.row,
            col: piece.col,
            alive: isActive(piece),
            immobilized: !!piece.immobilized,
            publicRevealed: !!piece.revealed
        };
    }

    function buildScenario(gameState, context, scenarioIndex) {
        const rng = {
            value: mix32(
                context.seed
                ^ Math.imul(context.turn + 1, 2654435761)
                ^ Math.imul(scenarioIndex + 7, 2246822519)
            )
        };
        const assignments = new Map();
        const hiddenEntries = [];
        let knownFlagId = null;
        let knownTrapId = null;

        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy)) {
                continue;
            }
            if (enemy.revealed) {
                const type = actualPieceType(enemy);
                assignments.set(enemy.id, type);
                if (type === FLAG) {
                    knownFlagId = enemy.id;
                } else if (type === TRAP) {
                    knownTrapId = enemy.id;
                }
            } else {
                hiddenEntries.push({
                    piece: enemy,
                    probs: probabilityFor(context, enemy.id)
                });
            }
        }

        const excluded = new Set();
        if (knownFlagId) {
            excluded.add(knownFlagId);
        } else {
            const flagEntry = chooseScenarioPiece(
                hiddenEntries,
                FLAG,
                rng,
                excluded
            );
            if (flagEntry) {
                assignments.set(flagEntry.piece.id, FLAG);
                excluded.add(flagEntry.piece.id);
            }
        }

        if (knownTrapId) {
            excluded.add(knownTrapId);
        } else {
            const trapEntry = chooseScenarioPiece(
                hiddenEntries,
                TRAP,
                rng,
                excluded
            );
            if (trapEntry) {
                assignments.set(trapEntry.piece.id, TRAP);
                excluded.add(trapEntry.piece.id);
            }
        }

        for (const entry of hiddenEntries) {
            if (assignments.has(entry.piece.id)) {
                continue;
            }
            assignments.set(entry.piece.id, sampleRpsType(entry.probs, rng));
        }

        const pieces = [];
        for (const own of gameState.aiPieces || []) {
            if (!isActive(own)) {
                continue;
            }
            const type = actualPieceType(own);
            const kind = type === FLAG || type === TRAP ? type : 'piece';
            const rps = kind === 'piece' ? type : null;
            pieces.push(simPieceFromPublic(own, 0, kind, rps));
        }
        for (const enemy of gameState.playerPieces || []) {
            if (!isActive(enemy)) {
                continue;
            }
            const assigned = assignments.get(enemy.id) || 'rock';
            const kind = assigned === FLAG || assigned === TRAP ? assigned : 'piece';
            const rps = kind === 'piece' ? assigned : null;
            pieces.push(simPieceFromPublic(enemy, 1, kind, rps));
        }

        const board = new Array(WIDTH * HEIGHT).fill(-1);
        for (let index = 0; index < pieces.length; index++) {
            const piece = pieces[index];
            if (piece.alive) {
                board[boardIndex(piece.row, piece.col)] = index;
            }
        }

        return {
            pieces,
            board,
            terminal: 0,
            ply: 0,
            random: rng.value
        };
    }

    function cloneScenario(state) {
        return {
            pieces: state.pieces.map((piece) => ({ ...piece })),
            board: state.board.slice(),
            terminal: state.terminal,
            ply: state.ply,
            random: state.random
        };
    }

    function simMoves(state, side) {
        const moves = [];
        for (let index = 0; index < state.pieces.length; index++) {
            const piece = state.pieces[index];
            if (!piece.alive || piece.side !== side || piece.immobilized) {
                continue;
            }
            if (piece.kind === FLAG && piece.publicRevealed) {
                continue;
            }

            for (const direction of DIRECTIONS) {
                const row = piece.row + direction[0];
                const col = piece.col + direction[1];
                if (!isInside(row, col)) {
                    continue;
                }
                const targetIndex = state.board[boardIndex(row, col)];
                if (targetIndex >= 0 && state.pieces[targetIndex].side === side) {
                    continue;
                }
                if (piece.kind === FLAG && targetIndex >= 0) {
                    continue;
                }
                moves.push({
                    pieceIndex: index,
                    row,
                    col,
                    targetIndex
                });
            }
        }
        return moves;
    }

    function removeSimPiece(state, pieceIndex) {
        const piece = state.pieces[pieceIndex];
        if (!piece.alive) {
            return;
        }
        state.board[boardIndex(piece.row, piece.col)] = -1;
        piece.alive = false;
        piece.row = -1;
        piece.col = -1;
    }

    function moveSimPiece(state, pieceIndex, row, col) {
        const piece = state.pieces[pieceIndex];
        state.board[boardIndex(piece.row, piece.col)] = -1;
        piece.row = row;
        piece.col = col;
        state.board[boardIndex(row, col)] = pieceIndex;
    }

    function simBattleResult(attackerType, defenderType) {
        if (attackerType === defenderType) {
            return 'draw';
        }
        return WIN_AGAINST[attackerType] === defenderType ? 'win' : 'lose';
    }

    function resolveSimDraw(state, move) {
        state.random = mix32(
            state.random
            ^ hashText(state.pieces[move.pieceIndex].id)
            ^ hashText(state.pieces[move.targetIndex].id)
            ^ state.ply
        );
        const roll = state.random % 100;
        if (roll < 49) {
            removeSimPiece(state, move.targetIndex);
            moveSimPiece(state, move.pieceIndex, move.row, move.col);
        } else if (roll < 98) {
            removeSimPiece(state, move.pieceIndex);
        } else {
            removeSimPiece(state, move.pieceIndex);
            removeSimPiece(state, move.targetIndex);
        }
    }

    function applySimMove(source, move) {
        const state = cloneScenario(source);
        state.ply += 1;
        const attacker = state.pieces[move.pieceIndex];
        const target = move.targetIndex >= 0
            ? state.pieces[move.targetIndex]
            : null;

        if (!attacker || !attacker.alive) {
            return state;
        }
        if (!target) {
            moveSimPiece(state, move.pieceIndex, move.row, move.col);
            return state;
        }

        if (target.kind === FLAG) {
            removeSimPiece(state, move.targetIndex);
            moveSimPiece(state, move.pieceIndex, move.row, move.col);
            state.terminal = attacker.side === 0 ? 1 : -1;
            return state;
        }
        if (attacker.kind === FLAG) {
            state.terminal = attacker.side === 0 ? -1 : 1;
            return state;
        }
        if (target.kind === TRAP) {
            removeSimPiece(state, move.pieceIndex);
            target.immobilized = true;
            target.publicRevealed = true;
            return state;
        }
        if (attacker.kind === TRAP) {
            removeSimPiece(state, move.targetIndex);
            moveSimPiece(state, move.pieceIndex, move.row, move.col);
            attacker.immobilized = true;
            attacker.publicRevealed = true;
            return state;
        }

        const result = simBattleResult(attacker.rps, target.rps);
        attacker.publicRevealed = true;
        target.publicRevealed = true;
        if (result === 'win') {
            removeSimPiece(state, move.targetIndex);
            moveSimPiece(state, move.pieceIndex, move.row, move.col);
        } else if (result === 'lose') {
            removeSimPiece(state, move.pieceIndex);
        } else {
            resolveSimDraw(state, move);
        }
        return state;
    }

    function findSimFlag(state, side) {
        return state.pieces.find((piece) => {
            return piece.alive && piece.side === side && piece.kind === FLAG;
        }) || null;
    }

    function simFlagSafety(state, side) {
        const flag = findSimFlag(state, side);
        if (!flag) {
            return -WIN_SCORE;
        }

        let score = 0;
        const defenderTypes = new Set();
        for (const piece of state.pieces) {
            if (!piece.alive || piece.id === flag.id) {
                continue;
            }
            const distance = chebyshev(flag.row, flag.col, piece.row, piece.col);
            if (piece.side !== side) {
                if (distance === 1 && !piece.immobilized) {
                    score -= FLAG_DANGER_SCORE;
                } else if (distance === 2 && !piece.immobilized) {
                    score -= FLAG_NEAR_SCORE;
                } else if (distance === 3) {
                    score -= 6200;
                }
                continue;
            }

            if (distance <= 1 && !piece.immobilized) {
                if (piece.kind === TRAP) {
                    score += 8500;
                } else if (piece.kind === 'piece') {
                    defenderTypes.add(piece.rps);
                    score += 3200;
                }
            } else if (distance === 2 && piece.kind === 'piece') {
                score += 950;
            }
        }
        score += defenderTypes.size * 4200;
        if (flag.row === (side === 0 ? 0 : HEIGHT - 1)) {
            score += 3200;
        }
        if (flag.col === 0 || flag.col === WIDTH - 1) {
            score += 900;
        }
        return score;
    }

    function simMaterial(state) {
        let score = 0;
        for (const piece of state.pieces) {
            if (!piece.alive || piece.kind === FLAG) {
                continue;
            }
            let value = MATERIAL_SCORE;
            if (piece.kind === TRAP && !piece.immobilized) {
                value = 2200;
            }
            if (!piece.publicRevealed && piece.kind === 'piece') {
                value += 160;
            }
            score += piece.side === 0 ? value : -value;
        }
        return score;
    }

    function simAdvance(state, side) {
        const enemyFlag = findSimFlag(state, side === 0 ? 1 : 0);
        if (!enemyFlag) {
            return side === 0 ? WIN_SCORE : -WIN_SCORE;
        }

        let nearest = Infinity;
        let formation = 0;
        for (const piece of state.pieces) {
            if (!piece.alive || piece.side !== side || piece.kind === FLAG) {
                continue;
            }
            const distance = chebyshev(
                piece.row,
                piece.col,
                enemyFlag.row,
                enemyFlag.col
            );
            nearest = Math.min(nearest, distance);
            for (const ally of state.pieces) {
                if (!ally.alive || ally.side !== side || ally.id === piece.id) {
                    continue;
                }
                if (chebyshev(piece.row, piece.col, ally.row, ally.col) === 1) {
                    formation += 1;
                }
            }
        }
        if (!Number.isFinite(nearest)) {
            return -18000;
        }
        const progress = (8 - nearest) * 950;
        return progress + Math.min(12, formation) * 80;
    }

    function evaluateScenario(state) {
        if (state.terminal > 0) {
            return WIN_SCORE - state.ply * 1000;
        }
        if (state.terminal < 0) {
            return -WIN_SCORE + state.ply * 1000;
        }

        const ownFlag = findSimFlag(state, 0);
        const enemyFlag = findSimFlag(state, 1);
        if (!ownFlag) {
            return -WIN_SCORE;
        }
        if (!enemyFlag) {
            return WIN_SCORE;
        }

        return simMaterial(state)
            + simFlagSafety(state, 0)
            - simFlagSafety(state, 1) * 0.72
            + simAdvance(state, 0)
            - simAdvance(state, 1) * 0.78;
    }

    function opponentTargetDistance(state, move, plan) {
        const piece = state.pieces[move.pieceIndex];
        let current = 0;
        let next = 0;
        for (const [id, probability] of plan.ownFlagModel.entries()) {
            const candidate = state.pieces.find((entry) => entry.id === id && entry.alive);
            if (!candidate) {
                continue;
            }
            current += probability * chebyshev(
                piece.row,
                piece.col,
                candidate.row,
                candidate.col
            );
            next += probability * chebyshev(
                move.row,
                move.col,
                candidate.row,
                candidate.col
            );
        }
        return current - next;
    }

    function simMoveOrderScore(state, move, side, plan, context) {
        const piece = state.pieces[move.pieceIndex];
        const target = move.targetIndex >= 0
            ? state.pieces[move.targetIndex]
            : null;
        let score = 0;

        if (target) {
            if (target.kind === FLAG) {
                return WIN_SCORE;
            }
            if (target.kind === TRAP) {
                score -= 4200;
            } else if (piece.kind === TRAP) {
                score += 2600;
            } else if (piece.kind === 'piece' && target.kind === 'piece') {
                const result = simBattleResult(piece.rps, target.rps);
                if (result === 'win') {
                    score += 3200;
                } else if (result === 'lose') {
                    score -= 2800;
                } else {
                    score += 120;
                }
            }
        }

        const ownFlag = findSimFlag(state, side);
        if (ownFlag && piece.kind !== FLAG) {
            const oldDistance = chebyshev(
                piece.row,
                piece.col,
                ownFlag.row,
                ownFlag.col
            );
            const newDistance = chebyshev(
                move.row,
                move.col,
                ownFlag.row,
                ownFlag.col
            );
            let threat = 0;
            for (const enemy of state.pieces) {
                if (!enemy.alive || enemy.side === side) {
                    continue;
                }
                if (chebyshev(
                    ownFlag.row,
                    ownFlag.col,
                    enemy.row,
                    enemy.col
                ) <= 2) {
                    threat += 1;
                }
            }
            score += (oldDistance - newDistance) * threat * 900;
        }

        if (piece.kind === FLAG) {
            score -= 16000;
        } else if (side === 0) {
            const enemyFlag = findSimFlag(state, 1);
            if (enemyFlag) {
                const oldDistance = chebyshev(
                    piece.row,
                    piece.col,
                    enemyFlag.row,
                    enemyFlag.col
                );
                const newDistance = chebyshev(
                    move.row,
                    move.col,
                    enemyFlag.row,
                    enemyFlag.col
                );
                score += (oldDistance - newDistance) * 740;
            }
        } else {
            score += opponentTargetDistance(state, move, plan) * 780;
            score += (piece.row - move.row) * (
                180
                + context.opponent.aggression * 260
            );
        }

        return score;
    }

    function orderedSimMoves(state, side, plan, context, beam) {
        const moves = simMoves(state, side);
        const scored = moves.map((move) => {
            return {
                move,
                score: simMoveOrderScore(state, move, side, plan, context)
            };
        });
        scored.sort((left, right) => right.score - left.score);
        return scored.slice(0, beam);
    }

    function scenarioHash(state, depth, side) {
        let hash = `${depth}:${side}:${state.terminal}|`;
        for (const piece of state.pieces) {
            if (!piece.alive) {
                continue;
            }
            hash += `${piece.id}:${piece.kind}:${piece.rps || '-'}:`
                + `${piece.row}${piece.col}:${piece.immobilized ? 1 : 0}|`;
        }
        return hash;
    }

    function cacheSearchValue(context, key, value) {
        if (context.searchCache.size >= MAX_CACHE) {
            const first = context.searchCache.keys().next();
            if (!first.done) {
                context.searchCache.delete(first.value);
            }
        }
        context.searchCache.set(key, value);
    }

    function searchScenario(state, depth, side, plan, context, deadline) {
        if (state.terminal !== 0 || depth <= 0 || Date.now() >= deadline) {
            return evaluateScenario(state);
        }

        const key = scenarioHash(state, depth, side);
        if (context.searchCache.has(key)) {
            return context.searchCache.get(key);
        }

        const beam = side === 0
            ? (depth >= 3 ? 6 : 8)
            : (depth >= 3 ? 7 : 10);
        const ordered = orderedSimMoves(state, side, plan, context, beam);
        if (ordered.length === 0) {
            return evaluateScenario(state);
        }

        if (side === 0) {
            let best = -Infinity;
            for (const entry of ordered) {
                if (Date.now() >= deadline) {
                    break;
                }
                const child = applySimMove(state, entry.move);
                const score = searchScenario(
                    child,
                    depth - 1,
                    1,
                    plan,
                    context,
                    deadline
                );
                best = Math.max(best, score);
            }
            if (!Number.isFinite(best)) {
                best = evaluateScenario(state);
            }
            cacheSearchValue(context, key, best);
            return best;
        }

        let worst = Infinity;
        let weighted = 0;
        let weightTotal = 0;
        for (let index = 0; index < ordered.length; index++) {
            if (Date.now() >= deadline) {
                break;
            }
            const entry = ordered[index];
            const child = applySimMove(state, entry.move);
            const score = searchScenario(
                child,
                depth - 1,
                0,
                plan,
                context,
                deadline
            );
            worst = Math.min(worst, score);
            const motiveWeight = 1 / (1 + index * 0.7);
            weighted += score * motiveWeight;
            weightTotal += motiveWeight;
        }
        if (!Number.isFinite(worst)) {
            worst = evaluateScenario(state);
        }
        const expected = weightTotal > 0 ? weighted / weightTotal : worst;
        const paranoia = 0.68
            + context.opponent.flagPressure * 0.17;
        const value = worst * paranoia
            + expected * (1 - paranoia);
        cacheSearchValue(context, key, value);
        return value;
    }

    function findScenarioMove(state, rootMove) {
        const pieceIndex = state.pieces.findIndex((piece) => {
            return piece.alive && piece.id === rootMove.piece.id;
        });
        if (pieceIndex < 0) {
            return null;
        }
        const targetIndex = state.board[boardIndex(rootMove.row, rootMove.col)];
        return {
            pieceIndex,
            row: rootMove.row,
            col: rootMove.col,
            targetIndex
        };
    }

    function robustAggregate(scores) {
        if (scores.length === 0) {
            return 0;
        }
        const sorted = scores.slice().sort((left, right) => left - right);
        let total = 0;
        for (const score of sorted) {
            total += score;
        }
        const mean = total / sorted.length;

        const tailSize = Math.max(1, Math.ceil(sorted.length * 0.4));
        let tailTotal = 0;
        for (let index = 0; index < tailSize; index++) {
            tailTotal += sorted[index];
        }
        const tailMean = tailTotal / tailSize;
        return mean * 0.48
            + tailMean * 0.52;
    }

    function searchBestMove(gameState, context, plan, roots) {
        if (roots.length === 0) {
            return null;
        }

        context.searchCache.clear();
        const presentRisk = currentFlagRisk(gameState);
        const baseBudget = gameState.devMode ? DEV_BUDGET_MS : NORMAL_BUDGET_MS;
        const budget = presentRisk >= 0.4 ? baseBudget + 45 : baseBudget;
        const deadline = Date.now() + budget;
        const totalPieces = (gameState.aiPieces || []).length
            + (gameState.playerPieces || []).length;
        const depth = totalPieces <= 14 ? 3 : 2;
        const scenarioCount = gameState.devMode ? 6 : 9;

        const results = roots.map((entry) => {
            return {
                entry,
                scores: []
            };
        });

        for (let scenarioIndex = 0; scenarioIndex < scenarioCount; scenarioIndex++) {
            if (Date.now() >= deadline) {
                break;
            }
            const scenario = buildScenario(gameState, context, scenarioIndex);
            for (const result of results) {
                if (Date.now() >= deadline) {
                    break;
                }
                const simMove = findScenarioMove(scenario, result.entry.move);
                if (!simMove) {
                    continue;
                }
                const next = applySimMove(scenario, simMove);
                const value = searchScenario(
                    next,
                    depth,
                    1,
                    plan,
                    context,
                    deadline
                );
                result.scores.push(value);
            }
        }

        for (const result of results) {
            const searched = robustAggregate(result.scores);
            const confidence = result.scores.length / scenarioCount;
            result.total = searched * confidence
                + result.entry.heuristic * (1 - confidence + 0.12);
            result.total -= result.entry.risk * FLAG_DANGER_SCORE;
            result.total += (nextRandom(context) - 0.5) * 9;
        }
        results.sort((left, right) => right.total - left.total);
        return results[0] || null;
    }

    function safeFallback(gameState, context, plan, legalMoves) {
        if (legalMoves.length === 0) {
            return null;
        }

        const winning = legalMoves.find((move) => {
            return move.target
                && move.target.revealed
                && move.target.type === FLAG;
        });
        if (winning) {
            return winning;
        }

        let best = legalMoves[0];
        let bestScore = -Infinity;
        for (const move of legalMoves) {
            const score = positionalHeuristic(gameState, context, plan, move);
            if (score > bestScore) {
                bestScore = score;
                best = move;
            }
        }
        return best;
    }

    function rememberChoice(gameState, context, move) {
        const target = gameState.board[move.row] && gameState.board[move.row][move.col];
        context.expectedOwn = {
            id: move.piece.id,
            row: move.row,
            col: move.col
        };

        const entry = {
            id: move.piece.id,
            fromRow: move.piece.row,
            fromCol: move.piece.col,
            toRow: move.row,
            toCol: move.col,
            turn: context.turn
        };
        context.moveHistory.push(entry);
        if (context.moveHistory.length > MAX_HISTORY) {
            context.moveHistory.shift();
        }

        const moveCount = context.ownMoveCounts.get(move.piece.id) || 0;
        context.ownMoveCounts.set(move.piece.id, moveCount + 1);
        const visit = `${move.piece.id}:${move.row}:${move.col}`;
        const visits = context.visits.get(visit) || 0;
        context.visits.set(visit, visits + 1);

        context.previousEnemies = snapshotPieces(gameState.playerPieces);
        context.previousOwn = snapshotPieces(gameState.aiPieces);
        if (!target) {
            const predicted = context.previousOwn.get(move.piece.id);
            if (predicted) {
                predicted.row = move.row;
                predicted.col = move.col;
            }
        }
        context.turn += 1;
    }

    function chooseMove(gameState) {
        const context = getContext(gameState);
        try {
            observeOpponent(gameState, context);
            const legalMoves = generateLegalMoves(gameState);
            if (legalMoves.length === 0) {
                return null;
            }

            const plan = buildStrategicPlan(gameState, context);
            const immediateWin = legalMoves.find((move) => {
                return move.target
                    && move.target.revealed
                    && move.target.type === FLAG;
            });
            if (immediateWin) {
                rememberChoice(gameState, context, immediateWin);
                return immediateWin;
            }

            const roots = selectRootMoves(gameState, context, plan, legalMoves);
            const searched = searchBestMove(gameState, context, plan, roots);
            let selected = searched ? searched.entry.move : null;
            const legal = selected
                && legalMoves.some((move) => sameMove(move, selected));
            if (!legal) {
                selected = safeFallback(gameState, context, plan, legalMoves);
            }
            if (selected) {
                rememberChoice(gameState, context, selected);
            }
            return selected;
        } catch (error) {
            console.error('[golubenok] move() failed:', error);
            const legalMoves = generateLegalMoves(gameState);
            if (legalMoves.length === 0) {
                return null;
            }
            const plan = buildStrategicPlan(gameState, context);
            const fallback = safeFallback(gameState, context, plan, legalMoves);
            if (fallback) {
                rememberChoice(gameState, context, fallback);
            }
            return fallback;
        }
    }

    function chooseFlagAndTrap() {
        const templates = [
            { flagIndex: 0, trapIndex: 9, weight: 14 },
            { flagIndex: 7, trapIndex: 14, weight: 14 },
            { flagIndex: 2, trapIndex: 10, weight: 10 },
            { flagIndex: 5, trapIndex: 13, weight: 10 },
            { flagIndex: 1, trapIndex: 10, weight: 8 },
            { flagIndex: 6, trapIndex: 13, weight: 8 },
            { flagIndex: 3, trapIndex: 11, weight: 6 },
            { flagIndex: 4, trapIndex: 12, weight: 6 },
            { flagIndex: 0, trapIndex: 14, weight: 2 },
            { flagIndex: 7, trapIndex: 9, weight: 2 }
        ];
        setupCounter += 1;
        const jitter = (Math.random() + setupCounter * 0.61803398875) % 1;
        const selected = weightedPick(
            templates,
            (template) => template.weight,
            jitter
        );
        return {
            flagIndex: selected.flagIndex,
            trapIndex: selected.trapIndex
        };
    }

    function tieOwnCollection(gameState) {
        const aiPieces = gameState.aiPieces || [];
        const playerPieces = gameState.playerPieces || [];
        const aiKnowledge = aiPieces.filter((piece) => {
            return piece.type !== 'piece' || !!piece.pieceType;
        }).length;
        const playerKnowledge = playerPieces.filter((piece) => {
            return piece.type !== 'piece' || !!piece.pieceType;
        }).length;
        return aiKnowledge >= playerKnowledge ? aiPieces : playerPieces;
    }

    function getTieContext(gameState) {
        const own = tieOwnCollection(gameState);
        const active = own.find(isActive);
        let key = 'tie:golubenok';
        if (active && typeof active.id === 'string') {
            const separator = active.id.indexOf('_');
            key = separator > 0 ? active.id.slice(0, separator) : active.id;
        }

        let context = contexts.get(key);
        if (!context) {
            const synthetic = {
                aiPieces: own,
                playerPieces: [],
                botId: 'golubenok'
            };
            context = createContext(key, synthetic);
            contexts.set(key, context);
        }
        return {
            context,
            ownIsAi: own === gameState.aiPieces
        };
    }

    function updateTieModel(gameState, context, ownIsAi) {
        const battle = gameState.battleState;
        if (!battle || !battle.lastRound) {
            return;
        }

        const last = battle.lastRound;
        const ownChoice = ownIsAi ? last.opponentChoice : last.playerChoice;
        const enemyChoice = ownIsAi ? last.playerChoice : last.opponentChoice;
        const marker = `${battle.drawRound}:${ownChoice}:${enemyChoice}`;
        if (context.tieSeen.has(marker)) {
            return;
        }
        context.tieSeen.add(marker);

        if (RPS_TYPES.includes(enemyChoice)) {
            context.tieCounts[enemyChoice] += 1;
        }
        if (RPS_TYPES.includes(ownChoice) && RPS_TYPES.includes(enemyChoice)) {
            const transitionKey = `${ownChoice}->${enemyChoice}`;
            const count = context.tieTransitions.get(transitionKey) || 0;
            context.tieTransitions.set(transitionKey, count + 1);
        }
    }

    function tiePrediction(context, currentType) {
        const total = context.tieCounts.rock
            + context.tieCounts.paper
            + context.tieCounts.scissors;
        const prediction = {
            rock: context.tieCounts.rock / total * 0.32,
            paper: context.tieCounts.paper / total * 0.32,
            scissors: context.tieCounts.scissors / total * 0.32
        };

        prediction[currentType] += 0.16;
        prediction[COUNTER[currentType]] += 0.34;
        prediction[WIN_AGAINST[currentType]] += 0.10;
        for (const type of RPS_TYPES) {
            prediction[type] += 0.08 / 3;
        }
        return prediction;
    }

    function expectedTiePayoff(choice, prediction) {
        const beaten = WIN_AGAINST[choice];
        const predator = COUNTER[choice];
        return (prediction[beaten] || 0)
            - (prediction[predator] || 0);
    }

    function chooseTieType(currentType, opponentRevealed, opponentType, gameState) {
        const tie = getTieContext(gameState);
        const context = tie.context;
        updateTieModel(gameState, context, tie.ownIsAi);

        const referenceType = opponentRevealed && RPS_TYPES.includes(opponentType)
            ? opponentType
            : currentType;
        const prediction = tiePrediction(context, referenceType);
        let available = RPS_TYPES.slice();
        const ownChoices = context.tieOwnChoices;
        if (ownChoices.length >= 2) {
            const last = ownChoices[ownChoices.length - 1];
            const previous = ownChoices[ownChoices.length - 2];
            if (last === previous) {
                available = available.filter((type) => type !== last);
            }
        }

        const ranked = available.map((type) => {
            return {
                type,
                payoff: expectedTiePayoff(type, prediction)
            };
        });
        ranked.sort((left, right) => right.payoff - left.payoff);

        let choice = ranked[0].type;
        const explore = nextRandom(context);
        if (explore < 0.34) {
            const index = Math.floor(nextRandom(context) * available.length);
            choice = available[index];
        } else if (ranked.length > 1 && ranked[0].payoff - ranked[1].payoff < 0.06) {
            choice = nextRandom(context) < 0.5 ? ranked[0].type : ranked[1].type;
        }

        context.tieOwnChoices.push(choice);
        if (context.tieOwnChoices.length > 12) {
            context.tieOwnChoices.shift();
        }
        return choice;
    }

    return {
        id: 'golubenok',
        name: 'Голубёнок',
        emoji: '🐦',
        avatar: 'js/bots/golubenok/avatar-min.png',
        shortDescription: 'Вероятностная стратегия и приоритетная защита флага',
        longDescription: 'Честная belief-модель, робастный поиск, редуты, обман и организованные атаки.',
        algorithmLabel: 'Belief-state expectiminimax + motive model',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['belief-state', 'expectiminimax', 'flag-defense', 'adaptive'],

        move(gameState) {
            return chooseMove(gameState);
        },

        chooseFlagAndTrap() {
            return chooseFlagAndTrap();
        },

        getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
            return chooseTieType(
                currentType,
                opponentRevealed,
                opponentType,
                gameState
            );
        }
    };
})();

if (typeof RPSBotAPI !== 'undefined'
    && RPSBotAPI
    && typeof RPSBotAPI.defineBot === 'function') {
    RPSBotAPI.defineBot(golubenokBot);
} else {
    throw new Error('[golubenok] RPSBotAPI is required');
}
