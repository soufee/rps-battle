/**
 * GPT 5.5 — OpenAI Sentinel
 *
 * Author: GPT 5.5 (OpenAI)
 *
 * Concept: A layered imperfect-information engine that combines hard tactical
 * obligations, Bayesian range evaluation, flag-safety paranoia, and a compact
 * strategic search over all legal moves. The bot plays for survivability first,
 * then converts information into pressure against likely flag locations.
 *
 * "This bot demonstrates what GPT 5.5 can achieve in algorithmic design for
 * imperfect-information tactical games. Named in honor of its creator."
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
    console.error('[medvezhonok] bot-api.js must be loaded BEFORE this bot');
}

const medvezhonokBot = (() => {
    'use strict';

    const FLAG = 'flag';
    const TRAP = 'trap';
    const PIECE = 'piece';
    const PLAYER = 'player';
    const COMPUTER = 'computer';
    const TYPES = ['rock', 'paper', 'scissors'];
    const WIN = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const SCORE = {
        FLAG_CAPTURE: 1000000,
        FLAG_LOSS_RISK: 45000,
        CERTAIN_KILL: 2400,
        HIDDEN_ATTACK: 900,
        FLAG_PRESSURE: 1400,
        FLAG_SAFETY: 1800,
        DEFENDER: 360,
        COHESION: 105,
        CENTER: 44,
        MOBILITY: 26,
        ADVANCE: 34,
        SHUTTLE: 210,
        TRAP_DANGER: 3800
    };

    const memory = {
        turn: 0,
        enemy: new Map(),
        ownMoves: []
    };

    function hasMethod(obj, name) {
        return !!(obj && typeof obj[name] === 'function');
    }

    function cheb(a, b) {
        return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    }

    function inBounds(row, col) {
        return row >= 0
            && row < 6
            && col >= 0
            && col < 8;
    }

    function activePieces(pieces) {
        if (!Array.isArray(pieces)) {
            return [];
        }
        return pieces.filter(piece =>
            piece
            && !piece.removed
            && !piece.immobilized
            && piece.row >= 0
            && piece.col >= 0
        );
    }

    function myFlag(gameState) {
        return (gameState.aiPieces || []).find(piece =>
            piece.type === FLAG
            && !piece.removed
        ) || null;
    }

    function targetAt(gameState, row, col) {
        if (!gameState.board || !gameState.board[row]) {
            return null;
        }
        return gameState.board[row][col] || null;
    }

    function resolve(typeA, typeB) {
        if (typeof RPSBotAPI !== 'undefined'
            && hasMethod(RPSBotAPI, 'resolveBattle')) {
            return RPSBotAPI.resolveBattle(typeA, typeB);
        }
        if (!typeA
            || !typeB) {
            return 'draw';
        }
        if (typeA === typeB) {
            return 'draw';
        }
        return WIN[typeA] === typeB ? 'win' : 'lose';
    }

    function counterType(type) {
        if (type === 'rock') {
            return 'paper';
        }
        if (type === 'paper') {
            return 'scissors';
        }
        if (type === 'scissors') {
            return 'rock';
        }
        return null;
    }

    function legalMoves(piece, gameState) {
        if (typeof RPSBotAPI !== 'undefined'
            && hasMethod(RPSBotAPI, 'getLegalMoves')) {
            return RPSBotAPI.getLegalMoves(piece, gameState);
        }
        const moves = [];
        for (let dr = -1; dr <= 1; dr += 1) {
            for (let dc = -1; dc <= 1; dc += 1) {
                if (dr === 0 && dc === 0) {
                    continue;
                }
                const row = piece.row + dr;
                const col = piece.col + dc;
                if (!inBounds(row, col)) {
                    continue;
                }
                const target = targetAt(gameState, row, col);
                if (!target || target.owner !== piece.owner) {
                    moves.push({ row, col });
                }
            }
        }
        return moves;
    }

    function validateMove(gameState, move) {
        if (!move
            || !move.piece
            || !inBounds(move.row, move.col)) {
            return false;
        }
        const piece = move.piece;
        if (piece.removed
            || piece.immobilized
            || piece.row < 0) {
            return false;
        }
        const dr = Math.abs(move.row - piece.row);
        const dc = Math.abs(move.col - piece.col);
        if (dr > 1
            || dc > 1
            || dr + dc === 0) {
            return false;
        }
        const target = targetAt(gameState, move.row, move.col);
        if (target && target.owner === piece.owner) {
            return false;
        }
        if (!target) {
            return true;
        }
        if (piece.type === FLAG) {
            return false;
        }
        if (target.revealed && target.type === TRAP) {
            return false;
        }
        if (target.revealed
            && target.type === PIECE
            && piece.type === PIECE
            && resolve(piece.pieceType, target.pieceType) === 'lose') {
            return false;
        }
        return true;
    }

    function recordOwnMove(move) {
        memory.ownMoves.push({
            pieceId: move.piece.id,
            fromRow: move.piece.row,
            fromCol: move.piece.col,
            row: move.row,
            col: move.col,
            turn: memory.turn
        });
        if (memory.ownMoves.length > 28) {
            memory.ownMoves.shift();
        }
    }

    function syncEnemyMemory(gameState) {
        const seen = new Set();
        for (const enemy of gameState.playerPieces || []) {
            if (!enemy
                || enemy.removed
                || enemy.row < 0) {
                continue;
            }
            const prev = memory.enemy.get(enemy.id);
            const moved = !!(prev
                && (prev.row !== enemy.row || prev.col !== enemy.col));
            const stillness = prev && !moved ? prev.stillness + 1 : 0;
            seen.add(enemy.id);
            memory.enemy.set(enemy.id, {
                row: enemy.row,
                col: enemy.col,
                stillness,
                movedEver: moved || !!(prev && prev.movedEver),
                revealed: !!enemy.revealed,
                type: enemy.type,
                pieceType: enemy.pieceType || null
            });
        }
        for (const id of memory.enemy.keys()) {
            if (!seen.has(id)) {
                memory.enemy.delete(id);
            }
        }
    }

    function updateSharedSystems(gameState) {
        if (typeof aiEngine !== 'undefined' && aiEngine) {
            if (aiEngine.positionCache && hasMethod(aiEngine.positionCache, 'clear')) {
                aiEngine.positionCache.clear();
            }
            if (hasMethod(aiEngine, 'analyzePlayerPattern')) {
                aiEngine.analyzePlayerPattern(gameState);
            }
            if (hasMethod(aiEngine, 'trackEnemyStillness')) {
                aiEngine.trackEnemyStillness(gameState);
            }
            if (hasMethod(aiEngine, 'updateStrategicTargets')) {
                aiEngine.updateStrategicTargets(gameState);
            }
        }
        if (typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && hasMethod(aiBeliefs, 'applyConstraints')) {
            aiBeliefs.applyConstraints(gameState);
        }
    }

    function beliefFor(piece) {
        if (!piece) {
            return { rock: 0.3, paper: 0.3, scissors: 0.3, flag: 0.05, trap: 0.05 };
        }
        if (piece.revealed) {
            if (piece.type === FLAG) {
                return { rock: 0, paper: 0, scissors: 0, flag: 1, trap: 0 };
            }
            if (piece.type === TRAP) {
                return { rock: 0, paper: 0, scissors: 0, flag: 0, trap: 1 };
            }
            return {
                rock: piece.pieceType === 'rock' ? 1 : 0,
                paper: piece.pieceType === 'paper' ? 1 : 0,
                scissors: piece.pieceType === 'scissors' ? 1 : 0,
                flag: 0,
                trap: 0
            };
        }
        if (typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && hasMethod(aiBeliefs, 'getProbDistribution')) {
            const dist = aiBeliefs.getProbDistribution(piece.id);
            if (dist) {
                return {
                    rock: dist.rock || 0,
                    paper: dist.paper || 0,
                    scissors: dist.scissors || 0,
                    flag: dist.flag || 0,
                    trap: dist.trap || 0
                };
            }
        }
        const remembered = memory.enemy.get(piece.id);
        const stillness = remembered ? Math.min(remembered.stillness, 8) : 0;
        const backRow = piece.row >= 5 ? 0.08 : 0.025;
        const pFlag = remembered && remembered.movedEver ? 0.015 : backRow + stillness * 0.018;
        const pTrap = remembered && remembered.movedEver ? 0.015 : backRow + stillness * 0.012;
        const rps = Math.max(0.05, 1 - pFlag - pTrap) / 3;
        return { rock: rps, paper: rps, scissors: rps, flag: pFlag, trap: pTrap };
    }

    function flagCandidates(gameState, topN) {
        if (typeof aiBeliefs !== 'undefined'
            && aiBeliefs
            && hasMethod(aiBeliefs, 'getFlagCandidates')) {
            const candidates = aiBeliefs.getFlagCandidates(gameState, topN);
            if (Array.isArray(candidates) && candidates.length > 0) {
                return candidates.map(item => ({
                    piece: item.piece,
                    prob: item.pFlag || 0
                }));
            }
        }
        const candidates = [];
        for (const enemy of gameState.playerPieces || []) {
            if (!enemy
                || enemy.removed
                || enemy.row < 0
                || enemy.revealed && enemy.type !== FLAG) {
                continue;
            }
            const belief = beliefFor(enemy);
            candidates.push({ piece: enemy, prob: belief.flag });
        }
        candidates.sort((a, b) => b.prob - a.prob);
        return candidates.slice(0, topN || 4);
    }

    function deducer(gameState) {
        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && aiTacticalCore.deducers
            && hasMethod(aiTacticalCore.deducers, 'simple')) {
            return aiTacticalCore.deducers.simple(gameState);
        }
        const candidates = flagCandidates(gameState, 4);
        const hiddenCount = (gameState.playerPieces || []).filter(piece =>
            piece
            && !piece.removed
            && piece.row >= 0
            && !piece.revealed
        ).length;
        return { candidates, hiddenCount };
    }

    function safeToLeave(gameState, piece) {
        if (typeof aiTacticalCore !== 'undefined'
            && aiTacticalCore
            && hasMethod(aiTacticalCore, 'safeToLeave')) {
            return aiTacticalCore.safeToLeave(gameState, piece);
        }
        const flag = myFlag(gameState);
        if (!flag || !piece) {
            return true;
        }
        return cheb(piece, flag) > 1;
    }

    function getAvailablePieces(gameState) {
        if (typeof aiEngine !== 'undefined'
            && aiEngine
            && hasMethod(aiEngine, 'getActivePieces')) {
            return aiEngine.getActivePieces(gameState);
        }
        return activePieces(gameState.aiPieces);
    }

    function collectCandidates(gameState, availablePieces) {
        const unique = new Map();
        const push = (move, source) => {
            if (!validateMove(gameState, move)) {
                return;
            }
            const key = `${move.piece.id}:${move.row}:${move.col}`;
            if (!unique.has(key)) {
                unique.set(key, { move, source });
            }
        };

        if (typeof aiEngine !== 'undefined' && aiEngine) {
            pushFromEngine(gameState, availablePieces, push);
        }
        if (typeof aiExpert !== 'undefined'
            && aiExpert
            && hasMethod(aiExpert, 'move')) {
            push(aiExpert.move(gameState), 'expert');
        }
        for (const piece of availablePieces) {
            const moves = legalMoves(piece, gameState);
            for (const dest of moves) {
                push({ piece, row: dest.row, col: dest.col }, 'legal');
            }
        }
        return Array.from(unique.values());
    }

    function pushFromEngine(gameState, availablePieces, push) {
        const sources = [
            ['findFlagCaptureMoves', 'flag-capture'],
            ['findFlagDefenseMoves', 'flag-defense'],
            ['findGuaranteedKills', 'guaranteed-kill'],
            ['findSafeMoves', 'safe'],
            ['getAllFilteredMoves', 'filtered']
        ];
        for (const [method, source] of sources) {
            if (!hasMethod(aiEngine, method)) {
                continue;
            }
            const moves = aiEngine[method](gameState, availablePieces);
            if (!Array.isArray(moves)) {
                continue;
            }
            for (const move of moves) {
                push(move, source);
            }
        }
    }

    function scoreCandidate(gameState, entry) {
        const move = entry.move;
        const target = targetAt(gameState, move.row, move.col);
        let score = sourceBonus(entry.source);
        score += attackScore(move.piece, target);
        score += flagSafetyScore(gameState, move);
        score += flagPressureScore(gameState, move);
        score += positionalScore(gameState, move);
        score += supportScore(gameState, move);
        score -= shuttlePenalty(move);
        score -= exposurePenalty(gameState, move);
        return score;
    }

    function sourceBonus(source) {
        if (source === 'flag-capture') {
            return SCORE.FLAG_CAPTURE;
        }
        if (source === 'flag-defense') {
            return 9000;
        }
        if (source === 'guaranteed-kill') {
            return 3600;
        }
        if (source === 'expert') {
            return 210;
        }
        if (source === 'safe') {
            return 120;
        }
        return 0;
    }

    function attackScore(piece, target) {
        if (!target) {
            return 0;
        }
        if (target.type === FLAG) {
            return SCORE.FLAG_CAPTURE;
        }
        if (target.revealed && target.type === PIECE && piece.type === PIECE) {
            const outcome = resolve(piece.pieceType, target.pieceType);
            if (outcome === 'win') {
                return SCORE.CERTAIN_KILL;
            }
            if (outcome === 'draw') {
                return 220;
            }
            return -SCORE.TRAP_DANGER;
        }
        if (piece.type === TRAP) {
            return 900;
        }
        if (piece.type !== PIECE) {
            return -1000;
        }
        return hiddenAttackEV(piece, target);
    }

    function hiddenAttackEV(piece, target) {
        const belief = beliefFor(target);
        let ev = belief.flag * 7200;
        ev -= belief.trap * 4200;
        for (const type of TYPES) {
            const result = resolve(piece.pieceType, type);
            if (result === 'win') {
                ev += belief[type] * 1150;
            } else if (result === 'lose') {
                ev -= belief[type] * 1350;
            } else {
                ev += belief[type] * 70;
            }
        }
        return ev + SCORE.HIDDEN_ATTACK * Math.max(0, belief.flag - belief.trap);
    }

    function flagSafetyScore(gameState, move) {
        const flag = myFlag(gameState);
        if (!flag) {
            return -SCORE.FLAG_LOSS_RISK;
        }
        let score = 0;
        const before = flagDanger(gameState, flag.row, flag.col, move.piece.id, null);
        const afterRow = move.piece.type === FLAG ? move.row : flag.row;
        const afterCol = move.piece.type === FLAG ? move.col : flag.col;
        const after = flagDanger(gameState, afterRow, afterCol, move.piece.id, move);
        score += (before - after) * SCORE.FLAG_SAFETY;
        if (cheb(move.piece, flag) <= 1 && move.piece.type !== FLAG) {
            score += safeToLeave(gameState, move.piece) ? 0 : -1200;
        }
        if (move.piece.type !== FLAG && cheb({ row: move.row, col: move.col }, flag) <= 1) {
            score += SCORE.DEFENDER;
        }
        return score;
    }

    function flagDanger(gameState, row, col, movingId, move) {
        let danger = 0;
        for (const enemy of gameState.playerPieces || []) {
            if (!enemy
                || enemy.removed
                || enemy.immobilized
                || enemy.row < 0
                || enemy.type === FLAG) {
                continue;
            }
            const dist = Math.max(Math.abs(enemy.row - row), Math.abs(enemy.col - col));
            if (dist > 3) {
                continue;
            }
            const belief = beliefFor(enemy);
            const revealedThreat = enemy.revealed && enemy.type !== TRAP ? 1.25 : 0.65;
            danger += revealedThreat * (4 - dist) * (1 - Math.min(0.85, belief.flag));
        }
        if (move && move.piece.id === movingId && move.piece.type === FLAG) {
            const target = targetAt(gameState, move.row, move.col);
            if (target) {
                danger += 100;
            }
        }
        return danger;
    }

    function flagPressureScore(gameState, move) {
        const candidates = flagCandidates(gameState, 4);
        let score = 0;
        for (const candidate of candidates) {
            const target = candidate.piece;
            const prob = candidate.prob;
            if (!target || prob <= 0) {
                continue;
            }
            const before = cheb(move.piece, target);
            const after = cheb({ row: move.row, col: move.col }, target);
            score += (before - after) * prob * SCORE.FLAG_PRESSURE;
            if (after === 0) {
                score += prob * SCORE.FLAG_CAPTURE;
            }
            if (after <= 1 && move.piece.type !== FLAG && move.piece.type !== TRAP) {
                score += prob * 520;
            }
        }
        return score;
    }

    function positionalScore(gameState, move) {
        const center = 3.5 - Math.abs(move.col - 3.5);
        let score = center * SCORE.CENTER;
        score += move.row * SCORE.ADVANCE;
        if (move.piece.type === FLAG) {
            score -= move.row * 90;
        }
        const mobility = legalMoves({ ...move.piece, row: move.row, col: move.col }, gameState).length;
        score += mobility * SCORE.MOBILITY;
        return score;
    }

    function supportScore(gameState, move) {
        let allies = 0;
        let crowd = 0;
        const pos = { row: move.row, col: move.col };
        for (const ally of gameState.aiPieces || []) {
            if (!ally
                || ally.removed
                || ally.id === move.piece.id
                || ally.row < 0) {
                continue;
            }
            const dist = cheb(pos, ally);
            if (dist <= 1) {
                allies += 1;
            }
            if (dist === 0) {
                crowd += 1;
            }
        }
        return allies * SCORE.COHESION - crowd * 500;
    }

    function shuttlePenalty(move) {
        let penalty = 0;
        const recent = memory.ownMoves.slice(-6);
        for (const item of recent) {
            if (item.pieceId !== move.piece.id) {
                continue;
            }
            if (item.fromRow === move.row && item.fromCol === move.col) {
                penalty += SCORE.SHUTTLE;
            }
            if (item.row === move.row && item.col === move.col) {
                penalty += 70;
            }
        }
        return penalty;
    }

    function exposurePenalty(gameState, move) {
        if (move.piece.type !== PIECE) {
            return 0;
        }
        let penalty = 0;
        const movedPos = { row: move.row, col: move.col };
        for (const enemy of gameState.playerPieces || []) {
            if (!enemy
                || enemy.removed
                || !enemy.revealed
                || enemy.type !== PIECE) {
                continue;
            }
            if (cheb(movedPos, enemy) > 1) {
                continue;
            }
            const enemyCounter = counterType(move.piece.pieceType);
            if (enemy.pieceType === enemyCounter) {
                penalty += 780;
            }
        }
        return penalty;
    }

    function pickBest(gameState, candidates) {
        let best = null;
        let bestScore = -Infinity;
        for (const entry of candidates) {
            const score = scoreCandidate(gameState, entry);
            if (score > bestScore) {
                best = entry.move;
                bestScore = score;
            }
        }
        return best;
    }

    function fallbackMove(gameState, availablePieces) {
        let best = null;
        let bestScore = -Infinity;
        for (const piece of availablePieces) {
            const moves = legalMoves(piece, gameState);
            for (const dest of moves) {
                const move = { piece, row: dest.row, col: dest.col };
                if (!validateMove(gameState, move)) {
                    continue;
                }
                const score = positionalScore(gameState, move)
                    + flagSafetyScore(gameState, move);
                if (score > bestScore) {
                    best = move;
                    bestScore = score;
                }
            }
        }
        return best;
    }

    function finishMove(move) {
        if (!move) {
            return null;
        }
        recordOwnMove(move);
        if (typeof aiEngine !== 'undefined'
            && aiEngine
            && hasMethod(aiEngine, 'recordAIMove')) {
            aiEngine.recordAIMove(move);
        }
        return move;
    }

    function chooseFlagAndTrap() {
        const templates = [
            { flagIndex: 0, trapIndex: 9 },
            { flagIndex: 7, trapIndex: 14 },
            { flagIndex: 1, trapIndex: 8 },
            { flagIndex: 6, trapIndex: 15 },
            { flagIndex: 2, trapIndex: 10 },
            { flagIndex: 5, trapIndex: 13 }
        ];
        const index = Math.floor(Math.random() * templates.length);
        return templates[index];
    }

    return {
        id: 'medvezhonok',
        name: 'Медвежонок',
        emoji: '🧠',
        avatar: 'js/bots/medvezhonok/avatar-min.png',
        shortDescription: 'Тактическое ядро, байес и давление на флаг',
        longDescription: 'Тактика, байес-атаки, антишаттл. Давит на вероятный флаг, свой бережёт.',
        algorithmLabel: 'Тактическое ядро + байесовский EV-поиск',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['openai', 'bayesian', 'tactical', 'flag-pressure'],

        move(gameState) {
            try {
                memory.turn += 1;
                syncEnemyMemory(gameState);
                updateSharedSystems(gameState);
                const availablePieces = getAvailablePieces(gameState);
                if (availablePieces.length === 0) {
                    return null;
                }
                if (typeof aiTacticalCore !== 'undefined'
                    && aiTacticalCore
                    && hasMethod(aiTacticalCore, 'getMandatoryMove')) {
                    const mandatory = aiTacticalCore.getMandatoryMove(gameState, {
                        deducer,
                        flagHuntHorizon: 5,
                        antiCluster: true
                    });
                    if (validateMove(gameState, mandatory)) {
                        return finishMove(mandatory);
                    }
                }
                const candidates = collectCandidates(gameState, availablePieces);
                if (candidates.length > 0) {
                    const best = pickBest(gameState, candidates);
                    if (best) {
                        return finishMove(best);
                    }
                }
                return finishMove(fallbackMove(gameState, availablePieces));
            } catch (error) {
                console.error('[medvezhonok] move() failed:', error);
                return null;
            }
        },

        chooseFlagAndTrap
    };
})();

if (typeof RPSBotAPI !== 'undefined' && RPSBotAPI.defineBot) {
    RPSBotAPI.defineBot(medvezhonokBot);
} else {
    throw new Error('[medvezhonok] RPSBotAPI is required');
}
