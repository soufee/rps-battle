import { BOARD_HEIGHT, BOARD_WIDTH, FLAG } from '../game-config.js';

/**
 * Стратегический планировщик для экспертного Ёжика
 *
 * Раз в N ходов (или при триггерах) пересчитывает текущий план:
 *   - mode: RECON | FLANK_ATTACK | DENSE_DEFENSE | ENDGAME
 *   - targetArea: клетка-цель (где скорее всего флаг игрока)
 *   - fist: 3 нераскрытые фигуры для атаки (балансированы по RPS)
 *   - defenders: 2 фигуры для защиты нашего флага
 *   - scouts: 1 разведчик (уже раскрытая фигура)
 *
 * Планировщик ничего не ходит сам — он только выдаёт контекст, которым пользуется
 * aiExpert при выборе ходов и при оценке позиций.
 */

const aiStrategy = {
    MODES: {
        RECON: 'recon',
        FLANK_ATTACK: 'flank_attack',
        DENSE_DEFENSE: 'dense_defense',
        ENDGAME: 'endgame'
    },
    
    // How often to fully recompute roles. Between rebuilds we still recompute mode.
    REPLAN_EVERY: 3,
    
    // How close fist members must remain to each other (Chebyshev).
    FIST_CONNECTED_RADIUS: 3,
    
    currentPlan: null,
    lastPlanTurn: -999,
    
    debug: false,
    
    reset() {
        this.currentPlan = null;
        this.lastPlanTurn = -999;
    },
    
    /**
     * Recompute the plan. Called at the start of every expert move.
     */
    update(gameState, beliefs, turn) {
        const currentTurn = typeof turn === 'number' ? turn : 0;
        const mode = this._pickMode(gameState, beliefs);
        const targetArea = this._pickTargetArea(gameState, beliefs, mode);
        
        const needFullRebuild = this._shouldRebuildRoles(currentTurn, gameState, mode, targetArea);
        
        if (needFullRebuild || !this.currentPlan) {
            const fist = this._pickFist(gameState, targetArea);
            const defenders = this._pickDefenders(gameState, fist);
            const scouts = this._pickScouts(gameState, fist, defenders);
            this.currentPlan = {
                mode,
                targetArea,
                fist,
                defenders,
                scouts,
                createdAt: currentTurn
            };
            this.lastPlanTurn = currentTurn;
        } else {
            this.currentPlan.mode = mode;
            this.currentPlan.targetArea = targetArea;
        }
        
        if (this.debug) {
            console.debug('[aiStrategy] update', {
                mode,
                targetArea,
                fist: this.currentPlan.fist,
                defenders: this.currentPlan.defenders,
                scouts: this.currentPlan.scouts
            });
        }
        return this.currentPlan;
    },
    
    /**
     * Role of a given AI piece in the current plan.
     * Returns 'fist' | 'defender' | 'scout' | 'free'.
     */
    getRoleForPiece(pieceId) {
        if (!this.currentPlan) {
            return 'free';
        }
        if (this.currentPlan.fist.indexOf(pieceId) !== -1) {
            return 'fist';
        }
        if (this.currentPlan.defenders.indexOf(pieceId) !== -1) {
            return 'defender';
        }
        if (this.currentPlan.scouts.indexOf(pieceId) !== -1) {
            return 'scout';
        }
        return 'free';
    },
    
    /**
     * Positional goal for a piece based on its role.
     * Returns {row, col} or null if no explicit target.
     */
    getTargetForPiece(pieceId, gameState) {
        if (!this.currentPlan) {
            return null;
        }
        const role = this.getRoleForPiece(pieceId);
        if (role === 'fist') {
            return this.currentPlan.targetArea;
        }
        if (role === 'defender') {
            const ourFlag = this._findOurFlag(gameState);
            if (ourFlag) {
                return { row: ourFlag.row, col: ourFlag.col };
            }
            return null;
        }
        if (role === 'scout') {
            return this._scoutTarget(gameState);
        }
        return null;
    },
    
    /**
     * Check whether the proposed move of a fist member keeps the fist connected.
     * Fist is connected if every pair of fist pieces is within FIST_CONNECTED_RADIUS.
     * Returns true if the fist is empty or the piece is not a fist member.
     */
    isFistConnected(pieceId, toRow, toCol, gameState) {
        if (!this.currentPlan || !this.currentPlan.fist.length) {
            return true;
        }
        if (this.currentPlan.fist.indexOf(pieceId) === -1) {
            return true;
        }
        const positions = [];
        for (const id of this.currentPlan.fist) {
            if (id === pieceId) {
                positions.push({ row: toRow, col: toCol });
                continue;
            }
            const piece = (gameState.aiPieces || []).find(p => p.id === id);
            if (piece && !piece.removed && piece.row >= 0) {
                positions.push({ row: piece.row, col: piece.col });
            }
        }
        if (positions.length <= 1) {
            return true;
        }
        for (let i = 0; i < positions.length; i++) {
            for (let j = i + 1; j < positions.length; j++) {
                const d = Math.max(
                    Math.abs(positions[i].row - positions[j].row),
                    Math.abs(positions[i].col - positions[j].col)
                );
                if (d > this.FIST_CONNECTED_RADIUS) {
                    return false;
                }
            }
        }
        return true;
    },
    
    // ==========================================================================
    //  INTERNAL HELPERS
    // ==========================================================================
    
    _pickMode(gameState, beliefs) {
        const M = this.MODES;
        const aiAlive = (gameState.aiPieces || []).filter(p => !p.removed).length;
        const playerAlive = (gameState.playerPieces || []).filter(p => !p.removed).length;
        if (aiAlive + playerAlive < 12) {
            return M.ENDGAME;
        }
        
        const ourFlag = this._findOurFlag(gameState);
        if (ourFlag) {
            let closestEnemyDist = Infinity;
            for (const enemy of gameState.playerPieces || []) {
                if (enemy.removed || enemy.row < 0) {
                    continue;
                }
                const d = Math.max(Math.abs(enemy.row - ourFlag.row), Math.abs(enemy.col - ourFlag.col));
                if (d < closestEnemyDist) {
                    closestEnemyDist = d;
                }
            }
            if (closestEnemyDist <= 2) {
                return M.DENSE_DEFENSE;
            }
        }
        
        const candidates = (beliefs && typeof beliefs.getFlagCandidates === 'function')
            ? beliefs.getFlagCandidates(gameState, 3)
            : [];
        if (candidates.length > 0 && candidates[0].pFlag >= 0.25) {
            return M.FLANK_ATTACK;
        }
        
        return M.RECON;
    },
    
    _pickTargetArea(gameState, beliefs, mode) {
        if (mode === this.MODES.DENSE_DEFENSE) {
            const ourFlag = this._findOurFlag(gameState);
            if (ourFlag) {
                return { row: ourFlag.row, col: ourFlag.col };
            }
        }
        
        const candidates = (beliefs && typeof beliefs.getFlagCandidates === 'function')
            ? beliefs.getFlagCandidates(gameState, 2)
            : [];
        if (candidates.length > 0) {
            let sumR = 0;
            let sumC = 0;
            let w = 0;
            for (const c of candidates) {
                const weight = Math.max(c.pFlag, 0.01);
                sumR += c.piece.row * weight;
                sumC += c.piece.col * weight;
                w += weight;
            }
            if (w > 0) {
                return {
                    row: Math.round(sumR / w),
                    col: Math.round(sumC / w)
                };
            }
        }
        
        // Fallback: target the center of the player's back row
        return { row: BOARD_HEIGHT - 1, col: Math.floor(BOARD_WIDTH / 2) };
    },
    
    _shouldRebuildRoles(currentTurn, gameState, mode, targetArea) {
        if (!this.currentPlan) {
            return true;
        }
        if (currentTurn - this.lastPlanTurn >= this.REPLAN_EVERY) {
            return true;
        }
        if (this.currentPlan.mode !== mode) {
            return true;
        }
        const ta = this.currentPlan.targetArea;
        if (!ta || ta.row !== targetArea.row || ta.col !== targetArea.col) {
            return true;
        }
        // If any fist member is dead, rebuild.
        for (const id of this.currentPlan.fist) {
            const piece = (gameState.aiPieces || []).find(p => p.id === id);
            if (!piece || piece.removed) {
                return true;
            }
        }
        return false;
    },
    
    _pickFist(gameState, targetArea) {
        const candidates = (gameState.aiPieces || []).filter(p =>
            !p.removed
            && p.type === 'piece'
            && !p.revealed
            && !p.immobilized
        );
        if (candidates.length === 0) {
            return [];
        }
        
        const byType = { rock: [], paper: [], scissors: [] };
        for (const p of candidates) {
            if (p.pieceType && byType[p.pieceType]) {
                byType[p.pieceType].push(p);
            }
        }
        const distTo = (p) => Math.max(
            Math.abs(p.row - targetArea.row),
            Math.abs(p.col - targetArea.col)
        );
        for (const t of Object.keys(byType)) {
            byType[t].sort((a, b) => distTo(a) - distTo(b));
        }
        
        // Prefer a balanced triangle (rock + paper + scissors) near the target.
        const fist = [];
        const haveBalance = byType.rock.length > 0 && byType.paper.length > 0 && byType.scissors.length > 0;
        if (haveBalance) {
            fist.push(byType.rock[0].id);
            fist.push(byType.paper[0].id);
            fist.push(byType.scissors[0].id);
            return fist;
        }
        // Otherwise take the three closest pieces regardless of type.
        const byDist = [...candidates].sort((a, b) => distTo(a) - distTo(b));
        for (let i = 0; i < Math.min(3, byDist.length); i++) {
            fist.push(byDist[i].id);
        }
        return fist;
    },
    
    _pickDefenders(gameState, fistIds) {
        const ourFlag = this._findOurFlag(gameState);
        if (!ourFlag) {
            return [];
        }
        const fistSet = new Set(fistIds || []);
        const candidates = (gameState.aiPieces || []).filter(p =>
            !p.removed
            && p.type === 'piece'
            && !p.immobilized
            && !fistSet.has(p.id)
        );
        const distToFlag = (p) => Math.max(
            Math.abs(p.row - ourFlag.row),
            Math.abs(p.col - ourFlag.col)
        );
        candidates.sort((a, b) => distToFlag(a) - distToFlag(b));
        return candidates.slice(0, 2).map(p => p.id);
    },
    
    _pickScouts(gameState, fistIds, defenderIds) {
        const exclude = new Set([...(fistIds || []), ...(defenderIds || [])]);
        const candidates = (gameState.aiPieces || []).filter(p =>
            !p.removed
            && p.type === 'piece'
            && !p.immobilized
            && !exclude.has(p.id)
        );
        
        // Prefer already revealed pieces — they are natural decoys.
        const revealed = candidates.filter(p => p.revealed);
        const pool = revealed.length > 0 ? revealed : candidates;
        if (pool.length === 0) {
            return [];
        }
        // Pick the one most advanced toward the player (largest row).
        pool.sort((a, b) => b.row - a.row);
        return [pool[0].id];
    },
    
    _findOurFlag(gameState) {
        return (gameState.aiPieces || []).find(p => p.type === 'flag' && !p.removed);
    },
    
    _scoutTarget(gameState) {
        // Scout pushes on the opposite flank from the fist's target.
        if (!this.currentPlan) {
            return null;
        }
        const ta = this.currentPlan.targetArea;
        if (!ta) {
            return null;
        }
        const oppositeCol = BOARD_WIDTH - 1 - ta.col;
        return { row: BOARD_HEIGHT - 1, col: oppositeCol };
    }
};

const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
g.aiStrategy = aiStrategy;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = aiStrategy;
}

