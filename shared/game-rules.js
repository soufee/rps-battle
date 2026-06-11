import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  FLAG,
  TRAP,
  GAME_CONFIG
} from './game-config.js';

/**
 * Resolves a battle between two pieces.
 * @param {string} attackerType - Type of the attacking piece
 * @param {string} defenderType - Type of the defending piece
 * @returns {string} 'win', 'lose', or 'draw' for the attacker
 */
export function resolveBattle(attackerType, defenderType) {
  if (attackerType === defenderType) return 'draw';
  if (defenderType === FLAG) return 'win';
  if (defenderType === TRAP) return 'lose'; // Trap defeats everything it combats, but explodes too
  
  return GAME_CONFIG.WIN_CONDITIONS[attackerType] === defenderType ? 'win' : 'lose';
}

/**
 * Gets all legal moves for a piece at (row, col)
 * @param {number} row
 * @param {number} col
 * @param {Array} board - 2D grid of cells
 * @param {string} playerSide - 'player' (bottom) or 'opponent' (top)
 * @returns {Array} List of [toRow, toCol] moves
 */
export function getValidMoves(row, col, board, playerSide) {
  const piece = board[row]?.[col];
  if (!piece) return [];
  if (piece.type === FLAG && piece.revealed) return []; // Flag is static only if revealed
  if (piece.immobilized) return []; // Immobilized pieces (like traps after combat) cannot move
  if (piece.owner !== playerSide) return [];

  const moves = [];
  for (const [dr, dc] of GAME_CONFIG.DIRECTIONS) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < BOARD_HEIGHT && nc >= 0 && nc < BOARD_WIDTH) {
      const target = board[nr][nc];
      // Can move to empty space or capture opponent's piece
      if (!target || target.owner !== playerSide) {
        moves.push([nr, nc]);
      }
    }
  }
  return moves;
}

/**
 * Checks if a move is legal
 */
export function isMoveLegal(fromRow, fromCol, toRow, toCol, board, playerSide) {
  const validMoves = getValidMoves(fromRow, fromCol, board, playerSide);
  return validMoves.some(([r, c]) => r === toRow && c === toCol);
}

/**
 * Checks if a player has any valid moves left
 * @param {Array} board
 * @param {string} playerSide
 * @returns {boolean}
 */
export function hasValidMoves(board, playerSide) {
  for (let r = 0; r < BOARD_HEIGHT; r++) {
    for (let c = 0; c < BOARD_WIDTH; c++) {
      const piece = board[r][c];
      if (piece && piece.owner === playerSide) {
        const moves = getValidMoves(r, c, board, playerSide);
        if (moves.length > 0) return true;
      }
    }
  }
  return false;
}
