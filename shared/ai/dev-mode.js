import { GAME_CONFIG, BOARD_WIDTH, BOARD_HEIGHT, COMPUTER, PLAYER } from '../game-config.js';

// Access these dynamically from globalThis to avoid circular dependency import issues
const getBotRegistry = () => globalThis.botRegistry;
const getAiEngine = () => globalThis.aiEngine;
const getAiBeliefs = () => globalThis.aiBeliefs;
const getAiStrategy = () => globalThis.aiStrategy;

const devMode = {
    active: false,
    topBotId: null,
    bottomBotId: null,
    topSlot: null,
    bottomSlot: null,
    currentSlotName: 'top',
    
    init() {
        this.active = false;
        this.topBotId = null;
        this.bottomBotId = null;
        this.topSlot = this._makeEmptySlot();
        this.bottomSlot = this._makeEmptySlot();
        this.currentSlotName = 'top';
    },
    
    start(topBotId, bottomBotId) {
        this.active = true;
        this.topBotId = topBotId;
        this.bottomBotId = bottomBotId;
        this.topSlot = this._makeEmptySlot();
        this.bottomSlot = this._makeEmptySlot();
        this.currentSlotName = 'top';
    },
    
    stop() {
        this.active = false;
    },
    
    // ======================================================================
    //  MEMORY SLOTS
    // ======================================================================
    
    _makeEmptySlot() {
        return {
            moveHistory: [],
            enemyStillness: new Map(),
            enemyPositionSnapshot: new Map(),
            aiTurnCounter: 0,
            strategicTargets: new Map(),
            aiChoiceHistory: [],
            reportedPhantoms: new Set(),
            playerPatternAnalysis: {
                moves: [],
                attackCount: 0,
                defenseCount: 0,
                pattern: GAME_CONFIG.PLAYER_PATTERNS.RANDOM
            },
            beliefs: new Map(),
            beliefsTurn: 0,
            flankActivity: { left: 0, center: 0, right: 0 },
            strategyPlan: null,
            strategyLastPlanTurn: -999
        };
    },
    
    saveSlot(name) {
        const aiEngine = getAiEngine();
        const aiBeliefs = getAiBeliefs();
        const aiStrategy = getAiStrategy();
        if (!aiEngine || !aiBeliefs || !aiStrategy) return;

        const slot = (name === 'top') ? this.topSlot : this.bottomSlot;
        slot.moveHistory = this._cloneMoveHistory(aiEngine.moveHistory);
        slot.enemyStillness = this._cloneMap(aiEngine.enemyStillness);
        slot.enemyPositionSnapshot = this._cloneMap(aiEngine.enemyPositionSnapshot);
        slot.aiTurnCounter = aiEngine.aiTurnCounter;
        slot.strategicTargets = this._cloneMap(aiEngine.strategicTargets);
        slot.aiChoiceHistory = aiEngine.aiChoiceHistory.slice();
        slot.reportedPhantoms = new Set(aiEngine.reportedPhantoms || []);
        slot.playerPatternAnalysis = this._clonePatternAnalysis(aiEngine.playerPatternAnalysis);
        slot.beliefs = this._cloneBeliefs(aiBeliefs.beliefs);
        slot.beliefsTurn = aiBeliefs.turn;
        slot.flankActivity = { ...aiBeliefs.flankActivity };
        slot.strategyPlan = this._cloneStrategyPlan(aiStrategy.currentPlan);
        slot.strategyLastPlanTurn = aiStrategy.lastPlanTurn;
    },
    
    loadSlot(name) {
        const aiEngine = getAiEngine();
        const aiBeliefs = getAiBeliefs();
        const aiStrategy = getAiStrategy();
        if (!aiEngine || !aiBeliefs || !aiStrategy) return;

        const slot = (name === 'top') ? this.topSlot : this.bottomSlot;
        aiEngine.moveHistory = this._cloneMoveHistory(slot.moveHistory);
        aiEngine.enemyStillness = this._cloneMap(slot.enemyStillness);
        aiEngine.enemyPositionSnapshot = this._cloneMap(slot.enemyPositionSnapshot);
        aiEngine.aiTurnCounter = slot.aiTurnCounter;
        aiEngine.strategicTargets = this._cloneMap(slot.strategicTargets);
        aiEngine.aiChoiceHistory = slot.aiChoiceHistory.slice();
        aiEngine.reportedPhantoms = new Set(slot.reportedPhantoms);
        aiEngine.playerPatternAnalysis = this._clonePatternAnalysis(slot.playerPatternAnalysis);
        if (aiEngine.positionCache && typeof aiEngine.positionCache.clear === 'function') {
            aiEngine.positionCache.clear();
        }
        aiBeliefs.beliefs = this._cloneBeliefs(slot.beliefs);
        aiBeliefs.turn = slot.beliefsTurn;
        aiBeliefs.flankActivity = { ...slot.flankActivity };
        aiStrategy.currentPlan = this._cloneStrategyPlan(slot.strategyPlan);
        aiStrategy.lastPlanTurn = slot.strategyLastPlanTurn;
        this.currentSlotName = name;
    },
    
    _cloneMoveHistory(src) {
        if (!Array.isArray(src)) {
            return [];
        }
        return src.map(m => ({ ...m }));
    },
    
    _cloneMap(src) {
        const dst = new Map();
        if (!src || typeof src.forEach !== 'function') {
            return dst;
        }
        for (const [k, v] of src) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                dst.set(k, { ...v });
            } else if (Array.isArray(v)) {
                dst.set(k, v.slice());
            } else {
                dst.set(k, v);
            }
        }
        return dst;
    },
    
    _clonePatternAnalysis(src) {
        if (!src) {
            return {
                moves: [],
                attackCount: 0,
                defenseCount: 0,
                pattern: GAME_CONFIG.PLAYER_PATTERNS.RANDOM
            };
        }
        return {
            moves: (src.moves || []).map(m => ({
                from: m.from ? { ...m.from } : null,
                to: m.to ? { ...m.to } : null,
                piece: m.piece
            })),
            attackCount: src.attackCount || 0,
            defenseCount: src.defenseCount || 0,
            pattern: src.pattern || GAME_CONFIG.PLAYER_PATTERNS.RANDOM
        };
    },
    
    _cloneBeliefs(src) {
        const dst = new Map();
        if (!src || typeof src.forEach !== 'function') {
            return dst;
        }
        for (const [k, v] of src) {
            dst.set(k, {
                probs: { ...(v.probs || {}) },
                moved: !!v.moved,
                stillTurns: v.stillTurns || 0,
                lastMoveTurn: (v.lastMoveTurn == null) ? null : v.lastMoveTurn,
                firstMoveTurn: (v.firstMoveTurn == null) ? null : v.firstMoveTurn,
                lastKnownRow: v.lastKnownRow,
                lastKnownCol: v.lastKnownCol,
                battles: (v.battles || []).map(b => ({ ...b }))
            });
        }
        return dst;
    },
    
    _cloneStrategyPlan(src) {
        if (!src) {
            return null;
        }
        return {
            mode: src.mode,
            targetArea: src.targetArea ? { ...src.targetArea } : null,
            fist: (src.fist || []).slice(),
            defenders: (src.defenders || []).slice(),
            scouts: (src.scouts || []).slice(),
            createdAt: src.createdAt || 0
        };
    },
    
    // ======================================================================
    //  MIRRORED STATE (for bottom bot)
    // ======================================================================
    
    flipRow(row) {
        if (row < 0) {
            return row;
        }
        return BOARD_HEIGHT - 1 - row;
    },
    
    mirrorState(real) {
        const flip = (r) => this.flipRow(r);
        const clonePiece = (p, newOwner) => ({
            id: p.id,
            type: p.type,
            pieceType: p.pieceType,
            owner: newOwner,
            row: flip(p.row),
            col: p.col,
            revealed: p.revealed,
            immobilized: p.immobilized,
            removed: p.removed
        });
        
        const mirroredAi = (real.playerPieces || []).map(p => clonePiece(p, COMPUTER));
        const mirroredPlayer = (real.aiPieces || []).map(p => clonePiece(p, PLAYER));
        
        const board = [];
        for (let r = 0; r < BOARD_HEIGHT; r++) {
            const row = [];
            for (let c = 0; c < BOARD_WIDTH; c++) {
                row.push(null);
            }
            board.push(row);
        }
        for (const p of mirroredAi) {
            if (!p.removed && p.row >= 0) {
                board[p.row][p.col] = p;
            }
        }
        for (const p of mirroredPlayer) {
            if (!p.removed && p.row >= 0) {
                board[p.row][p.col] = p;
            }
        }
        
        return {
            phase: real.phase,
            currentPlayer: COMPUTER,
            board,
            aiPieces: mirroredAi,
            playerPieces: mirroredPlayer,
            selectedPiece: null,
            battleState: null,
            botId: this.bottomBotId,
            gameOver: !!real.gameOver,
            lastMove: null
        };
    },
    
    // ======================================================================
    //  BOT MOVE WRAPPERS
    // ======================================================================
    
    makeBottomMove(realState) {
        const botRegistry = getBotRegistry();
        if (!botRegistry) return null;

        this.saveSlot('top');
        this.loadSlot('bottom');
        
        const mirrored = this.mirrorState(realState);
        mirrored.botId = this.bottomBotId;
        
        let mirroredMove = null;
        try {
            const bot = botRegistry.get(this.bottomBotId);
            mirroredMove = bot ? bot.move(mirrored) : null;
        } catch (e) {
            console.error('[devMode] bottom bot crashed:', e);
            mirroredMove = null;
        }
        
        if (!mirroredMove) {
            this.saveSlot('bottom');
            this.loadSlot('top');
            return null;
        }
        
        const realPiece = (realState.playerPieces || []).find(p => p.id === mirroredMove.piece.id);
        if (!realPiece) {
            this.saveSlot('bottom');
            this.loadSlot('top');
            return null;
        }
        
        const realRow = this.flipRow(mirroredMove.row);
        const realCol = mirroredMove.col;
        
        this.saveSlot('bottom');
        this.loadSlot('top');
        
        return { piece: realPiece, row: realRow, col: realCol };
    },
    
    // ======================================================================
    //  EVENT NOTIFICATIONS (keep the other slot in sync)
    // ======================================================================
    
    notifyBottomOfTopMove(piece, fromRow, fromCol, toRow, toCol, realState) {
        if (!this.active) return;

        const aiBeliefs = getAiBeliefs();
        const aiEngine = getAiEngine();
        if (!aiBeliefs || !aiEngine) return;

        this.saveSlot('top');
        this.loadSlot('bottom');
        
        const mirrored = this.mirrorState(realState);
        const mFrom = this.flipRow(fromRow);
        const mTo = this.flipRow(toRow);
        aiBeliefs.onPlayerMove(piece.id, mFrom, fromCol, mTo, toCol, mirrored);
        aiEngine.playerPatternAnalysis.moves.push({
            from: { row: mFrom, col: fromCol },
            to: { row: mTo, col: toCol },
            piece: piece
        });
        
        this.saveSlot('bottom');
        this.loadSlot('top');
    },
    
    notifyBottomOfBattle(piece) {
        if (!this.active || !piece) return;

        const aiBeliefs = getAiBeliefs();
        const aiEngine = getAiEngine();
        if (!aiBeliefs || !aiEngine) return;

        this.saveSlot('top');
        this.loadSlot('bottom');
        
        const revealedType = (piece.type === 'piece') ? piece.pieceType : piece.type;
        aiBeliefs.onBattle(piece.id, revealedType, null, aiEngine.aiTurnCounter);
        
        this.saveSlot('bottom');
        this.loadSlot('top');
    },
    
    notifyBottomOfPieceRemoved(pieceId) {
        if (!this.active) return;

        const aiBeliefs = getAiBeliefs();
        if (!aiBeliefs) return;

        this.saveSlot('top');
        this.loadSlot('bottom');
        aiBeliefs.onPieceRemoved(pieceId);
        this.saveSlot('bottom');
        this.loadSlot('top');
    },
    
    // ======================================================================
    //  BOARD SETUP FOR BOTTOM BOT
    // ======================================================================
    
    chooseBottomFlagAndTrapPositions(botId) {
        const botRegistry = getBotRegistry();
        const bot = botRegistry ? botRegistry.get(botId) : null;
        const raw = bot ? bot.chooseFlagAndTrap() : { flagIndex: 0, trapIndex: 8 };
        const flipLocal = (i) => {
            const r = Math.floor(i / 8);
            const c = i % 8;
            return (1 - r) * 8 + c;
        };
        return {
            flagIndex: flipLocal(raw.flagIndex),
            trapIndex: flipLocal(raw.trapIndex)
        };
    },
    
    // ======================================================================
    //  TIE-BREAKER CHOICES
    // ======================================================================
    
    pickChoiceForSide(side, ourPieceType, opponentRevealedType, gameState) {
        const botRegistry = getBotRegistry();
        const aiEngine = getAiEngine();
        if (!botRegistry || !aiEngine) return 'rock';

        const targetSlot = (side === 'top') ? 'top' : 'bottom';
        if (this.currentSlotName !== targetSlot) {
            this.saveSlot(this.currentSlotName);
            this.loadSlot(targetSlot);
        }
 
        const botId = side === 'top' ? gameState.topBotId : gameState.bottomBotId;
        const bot = botRegistry.get(botId);
        const bs = gameState.battleState;
        const attacker = bs.attacker;
        const defender = bs.defender;
        const topPiece = attacker.owner === COMPUTER ? attacker : defender;
        const bottomPiece = attacker.owner === PLAYER ? attacker : defender;
        const ourPiece = side === 'top' ? topPiece : bottomPiece;
        const opponentPiece = side === 'top' ? bottomPiece : topPiece;
 
        return aiEngine.resolveTieChoiceForBot(bot, {
            gameState: gameState,
            ourPiece: ourPiece,
            opponentPiece: opponentPiece,
            battleRow: bs.newRow,
            battleCol: bs.newCol
        });
    },
    
    // ======================================================================
    //  GAME START: initialize beliefs for both slots
    // ======================================================================
    
    initBothBeliefs(realState) {
        const aiBeliefs = getAiBeliefs();
        const aiStrategy = getAiStrategy();
        if (!aiBeliefs || !aiStrategy) return;

        const restoreTo = this.currentSlotName;
        
        this.saveSlot(restoreTo);
        
        this.loadSlot('top');
        aiBeliefs.init(realState);
        if (aiStrategy.reset && typeof aiStrategy.reset === 'function') {
            aiStrategy.reset();
        }
        this.saveSlot('top');
        
        this.loadSlot('bottom');
        aiBeliefs.init(this.mirrorState(realState));
        if (aiStrategy.reset && typeof aiStrategy.reset === 'function') {
            aiStrategy.reset();
        }
        this.saveSlot('bottom');
        
        this.loadSlot(restoreTo === 'bottom' ? 'bottom' : 'top');
    }
};

globalThis.devMode = devMode;

export default devMode;
