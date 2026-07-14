/**
 * Strategist — «Стратег»
 *
 * Author: Neomotron
 *
 * Concept: role-based heuristic bot with persistent memory:
 *   - Assigns roles (scout / attacker / defender / flag_guard) by start position
 *   - Tracks revealed enemy types, suspected traps and flag
 *   - Prioritizes flag capture, winning captures, trap probing, smart reveals
 *   - Counters opponent's most common revealed type in tie-breaks
 */

if (typeof window !== 'undefined' && !window.RPSBotAPI) {
  console.error('[strategist] bot-api.js must be loaded BEFORE this bot');
}

if (typeof RPSBotAPI === 'undefined') {
  throw new Error('[strategist] bot-api.js must be loaded before this bot');
}

const {
  RULES,
  resolveBattle,
  getLegalMoves,
  isLegalStep,
  canAttack,
  placementIndexToCoord
} = RPSBotAPI;

// ============================================
// STRATEGIST BOT - Advanced RPS Battle Bot
// ============================================

const STRATEGIST_BOT = {
  id: 'strategist',
  name: 'Стратег',
  emoji: '🧠',

  // ----------------------------
  // Persistent memory across moves
  // ----------------------------
  _memory: {
    enemyPieceTypes: new Map(), // pieceId -> {type, confidence, lastSeenTurn}
    suspectedTrapPositions: new Set(), // positions where trap likely exists
    suspectedFlagPosition: null, // suspected flag position
    turnCount: 0,
    lastMove: null,
    myPieceRoles: new Map(), // pieceId -> role: 'scout', 'attacker', 'defender', 'flag_guard'
    knownEnemyPieces: new Map(), // pieceId -> full piece info when revealed
    captureHistory: [], // track captures for pattern analysis
  },

  // ----------------------------
  // Placement Strategy
  // ----------------------------
  chooseFlagAndTrap() {
    // Flag in corner (0,0) - hardest to reach, protected by trap nearby
    // Trap at (1, 1) - covers diagonal approach to flag and center
    // Alternative: flag at (0,7), trap at (1,6) - mirror
    const flagIndex = 0;      // row 0, col 0
    const trapIndex = 9;      // row 1, col 1 (Math.floor(9/8)=1, 9%8=1)

    return { flagIndex, trapIndex };
  },

  // ----------------------------
  // Main Move Logic
  // ----------------------------
  move(gameState) {
    try {
      this._memory.turnCount++;
      this._updateMemory(gameState);

      const myPieces = gameState.aiPieces.filter(p => 
        !p.removed && !p.immobilized && p.type === 'piece' && p.row >= 0
      );

      if (myPieces.length === 0) return null;

      // Assign roles to pieces if not assigned
      this._assignRoles(myPieces, gameState);

      // Priority 1: Capture revealed enemy flag -> INSTANT WIN
      const flagCapture = this._findFlagCapture(myPieces, gameState);
      if (flagCapture) return flagCapture;

      // Priority 2: Winning captures on revealed pieces (guaranteed wins)
      const winningCapture = this._findWinningCapture(myPieces, gameState);
      if (winningCapture) return winningCapture;

      // Priority 3: Attack suspected trap with expendable piece (scout)
      const trapAttack = this._findTrapAttack(myPieces, gameState);
      if (trapAttack) return trapAttack;

      // Priority 4: Reveal hidden enemy pieces intelligently
      const revealMove = this._findRevealMove(myPieces, gameState);
      if (revealMove) return revealMove;

      // Priority 5: Advance toward enemy territory with purpose
      const advanceMove = this._findAdvanceMove(myPieces, gameState);
      if (advanceMove) return advanceMove;

      // Priority 6: Defensive repositioning
      const defensiveMove = this._findDefensiveMove(myPieces, gameState);
      if (defensiveMove) return defensiveMove;

      // Fallback: any legal move
      return this._getAnyLegalMove(myPieces, gameState);
    } catch (e) {
      console.error('[strategist] move error:', e);
      return this._getSafeFallbackMove(gameState);
    }
  },

  // ----------------------------
  // Tie-Break Intelligence
  // ----------------------------
  getSmartTieChoice(currentType, opponentRevealed, opponentType, gameState) {
    // In tie-break, we don't know opponent's CURRENT choice (opponentType may be stale)
    // Strategy: Counter the most likely type based on opponent's historical patterns

    const enemyStats = this._analyzeEnemyTypeDistribution(gameState);

    // If opponent has shown a strong preference, counter their most common type
    if (enemyStats.mostCommon) {
      const counter = this._getCounterType(enemyStats.mostCommon);
      // Add slight randomization to be unpredictable
      if (Math.random() < 0.85) return counter;
    }

    // Default: cycle through types to avoid being predicted
    const types = ['rock', 'paper', 'scissors'];
    const currentIndex = types.indexOf(currentType);
    return types[(currentIndex + 1) % 3];
  },

  // ============================================
  // HELPER METHODS
  // ============================================

  _updateMemory(gameState) {
    // Update known enemy pieces from revealed ones
    for (const piece of gameState.playerPieces) {
      if (piece.revealed && piece.type === 'piece' && piece.pieceType) {
        this._memory.knownEnemyPieces.set(piece.id, {
          type: piece.pieceType,
          row: piece.row,
          col: piece.col,
          turn: this._memory.turnCount
        });
        this._memory.enemyPieceTypes.set(piece.id, {
          type: piece.pieceType,
          confidence: 1.0,
          lastSeenTurn: this._memory.turnCount
        });
      }
    }

    // Track captures
    if (gameState.lastMove) {
      const target = gameState.board[gameState.lastMove.to[0]]?.[gameState.lastMove.to[1]];
      if (target && target.removed) {
        this._memory.captureHistory.push({
          turn: this._memory.turnCount,
          from: gameState.lastMove.from,
          to: gameState.lastMove.to,
          targetType: target.pieceType,
          targetOwner: target.owner
        });
      }
    }

    // Infer trap positions from immobilized pieces that survived attacks
    for (const piece of gameState.aiPieces) {
      if (piece.immobilized && piece.type === 'piece') {
        // This piece attacked a trap and got immobilized
        const trapPos = `${piece.row},${piece.col}`;
        this._memory.suspectedTrapPositions.add(trapPos);
      }
    }

    // Infer flag position: enemy pieces that never move and are well-protected
    this._inferFlagPosition(gameState);
  },

  _inferFlagPosition(gameState) {
    // Look for enemy pieces that:
    // 1. Never moved (stay in back rows 4-5)
    // 2. Are surrounded/protected
    // 3. Haven't been revealed as combat pieces
    const candidates = gameState.playerPieces.filter(p => 
      !p.removed && 
      p.row >= 4 && 
      (p.type === 'flag' || (!p.revealed && p.type === 'piece'))
    );

    if (candidates.length > 0) {
      // Prefer corner positions
      candidates.sort((a, b) => {
        const aCorner = (a.col === 0 || a.col === 7) && (a.row === 4 || a.row === 5) ? 0 : 1;
        const bCorner = (b.col === 0 || b.col === 7) && (b.row === 4 || b.row === 5) ? 0 : 1;
        return aCorner - bCorner;
      });
      this._memory.suspectedFlagPosition = { row: candidates[0].row, col: candidates[0].col };
    }
  },

  _assignRoles(myPieces, gameState) {
    for (const piece of myPieces) {
      if (!this._memory.myPieceRoles.has(piece.id)) {
        // Assign based on initial position
        if (piece.row === 0) {
          // Back row: defenders and flag guards
          this._memory.myPieceRoles.set(piece.id, piece.col < 4 ? 'flag_guard' : 'defender');
        } else {
          // Front row: scouts and attackers
          this._memory.myPieceRoles.set(piece.id, piece.col % 2 === 0 ? 'scout' : 'attacker');
        }
      }
    }
  },

  _findFlagCapture(myPieces, gameState) {
    // Look for revealed enemy flag
    for (const piece of myPieces) {
      const moves = getLegalMoves(piece, gameState);
      for (const dest of moves) {
        const target = gameState.board[dest.row]?.[dest.col];
        if (target && target.owner === 'player' && target.type === 'flag' && target.revealed) {
          return { piece, row: dest.row, col: dest.col };
        }
      }
    }
    return null;
  },

  _findWinningCapture(myPieces, gameState) {
    // Capture revealed enemy pieces we can BEAT
    let bestCapture = null;
    let bestScore = -1;

    for (const piece of myPieces) {
      const moves = getLegalMoves(piece, gameState);
      for (const dest of moves) {
        const target = gameState.board[dest.row]?.[dest.col];
        if (target && target.owner === 'player' && target.revealed && target.type === 'piece' && target.pieceType) {
          const result = resolveBattle(piece.pieceType, target.pieceType);
          if (result === 'win') {
            // Score: prioritize capturing strong pieces, advancing pieces
            let score = 10;
            // Bonus for advancing forward
            score += (dest.row - piece.row) * 2;
            // Bonus for capturing pieces near enemy flag
            if (this._memory.suspectedFlagPosition) {
              const distToFlag = Math.max(
                Math.abs(dest.row - this._memory.suspectedFlagPosition.row),
                Math.abs(dest.col - this._memory.suspectedFlagPosition.col)
              );
              score += (5 - distToFlag) * 2;
            }
            if (score > bestScore) {
              bestScore = score;
              bestCapture = { piece, row: dest.row, col: dest.col };
            }
          }
        }
      }
    }
    return bestCapture;
  },

  _findTrapAttack(myPieces, gameState) {
    // Use scouts to probe suspected trap positions
    const scouts = myPieces.filter(p => 
      this._memory.myPieceRoles.get(p.id) === 'scout' && !p.immobilized
    );

    for (const scout of scouts) {
      const moves = getLegalMoves(scout, gameState);
      for (const dest of moves) {
        const posKey = `${dest.row},${dest.col}`;
        if (this._memory.suspectedTrapPositions.has(posKey)) {
          // Attack suspected trap with scout
          const target = gameState.board[dest.row]?.[dest.col];
          if (target && target.owner === 'player') {
            return { piece: scout, row: dest.row, col: dest.col };
          }
        }
      }
    }
    return null;
  },

  _findRevealMove(myPieces, gameState) {
    // Attack hidden pieces to reveal them, but prefer:
    // 1. Pieces we likely beat (based on type distribution)
    // 2. Pieces in forward positions
    // 3. Avoid likely traps

    const enemyTypeDist = this._analyzeEnemyTypeDistribution(gameState);
    let bestMove = null;
    let bestScore = -1;

    for (const piece of myPieces) {
      const moves = getLegalMoves(piece, gameState);
      for (const dest of moves) {
        const target = gameState.board[dest.row]?.[dest.col];
        if (target && target.owner === 'player' && !target.revealed && target.type === 'piece') {
          const posKey = `${dest.row},${dest.col}`;

          // Skip if suspected trap
          if (this._memory.suspectedTrapPositions.has(posKey)) continue;

          // Calculate win probability against hidden piece
          let winProb = 0;
          if (enemyTypeDist.total > 0) {
            for (const [type, count] of Object.entries(enemyTypeDist.counts)) {
              const prob = count / enemyTypeDist.total;
              const result = resolveBattle(piece.pieceType, type);
              if (result === 'win') winProb += prob;
              else if (result === 'draw') winProb += prob * 0.5;
            }
          } else {
            winProb = 1/3; // Uniform prior
          }

          // Score combines win probability and positional value
          let score = winProb * 20;
          score += (dest.row - piece.row) * 3; // Forward progress

          // Penalty for moving into dangerous zones (enemy back rows without support)
          if (dest.row >= 4) {
            const support = this._countNearbyAllies(dest.row, dest.col, myPieces);
            if (support === 0) score -= 10;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMove = { piece, row: dest.row, col: dest.col };
          }
        }
      }
    }
    return bestMove;
  },

  _findAdvanceMove(myPieces, gameState) {
    // Move pieces toward enemy territory with purpose
    let bestMove = null;
    let bestScore = -1;

    for (const piece of myPieces) {
      const role = this._memory.myPieceRoles.get(piece.id) || 'attacker';
      const moves = getLegalMoves(piece, gameState)
        .filter(d => !gameState.board[d.row]?.[d.col]); // Empty squares only

      for (const dest of moves) {
        let score = 0;

        // Role-based scoring
        switch (role) {
          case 'scout':
            score += (dest.row - piece.row) * 5; // Rush forward
            score += this._countNearbyEnemies(dest.row, dest.col, gameState) * 3; // Seek contact
            break;
          case 'attacker':
            score += (dest.row - piece.row) * 3;
            score += this._countNearbyEnemies(dest.row, dest.col, gameState) * 5;
            break;
          case 'defender':
            score += (dest.row - piece.row) * 2;
            // Stay near center to control board
            score -= Math.abs(dest.col - 3.5) * 2;
            break;
          case 'flag_guard':
            // Stay near flag (row 0, col 0)
            const flagDist = Math.max(Math.abs(dest.row - 0), Math.abs(dest.col - 0));
            score -= flagDist * 3;
            break;
        }

        // General bonuses
        // Avoid moving onto suspected traps
        const posKey = `${dest.row},${dest.col}`;
        if (this._memory.suspectedTrapPositions.has(posKey)) score -= 50;

        // Prefer moves that maintain formation
        const allies = this._countNearbyAllies(dest.row, dest.col, myPieces);
        score += allies * 2;

        if (score > bestScore) {
          bestScore = score;
          bestMove = { piece, row: dest.row, col: dest.col };
        }
      }
    }
    return bestMove;
  },

  _findDefensiveMove(myPieces, gameState) {
    // Protect flag and key pieces
    // Move pieces to block enemy advance toward our flag
    const flagPos = { row: 0, col: 0 }; // Our flag position

    let bestMove = null;
    let bestScore = -1;

    for (const piece of myPieces) {
      const moves = getLegalMoves(piece, gameState)
        .filter(d => !gameState.board[d.row]?.[d.col]);

      for (const dest of moves) {
        let score = 0;

        // Block enemy paths to flag
        for (const enemy of gameState.playerPieces) {
          if (enemy.removed || enemy.type !== 'piece') continue;
          const distToFlag = Math.max(Math.abs(enemy.row - flagPos.row), Math.abs(enemy.col - flagPos.col));
          const myDistToFlag = Math.max(Math.abs(dest.row - flagPos.row), Math.abs(dest.col - flagPos.col));
          if (myDistToFlag < distToFlag && myDistToFlag <= 3) {
            score += 10; // Intercepting
          }
        }

        // Stay mobile (don't get immobilized)
        const futureMoves = getLegalMoves({...piece, row: dest.row, col: dest.col}, gameState);
        score += futureMoves.length * 0.5;

        if (score > bestScore) {
          bestScore = score;
          bestMove = { piece, row: dest.row, col: dest.col };
        }
      }
    }
    return bestMove;
  },

  _getAnyLegalMove(myPieces, gameState) {
    for (const piece of myPieces) {
      const moves = getLegalMoves(piece, gameState);
      if (moves.length > 0) {
        // Prefer forward moves
        moves.sort((a, b) => b.row - a.row);
        return { piece, row: moves[0].row, col: moves[0].col };
      }
    }
    return null;
  },

  _getSafeFallbackMove(gameState) {
    const myPieces = gameState.aiPieces.filter(p => !p.removed && !p.immobilized && p.type === 'piece');
    return this._getAnyLegalMove(myPieces, gameState);
  },

  // Utility functions
  _analyzeEnemyTypeDistribution(gameState) {
    const counts = { rock: 0, paper: 0, scissors: 0 };
    let total = 0;

    for (const piece of gameState.playerPieces) {
      if (piece.revealed && piece.type === 'piece' && piece.pieceType) {
        counts[piece.pieceType]++;
        total++;
      }
    }

    let mostCommon = null;
    let maxCount = 0;
    for (const [type, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = type;
      }
    }

    return { counts, total, mostCommon };
  },

  _getCounterType(type) {
    const counters = { rock: 'paper', paper: 'scissors', scissors: 'rock' };
    return counters[type];
  },

  _countNearbyAllies(row, col, myPieces) {
    let count = 0;
    for (const piece of myPieces) {
      const dist = Math.max(Math.abs(piece.row - row), Math.abs(piece.col - col));
      if (dist <= 2) count++;
    }
    return count;
  },

  _countNearbyEnemies(row, col, gameState) {
    let count = 0;
    for (const piece of gameState.playerPieces) {
      if (piece.removed) continue;
      const dist = Math.max(Math.abs(piece.row - row), Math.abs(piece.col - col));
      if (dist <= 2) count++;
    }
    return count;
  }
};

// Register the bot
RPSBotAPI.defineBot(STRATEGIST_BOT);
