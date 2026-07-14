/**
 * Kapibarysh is a fair strategy bot for an imperfect-information RPS game.
 * It uses only the public BotView and never observes hidden opponent types.
 */

if (typeof RPSBotAPI === 'undefined'
    || !RPSBotAPI
    || !RPSBotAPI.RULES) {
    throw new Error('[kapibarysh] RPSBotAPI must be loaded first');
}

const kapibaryshBot = (() => {
    'use strict';

    const API = RPSBotAPI;
    const RULES = API.RULES;
    const WIDTH = RULES.BOARD.WIDTH;
    const HEIGHT = RULES.BOARD.HEIGHT;
    const FLAG = RULES.SPECIAL_TYPES.FLAG;
    const TRAP = RULES.SPECIAL_TYPES.TRAP;
    const TYPES = RULES.PIECE_TYPES;
    const BEATS = RULES.WIN_CONDITIONS;
    const COUNTER = { rock: 'paper', paper: 'scissors', scissors: 'rock' };
    const contexts = new Map();
    let setupSeed = 0;

    function active(piece) {
        return !!piece
            && !piece.removed
            && piece.row >= 0
            && piece.col >= 0;
    }

    function distance(aRow, aCol, bRow, bCol) {
        return Math.max(Math.abs(aRow - bRow), Math.abs(aCol - bCol));
    }

    function key(row, col) {
        return `${row}:${col}`;
    }

    function ownType(piece) {
        if (!piece) {
            return null;
        }
        return piece.type === 'piece' ? piece.pieceType : piece.type;
    }

    function random(context) {
        context.seed ^= context.seed << 13;
        context.seed ^= context.seed >>> 17;
        context.seed ^= context.seed << 5;
        return (context.seed >>> 0) / 4294967296;
    }

    function pieceSnapshot(pieces) {
        const snapshot = new Map();
        for (const piece of pieces || []) {
            if (active(piece)) {
                snapshot.set(piece.id, {
                    row: piece.row,
                    col: piece.col,
                    revealed: !!piece.revealed,
                    type: piece.type,
                    pieceType: piece.pieceType
                });
            }
        }
        return snapshot;
    }

    function newBelief(piece) {
        const backRank = piece.row >= HEIGHT - 2;
        const edge = piece.col === 0 || piece.col === WIDTH - 1;
        return {
            weights: {
                flag: (backRank ? 1.8 : 1) * (edge ? 1.25 : 1),
                trap: backRank ? 1.2 : 0.9,
                rock: 4.7,
                paper: 4.7,
                scissors: 4.7
            },
            probs: {},
            still: 0,
            moves: 0
        };
    }

    function contextKey(state) {
        const piece = (state.aiPieces || []).find(active);
        if (!piece) {
            return 'kapibarysh';
        }
        return piece.id.startsWith('ai_') ? 'top' : 'bottom';
    }

    function fresh(state, context) {
        const own = (state.aiPieces || []).filter(active);
        const enemy = (state.playerPieces || []).filter(active);
        return context.turn > 2
            && own.length === 16
            && enemy.length === 16
            && own.every((piece) => piece.row <= 1)
            && enemy.every((piece) => piece.row >= 4);
    }

    function getContext(state) {
        const id = contextKey(state);
        let context = contexts.get(id);
        if (!context || fresh(state, context)) {
            context = {
                seed: (Date.now() ^ (id === 'top' ? 0x41c64e6d : 0x9e3779b9)) >>> 0,
                turn: 0,
                beliefs: new Map(),
                previousEnemy: new Map(),
                moves: [],
                opponent: { aggression: 0.35, retreat: 0.25, pressure: 0.25 },
                tieChoices: [],
                tieSeen: new Set()
            };
            contexts.set(id, context);
        }
        return context;
    }

    function scale(belief, type, factor) {
        belief.weights[type] = Math.max(
            0.00001,
            Math.min(100000, belief.weights[type] * factor)
        );
    }

    function normalize(state, context) {
        const hidden = [];
        let knownFlag = false;
        let knownTrap = false;
        for (const enemy of state.playerPieces || []) {
            if (!active(enemy)) {
                continue;
            }
            let belief = context.beliefs.get(enemy.id);
            if (!belief) {
                belief = newBelief(enemy);
                context.beliefs.set(enemy.id, belief);
            }
            if (enemy.revealed) {
                const type = ownType(enemy);
                for (const candidate of [FLAG, TRAP, ...TYPES]) {
                    belief.probs[candidate] = candidate === type ? 1 : 0;
                }
                knownFlag = knownFlag || type === FLAG;
                knownTrap = knownTrap || type === TRAP;
            } else {
                hidden.push({ piece: enemy, belief });
            }
        }

        const flagTotal = hidden.reduce((sum, entry) => sum + entry.belief.weights.flag, 0);
        for (const entry of hidden) {
            entry.belief.probs.flag = knownFlag ? 0 : entry.belief.weights.flag / flagTotal;
        }
        const trapTotal = hidden.reduce((sum, entry) => {
            return sum
                + entry.belief.weights.trap * (1 - entry.belief.probs.flag);
        }, 0);
        for (const entry of hidden) {
            const trapWeight = entry.belief.weights.trap * (1 - entry.belief.probs.flag);
            entry.belief.probs.trap = knownTrap ? 0 : trapWeight / trapTotal;
            const remaining = 1 - entry.belief.probs.flag - entry.belief.probs.trap;
            const rpsTotal = TYPES.reduce((sum, type) => sum + entry.belief.weights[type], 0);
            for (const type of TYPES) {
                entry.belief.probs[type] = remaining * entry.belief.weights[type] / rpsTotal;
            }
        }
    }

    function observe(state, context) {
        const flag = myFlag(state);
        for (const enemy of state.playerPieces || []) {
            if (!active(enemy)) {
                continue;
            }
            let belief = context.beliefs.get(enemy.id);
            if (!belief) {
                belief = newBelief(enemy);
                context.beliefs.set(enemy.id, belief);
            }
            const before = context.previousEnemy.get(enemy.id);
            if (!before) {
                continue;
            }
            const moved = before.row !== enemy.row || before.col !== enemy.col;
            if (!moved) {
                belief.still += 1;
                if (belief.still <= 10) {
                    scale(belief, FLAG, 1.08);
                    scale(belief, TRAP, 1.04);
                }
                continue;
            }
            belief.still = 0;
            belief.moves += 1;
            scale(belief, FLAG, 0.6);
            if (enemy.row < before.row) {
                context.opponent.aggression = context.opponent.aggression * 0.8 + 0.2;
            } else if (enemy.row > before.row) {
                context.opponent.retreat = context.opponent.retreat * 0.8 + 0.2;
                scale(belief, FLAG, 1.12);
            }

            const visible = nearestRevealedOwn(state, before.row, before.col);
            if (visible && visible.distance <= 2) {
                const newDistance = distance(enemy.row, enemy.col, visible.piece.row, visible.piece.col);
                const loseToOwn = BEATS[visible.piece.pieceType];
                const beatOwn = COUNTER[visible.piece.pieceType];
                if (newDistance > visible.distance) {
                    scale(belief, loseToOwn, 1.9);
                    scale(belief, beatOwn, 0.72);
                    scale(belief, FLAG, 1.12);
                } else if (newDistance < visible.distance) {
                    scale(belief, beatOwn, 1.4);
                    scale(belief, loseToOwn, 0.82);
                }
            }
            if (flag) {
                const oldDistance = distance(before.row, before.col, flag.row, flag.col);
                const newDistance = distance(enemy.row, enemy.col, flag.row, flag.col);
                if (newDistance < oldDistance) {
                    context.opponent.pressure = context.opponent.pressure * 0.75 + 0.25;
                }
            }
        }
        normalize(state, context);
        context.previousEnemy = pieceSnapshot(state.playerPieces);
    }

    function myFlag(state) {
        return (state.aiPieces || []).find((piece) => active(piece) && piece.type === FLAG) || null;
    }

    function nearestRevealedOwn(state, row, col) {
        let best = null;
        for (const piece of state.aiPieces || []) {
            if (!active(piece)
                || !piece.revealed
                || piece.type !== 'piece'
                || !piece.pieceType) {
                continue;
            }
            const d = distance(row, col, piece.row, piece.col);
            if (!best || d < best.distance) {
                best = { piece, distance: d };
            }
        }
        return best;
    }

    function probs(context, id) {
        const belief = context.beliefs.get(id);
        return belief ? belief.probs : { flag: 1 / 16, trap: 1 / 16, rock: 7 / 24, paper: 7 / 24, scissors: 7 / 24 };
    }

    function legalMoves(state) {
        const moves = [];
        for (const piece of state.aiPieces || []) {
            if (!active(piece)
                || piece.immobilized
                || (piece.type === FLAG && piece.revealed)) {
                continue;
            }
            for (const destination of API.getLegalMoves(piece, state)) {
                const target = state.board[destination.row][destination.col];
                if (piece.type === FLAG && target) {
                    continue;
                }
                moves.push({ piece, row: destination.row, col: destination.col, target: target || null });
            }
        }
        return moves;
    }

    function immediateFlagRisk(state, move) {
        const flag = myFlag(state);
        if (!flag) {
            return 1;
        }
        const row = move.piece.id === flag.id ? move.row : flag.row;
        const col = move.piece.id === flag.id ? move.col : flag.col;
        let risk = 0;
        for (const enemy of state.playerPieces || []) {
            if (!active(enemy) || enemy.immobilized) {
                continue;
            }
            const d = distance(row, col, enemy.row, enemy.col);
            if (d === 1) {
                if (move.target && move.target.id === enemy.id && move.piece.type !== FLAG) {
                    continue;
                }
                risk += 1;
            } else if (d === 2) {
                risk += 0.12;
            }
        }
        return Math.min(1, risk);
    }

    function combatValue(move, context) {
        if (!move.target) {
            return 0;
        }
        if (move.target.revealed && move.target.type === FLAG) {
            return 1000000;
        }
        if (move.target.revealed && move.target.type === TRAP) {
            return -100000;
        }
        if (move.piece.type === TRAP) {
            return move.target.revealed && move.target.type === FLAG ? 1000000 : -4000;
        }
        if (move.piece.type !== 'piece') {
            return -100000;
        }
        if (move.target.revealed && move.target.type === 'piece') {
            const result = API.resolveBattle(move.piece.pieceType, move.target.pieceType);
            return result === 'win' ? 3500 : (result === 'draw' ? 120 : -6000);
        }
        const belief = probs(context, move.target.id);
        const type = move.piece.pieceType;
        return (belief.flag || 0) * 700000
            + (belief[BEATS[type]] || 0) * 3000
            + (belief[type] || 0) * 100
            - ((belief[COUNTER[type]] || 0) + (belief.trap || 0)) * 3100;
    }

    function formationValue(state, move) {
        let score = 0;
        const types = new Set();
        for (const ally of state.aiPieces || []) {
            if (!active(ally) || ally.id === move.piece.id) {
                continue;
            }
            if (distance(move.row, move.col, ally.row, ally.col) <= 1) {
                score += 55;
                if (ally.type === 'piece') {
                    types.add(ally.pieceType);
                }
            }
        }
        return score + types.size * 160;
    }

    function flagCandidateScore(enemy, context) {
        const belief = probs(context, enemy.id);
        return belief.flag || 0;
    }

    function scoreMove(state, context, move) {
        const flag = myFlag(state);
        const risk = immediateFlagRisk(state, move);
        let score = combatValue(move, context) - risk * 2500000;
        score += formationValue(state, move);

        if (move.piece.type === FLAG) {
            score += risk < 0.01 ? -9000 : 18000;
            return score;
        }

        if (flag) {
            const oldDistance = distance(move.piece.row, move.piece.col, flag.row, flag.col);
            const newDistance = distance(move.row, move.col, flag.row, flag.col);
            if (context.opponent.pressure > 0.45) {
                score += (oldDistance - newDistance) * 450;
            }
        }

        let candidate = null;
        for (const enemy of state.playerPieces || []) {
            if (!active(enemy)) {
                continue;
            }
            if (!candidate || flagCandidateScore(enemy, context) > flagCandidateScore(candidate, context)) {
                candidate = enemy;
            }
        }
        if (candidate && move.piece.type === 'piece') {
            const oldDistance = distance(move.piece.row, move.piece.col, candidate.row, candidate.col);
            const newDistance = distance(move.row, move.col, candidate.row, candidate.col);
            score += (oldDistance - newDistance) * (220 + flagCandidateScore(candidate, context) * 1500);
        }

        const noCapture = state.movesWithoutCapture || 0;
        const material = (state.aiPieces || []).filter(active).length
            - (state.playerPieces || []).filter(active).length;
        if (noCapture >= 10) {
            let nearestBefore = Infinity;
            let nearestAfter = Infinity;
            for (const enemy of state.playerPieces || []) {
                if (!active(enemy)) {
                    continue;
                }
                nearestBefore = Math.min(
                    nearestBefore,
                    distance(move.piece.row, move.piece.col, enemy.row, enemy.col)
                );
                nearestAfter = Math.min(
                    nearestAfter,
                    distance(move.row, move.col, enemy.row, enemy.col)
                );
            }
            if (material >= 0) {
                score += move.target ? 1000 + noCapture * 80 : (move.row > move.piece.row ? 180 : -70);
                score += (nearestBefore - nearestAfter) * (noCapture >= 15 ? 620 : 180);
            } else if (!move.target) {
                score += 240;
            } else {
                score -= 800;
            }
        }
        return score;
    }

    function simulateReplyPenalty(state, context, move) {
        let penalty = 0;
        for (const enemy of state.playerPieces || []) {
            if (!active(enemy) || enemy.immobilized) {
                continue;
            }
            if (distance(move.row, move.col, enemy.row, enemy.col) !== 1) {
                continue;
            }
            if (move.piece.type !== 'piece') {
                continue;
            }
            if (enemy.revealed && enemy.type === 'piece') {
                if (API.resolveBattle(enemy.pieceType, move.piece.pieceType) === 'win') {
                    penalty += 1800;
                }
            } else {
                const belief = probs(context, enemy.id);
                penalty += ((belief[COUNTER[move.piece.pieceType]] || 0)
                    + (belief.trap || 0)) * 1800;
            }
        }
        return penalty;
    }

    function chooseMove(state) {
        const context = getContext(state);
        observe(state, context);
        const moves = legalMoves(state);
        if (moves.length === 0) {
            return null;
        }

        const ranked = moves.map((move) => {
            return {
                move,
                risk: immediateFlagRisk(state, move),
                score: scoreMove(state, context, move)
            };
        });
        const safeRisk = ranked.reduce((minimum, entry) => Math.min(minimum, entry.risk), 1);
        const currentRisk = immediateFlagRisk(state, { piece: { id: '' }, row: -1, col: -1 });
        const candidates = currentRisk >= 0.12
            ? ranked.filter((entry) => entry.risk <= safeRisk + 0.001)
            : ranked;
        for (const entry of candidates) {
            entry.score -= simulateReplyPenalty(state, context, entry.move);
            const repeats = context.moves.filter((past) => {
                return past.id === entry.move.piece.id
                    && past.row === entry.move.row
                    && past.col === entry.move.col;
            }).length;
            entry.score -= repeats * 350;
        }
        candidates.sort((left, right) => right.score - left.score);
        const top = candidates.slice(0, Math.min(3, candidates.length));
        const selected = top.length > 1 && top[0].score - top[1].score < 75
            ? top[Math.floor(random(context) * top.length)]
            : top[0];
        context.moves.push({
            id: selected.move.piece.id,
            row: selected.move.row,
            col: selected.move.col
        });
        if (context.moves.length > 32) {
            context.moves.shift();
        }
        context.turn += 1;
        return selected.move;
    }

    function chooseFlagAndTrap() {
        const layouts = [
            [0, 9], [7, 14], [1, 10], [6, 13],
            [2, 10], [5, 13], [3, 11], [4, 12]
        ];
        setupSeed = (setupSeed + 3) % layouts.length;
        const layout = layouts[(setupSeed + Math.floor(Math.random() * layouts.length)) % layouts.length];
        return { flagIndex: layout[0], trapIndex: layout[1] };
    }

    function getTieChoice(currentType, opponentRevealed, opponentType, state) {
        const context = getContext(state);
        const available = TYPES.filter((type) => {
            const history = context.tieChoices;
            return history.length < 2
                || history[history.length - 1] !== type
                || history[history.length - 2] !== type;
        });
        const own = state.aiPieces || [];
        const battle = state.battleState;
        const row = battle ? battle.newRow : -1;
        const col = battle ? battle.newCol : -1;
        let best = available[0];
        let bestScore = -Infinity;
        for (const choice of available) {
            const win = opponentRevealed && BEATS[choice] === opponentType ? 1 : 0;
            const loss = opponentRevealed && BEATS[opponentType] === choice ? 1 : 0;
            let backup = 0;
            for (const ally of own) {
                if (!active(ally)
                    || ally.type !== 'piece'
                    || distance(row, col, ally.row, ally.col) !== 1) {
                    continue;
                }
                if (loss && BEATS[ally.pieceType] === opponentType) {
                    backup += 1;
                }
                if (loss && BEATS[ally.pieceType] === COUNTER[choice]) {
                    backup += 0.4;
                }
            }
            const score = win * 1000 - loss * 420 + backup * 320 + random(context) * 8;
            if (score > bestScore) {
                bestScore = score;
                best = choice;
            }
        }
        context.tieChoices.push(best);
        if (context.tieChoices.length > 10) {
            context.tieChoices.shift();
        }
        return best;
    }

    return {
        id: 'kapibarysh',
        name: 'Капибарыш',
        emoji: '🦦',
        avatar: 'js/bots/kapibarysh/avatar-min.png',
        shortDescription: 'Вероятностная защита флага и организованные атаки',
        longDescription: 'Честная модель скрытых фигур, редуты КНБ, прогноз мотивов и риск-контроль.',
        algorithmLabel: 'Belief-state defense and tactical search',
        tier: 'hard',
        stars: 3,
        difficultyLabel: 'Сложный',
        tags: ['beliefs', 'flag-defense', 'formations', 'risk-control'],
        move(gameState) {
            return chooseMove(gameState);
        },
        chooseFlagAndTrap() {
            return chooseFlagAndTrap();
        },
        getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
            return getTieChoice(currentType, opponentRevealed, opponentType, gameState);
        }
    };
})();

RPSBotAPI.defineBot(kapibaryshBot);
