import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    COMPUTER,
    FLAG,
    GAME_CONFIG,
    PLAYER,
    TRAP
} from '../game-config.js';

const RPS_TYPES = ['rock', 'paper', 'scissors'];
const TYPE_KEYS = ['rock', 'paper', 'scissors', 'flag', 'trap'];
const DEFAULT_TIE_OUTCOMES = {
    attackerWin: 0.49,
    defenderWin: 0.49,
    mutual: 0.02
};

function emptyBoard() {
    const board = [];
    for (let row = 0; row < BOARD_HEIGHT; row++) {
        board.push(new Array(BOARD_WIDTH).fill(null));
    }
    return board;
}

function clonePiece(piece) {
    return { ...piece };
}

function cloneSearchState(state) {
    const aiPieces = (state.aiPieces || []).map(clonePiece);
    const playerPieces = (state.playerPieces || []).map(clonePiece);
    const board = emptyBoard();
    const pieces = aiPieces.concat(playerPieces);
    for (const piece of pieces) {
        if (!piece.removed
            && piece.row >= 0
            && piece.col >= 0) {
            board[piece.row][piece.col] = piece;
        }
    }
    return {
        ...state,
        board,
        aiPieces,
        playerPieces,
        lastMove: state.lastMove
            ? {
                from: state.lastMove.from ? [...state.lastMove.from] : null,
                to: state.lastMove.to ? [...state.lastMove.to] : null
            }
            : null,
        searchOutcome: state.searchOutcome ? { ...state.searchOutcome } : null
    };
}

function exactType(piece) {
    if (!piece) {
        return null;
    }
    if (piece.type === 'piece') {
        return piece.pieceType || null;
    }
    return piece.type || null;
}

function knownSearchType(piece) {
    if (!piece) {
        return null;
    }
    if (piece.owner === COMPUTER
        || piece.revealed
        || piece._searchHypothesis) {
        return exactType(piece);
    }
    return null;
}

function normalizeDistribution(input) {
    const output = {
        rock: 0,
        paper: 0,
        scissors: 0,
        flag: 0,
        trap: 0
    };
    let sum = 0;
    for (const key of TYPE_KEYS) {
        const value = Number(input && input[key]);
        output[key] = Number.isFinite(value) && value > 0 ? value : 0;
        sum += output[key];
    }
    if (sum <= 0) {
        output.rock = 1 / 3;
        output.paper = 1 / 3;
        output.scissors = 1 / 3;
        return output;
    }
    for (const key of TYPE_KEYS) {
        output[key] /= sum;
    }
    return output;
}

function exactDistribution(type) {
    const distribution = normalizeDistribution(null);
    for (const key of TYPE_KEYS) {
        distribution[key] = key === type ? 1 : 0;
    }
    return distribution;
}

function fallbackDistribution(state, piece) {
    const hidden = (state.playerPieces || []).filter(candidate => {
        return !candidate.removed
            && candidate.row >= 0
            && knownSearchType(candidate) === null;
    });
    const count = Math.max(1, hidden.length);
    const backRow = BOARD_HEIGHT - 1;
    const onBackRows = piece.row === backRow
        || piece.row === backRow - 1;
    const flagWeight = onBackRows ? 1.4 : 0.45;
    const trapWeight = onBackRows ? 1.15 : 0.55;
    const pFlag = Math.min(0.45, flagWeight / count);
    const pTrap = Math.min(0.35, trapWeight / count);
    const rps = Math.max(0, 1 - pFlag - pTrap) / 3;
    return normalizeDistribution({
        rock: rps,
        paper: rps,
        scissors: rps,
        flag: pFlag,
        trap: pTrap
    });
}

function resolveBeliefSource(options) {
    if (options
        && options.beliefs) {
        return options.beliefs;
    }
    if (typeof globalThis !== 'undefined'
        && globalThis.aiBeliefs) {
        return globalThis.aiBeliefs;
    }
    return null;
}

function readBelief(source, pieceId) {
    if (!source) {
        return null;
    }
    if (typeof source.getProbDistribution === 'function') {
        return source.getProbDistribution(pieceId);
    }
    if (source instanceof Map) {
        const entry = source.get(pieceId);
        return entry && entry.probs ? entry.probs : entry;
    }
    return null;
}

function getPieceDistribution(state, piece, options) {
    const type = knownSearchType(piece);
    if (type) {
        return exactDistribution(type);
    }
    let distribution = null;
    if (options
        && typeof options.getDistribution === 'function') {
        const custom = options.getDistribution(piece, state);
        if (custom) {
            distribution = normalizeDistribution(custom);
        }
    }
    if (!distribution) {
        const source = resolveBeliefSource(options);
        const belief = readBelief(source, piece.id);
        distribution = belief
            ? normalizeDistribution(belief)
            : fallbackDistribution(state, piece);
    }
    const knownFlag = (state.playerPieces || []).some(candidate => {
        return candidate.id !== piece.id
            && !candidate.removed
            && knownSearchType(candidate) === FLAG;
    });
    const knownTrap = (state.playerPieces || []).some(candidate => {
        return candidate.id !== piece.id
            && !candidate.removed
            && knownSearchType(candidate) === TRAP;
    });
    if (knownFlag) {
        distribution.flag = 0;
    }
    if (knownTrap) {
        distribution.trap = 0;
    }
    return normalizeDistribution(distribution);
}

function getFlagCandidates(state, options) {
    const active = (state.playerPieces || []).filter(piece => {
        return !piece.removed
            && piece.row >= 0;
    });
    const knownFlag = active.find(piece => knownSearchType(piece) === FLAG);
    if (knownFlag) {
        return [{ piece: knownFlag, probability: 1 }];
    }
    const candidates = [];
    let sum = 0;
    for (const piece of active) {
        if (knownSearchType(piece) !== null) {
            continue;
        }
        const distribution = getPieceDistribution(state, piece, options);
        const probability = distribution.flag || 0;
        candidates.push({ piece, probability });
        sum += probability;
    }
    if (candidates.length === 0) {
        return [];
    }
    if (sum <= 0) {
        const probability = 1 / candidates.length;
        return candidates.map(candidate => ({
            piece: candidate.piece,
            probability
        }));
    }
    return candidates
        .map(candidate => ({
            piece: candidate.piece,
            probability: candidate.probability / sum
        }))
        .sort((left, right) => right.probability - left.probability);
}

function activePieces(pieces) {
    return (pieces || []).filter(piece => {
        return !piece.removed
            && piece.row >= 0;
    });
}

function publicType(piece, inferredFlag) {
    if (inferredFlag
        && piece.id === inferredFlag.id) {
        return FLAG;
    }
    return knownSearchType(piece);
}

function isHopelessPublic(pieces, inferredFlag = null) {
    const alive = activePieces(pieces);
    const mobile = alive.filter(piece => !piece.immobilized);
    if (mobile.length === 1
        && publicType(mobile[0], inferredFlag) === FLAG) {
        return true;
    }
    if (alive.length !== 2) {
        return false;
    }
    const hasFlag = alive.some(piece => {
        return publicType(piece, inferredFlag) === FLAG;
    });
    const hasSpentTrap = alive.some(piece => {
        return publicType(piece, inferredFlag) === TRAP
            && piece.immobilized;
    });
    return hasFlag && hasSpentTrap;
}

function allEnemyTypesKnown(state) {
    return activePieces(state.playerPieces).every(piece => {
        return knownSearchType(piece) !== null;
    });
}

function isMutualStalematePublic(state, inferredEnemyFlag) {
    const onlyFlagsAndTraps = pieces => {
        const alive = activePieces(pieces);
        if (alive.length === 0) {
            return false;
        }
        return alive.every(piece => {
            const inferredFlag = piece.owner === PLAYER
                ? inferredEnemyFlag
                : null;
            const type = publicType(piece, inferredFlag);
            return type === FLAG
                || (type === TRAP
                    && (piece.revealed || piece.immobilized));
        });
    };
    return onlyFlagsAndTraps(state.playerPieces)
        && onlyFlagsAndTraps(state.aiPieces);
}

function getTerminalOutcome(state) {
    if (state.searchOutcome
        && state.searchOutcome.outcome !== 'draw') {
        return state.searchOutcome;
    }
    const myFlag = activePieces(state.aiPieces).find(piece => {
        return knownSearchType(piece) === FLAG;
    });
    if (!myFlag) {
        return { outcome: 'lose', reason: 'own_flag_missing' };
    }
    const enemies = activePieces(state.playerPieces);
    if (enemies.length === 0) {
        return { outcome: 'win', reason: 'enemy_has_no_pieces' };
    }
    const candidates = getFlagCandidates(state);
    if (candidates.length === 0
        && allEnemyTypesKnown(state)) {
        return { outcome: 'win', reason: 'enemy_flag_missing' };
    }
    const inferredEnemyFlagEntry = candidates.find(candidate => {
        return candidate.probability >= 1 - 1e-9;
    });
    const inferredEnemyFlag = inferredEnemyFlagEntry
        ? inferredEnemyFlagEntry.piece
        : null;
    if (isMutualStalematePublic(state, inferredEnemyFlag)) {
        return { outcome: 'draw', reason: 'mutual_stalemate' };
    }
    if (isHopelessPublic(state.playerPieces, inferredEnemyFlag)) {
        return { outcome: 'win', reason: 'enemy_hopeless' };
    }
    if (isHopelessPublic(state.aiPieces)) {
        return { outcome: 'lose', reason: 'own_hopeless' };
    }
    if (state.searchOutcome) {
        return state.searchOutcome;
    }
    const drawLimit = GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT || 20;
    if ((state.movesWithoutCapture || 0) >= drawLimit) {
        return { outcome: 'draw', reason: 'no_captures' };
    }
    return null;
}

function findPiece(state, owner, pieceId) {
    const pieces = owner === COMPUTER ? state.aiPieces : state.playerPieces;
    return pieces.find(piece => piece.id === pieceId) || null;
}

function removeSearchPiece(state, piece) {
    if (!piece) {
        return;
    }
    if (piece.row >= 0
        && piece.col >= 0
        && state.board[piece.row]
        && state.board[piece.row][piece.col]
        && state.board[piece.row][piece.col].id === piece.id) {
        state.board[piece.row][piece.col] = null;
    }
    const pieces = piece.owner === COMPUTER ? state.aiPieces : state.playerPieces;
    const index = pieces.findIndex(candidate => candidate.id === piece.id);
    if (index >= 0) {
        pieces.splice(index, 1);
    }
    piece.removed = true;
    piece.row = -1;
    piece.col = -1;
}

function moveSearchPiece(state, piece, row, col) {
    state.board[piece.row][piece.col] = null;
    piece.row = row;
    piece.col = col;
    state.board[row][col] = piece;
}

function battleResult(attackerType, defenderType) {
    if (attackerType === defenderType) {
        return 'draw';
    }
    return GAME_CONFIG.WIN_CONDITIONS[attackerType] === defenderType
        ? 'win'
        : 'lose';
}

function setOutcome(state, owner, reason) {
    state.searchOutcome = {
        outcome: owner === COMPUTER ? 'win' : 'lose',
        reason
    };
}

function advanceDrawClock(state, captured) {
    state.movesWithoutCapture = captured
        ? 1
        : (state.movesWithoutCapture || 0) + 1;
    const drawLimit = GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT || 20;
    if (state.movesWithoutCapture >= drawLimit
        && !state.searchOutcome) {
        state.searchOutcome = {
            outcome: 'draw',
            reason: 'no_captures'
        };
    }
}

function applyResolvedMove(source, move, tieOutcome) {
    const state = cloneSearchState(source);
    const sourcePiece = move && move.piece ? move.piece : null;
    const pieceId = move && move.pieceId
        ? move.pieceId
        : (sourcePiece ? sourcePiece.id : null);
    const owner = sourcePiece
        ? sourcePiece.owner
        : (move ? move.owner : null);
    const piece = findPiece(state, owner, pieceId);
    if (!piece
        || piece.removed
        || piece.immobilized) {
        return state;
    }
    const target = state.board[move.row] && state.board[move.row][move.col];
    const oldRow = piece.row;
    const oldCol = piece.col;
    if (!target) {
        moveSearchPiece(state, piece, move.row, move.col);
        state.lastMove = {
            from: [oldRow, oldCol],
            to: [move.row, move.col]
        };
        advanceDrawClock(state, false);
        return state;
    }
    if (target.owner === piece.owner) {
        return state;
    }
    piece.revealed = true;
    target.revealed = true;
    const attackerType = exactType(piece);
    const defenderType = exactType(target);
    if (defenderType === FLAG) {
        removeSearchPiece(state, target);
        moveSearchPiece(state, piece, move.row, move.col);
        setOutcome(state, piece.owner, 'flag_captured');
        advanceDrawClock(state, true);
    } else if (attackerType === FLAG) {
        setOutcome(state, target.owner, 'flag_attacked');
        advanceDrawClock(state, false);
    } else if (defenderType === TRAP) {
        removeSearchPiece(state, piece);
        target.immobilized = true;
        advanceDrawClock(state, true);
    } else if (attackerType === TRAP) {
        removeSearchPiece(state, target);
        moveSearchPiece(state, piece, move.row, move.col);
        piece.immobilized = true;
        advanceDrawClock(state, true);
    } else {
        const result = battleResult(attackerType, defenderType);
        if (result === 'win'
            || tieOutcome === 'attacker_win') {
            removeSearchPiece(state, target);
            moveSearchPiece(state, piece, move.row, move.col);
            advanceDrawClock(state, true);
        } else if (result === 'lose'
            || tieOutcome === 'defender_win') {
            removeSearchPiece(state, piece);
            advanceDrawClock(state, true);
        } else if (tieOutcome === 'mutual') {
            removeSearchPiece(state, piece);
            removeSearchPiece(state, target);
            advanceDrawClock(state, true);
        }
    }
    state.lastMove = {
        from: [oldRow, oldCol],
        to: [move.row, move.col]
    };
    return state;
}

function applyHypothesis(state, owner, pieceId, type) {
    const piece = findPiece(state, owner, pieceId);
    if (!piece) {
        return;
    }
    if (type === FLAG
        || type === TRAP) {
        piece.type = type;
        piece.pieceType = null;
    } else {
        piece.type = 'piece';
        piece.pieceType = type;
    }
    piece._searchHypothesis = true;
}

function expandExactMove(state, move, probability, event) {
    const sourcePiece = move.piece;
    const attackerType = exactType(sourcePiece);
    const target = state.board[move.row] && state.board[move.row][move.col];
    const defenderType = exactType(target);
    if (target
        && attackerType
        && defenderType
        && attackerType !== FLAG
        && defenderType !== FLAG
        && attackerType !== TRAP
        && defenderType !== TRAP
        && battleResult(attackerType, defenderType) === 'draw') {
        return [
            {
                state: applyResolvedMove(state, move, 'attacker_win'),
                probability: probability * DEFAULT_TIE_OUTCOMES.attackerWin,
                event: 'tie_attacker_win'
            },
            {
                state: applyResolvedMove(state, move, 'defender_win'),
                probability: probability * DEFAULT_TIE_OUTCOMES.defenderWin,
                event: 'tie_defender_win'
            },
            {
                state: applyResolvedMove(state, move, 'mutual'),
                probability: probability * DEFAULT_TIE_OUTCOMES.mutual,
                event: 'tie_mutual'
            }
        ];
    }
    return [{
        state: applyResolvedMove(state, move, null),
        probability,
        event
    }];
}

function normalizeOutcomes(outcomes) {
    const filtered = outcomes.filter(outcome => {
        return outcome
            && outcome.state
            && Number.isFinite(outcome.probability)
            && outcome.probability > 0;
    });
    const sum = filtered.reduce((total, outcome) => {
        return total + outcome.probability;
    }, 0);
    if (sum <= 0) {
        return [];
    }
    return filtered
        .map(outcome => ({
            ...outcome,
            probability: outcome.probability / sum
        }))
        .sort((left, right) => right.probability - left.probability);
}

function getMoveOutcomes(state, move, options) {
    if (!state
        || !move
        || (!move.piece && !move.pieceId)) {
        return [];
    }
    const sourcePiece = move.piece;
    const owner = sourcePiece ? sourcePiece.owner : move.owner;
    const pieceId = sourcePiece ? sourcePiece.id : move.pieceId;
    const piece = findPiece(state, owner, pieceId);
    if (!piece) {
        return [];
    }
    const target = state.board[move.row] && state.board[move.row][move.col];
    if (!target) {
        return [{
            state: applyResolvedMove(state, move, null),
            probability: 1,
            event: 'quiet'
        }];
    }
    const hiddenPiece = knownSearchType(piece) === null
        ? piece
        : (knownSearchType(target) === null ? target : null);
    if (!hiddenPiece) {
        return normalizeOutcomes(expandExactMove(state, move, 1, 'known_battle'));
    }
    const distribution = getPieceDistribution(state, hiddenPiece, options);
    const outcomes = [];
    for (const type of TYPE_KEYS) {
        const probability = distribution[type] || 0;
        if (probability <= 0) {
            continue;
        }
        const branch = cloneSearchState(state);
        applyHypothesis(branch, hiddenPiece.owner, hiddenPiece.id, type);
        const branchPiece = findPiece(branch, owner, pieceId);
        const branchMove = {
            piece: branchPiece,
            row: move.row,
            col: move.col
        };
        const expanded = expandExactMove(
            branch,
            branchMove,
            probability,
            `hidden_${type}`
        );
        outcomes.push(...expanded);
    }
    return normalizeOutcomes(outcomes);
}

function evaluateMoveOutcomes(state, move, evaluator, options) {
    if (typeof evaluator !== 'function') {
        throw new TypeError('evaluateMoveOutcomes requires an evaluator function');
    }
    const outcomes = getMoveOutcomes(state, move, options);
    if (outcomes.length === 0) {
        return evaluator(cloneSearchState(state), null);
    }
    const scores = [];
    let mean = 0;
    for (const outcome of outcomes) {
        const score = Number(evaluator(outcome.state, outcome));
        const safeScore = Number.isFinite(score) ? score : 0;
        scores.push(safeScore);
        mean += outcome.probability * safeScore;
    }
    const aggregation = options && options.aggregation
        ? options.aggregation
        : 'mean';
    if (aggregation === 'worst') {
        return Math.min(...scores);
    }
    if (aggregation === 'best') {
        return Math.max(...scores);
    }
    const riskAversion = options
        && Number.isFinite(options.riskAversion)
        ? Math.max(0, Math.min(1, options.riskAversion))
        : 0;
    if (riskAversion <= 0) {
        return mean;
    }
    const worst = Math.min(...scores);
    return mean * (1 - riskAversion)
        + worst * riskAversion;
}

function generateSearchMoves(state, owner) {
    const pieces = owner === COMPUTER ? state.aiPieces : state.playerPieces;
    const moves = [];
    for (const piece of pieces || []) {
        if (piece.removed
            || piece.immobilized
            || piece.row < 0
            || piece.col < 0) {
            continue;
        }
        const type = knownSearchType(piece);
        if (type === FLAG
            && piece.revealed) {
            continue;
        }
        for (const direction of GAME_CONFIG.DIRECTIONS) {
            const row = piece.row + direction[0];
            const col = piece.col + direction[1];
            if (row < 0
                || row >= BOARD_HEIGHT
                || col < 0
                || col >= BOARD_WIDTH) {
                continue;
            }
            const target = state.board[row][col];
            if (target
                && target.owner === owner) {
                continue;
            }
            if (type === FLAG
                && target) {
                continue;
            }
            moves.push({ piece, row, col });
        }
    }
    return moves;
}

function hashSeed(value) {
    const text = String(value == null ? '0' : value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededRandom(seed) {
    let value = hashSeed(seed);
    return () => {
        value += 0x6D2B79F5;
        let mixed = value;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed
            + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function weightedPick(entries, weightOf, random) {
    if (entries.length === 0) {
        return null;
    }
    let total = 0;
    for (const entry of entries) {
        total += Math.max(0, weightOf(entry));
    }
    if (total <= 0) {
        return entries[Math.floor(random() * entries.length)];
    }
    let roll = random() * total;
    for (const entry of entries) {
        roll -= Math.max(0, weightOf(entry));
        if (roll <= 0) {
            return entry;
        }
    }
    return entries[entries.length - 1];
}

function determinizeWorld(source, options) {
    const state = cloneSearchState(source);
    const seed = options && options.seed != null
        ? options.seed
        : `${state.movesWithoutCapture || 0}|${activePieces(state.playerPieces).length}`;
    const random = seededRandom(seed);
    const hidden = activePieces(state.playerPieces).filter(piece => {
        return !piece.revealed
            && !piece._searchHypothesis;
    });
    const hasKnownFlag = activePieces(state.playerPieces).some(piece => {
        return knownSearchType(piece) === FLAG;
    });
    const hasKnownTrap = activePieces(state.playerPieces).some(piece => {
        return knownSearchType(piece) === TRAP;
    });
    const excluded = new Set();
    if (!hasKnownFlag) {
        const flagPiece = weightedPick(
            hidden,
            piece => getPieceDistribution(state, piece, options).flag,
            random
        );
        if (flagPiece) {
            applyHypothesis(state, flagPiece.owner, flagPiece.id, FLAG);
            excluded.add(flagPiece.id);
        }
    }
    if (!hasKnownTrap) {
        const trapPool = hidden.filter(piece => !excluded.has(piece.id));
        const trapPiece = weightedPick(
            trapPool,
            piece => getPieceDistribution(state, piece, options).trap,
            random
        );
        if (trapPiece) {
            applyHypothesis(state, trapPiece.owner, trapPiece.id, TRAP);
            excluded.add(trapPiece.id);
        }
    }
    for (const piece of hidden) {
        if (excluded.has(piece.id)) {
            continue;
        }
        const distribution = getPieceDistribution(source, piece, options);
        const type = weightedPick(
            RPS_TYPES,
            candidate => distribution[candidate],
            random
        ) || RPS_TYPES[Math.floor(random() * RPS_TYPES.length)];
        applyHypothesis(state, piece.owner, piece.id, type);
    }
    state.searchDeterminized = true;
    state.searchSeed = hashSeed(seed);
    return state;
}

function flagSafety(flag, state) {
    if (!flag) {
        return 0;
    }
    const enemies = flag.owner === COMPUTER
        ? activePieces(state.playerPieces)
        : activePieces(state.aiPieces);
    const allies = flag.owner === COMPUTER
        ? activePieces(state.aiPieces)
        : activePieces(state.playerPieces);
    let safety = 0;
    let nearest = Infinity;
    for (const enemy of enemies) {
        const distance = Math.max(
            Math.abs(enemy.row - flag.row),
            Math.abs(enemy.col - flag.col)
        );
        nearest = Math.min(nearest, distance);
    }
    if (Number.isFinite(nearest)) {
        safety += nearest * 12;
    }
    for (const ally of allies) {
        if (ally.id === flag.id
            || ally.immobilized) {
            continue;
        }
        const distance = Math.max(
            Math.abs(ally.row - flag.row),
            Math.abs(ally.col - flag.col)
        );
        if (distance <= 2) {
            safety += 25;
        }
    }
    return safety;
}

function evaluateSearchPosition(state, options) {
    const terminal = getTerminalOutcome(state);
    const flagScore = GAME_CONFIG.SCORING.FLAG_CAPTURE || 10000;
    if (terminal) {
        if (terminal.outcome === 'win') {
            return flagScore;
        }
        if (terminal.outcome === 'lose') {
            return -flagScore;
        }
        return 0;
    }
    const aiAlive = activePieces(state.aiPieces);
    const enemyAlive = activePieces(state.playerPieces);
    let score = (aiAlive.length - enemyAlive.length) * 100;
    const myFlag = aiAlive.find(piece => knownSearchType(piece) === FLAG);
    score += flagSafety(myFlag, state) * 80;
    const candidates = getFlagCandidates(state, options);
    let expectedEnemySafety = 0;
    for (const candidate of candidates) {
        expectedEnemySafety += candidate.probability
            * flagSafety(candidate.piece, state);
    }
    score -= expectedEnemySafety * 40;
    return score;
}

const aiSearch = {
    cloneSearchState,
    knownSearchType,
    getPieceDistribution,
    getFlagCandidates,
    getTerminalOutcome,
    getMoveOutcomes,
    evaluateMoveOutcomes,
    generateSearchMoves,
    determinizeWorld,
    evaluateSearchPosition
};

const globalObject = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : global);
globalObject.aiSearch = aiSearch;

export default aiSearch;
export {
    cloneSearchState,
    determinizeWorld,
    evaluateMoveOutcomes,
    evaluateSearchPosition,
    generateSearchMoves,
    getFlagCandidates,
    getMoveOutcomes,
    getPieceDistribution,
    getTerminalOutcome,
    knownSearchType
};
