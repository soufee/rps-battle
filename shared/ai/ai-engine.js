import { GAME_CONFIG, PLAYER, COMPUTER, FLAG, TRAP, PIECE_TYPES, PIECE_SYMBOLS, BOARD_WIDTH, BOARD_HEIGHT } from '../game-config.js';
import { resolveBattle } from '../game-rules.js';

const aiEngine = {
    // Кеш позиций для оптимизации
    positionCache: new Map(),
    
    // История выборов ИИ при ничьей
    aiChoiceHistory: [],
    
    // Анализ паттернов игрока
    playerPatternAnalysis: {
        moves: [],
        attackCount: 0,
        defenseCount: 0,
        pattern: GAME_CONFIG.PLAYER_PATTERNS.RANDOM
    },
    
    // Отслеживание уже залогированных фантомных фигур
    reportedPhantoms: new Set(),
    
    // =====================================================================
    //  СТРУКТУРЫ ПАМЯТИ ДЛЯ АНТИ-ШАТТЛ ЛОГИКИ И СТРАТЕГИЧЕСКОГО ПЛАНА
    // =====================================================================
    
    // Recent AI moves (last ~20) used to detect shuttles and over-activity
    moveHistory: [],
    
    // Enemy piece stillness tracker: pieceId -> { stillnessScore, lastSeenRow, lastSeenCol, hasMovedOnce }
    enemyStillness: new Map(),
    
    // Snapshot of enemy positions taken on previous AI turn, used to update stillness
    enemyPositionSnapshot: new Map(),
    
    // Counter of AI turns since game start
    aiTurnCounter: 0,
    
    // Strategic targets per AI piece: pieceId -> { row, col, reason }
    strategicTargets: new Map(),
    
    // =========================================================================
    //  ПАМЯТЬ: ХОДЫ ИИ, ПОДВИЖНОСТЬ ВРАГОВ, СТРАТЕГИЧЕСКИЕ ЦЕЛИ
    // =========================================================================
    
    /**
     * Записать совершённый ход ИИ в историю.
     * История используется для детекции шаттлов и "гоняний" одной фигурой.
     */
    recordAIMove(move) {
        if (!move || !move.piece) {
            return;
        }
        this.aiTurnCounter++;
        this.moveHistory.push({
            pieceId: move.piece.id,
            fromRow: move.piece.row,
            fromCol: move.piece.col,
            toRow: move.row,
            toCol: move.col,
            turn: this.aiTurnCounter
        });
        if (this.moveHistory.length > 20) {
            this.moveHistory.shift();
        }
    },
    
    /**
     * Проверить, была ли фигура в последние 3 своих ходах уже в этой клетке.
     * Если да — ход туда считается шаттлом.
     */
    isShuttlePosition(pieceId, newRow, newCol) {
        const ownMoves = this.moveHistory.filter(m => m.pieceId === pieceId);
        const recent = ownMoves.slice(-3);
        for (const m of recent) {
            if (m.fromRow === newRow && m.fromCol === newCol) {
                return true;
            }
        }
        return false;
    },
    
    /**
     * Подсчитать, сколько раз конкретная фигура двигалась
     * в последних N ходах ИИ.
     */
    countRecentMovesOfPiece(pieceId, lookback) {
        const window = lookback || 4;
        const slice = this.moveHistory.slice(-window);
        return slice.filter(m => m.pieceId === pieceId).length;
    },
    
    /**
     * Remove shuttle-like candidates from a move list. A move is considered
     * a shuttle if the piece has already visited the destination in its last
     * three moves or if it has moved 2+ times in the last four AI turns.
     *
     * If every candidate is a shuttle (e.g. the only legal flag-defence move
     * bounces the flag back to a known cell), we fall back to the original
     * list so the AI can still act. Otherwise we keep only non-shuttle moves.
     */
    filterOutShuttleMoves(moves) {
        if (!Array.isArray(moves) || moves.length === 0) {
            return moves;
        }
        const safe = moves.filter(m =>
            m
            && m.piece
            && !this.isShuttlePosition(m.piece.id, m.row, m.col)
            && this.countRecentMovesOfPiece(m.piece.id, 4) < 2
        );
        return safe.length > 0 ? safe : moves;
    },

    /**
     * Detect oscillation between 2–3 cells after 3+ moves by the same piece.
     * Examples: A↔B (a2-b2-a2-b2) or A-B-C (a2-b2-a1-a2-b2-a1).
     */
    isPieceInPositionLoop(pieceId, minMoves = 3) {
        const ownMoves = this.moveHistory.filter(m => m.pieceId === pieceId);
        if (ownMoves.length < minMoves) {
            return false;
        }
        const recent = ownMoves.slice(-minMoves);
        const cells = new Set();
        for (const m of recent) {
            cells.add(`${m.fromRow},${m.fromCol}`);
            cells.add(`${m.toRow},${m.toCol}`);
        }
        return cells.size <= 3;
    },

    /**
     * Return destination cells involved in a piece's recent loop (last 3 moves).
     */
    getPieceLoopCells(pieceId) {
        const ownMoves = this.moveHistory.filter(m => m.pieceId === pieceId);
        const recent = ownMoves.slice(-3);
        const cells = new Set();
        for (const m of recent) {
            cells.add(`${m.fromRow},${m.fromCol}`);
            cells.add(`${m.toRow},${m.toCol}`);
        }
        return cells;
    },

    /**
     * Sideline pieces stuck in a 2–3 cell loop for one turn when alternatives exist.
     */
    filterOutLoopingPieces(pieces) {
        if (!Array.isArray(pieces) || pieces.length === 0) {
            return pieces;
        }
        const active = pieces.filter(p => p && !p.immobilized);
        const nonLooping = active.filter(p => !this.isPieceInPositionLoop(p.id));
        return nonLooping.length > 0 ? nonLooping : active;
    },

    /**
     * Remove moves that continue a detected position loop.
     */
    filterOutLoopMoves(moves) {
        if (!Array.isArray(moves) || moves.length === 0) {
            return moves;
        }
        const safe = moves.filter(m => {
            if (!m || !m.piece) {
                return false;
            }
            if (!this.isPieceInPositionLoop(m.piece.id)) {
                return true;
            }
            const loopCells = this.getPieceLoopCells(m.piece.id);
            return !loopCells.has(`${m.row},${m.col}`);
        });
        return safe.length > 0 ? safe : moves;
    },

    /**
     * Combined anti-passivity filter: shuttle + loop detection.
     */
    filterOutPassiveMoves(moves) {
        return this.filterOutLoopMoves(this.filterOutShuttleMoves(moves));
    },
    
    /**
     * Обновить счётчик неподвижности вражеских фигур:
     * если позиция фигуры не изменилась с прошлого нашего хода — увеличиваем stillness.
     * Если фигура двигалась — сбрасываем stillness и ставим hasMovedOnce.
     * Fresh-фигуры (без предыдущего snapshot) инициализируются с stillness=0.
     */
    trackEnemyStillness(gameState) {
        const seenIds = new Set();
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) {
                continue;
            }
            seenIds.add(enemy.id);
            
            const prevPos = this.enemyPositionSnapshot.get(enemy.id);
            const info = this.enemyStillness.get(enemy.id)
                || { stillnessScore: 0, hasMovedOnce: false };
            
            if (!prevPos) {
                info.stillnessScore = 0;
            } else if (prevPos.row === enemy.row && prevPos.col === enemy.col) {
                info.stillnessScore += 1;
            } else {
                info.stillnessScore = 0;
                info.hasMovedOnce = true;
            }
            info.lastSeenRow = enemy.row;
            info.lastSeenCol = enemy.col;
            
            this.enemyStillness.set(enemy.id, info);
            this.enemyPositionSnapshot.set(enemy.id, { row: enemy.row, col: enemy.col });
        }
        
        // Clean up snapshots for removed pieces
        for (const id of this.enemyPositionSnapshot.keys()) {
            if (!seenIds.has(id)) {
                this.enemyPositionSnapshot.delete(id);
                this.enemyStillness.delete(id);
            }
        }
    },
    
    /**
     * Вернуть список вражеских фигур, отсортированных по "подозрению на флаг".
     * Учитываем: неподвижность, задний ряд, угол, факт что фигура не атаковала.
     */
    getSuspectedFlagCandidates(gameState) {
        const candidates = [];
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) {
                continue;
            }
            
            // Revealed non-flag pieces are not flag
            if (enemy.revealed && enemy.type !== FLAG) {
                continue;
            }
            
            const info = this.enemyStillness.get(enemy.id)
                || { stillnessScore: 0, hasMovedOnce: false };
            
            let score = 0;
            score += Math.min(info.stillnessScore, 10) * 10;
            
            // Back rows of the player's territory
            if (enemy.row >= BOARD_HEIGHT - 1) {
                score += 30;
            } else if (enemy.row === BOARD_HEIGHT - 2) {
                score += 20;
            }
            
            // Corner bonus
            if (enemy.row >= BOARD_HEIGHT - 2
                && (enemy.col === 0 || enemy.col === BOARD_WIDTH - 1)) {
                score += 15;
            }
            
            // Pieces that already moved are less likely to be flags, but not impossible
            if (info.hasMovedOnce) {
                score -= 10;
            }
            
            candidates.push({ piece: enemy, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates;
    },
    
    /**
     * Назначить стратегические цели нашим продвинутым фигурам.
     * Базовая идея: 2 самых "переднеи" наших фигуры получают цель — клетку главного кандидата на флаг игрока
     * (либо реально раскрытого флага). Это даёт им "задумку атаки" вместо реактивного поведения.
     */
    updateStrategicTargets(gameState) {
        this.strategicTargets.clear();
        
        let targetRow = -1;
        let targetCol = -1;
        let reason = 'none';
        
        const revealedFlag = gameState.playerPieces.find(p =>
            p.type === FLAG && !p.removed && p.revealed
        );
        
        if (revealedFlag) {
            targetRow = revealedFlag.row;
            targetCol = revealedFlag.col;
            reason = 'revealed_flag';
        } else {
            const candidates = this.getSuspectedFlagCandidates(gameState);
            if (candidates.length > 0 && candidates[0].score >= 20) {
                targetRow = candidates[0].piece.row;
                targetCol = candidates[0].piece.col;
                reason = 'suspect_flag';
            }
        }
        
        // Fallback: any well-defined enemy back-row cell we can push toward
        if (targetRow < 0) {
            const backRow = BOARD_HEIGHT - 1;
            const activeAI = gameState.aiPieces.filter(p =>
                !p.removed && p.type === 'piece' && p.row >= 0
            );
            if (activeAI.length > 0) {
                let bestCol = 3;
                let bestRow = activeAI[0].row;
                for (const piece of activeAI) {
                    if (piece.row > bestRow) {
                        bestRow = piece.row;
                        bestCol = piece.col;
                    }
                }
                targetRow = backRow;
                targetCol = bestCol;
                reason = 'advance_frontier';
            }
        }
        
        if (targetRow < 0) {
            return;
        }
        
        const attackers = gameState.aiPieces
            .filter(p => !p.removed && !p.immobilized && p.type === 'piece' && p.row >= 0)
            .sort((a, b) => b.row - a.row)
            .slice(0, 2);
        
        for (const attacker of attackers) {
            this.strategicTargets.set(attacker.id, { row: targetRow, col: targetCol, reason });
        }
    },
    
    /**
     * Проверка "атака застоялась": ни одна наша фигура не в половине игрока.
     * Используется чтобы дать временный буст любому ходу в сторону игрока.
     */
    isAttackStalled(gameState) {
        const playerHalfStart = Math.floor(BOARD_HEIGHT / 2);
        const advanced = gameState.aiPieces.filter(p =>
            !p.removed && p.row >= playerHalfStart && p.type === 'piece'
        );
        return advanced.length === 0;
    },
    
    /**
     * Сброс всей памяти ИИ. Вызывается при старте новой партии.
     */
    resetMemory() {
        this.moveHistory = [];
        this.enemyStillness.clear();
        this.enemyPositionSnapshot.clear();
        this.aiTurnCounter = 0;
        this.strategicTargets.clear();
        this.positionCache.clear();
        this.aiChoiceHistory = [];
        this.reportedPhantoms.clear();
        this.playerPatternAnalysis = {
            moves: [],
            attackCount: 0,
            defenseCount: 0,
            pattern: GAME_CONFIG.PLAYER_PATTERNS.RANDOM
        };
        if (typeof aiBeliefs !== 'undefined' && aiBeliefs && typeof aiBeliefs.reset === 'function') {
            aiBeliefs.reset();
        }
        if (typeof aiStrategy !== 'undefined' && aiStrategy && typeof aiStrategy.reset === 'function') {
            aiStrategy.reset();
        }
    },
    
    // =========================================================================
    //  НАЧАЛЬНАЯ РАССТАНОВКА: ВЫБОР ПОЗИЦИЙ ФЛАГА И КАПКАНА ДЛЯ БОТА
    //  Обычные фигуры расставляются случайно в game-core.js; бот сам выбирает
    //  только позиции флага и капкана из 16 клеток своей территории (row 0-1).
    //  Индексация: i = row*8 + col, где row ∈ {0,1}, col ∈ {0..7}.
    // =========================================================================
    
    /**
     * Выбрать позиции флага и капкана для начальной расстановки бота.
     *
     * Флаг — в одном из углов заднего ряда (row 0). Капкан — рядом с флагом
     * (в радиусе 1-2), чтобы прикрывать флаг. Поведение зависит от `style`
     * в options, передаваемом ботом:
     *   'random'         — равномерно случайно по углам/боковым клеткам.
     *   'corner-biased'  — 70% шанс истинного угла (0 или 7), trap на диагонали.
     *   'corner-strong'  — 85% шанс истинного угла, trap на диагонали.
     *
     * @param {{style?: string}} [options]
     * @returns {{flagIndex: number, trapIndex: number}}
     */
    chooseFlagAndTrapPositions(options) {
        const opts = options || {};
        const style = opts.style || 'corner-biased';
        const backRowCandidates = [0, 1, 6, 7];
        
        let flagIndex;
        if (style === 'random') {
            flagIndex = backRowCandidates[Math.floor(Math.random() * backRowCandidates.length)];
        } else {
            const cornerBias = (style === 'corner-strong') ? 0.85 : 0.7;
            flagIndex = Math.random() < cornerBias
                ? [0, 7][Math.floor(Math.random() * 2)]
                : backRowCandidates[Math.floor(Math.random() * backRowCandidates.length)];
        }
        
        const flagRow = Math.floor(flagIndex / 8);
        const flagCol = flagIndex % 8;
        
        const trapCandidates = [];
        for (let i = 0; i < 16; i++) {
            if (i === flagIndex) {
                continue;
            }
            const row = Math.floor(i / 8);
            const col = i % 8;
            const dist = Math.max(Math.abs(row - flagRow), Math.abs(col - flagCol));
            if (dist === 1) {
                trapCandidates.push({ index: i, dist, row, col });
            }
        }
        
        if (trapCandidates.length === 0) {
            for (let i = 0; i < 16; i++) {
                if (i === flagIndex) {
                    continue;
                }
                const row = Math.floor(i / 8);
                const col = i % 8;
                const dist = Math.max(Math.abs(row - flagRow), Math.abs(col - flagCol));
                if (dist <= 2) {
                    trapCandidates.push({ index: i, dist, row, col });
                }
            }
        }
        
        let trapIndex;
        if (style === 'random') {
            trapIndex = trapCandidates[Math.floor(Math.random() * trapCandidates.length)].index;
        } else {
            const diagonal = trapCandidates.filter(c =>
                c.row !== flagRow && c.col !== flagCol
            );
            const pool = diagonal.length > 0 ? diagonal : trapCandidates;
            trapIndex = pool[Math.floor(Math.random() * pool.length)].index;
        }
        
        return { flagIndex, trapIndex };
    },
    
    // =========================================================================
    //  СИСТЕМА ПРИОРИТЕТОВ: Защита флага
    // =========================================================================
    
    /**
     * Минимальное расстояние (Чебышёв) от клетки до любой из переданных угроз.
     * Если угроз нет — возвращает +Infinity.
     */
    minDistanceToThreats(row, col, threats) {
        if (!threats || threats.length === 0) {
            return Infinity;
        }
        let min = Infinity;
        for (const threat of threats) {
            const d = Math.max(Math.abs(threat.row - row), Math.abs(threat.col - col));
            if (d < min) {
                min = d;
            }
        }
        return min;
    },
    
    /**
     * Возвращает множество типов раскрытых вражеских фигур, угрожающих клетке (row, col).
     * "Угрожает" = стоит в радиусе 1 от клетки и раскрыта как обычная фигура или капкан.
     * Любая раскрытая фигура в R1 от флага означает потерю флага на следующем ходу,
     * потому что флаг проигрывает всем.
     */
    getVisibleThreatsAtCell(row, col, gameState) {
        const threats = [];
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) {
                continue;
            }
            const dist = Math.max(Math.abs(enemy.row - row), Math.abs(enemy.col - col));
            if (dist !== 1) {
                continue;
            }
            threats.push(enemy);
        }
        return threats;
    },
    
    /**
     * RPS-покрытие защитников вокруг клетки.
     * Возвращает число уникальных типов (rock/paper/scissors/trap) наших фигур
     * в радиусе 1 от клетки. Если оно = 3+ (все три основных типа + капкан —
     * покрытие полное: чем бы враг ни был, один из защитников его побьёт
     * либо минимум устроит ничью.
     *
     * Дополнительно возвращает hasTrap — капкан съест любую пешку,
     * это особенно ценно для защиты флага.
     */
    computeRPSCoverage(row, col, gameState) {
        const types = new Set();
        let hasTrap = false;
        let defenders = 0;
        
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const r = row + dRow;
            const c = col + dCol;
            if (!this.isValidPosition(r, c)) {
                continue;
            }
            const ally = gameState.board[r][c];
            if (!ally || ally.owner !== COMPUTER || ally.type === FLAG) {
                continue;
            }
            if (ally.immobilized || ally.removed) {
                continue;
            }
            defenders++;
            if (ally.type === TRAP) {
                hasTrap = true;
            } else if (ally.type === 'piece' && ally.pieceType) {
                types.add(ally.pieceType);
            }
        }
        
        return {
            defenders,
            typeCount: types.size,
            hasTrap,
            hasRock: types.has('rock'),
            hasPaper: types.has('paper'),
            hasScissors: types.has('scissors')
        };
    },
    
    /**
     * Главная эвристика оценки хода флагом.
     * Даёт большой штраф за подставу под прямой удар, но награждает
     * перемещение в хорошо защищённую клетку. Не запрещает физически —
     * позволяет оценивать вместе с другими ходами.
     *
     * Правила:
     *   - прямой удар: раскрытый враг в R1 от новой клетки → -5000 (почти терминально).
     *   - нераскрытый враг в R1 от новой клетки → -500 (большой риск).
     *   - дельта безопасности new-current × 40.
     *   - полнота RPS-покрытия: +20 за каждый уникальный тип защитника (max 3), +40 за капкан рядом.
     *   - базовый штраф за ход флагом вообще: -80 (флаг двигается только если есть смысл).
     *   - анти-шаттл (общие правила isShuttlePosition, countRecentMovesOfPiece).
     */
    evaluateFlagMove(piece, row, col, gameState) {
        let score = -80;
        
        const isAI = piece.owner === 'computer';
        const homeRow = isAI ? 0 : 5;
        const isMovingForward = homeRow === 0 ? (row > piece.row) : (row < piece.row);
        const threats = this.getFlagThreats(gameState).length > 0 || this.getNearFlagThreats(gameState).length > 0;
        
        if (isMovingForward) {
            if (!threats) {
                score -= 4000;
            } else {
                score -= 200;
            }
        }

        const visibleThreats = this.getVisibleThreatsAtCell(row, col, gameState);
        for (const threat of visibleThreats) {
            if (threat.revealed) {
                score -= 5000;
            } else {
                score -= 500;
            }
        }
        
        const currentSafety = this.evaluatePositionSafety(piece.row, piece.col, gameState);
        const newSafety = this.evaluatePositionSafety(row, col, gameState);
        score += (newSafety - currentSafety) * 40;
        
        const coverage = this.computeRPSCoverage(row, col, gameState);
        score += coverage.typeCount * 20;
        if (coverage.hasTrap) {
            score += 40;
        }
        if (coverage.defenders >= 3 && coverage.typeCount >= 2) {
            score += 30;
        }
        
        if (this.isShuttlePosition(piece.id, row, col)) {
            score -= 300;
        }
        const recentSelfMoves = this.countRecentMovesOfPiece(piece.id, 4);
        if (recentSelfMoves >= 2) {
            score -= 120 * (recentSelfMoves - 1);
        }
        
        return score;
    },
    
    /**
     * Проверяет, находится ли флаг ИИ под непосредственной угрозой
     * @returns {Array} вражеские фигуры, угрожающие флагу (стоят рядом)
     */
    getFlagThreats(gameState) {
        const aiFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!aiFlag) return [];

        const threats = [];
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) continue;
            // A sprung trap and a revealed flag cannot move or attack — they are
            // no longer threats. Skipping them prevents bots from "defending"
            // against pieces that are already neutralised.
            if (enemy.immobilized) continue;
            if (enemy.type === FLAG) continue;
            const dist = Math.max(Math.abs(enemy.row - aiFlag.row), Math.abs(enemy.col - aiFlag.col));
            if (dist === 1) {
                threats.push(enemy);
            }
        }
        return threats;
    },

    /**
     * Проверяет, есть ли враги на расстоянии 2 клеток от флага (потенциальная угроза)
     */
    getNearFlagThreats(gameState) {
        const aiFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!aiFlag) return [];

        const threats = [];
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) continue;
            if (enemy.immobilized) continue;
            if (enemy.type === FLAG) continue;
            const dist = Math.max(Math.abs(enemy.row - aiFlag.row), Math.abs(enemy.col - aiFlag.col));
            if (dist === 2) {
                threats.push(enemy);
            }
        }
        return threats;
    },
    
    /**
     * Находит ходы для защиты флага.
     * Стратегии защиты:
     * 1. Атаковать угрозу выигрышной фигурой или капканом
     * 2. Поставить фигуру между врагом и флагом
     * 3. Отвести флаг в безопасное место
     */
    findFlagDefenseMoves(gameState, availablePieces) {
        const immediateThreats = this.getFlagThreats(gameState);
        if (immediateThreats.length === 0) return [];
        
        const aiFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (!aiFlag) return [];
        
        const defenseMoves = [];
        
        for (const threat of immediateThreats) {
            // Стратегия 1: Атаковать угрозу
            for (const piece of availablePieces) {
                if (piece.type === FLAG) continue; // Флаг не атакует
                
                const moves = this.getMovesForPiece(piece, gameState);
                for (const move of moves) {
                    if (move.row === threat.row && move.col === threat.col) {
                        // Проверяем, можем ли мы выиграть
                        if (piece.type === TRAP) {
                            // Капкан побеждает всех — отличная защита!
                            defenseMoves.push({ piece, row: move.row, col: move.col, priority: 100 });
                        } else if (threat.revealed && piece.type === 'piece') {
                            const result = this.resolveBattle(piece.pieceType, threat.pieceType);
                            if (result === 'win') {
                                defenseMoves.push({ piece, row: move.row, col: move.col, priority: 90 });
                            } else if (result === 'draw') {
                                // Даже ничья лучше, чем потерять флаг
                                defenseMoves.push({ piece, row: move.row, col: move.col, priority: 50 });
                            }
                            // Проигрышную атаку мы тоже рассматриваем как крайний вариант
                            // но только если нет вообще ничего лучше
                        } else if (!threat.revealed && piece.type === 'piece') {
                            // Неизвестная угроза — рискуем, но защищаем флаг
                            defenseMoves.push({ piece, row: move.row, col: move.col, priority: 60 });
                        }
                    }
                }
            }
            
            // Стратегия 2: Встать между врагом и флагом
            // Ищем клетки, которые блокируют путь к флагу
            for (const piece of availablePieces) {
                if (piece.type === FLAG) continue;
                const moves = this.getMovesForPiece(piece, gameState);
                for (const move of moves) {
                    // Клетка должна быть пустой и стоять рядом с флагом, блокируя угрозу
                    const target = gameState.board[move.row][move.col];
                    if (target) continue; // Только пустые клетки для блокировки
                    
                    const distToFlag = Math.max(Math.abs(move.row - aiFlag.row), Math.abs(move.col - aiFlag.col));
                    const distToThreat = Math.max(Math.abs(move.row - threat.row), Math.abs(move.col - threat.col));
                    
                    if (distToFlag === 1 && distToThreat === 1) {
                        // Эта позиция блокирует путь к флагу
                        defenseMoves.push({ piece, row: move.row, col: move.col, priority: 40 });
                    }
                }
            }
        }
        
        // Стратегия 3: Увести флаг (только если нет сильных атак/блокировок).
        // Решение через evaluateFlagMove: флаг реально двигается только
        // если новая позиция по стратегической оценке лучше текущей.
        if (defenseMoves.filter(m => m.priority >= 40).length === 0) {
            const flagMoves = this.getMovesForPiece(aiFlag, gameState);
            const currentScore = this.evaluateFlagMove(
                aiFlag, aiFlag.row, aiFlag.col, gameState
            );
            
            for (const move of flagMoves) {
                const target = gameState.board[move.row][move.col];
                if (target) continue;
                
                const moveScore = this.evaluateFlagMove(
                    aiFlag, move.row, move.col, gameState
                );
                
                // Only propose a flag move if it is measurably better than staying put.
                // The evaluation already penalises "walking into a revealed threat"
                // and rewards ending up near balanced defenders.
                if (moveScore <= currentScore + 10) {
                    continue;
                }
                
                defenseMoves.push({
                    piece: aiFlag,
                    row: move.row,
                    col: move.col,
                    priority: 25 + Math.min(30, Math.floor((moveScore - currentScore) / 10))
                });
            }
        }
        
        // Крайний вариант: атаковать угрозу даже проигрышной фигурой
        if (defenseMoves.length === 0) {
            for (const threat of immediateThreats) {
                for (const piece of availablePieces) {
                    if (piece.type === FLAG) continue;
                    const moves = this.getMovesForPiece(piece, gameState);
                    for (const move of moves) {
                        if (move.row === threat.row && move.col === threat.col) {
                            defenseMoves.push({ piece, row: move.row, col: move.col, priority: 5 });
                        }
                    }
                }
            }
        }
        
        // Сортируем по приоритету и возвращаем лучшие
        defenseMoves.sort((a, b) => b.priority - a.priority);
        
        if (defenseMoves.length === 0) return [];
        
        // Возвращаем ходы с лучшим приоритетом
        const bestPriority = defenseMoves[0].priority;
        return defenseMoves.filter(m => m.priority >= bestPriority - 10);
    },
    
    // =========================================================================
    //  СИСТЕМА ПРИОРИТЕТОВ: Захват вражеского флага
    // =========================================================================
    
    /**
     * Находит ходы для захвата вражеского флага
     */
    findFlagCaptureMoves(gameState, availablePieces) {
        const captures = [];
        
        for (const piece of availablePieces) {
            if (piece.type === FLAG) continue; // Флаг не атакует!
            
            const moves = this.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row][move.col];
                if (target && target.owner === PLAYER && target.type === FLAG) {
                    captures.push({ piece, row: move.row, col: move.col });
                }
            }
        }
        
        return captures;
    },
    
    // =========================================================================
    //  СИСТЕМА ПРИОРИТЕТОВ: Атака раскрытых фигур
    // =========================================================================
    
    /**
     * Находит гарантированные убийства — наша фигура может атаковать
     * раскрытую вражескую фигуру и гарантированно победить
     */
    findGuaranteedKills(gameState, availablePieces) {
        const kills = [];
        
        for (const piece of availablePieces) {
            if (piece.type === FLAG) continue; // Флаг не атакует!
            if (piece.type === TRAP) continue; // Капкан бережём для защиты
            if (piece.type !== 'piece') continue;
            
            const moves = this.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row][move.col];
                if (!target || target.owner !== PLAYER) continue;
                
                // Только раскрытые фигуры типа 'piece'
                if (target.revealed && target.type === 'piece') {
                    const result = this.resolveBattle(piece.pieceType, target.pieceType);
                    if (result === 'win') {
                        kills.push({ piece, row: move.row, col: move.col });
                    }
                }
            }
        }
        
        return kills;
    },
    
    // =========================================================================
    //  ГЕНЕРАЦИЯ И ФИЛЬТРАЦИЯ ХОДОВ
    // =========================================================================
    
    /**
     * Получить активные (не удалённые, не обездвиженные) фигуры ИИ
     */
    getActivePieces(gameState) {
        return gameState.aiPieces.filter(piece => {
            if (piece.immobilized || piece.removed || piece.row < 0 || piece.col < 0) return false;
            
            // Проверяем, что фигура действительно на доске
            const boardPiece = gameState.board[piece.row] && gameState.board[piece.row][piece.col];
            if (!boardPiece || boardPiece.id !== piece.id) {
                return false;
            }
            return true;
        });
    },
    
    /**
     * Получить отфильтрованные ходы для фигуры.
     * КЛЮЧЕВЫЕ ПРАВИЛА:
     *  1. Флаг ходит ТОЛЬКО на пустые клетки (никогда не атакует).
     *  2. Никакая фигура не атакует раскрытую фигуру игрока, которой она заведомо проиграет.
     *  3. Никакая фигура не атакует раскрытый капкан (это самоубийство).
     *  Оба эти запрета — жёсткие, применяются до любой эвристики.
     */
    getMovesForPiece(piece, gameState) {
        const moves = [];
        
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const newRow = piece.row + dRow;
            const newCol = piece.col + dCol;
            
            if (!this.isValidPosition(newRow, newCol)) continue;
            
            const target = gameState.board[newRow][newCol];
            
            // Нельзя ходить на свои фигуры
            if (target && target.owner === piece.owner) continue;
            
            // ФЛАГ: только на пустые клетки! Никогда не атакует!
            if (piece.type === FLAG) {
                if (!target) {
                    moves.push({ row: newRow, col: newCol });
                }
                continue;
            }
            
            // Hard rule: never attack a revealed enemy we are guaranteed to lose to.
            if (this.isHopelessAttack(piece, target)) {
                continue;
            }
            
            // Остальные фигуры могут ходить на пустые и вражеские
            moves.push({ row: newRow, col: newCol });
        }
        
        return moves;
    },
    
    /**
     * Ход считается самоубийственной атакой (для ИИ), если:
     *  - цель принадлежит игроку,
     *  - цель раскрыта (мы реально знаем её тип),
     *  - цель — капкан (он съест любую нашу фигуру), или
     *  - цель — обычная фигура и resolveBattle для нас = 'lose'.
     * Такой ход запрещён на уровне генерации для всех ботов и всей минимакс-цепочки.
     */
    isHopelessAttack(piece, target) {
        if (!piece || piece.owner !== COMPUTER) {
            return false;
        }
        if (!target || target.owner !== PLAYER) {
            return false;
        }
        if (!target.revealed) {
            return false;
        }
        if (piece.type !== 'piece' || !piece.pieceType) {
            return false;
        }
        if (target.type === TRAP) {
            return true;
        }
        if (target.type === 'piece'
            && target.pieceType
            && this.resolveBattle(piece.pieceType, target.pieceType) === 'lose') {
            return true;
        }
        return false;
    },
    
    /**
     * Получить все отфильтрованные ходы для всех фигур.
     * Флаг включён в пул наравне с другими фигурами — его движение будет
     * оценено специальной эвристикой (evaluateFlagMove), которая знает
     * правила осторожности: не подставлять под раскрытого врага,
     * двигаться под защиту группы, избегать шаттла.
     */
    getAllFilteredMoves(gameState, availablePieces) {
        const allMoves = [];
        
        for (const piece of availablePieces) {
            const moves = this.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                allMoves.push({ piece, row: move.row, col: move.col });
            }
        }
        
        return allMoves;
    },
    
    /**
     * Найти безопасные ходы (на пустые клетки, без атак)
     */
    findSafeMoves(gameState, availablePieces) {
        const safeMoves = [];
        
        for (const piece of availablePieces) {
            if (piece.type === FLAG) continue; // Флаг двигаем только при необходимости
            
            const moves = this.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row][move.col];
                if (!target) {
                    safeMoves.push({ piece, row: move.row, col: move.col });
                }
            }
        }
        
        return safeMoves;
    },
    
    /**
     * Категоризировать ходы по типу
     */
    categorizeMoves(allMoves, gameState) {
        const categorized = {
            winning: [],    // Гарантированная победа
            safe: [],       // Безопасные ходы (пустые клетки)
            risky: [],      // Атака неизвестной фигуры
            losing: []      // Заведомо проигрышные
        };
        
        for (const moveData of allMoves) {
            const target = gameState.board[moveData.row][moveData.col];
            
            if (!target) {
                // Пустая клетка — безопасный ход
                categorized.safe.push(moveData);
            } else if (target.owner === PLAYER) {
                if (target.type === FLAG) {
                    categorized.winning.push(moveData);
                } else if (target.revealed && moveData.piece.type === 'piece' && target.type === 'piece') {
                    const result = this.resolveBattle(moveData.piece.pieceType, target.pieceType);
                    if (result === 'win') {
                        categorized.winning.push(moveData);
                    } else if (result === 'lose') {
                        categorized.losing.push(moveData);
                    } else {
                        categorized.risky.push(moveData);
                    }
                } else if (!target.revealed) {
                    categorized.risky.push(moveData);
                }
            }
        }
        
        return categorized;
    },
    
    // =========================================================================
    //  ОЦЕНКА ХОДА V2 (для Енота и выше)
    // =========================================================================
    
    /**
     * Улучшенная функция оценки хода
     */
    /**
     * Проверяет, проигрывает ли бот (меньше боевых фигур).
     * Если да — ничья для него выгодна, и draw-pressure НЕ применяется.
     */
    isLosingPosition(gameState) {
        // Fog-of-war safe material count: use the number of pieces still on the
        // board (removal is public knowledge for both sides). Counting by
        // `type === 'piece'` is unreliable here because a hidden enemy flag/trap
        // is masked as a generic 'piece', which would phantom-inflate the enemy
        // material and make BOTH sides wrongly think they are losing.
        const aiCount = gameState.aiPieces.filter(p => !p.removed).length;
        const playerCount = gameState.playerPieces.filter(p => !p.removed).length;
        // A position is "losing" when the bot is behind by 2+ pieces.
        return playerCount - aiCount >= 2;
    },

    /**
     * Бонус/штраф за приближение к ничье (ходы без взятия).
     * Заставляет ботов атаковать агрессивнее, если ничья приближается,
     * но только если позиция бота не проигрышная (тогда ничья выгодна).
     */
    getDrawPressureBonus(moveData, gameState) {
        const movesWithout = gameState.movesWithoutCapture || 0;
        const drawLimit = (GAME_CONFIG.GAME && GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT) || 20;
        const ratio = movesWithout / drawLimit;

        // Far from the limit: no pressure at all.
        if (ratio < 0.5) {
            return 0;
        }

        // A losing side benefits from a draw, so do not push it to attack.
        if (this.isLosingPosition(gameState)) {
            return 0;
        }

        const { piece, row, col } = moveData;
        const target = gameState.board[row][col];
        const isAttack = !!(target && target.owner === PLAYER);
        const isForward = row > piece.row;

        // Escalating base incentive: the closer to the draw, the bolder the bot.
        // Values are deliberately large so that in a stall they outweigh the
        // defensive (flag-shield / stay-home / consolidation) bonuses baked into
        // the per-bot evaluators, which otherwise keep both armies at home.
        let bonus = 0;
        if (ratio >= 0.9) {
            bonus = isAttack ? 800 : (isForward ? 300 : -200);
        } else if (ratio >= 0.75) {
            bonus = isAttack ? 450 : (isForward ? 150 : -120);
        } else {
            bonus = isAttack ? 220 : (isForward ? 70 : -60);
        }

        // Engagement drive: reward closing the gap to the nearest enemy piece
        // even when no flag is revealed. Without this the armies never get a
        // target to walk toward and simply patrol their own halves to a draw.
        // Scale must beat the "return to own flag" consolidation pull.
        const nearest = this.nearestEnemyDistance(piece.row, piece.col, gameState);
        if (nearest.dist >= 0) {
            const nextDist = Math.max(
                Math.abs(row - nearest.row),
                Math.abs(col - nearest.col)
            );
            const closing = nearest.dist - nextDist;
            const engageScale = ratio >= 0.9
                ? 300
                : (ratio >= 0.75 ? 200 : 120);
            bonus += closing * engageScale;
        }

        return bonus;
    },

    /**
     * Chebyshev distance from a square to the nearest active enemy piece.
     * Returns { dist, row, col } of the closest enemy, or dist = -1 if none.
     */
    nearestEnemyDistance(fromRow, fromCol, gameState) {
        const best = { dist: -1, row: -1, col: -1 };
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0 || enemy.immobilized) {
                continue;
            }
            const dist = Math.max(
                Math.abs(fromRow - enemy.row),
                Math.abs(fromCol - enemy.col)
            );
            if (best.dist < 0 || dist < best.dist) {
                best.dist = dist;
                best.row = enemy.row;
                best.col = enemy.col;
            }
        }
        return best;
    },

    evaluateMoveV2(moveData, gameState) {
        const { piece, row, col } = moveData;
        const target = gameState.board[row][col];
        let score = 0;
        
        // === Абсолютный запрет: флаг не атакует ===
        if (piece.type === FLAG && target && target.owner === PLAYER) {
            return -100000;
        }
        
        // === Флаг: стратегическая оценка перемещения ===
        // Разрешено, если есть смысл (уход под защиту, подальше от угроз, избегание шаттла).
        // Запрещено высоким штрафом только в очевидно плохих случаях (подстава под раскрытого врага).
        if (piece.type === FLAG) {
            return this.evaluateFlagMove(piece, row, col, gameState);
        }
        
        // === Атака ===
        if (target && target.owner === PLAYER) {
            score += this.evaluateAttackV2(piece, target, gameState);
        } else {
            // === Позиционный ход ===
            score += this.evaluatePositionalMoveV2(piece, { row, col }, gameState);
        }
        
        // === Бонус за защиту флага ===
        const aiFlag = gameState.aiPieces.find(p => p.type === FLAG && !p.removed);
        if (aiFlag) {
            const currentDistToFlag = Math.max(Math.abs(piece.row - aiFlag.row), Math.abs(piece.col - aiFlag.col));
            const newDistToFlag = Math.max(Math.abs(row - aiFlag.row), Math.abs(col - aiFlag.col));
            
            // Если рядом с флагом есть угрозы, бонус за приближение к флагу
            const nearThreats = this.getNearFlagThreats(gameState);
            if (nearThreats.length > 0) {
                if (newDistToFlag < currentDistToFlag) {
                    score += 80; // Идём защищать флаг
                } else if (newDistToFlag > currentDistToFlag && currentDistToFlag <= 2) {
                    score -= 60; // Не уходить от флага, когда есть угрозы рядом
                }
            }
        }
        
        // === Штраф за движение рядом с вражеским капканом ===
        if (piece.type === 'piece') {
            for (const enemy of gameState.playerPieces) {
                if (enemy.removed || enemy.row < 0) continue;
                if (enemy.revealed && enemy.type === TRAP) {
                    const distToTrap = Math.max(Math.abs(row - enemy.row), Math.abs(col - enemy.col));
                    if (distToTrap <= 1) {
                        score -= 500; // Избегаем раскрытых капканов!
                    }
                }
            }
        }
        
        // Учитываем паттерн игрока
        score += this.adjustScoreByPlayerPattern(piece, { row, col }, gameState);
        
        // === Давление ничьи: усиление агрессии при приближении к лимиту ходов ===
        score += this.getDrawPressureBonus(moveData, gameState);
        
        return score;
    },
    
    /**
     * Оценка атаки (V2)
     */
    evaluateAttackV2(piece, target, gameState) {
        // Захват флага — максимальный приоритет
        if (target.type === FLAG) {
            return GAME_CONFIG.SCORING.FLAG_CAPTURE;
        }
        
        // Атака раскрытого капкана — самоубийство
        if (target.type === TRAP && target.revealed) {
            return -10000;
        }
        
        // Атака нераскрытого — может быть капкан
        if (target.type === TRAP && !target.revealed) {
            return GAME_CONFIG.SCORING.TRAP_PENALTY;
        }
        
        // Капкан всегда побеждает обычные фигуры
        if (piece.type === TRAP) {
            return 150;
        }
        
        // Атака раскрытой фигуры — считаем результат
        if (target.revealed && piece.type === 'piece' && target.type === 'piece') {
            const result = this.resolveBattle(piece.pieceType, target.pieceType);
            if (result === 'win') {
                return GAME_CONFIG.SCORING.GUARANTEED_WIN;
            } else if (result === 'lose') {
                return -10000; // Никогда не атакуем заведомо проигрышной
            } else {
                return GAME_CONFIG.SCORING.DRAW_BATTLE;
            }
        }
        
        // Атака нераскрытой фигуры — риск
        if (!target.revealed) {
            return GAME_CONFIG.SCORING.RISKY_ATTACK;
        }
        
        return 0;
    },
    
    /**
     * Оценка позиционного хода (V2).
     * Новая версия с анти-шаттл логикой и стратегической задумкой атаки.
     */
    evaluatePositionalMoveV2(piece, move, gameState) {
        let score = 0;
        
        // === 1. Forward progress (also penalize retreat without reason) ===
        // row 0-1 — AI side, row 4-5 — player side.
        // Moving toward higher row == advancing into the player's territory.
        const forwardProgress = move.row - piece.row;
        if (forwardProgress > 0) {
            score += 15;
        } else if (forwardProgress < 0) {
            score -= 15;
        }
        
        // === 2. Anti-shuttle: strong penalty for returning to a recent cell ===
        if (this.isShuttlePosition(piece.id, move.row, move.col)) {
            score -= 300;
        }
        
        // === 3. Penalty for over-using the same piece ===
        // Encourages the AI to develop multiple pieces instead of shuffling one.
        const recentSelfMoves = this.countRecentMovesOfPiece(piece.id, 4);
        if (recentSelfMoves >= 2) {
            score -= 80 * (recentSelfMoves - 1);
        }
        
        // === 4. Center control ===
        const centerDistance = Math.abs(move.row - 2.5) + Math.abs(move.col - 3.5);
        score += (6 - centerDistance) * GAME_CONFIG.SCORING.POSITION_CENTER;
        
        // === 5. Approach to a revealed enemy flag ===
        const enemyFlag = gameState.playerPieces.find(p => p.type === FLAG && !p.removed);
        if (enemyFlag && enemyFlag.revealed) {
            const currentDist = Math.abs(piece.row - enemyFlag.row)
                + Math.abs(piece.col - enemyFlag.col);
            const newDist = Math.abs(move.row - enemyFlag.row)
                + Math.abs(move.col - enemyFlag.col);
            if (newDist < currentDist) {
                score += 45;
            }
        }
        
        // === 6. Approach to the strategic target (suspect flag / advance frontier) ===
        const target = this.strategicTargets.get(piece.id);
        if (target) {
            const currentDist = Math.max(
                Math.abs(piece.row - target.row),
                Math.abs(piece.col - target.col)
            );
            const newDist = Math.max(
                Math.abs(move.row - target.row),
                Math.abs(move.col - target.col)
            );
            if (newDist < currentDist) {
                score += target.reason === 'revealed_flag' ? 70 : 55;
            } else if (newDist > currentDist) {
                score -= 25;
            }
        }
        
        // === 7. Forward tempo: if our army is stalled, reward any push into player's half ===
        if (this.isAttackStalled(gameState)
            && move.row >= Math.floor(BOARD_HEIGHT / 2)) {
            score += 50;
        }
        
        // === 8. Ally support with anti-clustering ===
        let allySupport = 0;
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const checkRow = move.row + dRow;
            const checkCol = move.col + dCol;
            if (!this.isValidPosition(checkRow, checkCol)) {
                continue;
            }
            const neighbor = gameState.board[checkRow][checkCol];
            if (neighbor && neighbor.owner === COMPUTER && neighbor.type !== FLAG) {
                allySupport++;
            }
        }
        if (allySupport >= 4) {
            score -= 15;
        } else {
            score += allySupport * 5;
        }
        
        return score;
    },
    
    /**
     * Оценка безопасности позиции для флага
     */
    evaluatePositionSafety(row, col, gameState) {
        let safety = 0;
        
        // Расстояние от врагов
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) continue;
            const dist = Math.max(Math.abs(enemy.row - row), Math.abs(enemy.col - col));
            safety += Math.min(dist, 5); // Чем дальше враг, тем безопаснее
        }
        
        // Количество союзников рядом (защитники)
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const checkRow = row + dRow;
            const checkCol = col + dCol;
            if (this.isValidPosition(checkRow, checkCol)) {
                const neighbor = gameState.board[checkRow][checkCol];
                if (neighbor && neighbor.owner === COMPUTER && neighbor.type !== FLAG) {
                    safety += 3; // Защитник рядом
                }
            }
        }
        
        // Задний ряд безопаснее
        if (row === 0) safety += 5;
        if (row === 1) safety += 3;
        
        // Углы и стены безопаснее (меньше направлений атаки)
        if (col === 0 || col === BOARD_WIDTH - 1) safety += 2;
        
        return safety;
    },
    
    // =========================================================================
    //  МИНИМАКС (для Ёжика)
    // =========================================================================
    
    /**
     * Минимакс алгоритм с альфа-бета отсечением
     */
    minimax(state, depth, alpha, beta, isMaximizing) {
        // Проверяем кеш
        const cacheKey = this.getStateHash(state);
        if (this.positionCache.has(cacheKey)) {
            return this.positionCache.get(cacheKey);
        }
        
        // Терминальные условия
        if (depth === 0 || this.isGameOver(state)) {
            const score = this.evaluatePositionV2(state);
            return { score, move: null };
        }
        
        if (isMaximizing) {
            let maxEval = -Infinity;
            let bestMove = null;
            
            const moves = this.getAllPossibleMoves(state, COMPUTER);
            for (const move of moves) {
                const newState = this.makeVirtualMove(state, move);
                const result = this.minimax(newState, depth - 1, alpha, beta, false);
                
                if (result.score > maxEval) {
                    maxEval = result.score;
                    bestMove = move;
                }
                
                alpha = Math.max(alpha, result.score);
                if (beta <= alpha) break;
            }
            
            const result = { score: maxEval, move: bestMove };
            this.cachePosition(cacheKey, result);
            return result;
        } else {
            let minEval = Infinity;
            let bestMove = null;
            
            const moves = this.getAllPossibleMoves(state, PLAYER);
            for (const move of moves) {
                const newState = this.makeVirtualMove(state, move);
                const result = this.minimax(newState, depth - 1, alpha, beta, true);
                
                if (result.score < minEval) {
                    minEval = result.score;
                    bestMove = move;
                }
                
                beta = Math.min(beta, result.score);
                if (beta <= alpha) break;
            }
            
            return { score: minEval, move: bestMove };
        }
    },
    
    /**
     * Улучшенная оценка позиции для минимакса
     */
    evaluatePositionV2(state) {
        let score = 0;
        
        // Материальная оценка
        const aiPieceCount = state.aiPieces.filter(p => !p.removed).length;
        const playerPieceCount = state.playerPieces.filter(p => !p.removed).length;
        score += aiPieceCount * 100;
        score -= playerPieceCount * 100;
        
        // Оценка безопасности флагов
        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        const playerFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);
        
        if (!aiFlag) return -GAME_CONFIG.SCORING.FLAG_CAPTURE;
        if (!playerFlag) return GAME_CONFIG.SCORING.FLAG_CAPTURE;
        
        // Безопасность нашего флага (ОЧЕНЬ ВАЖНО)
        score += this.evaluateFlagSafety(aiFlag, state) * 80;
        
        // Уязвимость вражеского флага
        score -= this.evaluateFlagSafety(playerFlag, state) * 40;
        
        // Жёсткий штраф: флаг в радиусе 1 от РАСКРЫТОЙ вражеской фигуры = гарантированная потеря.
        // Любая раскрытая фигура игрока в соседней клетке может взять флаг следующим ходом.
        // Нераскрытая рядом с флагом тоже опасна (меньше, но существенно).
        const visibleThreatsOnOurFlag = this.getVisibleThreatsAtCell(aiFlag.row, aiFlag.col, state);
        for (const threat of visibleThreatsOnOurFlag) {
            if (threat.revealed) {
                score -= 8000;
            } else {
                score -= 400;
            }
        }
        
        // Контроль центра
        score += this.evaluateCenterControl(state) * 15;
        
        // Мобильность
        score += this.evaluateMobility(state) * 8;
        
        // Бонус за раскрытых вражеских фигур рядом с нашими выигрышными
        for (const aiPiece of state.aiPieces) {
            if (aiPiece.removed || aiPiece.type !== 'piece') continue;
            for (const enemy of state.playerPieces) {
                if (enemy.removed || !enemy.revealed || enemy.type !== 'piece') continue;
                const dist = Math.max(Math.abs(aiPiece.row - enemy.row), Math.abs(aiPiece.col - enemy.col));
                if (dist <= 2) {
                    const result = this.resolveBattle(aiPiece.pieceType, enemy.pieceType);
                    if (result === 'win') {
                        score += 50; // Потенциальная добыча рядом
                    }
                }
            }
        }
        
        return score;
    },
    
    // =========================================================================
    //  ТАКТИКИ
    // =========================================================================
    
    /**
     * Тактика "Коридор смерти" - создаем ловушку из нескольких фигур
     */
    tryDeathCorridor(gameState) {
        const playerMoves = this.playerPatternAnalysis.moves.slice(-3);
        if (playerMoves.length < 3) return null;
        
        const direction = this.detectMovementDirection(playerMoves);
        if (!direction) return null;
        
        const lastMove = playerMoves[playerMoves.length - 1];
        const trapPosition = {
            row: lastMove.to.row + direction.row * 2,
            col: lastMove.to.col + direction.col * 2
        };
        
        if (!this.isValidPosition(trapPosition.row, trapPosition.col)) return null;
        
        const availablePieces = gameState.aiPieces.filter(p => 
            !p.immobilized && !p.removed && p.type === 'piece' && p.row >= 0
        );
        
        for (const piece of availablePieces) {
            const moves = this.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const distance = Math.abs(move.row - trapPosition.row) + 
                               Math.abs(move.col - trapPosition.col);
                if (distance === 1) {
                    const support = this.countNearbyAllies(move, gameState);
                    if (support >= 2) {
                        return { piece, row: move.row, col: move.col };
                    }
                }
            }
        }
        
        return null;
    },
    
    /**
     * Тактика "Ложная слабость" - открываем слабую фигуру как приманку
     */
    tryFalseWeakness(gameState) {
        if (this.playerPatternAnalysis.pattern !== GAME_CONFIG.PLAYER_PATTERNS.AGGRESSIVE) {
            return null;
        }
        
        const baitCandidates = gameState.aiPieces.filter(p => 
            p.type === 'piece' && !p.revealed && !p.immobilized && !p.removed && p.row >= 0
        );
        
        for (const bait of baitCandidates) {
            const support = this.analyzePositionSupport(bait, gameState);
            if (support.defenders < 2) continue;
            
            const moves = this.getMovesForPiece(bait, gameState);
            for (const move of moves) {
                const visibleToPlayer = this.isPositionVisibleToPlayer(move, gameState);
                if (!visibleToPlayer) continue;
                
                const hiddenDefenders = this.countHiddenDefenders(move, gameState);
                if (hiddenDefenders >= 2) {
                    const playerPiece = this.findNearbyPlayerPiece(move, gameState);
                    if (playerPiece && playerPiece.revealed) {
                        return { piece: bait, row: move.row, col: move.col };
                    }
                }
            }
        }
        
        return null;
    },
    
    // =========================================================================
    //  АНАЛИЗ ПАТТЕРНОВ ИГРОКА
    // =========================================================================
    
    analyzePlayerPattern(gameState) {
        const recentMoves = this.playerPatternAnalysis.moves.slice(-10);
        if (recentMoves.length < 5) return;
        
        let attacks = 0;
        let retreats = 0;
        let lateral = 0;
        
        recentMoves.forEach(move => {
            if (move.to.row < move.from.row) attacks++;
            else if (move.to.row > move.from.row) retreats++;
            else lateral++;
        });
        
        if (attacks > retreats * 2) {
            this.playerPatternAnalysis.pattern = GAME_CONFIG.PLAYER_PATTERNS.AGGRESSIVE;
        } else if (retreats > attacks * 2) {
            this.playerPatternAnalysis.pattern = GAME_CONFIG.PLAYER_PATTERNS.DEFENSIVE;
        } else {
            this.playerPatternAnalysis.pattern = GAME_CONFIG.PLAYER_PATTERNS.BALANCED;
        }
    },
    
    adjustScoreByPlayerPattern(piece, move, gameState) {
        let adjustment = 0;
        const pattern = this.playerPatternAnalysis.pattern;
        
        switch(pattern) {
            case GAME_CONFIG.PLAYER_PATTERNS.AGGRESSIVE:
                // Reward defensive retreat only when this specific piece
                // is actually under a real, calculable threat. Otherwise the
                // bonus caused the AI to keep retreating pieces that had no
                // threat on them, which produced shuttle behaviour.
                if (this.isPieceUnderRealThreat(piece, gameState)
                    && this.isDefensiveMove(piece, move, gameState)) {
                    adjustment += 30;
                }
                break;
                
            case GAME_CONFIG.PLAYER_PATTERNS.DEFENSIVE:
                if (this.isAggressiveMove(piece, move, gameState)) {
                    adjustment += 30;
                }
                break;
                
            case GAME_CONFIG.PLAYER_PATTERNS.BALANCED:
                adjustment += 10;
                break;
        }
        
        return adjustment;
    },
    
    /**
     * Проверяет, есть ли у конкретной нашей фигуры реальная непосредственная угроза.
     * Угрозой считается:
     * - раскрытая вражеская фигура, которая стоит на расстоянии 1 и может нас побить,
     * - раскрытый вражеский капкан на расстоянии 1.
     */
    isPieceUnderRealThreat(piece, gameState) {
        if (!piece || piece.row < 0) {
            return false;
        }
        for (const enemy of gameState.playerPieces) {
            if (enemy.removed || enemy.row < 0) {
                continue;
            }
            const dist = Math.max(
                Math.abs(enemy.row - piece.row),
                Math.abs(enemy.col - piece.col)
            );
            if (dist !== 1) {
                continue;
            }
            if (enemy.revealed && enemy.type === TRAP) {
                return true;
            }
            if (enemy.revealed && enemy.type === 'piece' && piece.type === 'piece') {
                if (this.resolveBattle(enemy.pieceType, piece.pieceType) === 'win') {
                    return true;
                }
            }
        }
        return false;
    },
    
    // =========================================================================
    //  ВЫБОР ПРИ НИЧЬЕЙ
    // =========================================================================

    /**
     * Types allowed on this tie-break pick. Blocks a 3rd consecutive same pick:
     * if the last two history entries match, that type is unavailable.
     */
    getTieBreakAvailableChoices() {
        let available = ['rock', 'paper', 'scissors'];
        const hist = this.aiChoiceHistory;

        if (hist.length >= 2) {
            const last = hist[hist.length - 1];
            const prev = hist[hist.length - 2];
            if (last === prev) {
                available = available.filter(function (t) {
                    return t !== last;
                });
            }
        }

        if (available.length === 0) {
            this.aiChoiceHistory = [];
            available = ['rock', 'paper', 'scissors'];
        }

        return available;
    },

    recordTieChoice(choice) {
        this.aiChoiceHistory.push(choice);
        if (this.aiChoiceHistory.length > 10) {
            this.aiChoiceHistory.shift();
        }
    },

    pickChoiceFromAvailable(available, opponentRevealed, opponentType) {
        if (!available || available.length === 0) {
            return 'rock';
        }

        let choice;

        if (opponentRevealed && opponentType) {
            const winChoice = this.getWinningChoice(opponentType);
            if (available.includes(winChoice)) {
                choice = winChoice;
            } else {
                choice = available[Math.floor(Math.random() * available.length)];
            }
        } else {
            const playerStats = this.analyzePlayerChoiceHistory();
            const predictedChoice = this.predictPlayerChoice(playerStats);
            const counterChoice = this.getWinningChoice(predictedChoice);

            if (available.includes(counterChoice)) {
                choice = counterChoice;
            } else {
                choice = available[Math.floor(Math.random() * available.length)];
            }
        }

        return choice;
    },

    /**
     * Fist-backup tie choice (Lion / Rabbit): nearby ally can counter if we lose.
     */
    pickFistFormationTieChoice(gameState, battleRow, battleCol, owner, available) {
        if (!available || available.length === 0) {
            return 'rock';
        }

        const RPS_TYPES = ['rock', 'paper', 'scissors'];
        const pieces = owner === COMPUTER
            ? (gameState.aiPieces || [])
            : (gameState.playerPieces || []);

        const backupTypes = [];
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            if (p.removed || p.type !== 'piece' || !p.pieceType) {
                continue;
            }
            const dist = Math.max(Math.abs(p.row - battleRow), Math.abs(p.col - battleCol));
            if (dist === 1) {
                backupTypes.push(p.pieceType);
            }
        }

        if (backupTypes.length > 0) {
            let bestType = null;
            let bestScore = -1;

            for (let a = 0; a < available.length; a++) {
                const choice = available[a];
                let score = 0;

                for (let o = 0; o < RPS_TYPES.length; o++) {
                    const opp = RPS_TYPES[o];
                    if (GAME_CONFIG.WIN_CONDITIONS[choice] === opp) {
                        score += 2;
                    } else {
                        for (let b = 0; b < backupTypes.length; b++) {
                            if (GAME_CONFIG.WIN_CONDITIONS[backupTypes[b]] === opp) {
                                score += 1;
                                break;
                            }
                        }
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestType = choice;
                }
            }

            if (bestType) {
                return bestType;
            }
        }

        const counts = { rock: 0, paper: 0, scissors: 0 };
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            if (p.removed || p.type !== 'piece' || !p.pieceType) {
                continue;
            }
            counts[p.pieceType]++;
        }

        let minCount = Infinity;
        const scarce = [];

        for (let a = 0; a < available.length; a++) {
            const t = available[a];
            if (counts[t] < minCount) {
                minCount = counts[t];
                scarce.length = 0;
                scarce.push(t);
            } else if (counts[t] === minCount) {
                scarce.push(t);
            }
        }

        if (scarce.length === 1) {
            return scarce[0];
        }

        return null;
    },

    /**
     * Lion / Rabbit tie policy: fist backup, then scarce type, then engine random.
     */
    pickAnimalTieChoice(botId, currentType, opponentRevealed, opponentType, gameState) {
        const available = this.getTieBreakAvailableChoices();
        const bs = gameState.battleState;
        let owner = COMPUTER;

        if (gameState.devMode) {
            if (gameState.bottomBotId === botId) {
                owner = PLAYER;
            } else if (gameState.topBotId === botId) {
                owner = COMPUTER;
            }
        }

        const fistPick = this.pickFistFormationTieChoice(
            gameState,
            bs.newRow,
            bs.newCol,
            owner,
            available
        );

        if (fistPick && available.indexOf(fistPick) >= 0) {
            return fistPick;
        }

        return this.pickChoiceFromAvailable(
            available,
            opponentRevealed,
            opponentType
        );
    },

    /**
     * Resolve tie-break for a bot: custom getSmartTieChoice or engine default.
     */
    resolveTieChoiceForBot(bot, options) {
        const gameState = options.gameState;
        const ourPiece = options.ourPiece;
        const opponentPiece = options.opponentPiece;
        const battleRow = options.battleRow;
        const battleCol = options.battleCol;

        const available = this.getTieBreakAvailableChoices();
        let choice = null;

        if (bot && typeof bot.getSmartTieChoice === 'function') {
            choice = bot.getSmartTieChoice(
                ourPiece.pieceType,
                true,
                opponentPiece.pieceType,
                gameState
            );
        }

        if (!choice || available.indexOf(choice) < 0) {
            choice = this.pickChoiceFromAvailable(
                available,
                true,
                opponentPiece.pieceType
            );
        }

        this.recordTieChoice(choice);
        return choice;
    },

    getSmartAIChoice(currentType, opponentRevealed, opponentType) {
        const available = this.getTieBreakAvailableChoices();
        const choice = this.pickChoiceFromAvailable(
            available,
            opponentRevealed,
            opponentType
        );
        this.recordTieChoice(choice);
        return choice;
    },
    
    // =========================================================================
    //  ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    // =========================================================================
    
    /**
     * Выбрать случайный элемент из массива
     */
    pickRandom(arr) {
        if (arr.length === 0) return null;
        const pool = this.filterOutShuttleMoves(arr);
        const item = pool[Math.floor(Math.random() * pool.length)];
        return { piece: item.piece, row: item.row, col: item.col };
    },
    
    /**
     * Выбрать лучший ход по оценке
     */
    pickBestScored(moves, gameState) {
        if (moves.length === 0) return null;
        
        const pool = this.filterOutShuttleMoves(moves);
        let best = pool[0];
        let bestScore = -Infinity;
        
        for (const move of pool) {
            const score = move.priority !== undefined 
                ? move.priority 
                : this.evaluateMoveV2(move, gameState);
            if (score > bestScore) {
                bestScore = score;
                best = move;
            }
        }
        
        return { piece: best.piece, row: best.row, col: best.col };
    },
    
    /**
     * Выбрать ход из top-K лучших по оценке.
     * Используется, чтобы ИИ не играл механически один и тот же лучший ход
     * в одинаковых позициях — добавляет лёгкое разнообразие без потери качества.
     */
    pickFromTopK(moves, gameState, k) {
        if (!moves || moves.length === 0) {
            return null;
        }
        
        const scored = moves.map(m => ({
            move: m,
            score: m.priority !== undefined
                ? m.priority
                : this.evaluateMoveV2(m, gameState)
        }));
        scored.sort((a, b) => b.score - a.score);
        
        const limit = Math.min(k || 3, scored.length);
        const top = scored.slice(0, limit);
        const picked = top[Math.floor(Math.random() * top.length)].move;
        return { piece: picked.piece, row: picked.row, col: picked.col };
    },
    
    /**
     * Проверить, есть ли рядом с целевой клеткой союзник-контрудар.
     * Если наш rock атакует неизвестную фигуру и она оказалась paper —
     * мы хотим иметь scissors рядом, чтобы отомстить. Это именно та
     * "осторожная, но не трусливая" логика Зайца.
     */
    hasRetaliationSupport(piece, move, gameState) {
        if (!piece || piece.type !== 'piece' || !piece.pieceType) {
            return true;
        }
        
        const loseMap = {
            rock: 'paper',
            paper: 'scissors',
            scissors: 'rock'
        };
        const dangerousEnemyType = loseMap[piece.pieceType];
        if (!dangerousEnemyType) {
            return true;
        }
        
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const ar = move.row + dRow;
            const ac = move.col + dCol;
            if (!this.isValidPosition(ar, ac)) {
                continue;
            }
            if (ar === piece.row && ac === piece.col) {
                continue;
            }
            const ally = gameState.board[ar][ac];
            if (!ally || ally.owner !== COMPUTER) {
                continue;
            }
            if (ally.type !== 'piece' || !ally.pieceType) {
                continue;
            }
            if (this.resolveBattle(ally.pieceType, dangerousEnemyType) === 'win') {
                return true;
            }
        }
        return false;
    },
    
    getPossibleMoves(piece, gameState) {
        const moves = [];
        
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const newRow = piece.row + dRow;
            const newCol = piece.col + dCol;
            
            if (this.isValidPosition(newRow, newCol)) {
                const target = gameState.board[newRow][newCol];
                if (!target || target.owner !== piece.owner) {
                    moves.push({ row: newRow, col: newCol });
                }
            }
        }
        
        return moves;
    },
    
    isValidPosition(row, col) {
        return row >= 0 && row < BOARD_HEIGHT && col >= 0 && col < BOARD_WIDTH;
    },
    
    canWinBattle(attacker, defender) {
        if (attacker.type !== 'piece' || defender.type !== 'piece') return false;
        return this.resolveBattle(attacker.pieceType, defender.pieceType) === 'win';
    },
    
    resolveBattle(type1, type2) {
        if (type1 === type2) return 'draw';
        return GAME_CONFIG.WIN_CONDITIONS[type1] === type2 ? 'win' : 'lose';
    },
    
    getWinningChoice(opponentType) {
        const winMap = {
            'rock': 'paper',
            'paper': 'scissors',
            'scissors': 'rock'
        };
        return winMap[opponentType] || 'rock';
    },
    
    getStateHash(state) {
        let hash = '';
        for (let row = 0; row < BOARD_HEIGHT; row++) {
            for (let col = 0; col < BOARD_WIDTH; col++) {
                const piece = state.board[row][col];
                if (piece) {
                    hash += `${piece.owner}-${piece.type}-${piece.pieceType || 'x'}`;
                } else {
                    hash += '0';
                }
                hash += ',';
            }
        }
        return hash;
    },
    
    cachePosition(key, value) {
        if (this.positionCache.size > GAME_CONFIG.GAME.POSITION_CACHE_SIZE) {
            const firstKey = this.positionCache.keys().next().value;
            this.positionCache.delete(firstKey);
        }
        this.positionCache.set(key, value);
    },
    
    countWinningMatchups(pieceType) {
        let count = 0;
        for (const type of PIECE_TYPES) {
            if (this.resolveBattle(pieceType, type) === 'win') count++;
        }
        return count;
    },
    
    detectMovementDirection(moves) {
        if (moves.length < 2) return null;
        
        let totalDRow = 0;
        let totalDCol = 0;
        
        for (let i = 1; i < moves.length; i++) {
            totalDRow += moves[i].to.row - moves[i-1].to.row;
            totalDCol += moves[i].to.col - moves[i-1].to.col;
        }
        
        const avgDRow = totalDRow / (moves.length - 1);
        const avgDCol = totalDCol / (moves.length - 1);
        
        if (Math.abs(avgDRow) < 0.3 && Math.abs(avgDCol) < 0.3) return null;
        
        return {
            row: Math.sign(avgDRow),
            col: Math.sign(avgDCol)
        };
    },
    
    countNearbyAllies(position, gameState) {
        let count = 0;
        for (const [dRow, dCol] of GAME_CONFIG.DIRECTIONS) {
            const checkRow = position.row + dRow;
            const checkCol = position.col + dCol;
            if (this.isValidPosition(checkRow, checkCol)) {
                const piece = gameState.board[checkRow][checkCol];
                if (piece && piece.owner === COMPUTER) count++;
            }
        }
        return count;
    },
    
    findImmediateAttackOpportunities(gameState) {
        const attacks = [];
        const aiPieces = gameState.aiPieces.filter(p => 
            !p.immobilized && !p.removed && p.row >= 0 && p.type !== FLAG
        );
        
        for (const piece of aiPieces) {
            const moves = this.getMovesForPiece(piece, gameState);
            for (const move of moves) {
                const target = gameState.board[move.row][move.col];
                if (target && target.owner === PLAYER) {
                    if (target.type === FLAG || 
                        (target.revealed && this.canWinBattle(piece, target))) {
                        attacks.push({ 
                            piece, 
                            row: move.row, 
                            col: move.col,
                            target: target
                        });
                    }
                }
            }
        }
        
        return attacks;
    },
    
    getAllPossibleMoves(state, owner) {
        const pieces = owner === COMPUTER ? state.aiPieces : state.playerPieces;
        const moves = [];
        
        for (const piece of pieces) {
            if (!piece.immobilized && !piece.removed && piece.row >= 0 && piece.col >= 0) {
                const boardPiece = state.board[piece.row] && state.board[piece.row][piece.col];
                if (!boardPiece || boardPiece.id !== piece.id) {
                    const phantomKey = `${piece.id}_${piece.row}_${piece.col}`;
                    if (!this.reportedPhantoms.has(phantomKey)) {
                        console.warn('Phantom piece detected:', piece.id, 'at', piece.row, piece.col);
                        this.reportedPhantoms.add(phantomKey);
                    }
                    continue;
                }
                
                // Используем отфильтрованные ходы для ИИ, обычные для игрока
                const pieceMoves = (owner === COMPUTER) 
                    ? this.getMovesForPiece(piece, state) 
                    : this.getPossibleMoves(piece, state);
                    
                for (const move of pieceMoves) {
                    moves.push({
                        piece: piece,
                        row: move.row,
                        col: move.col
                    });
                }
            }
        }
        
        return moves;
    },
    
    makeVirtualMove(state, move) {
        const newState = JSON.parse(JSON.stringify(state));
        
        newState.board = [];
        for (let row = 0; row < BOARD_HEIGHT; row++) {
            newState.board[row] = [];
            for (let col = 0; col < BOARD_WIDTH; col++) {
                newState.board[row][col] = null;
            }
        }
        
        [...newState.playerPieces, ...newState.aiPieces].forEach(piece => {
            if (!piece.removed && piece.row >= 0 && piece.col >= 0) {
                newState.board[piece.row][piece.col] = piece;
            }
        });
        
        const piece = newState.board[move.piece.row][move.piece.col];
        if (!piece) return newState;
        
        const target = newState.board[move.row][move.col];
        
        if (target) {
            // Не позволяем флагу атаковать в виртуальных ходах
            if (piece.type === FLAG && target.owner !== piece.owner) {
                return newState; // Не выполняем ход
            }
            
            const result = this.resolveBattle(
                piece.type === 'piece' ? piece.pieceType : piece.type,
                target.type === 'piece' ? target.pieceType : target.type
            );
            
            if (result === 'win') {
                this.removeVirtualPiece(newState, target);
                newState.board[piece.row][piece.col] = null;
                piece.row = move.row;
                piece.col = move.col;
                newState.board[move.row][move.col] = piece;
            } else if (result === 'lose') {
                this.removeVirtualPiece(newState, piece);
            }
        } else {
            newState.board[piece.row][piece.col] = null;
            piece.row = move.row;
            piece.col = move.col;
            newState.board[move.row][move.col] = piece;
        }
        
        return newState;
    },
    
    removeVirtualPiece(state, piece) {
        if (piece.owner === PLAYER) {
            const index = state.playerPieces.findIndex(p => p.id === piece.id);
            if (index > -1) state.playerPieces.splice(index, 1);
        } else {
            const index = state.aiPieces.findIndex(p => p.id === piece.id);
            if (index > -1) state.aiPieces.splice(index, 1);
        }
    },
    
    isGameOver(state) {
        const playerFlag = state.playerPieces.find(p => p.type === FLAG && !p.removed);
        const aiFlag = state.aiPieces.find(p => p.type === FLAG && !p.removed);
        return !playerFlag || !aiFlag;
    },
    
    evaluateFlagSafety(flag, state) {
        let safety = 0;
        
        const enemyPieces = flag.owner === COMPUTER ? state.playerPieces : state.aiPieces;
        const activEnemies = enemyPieces.filter(p => !p.removed && p.row >= 0);
        
        if (activEnemies.length === 0) return 100;
        
        const minEnemyDistance = Math.min(...activEnemies.map(p => 
            Math.max(Math.abs(p.row - flag.row), Math.abs(p.col - flag.col))
        ));
        safety += minEnemyDistance * 12;
        
        // Количество защитников
        const allies = flag.owner === COMPUTER ? state.aiPieces : state.playerPieces;
        const defenders = allies.filter(p => {
            if (p.removed || p.row < 0) return false;
            const distance = Math.max(Math.abs(p.row - flag.row), Math.abs(p.col - flag.col));
            return distance <= 2 && p.type !== FLAG && !p.immobilized;
        }).length;
        safety += defenders * 25;
        
        // Позиция (задний ряд безопаснее)
        if (flag.owner === COMPUTER) {
            safety += (BOARD_HEIGHT - 1 - flag.row) * 5; // row 0 = задний ряд для ИИ (ближе к 0 = безопаснее)
            // Исправляем: для ИИ ряд 0 — задний = безопаснее
            safety += (flag.row === 0 ? 20 : 0);
        }
        
        // Углы безопаснее
        if ((flag.row === 0 || flag.row === BOARD_HEIGHT - 1) && 
            (flag.col === 0 || flag.col === BOARD_WIDTH - 1)) {
            safety += 15;
        }
        
        return safety;
    },
    
    evaluateCenterControl(state) {
        let control = 0;
        const centerRows = [2, 3];
        const centerCols = [3, 4];
        
        for (const row of centerRows) {
            for (const col of centerCols) {
                const piece = state.board[row][col];
                if (piece) {
                    control += piece.owner === COMPUTER ? 1 : -1;
                }
            }
        }
        
        return control;
    },
    
    evaluateMobility(state) {
        const aiMoves = this.getAllPossibleMoves(state, COMPUTER).length;
        const playerMoves = this.getAllPossibleMoves(state, PLAYER).length;
        return aiMoves - playerMoves;
    },
    
    analyzePositionSupport(piece, state) {
        const allies = state.aiPieces.filter(p => {
            if (p.removed || p.row < 0) return false;
            const distance = Math.abs(p.row - piece.row) + Math.abs(p.col - piece.col);
            return distance <= 2 && p !== piece && p.type === 'piece' && !p.immobilized;
        });
        
        return {
            defenders: allies.length,
            canCounter: allies.filter(a => {
                if (piece.type !== 'piece') return false;
                return this.resolveBattle(a.pieceType, piece.pieceType) === 'win';
            }).length
        };
    },
    
    isPositionVisibleToPlayer(position, state) {
        for (const piece of state.playerPieces) {
            if (piece.removed || piece.row < 0) continue;
            const distance = Math.abs(piece.row - position.row) + Math.abs(piece.col - position.col);
            if (distance <= 2) return true;
        }
        return false;
    },
    
    countHiddenDefenders(position, state) {
        return state.aiPieces.filter(p => {
            if (p.removed || p.row < 0) return false;
            const distance = Math.abs(p.row - position.row) + Math.abs(p.col - position.col);
            return distance === 1 && !p.revealed && p.type === 'piece' && !p.immobilized;
        }).length;
    },
    
    findNearbyPlayerPiece(position, state) {
        for (const piece of state.playerPieces) {
            if (piece.removed || piece.row < 0) continue;
            const distance = Math.abs(piece.row - position.row) + Math.abs(piece.col - position.col);
            if (distance === 1) return piece;
        }
        return null;
    },
    
    isDefensiveMove(piece, move, state) {
        const currentEnemyDistance = this.getMinEnemyDistance(piece.row, piece.col, state);
        const newEnemyDistance = this.getMinEnemyDistance(move.row, move.col, state);
        return newEnemyDistance > currentEnemyDistance;
    },
    
    isAggressiveMove(piece, move, state) {
        const currentEnemyDistance = this.getMinEnemyDistance(piece.row, piece.col, state);
        const newEnemyDistance = this.getMinEnemyDistance(move.row, move.col, state);
        return newEnemyDistance < currentEnemyDistance;
    },
    
    getMinEnemyDistance(row, col, state) {
        const enemies = state.playerPieces.filter(p => !p.removed && p.row >= 0);
        let minDistance = Infinity;
        
        for (const enemy of enemies) {
            const distance = Math.abs(enemy.row - row) + Math.abs(enemy.col - col);
            minDistance = Math.min(minDistance, distance);
        }
        
        return minDistance;
    },
    
    analyzePlayerChoiceHistory() {
        return {
            rock: 0.33,
            paper: 0.33,
            scissors: 0.34
        };
    },
    
    predictPlayerChoice(stats) {
        let maxProb = 0;
        let prediction = 'rock';
        
        for (const [type, prob] of Object.entries(stats)) {
            if (prob > maxProb) {
                maxProb = prob;
                prediction = type;
            }
        }
        
        return prediction;
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.aiEngine = aiEngine;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = aiEngine;
}

