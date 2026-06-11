import prisma from '../models/db.js';
import { resolveBattle, getValidMoves } from '../../../shared/game-rules.js';
import { generateBalancedPieceTypes } from '../../../shared/game-core.js';
import { GAME_CONFIG, FLAG, TRAP } from '../../../shared/game-config.js';
import { socketAuthenticate } from '../middleware/auth.js';


const TURN_TIME_MS = 2 * 60 * 1000;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;

// Active games mapping: gameId -> room object
const activeGames = new Map();

// Mapping: userId -> gameId (to quickly find which game a user is in)
const userActiveGames = new Map();

export function isUserInActiveGame(userId) {
  const gameId = userActiveGames.get(userId);
  if (!gameId) return false;
  const room = activeGames.get(gameId);
  return !!(room && !room.gameOver);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function resetTurnTimer(room, io) {
  clearTurnTimer(room);
  if (room.phase !== 'playing' || room.gameOver) return;
  room.turnDeadline = Date.now() + TURN_TIME_MS;
  room.turnTimer = setTimeout(() => {
    if (room.gameOver) return;
    const timedOutRole = room.currentPlayer;
    const winnerRole = timedOutRole === 'p1' ? 'p2' : 'p1';
    room.logs.push(`⏱️ Время хода истекло у ${room[timedOutRole].nickname}.`);
    endGameSession(room, io, winnerRole, 'turn_timeout');
  }, TURN_TIME_MS);
}

function advanceTurn(room, io) {
  room.currentPlayer = room.currentPlayer === 'p1' ? 'p2' : 'p1';
  room.movesWithoutCapture = (room.movesWithoutCapture || 0) + 1;
  if (room.movesWithoutCapture >= 20) {
    room.logs.push(`🤝 Матч завершился ничьей: 20 ходов без взятий.`);
    endGameSession(room, io, 'draw', 'no_captures_draw');
  } else {
    resetTurnTimer(room, io);
  }
}

// Map coordinates to standard notation (e.g., A6, B5)
function formatCoord(row, col) {
  const rank = GAME_CONFIG.BOARD.HEIGHT - row;
  return `${String.fromCharCode(65 + col)}${rank}`;
}

function countActivePieces(pieces) {
  return pieces.filter(p => !p.removed && p.row >= 0).length;
}

// Check if a player's army is in a hopeless state
function isHopeless(pieces) {
  const activePieces = pieces.filter(p => !p.immobilized && !p.removed);
  
  // Only flag left
  if (activePieces.length === 1 && activePieces[0].type === FLAG) {
    return true;
  }
  
  // Only flag and immobilized trap left
  if (pieces.filter(p => !p.removed).length === 2) {
    const hasFlag = pieces.some(p => p.type === FLAG && !p.removed);
    const hasImmobilizedTrap = pieces.some(p => p.type === TRAP && p.immobilized && !p.removed);
    return hasFlag && hasImmobilizedTrap;
  }
  
  return false;
}

// Remove a piece from the board
function removePiece(room, piece) {
  room.board[piece.row][piece.col] = null;
  room.movesWithoutCapture = 0;
  
  if (piece.owner === 'p1') {
    const idx = room.p1Pieces.findIndex(p => p.id === piece.id);
    if (idx > -1) room.p1Pieces.splice(idx, 1);
  } else {
    const idx = room.p2Pieces.findIndex(p => p.id === piece.id);
    if (idx > -1) room.p2Pieces.splice(idx, 1);
  }
  
  piece.removed = true;
  piece.row = -1;
  piece.col = -1;
}

async function recordPvpOpponentPair(userId, opponentId, resultForUser) {
  const inc = {
    wins: resultForUser === 'win' ? 1 : 0,
    losses: resultForUser === 'lose' ? 1 : 0,
    draws: resultForUser === 'draw' ? 1 : 0,
    gamesPlayed: 1,
    lastPlayedAt: new Date()
  };
  await prisma.pvpOpponentStats.upsert({
    where: { userId_opponentId: { userId, opponentId } },
    create: { userId, opponentId, ...inc },
    update: {
      wins: { increment: inc.wins },
      losses: { increment: inc.losses },
      draws: { increment: inc.draws },
      gamesPlayed: { increment: 1 },
      lastPlayedAt: inc.lastPlayedAt
    }
  });
}

// End game session and update DB stats (PvP only — rating & global W/L)
async function endGameSession(room, io, winnerRole, reason) {
  room.phase = 'finished';
  room.gameOver = true;
  room.winner = winnerRole;
  room.endReason = reason;

  // Reveal all pieces
  room.p1Pieces.forEach(p => p.revealed = true);
  room.p2Pieces.forEach(p => p.revealed = true);

  // Clear reconnect timers
  if (room.reconnectTimers) {
    Object.values(room.reconnectTimers).forEach(timer => clearTimeout(timer));
    room.reconnectTimers = {};
  }

  const p1UserId = room.p1.userId;
  const p2UserId = room.p2.userId;

  let mmrChangeP1 = 0;
  let mmrChangeP2 = 0;

  if (winnerRole === 'p1') {
    mmrChangeP1 = 25;
    mmrChangeP2 = -25;
  } else if (winnerRole === 'p2') {
    mmrChangeP1 = -25;
    mmrChangeP2 = 25;
  }

  // Update DB stats & MatchHistory
  try {
    const ratingP1 = room.p1.ratingMmr || 1000;
    const ratingP2 = room.p2.ratingMmr || 1000;

    const newRatingP1 = Math.max(100, ratingP1 + mmrChangeP1);
    const newRatingP2 = Math.max(100, ratingP2 + mmrChangeP2);

    await prisma.$transaction([
      prisma.stats.update({
        where: { userId: p1UserId },
        data: {
          wins: { increment: winnerRole === 'p1' ? 1 : 0 },
          losses: { increment: winnerRole === 'p2' ? 1 : 0 },
          draws: { increment: winnerRole === 'draw' ? 1 : 0 },
          ratingMmr: newRatingP1
        }
      }),
      prisma.stats.update({
        where: { userId: p2UserId },
        data: {
          wins: { increment: winnerRole === 'p2' ? 1 : 0 },
          losses: { increment: winnerRole === 'p1' ? 1 : 0 },
          draws: { increment: winnerRole === 'draw' ? 1 : 0 },
          ratingMmr: newRatingP2
        }
      }),
      prisma.matchHistory.create({
        data: {
          player1Id: p1UserId,
          player2Id: p2UserId,
          winnerId: winnerRole === 'p1' ? p1UserId : (winnerRole === 'p2' ? p2UserId : null),
          score: winnerRole === 'p1' ? '1-0' : (winnerRole === 'p2' ? '0-1' : '0-0')
        }
      })
    ]);

    const p1Result = winnerRole === 'p1' ? 'win' : (winnerRole === 'p2' ? 'lose' : 'draw');
    const p2Result = winnerRole === 'p2' ? 'win' : (winnerRole === 'p1' ? 'lose' : 'draw');
    await recordPvpOpponentPair(p1UserId, p2UserId, p1Result);
    await recordPvpOpponentPair(p2UserId, p1UserId, p2Result);

    room.p1.ratingMmr = newRatingP1;
    room.p2.ratingMmr = newRatingP2;

    room.logs.push(`🏆 MMR обновлен: ${room.p1.nickname} (${mmrChangeP1 >= 0 ? '+' : ''}${mmrChangeP1}), ${room.p2.nickname} (${mmrChangeP2 >= 0 ? '+' : ''}${mmrChangeP2})`);
  } catch (error) {
    console.error('Error saving match stats to DB:', error);
  }

  clearTurnTimer(room);

  // Clean user session references
  userActiveGames.delete(p1UserId);
  userActiveGames.delete(p2UserId);
  import('./onlineLobby.js').then((m) => {
    m.notifyUserLeftGame(p1UserId);
    m.notifyUserLeftGame(p2UserId);
  }).catch(() => {});

  // Notify clients
  io.to(room.id).emit('game:update', {
    p1: sanitizeStateForPlayer(room, 'p1'),
    p2: sanitizeStateForPlayer(room, 'p2')
  });

  // Remove room from active games after a short delay
  setTimeout(() => {
    activeGames.delete(room.id);
  }, 10000);
}

// Check game ending conditions
function checkGameEnd(room, io) {
  if (room.p1Pieces.length === 0) {
    endGameSession(room, io, 'p2', 'no_pieces');
    return true;
  }
  
  if (room.p2Pieces.length === 0) {
    endGameSession(room, io, 'p1', 'no_pieces');
    return true;
  }
  
  const p1Hopeless = isHopeless(room.p1Pieces);
  const p2Hopeless = isHopeless(room.p2Pieces);
  
  if (p1Hopeless && p2Hopeless) {
    endGameSession(room, io, 'draw', 'hopeless');
    return true;
  }
  if (p1Hopeless) {
    endGameSession(room, io, 'p2', 'hopeless');
    return true;
  }
  if (p2Hopeless) {
    endGameSession(room, io, 'p1', 'hopeless');
    return true;
  }
  
  return false;
}

// Sanitize game state for a specific player (hiding opponent's figures)
function sanitizeStateForPlayer(room, role) {
  const sanitizedBoard = room.board.map((row) =>
    row.map((piece) => {
      if (!piece) return null;
      if (piece.owner === role || piece.revealed) {
        return piece;
      }
      return {
        id: piece.id,
        type: 'piece',
        pieceType: null,
        owner: piece.owner,
        row: piece.row,
        col: piece.col,
        revealed: false,
        immobilized: piece.immobilized,
        removed: piece.removed
      };
    })
  );

  return {
    id: room.id,
    phase: room.phase,
    currentPlayer: room.currentPlayer,
    board: sanitizedBoard,
    p1: {
      userId: room.p1.userId,
      nickname: room.p1.nickname,
      avatarUrl: room.p1.avatarUrl,
      setupDone: room.p1.setupDone,
      ratingMmr: room.p1.ratingMmr,
      pieceCount: countActivePieces(room.p1Pieces)
    },
    p2: {
      userId: room.p2.userId,
      nickname: room.p2.nickname,
      avatarUrl: room.p2.avatarUrl,
      setupDone: room.p2.setupDone,
      ratingMmr: room.p2.ratingMmr,
      pieceCount: countActivePieces(room.p2Pieces)
    },
    battleState: room.battleState ? sanitizeBattleState(room.battleState, role) : null,
    lastMove: room.lastMove,
    gameOver: room.gameOver,
    winner: room.winner,
    endReason: room.endReason,
    logs: room.logs,
    turnDeadline: room.turnDeadline ?? null,
    turnTimeMs: TURN_TIME_MS,
    movesWithoutCapture: room.movesWithoutCapture || 0
  };
}

/** Start a PvP match between two connected players (p1 = first arg, p2 = second). */
export async function createPvPMatch(io, player1, player2) {
  if (isUserInActiveGame(player1.userId) || isUserInActiveGame(player2.userId)) {
    return null;
  }

  const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

  let ratingP1 = 1000;
  let ratingP2 = 1000;
  try {
    const stats1 = await prisma.stats.findUnique({ where: { userId: player1.userId } });
    const stats2 = await prisma.stats.findUnique({ where: { userId: player2.userId } });
    if (stats1) ratingP1 = stats1.ratingMmr;
    if (stats2) ratingP2 = stats2.ratingMmr;
  } catch (err) {
    console.error('Error fetching MMR for match:', err);
  }

  const room = {
    id: roomId,
    p1: {
      userId: player1.userId,
      nickname: player1.nickname,
      avatarUrl: player1.avatarUrl,
      socketId: player1.socket?.id,
      setupDone: false,
      flagPosition: null,
      trapPosition: null,
      ratingMmr: ratingP1
    },
    p2: {
      userId: player2.userId,
      nickname: player2.nickname,
      avatarUrl: player2.avatarUrl,
      socketId: player2.socket?.id,
      setupDone: false,
      flagPosition: null,
      trapPosition: null,
      ratingMmr: ratingP2
    },
    phase: 'setup',
    currentPlayer: 'p1',
    board: Array.from({ length: GAME_CONFIG.BOARD.HEIGHT }, () => Array(GAME_CONFIG.BOARD.WIDTH).fill(null)),
    p1Pieces: [],
    p2Pieces: [],
    battleState: null,
    lastMove: null,
    gameOver: false,
    winner: null,
    endReason: null,
    movesWithoutCapture: 0,
    logs: ['🎮 Матч найден! Начинается расстановка флага и капкана.'],
    reconnectTimers: {},
    turnTimer: null,
    turnDeadline: null
  };

  activeGames.set(roomId, room);
  userActiveGames.set(player1.userId, roomId);
  userActiveGames.set(player2.userId, roomId);

  if (player1.socket) player1.socket.join(roomId);
  if (player2.socket) player2.socket.join(roomId);

  const emitMatchInit = (sock, role, opponent) => {
    if (!sock) return;
    sock.emit('match:init', {
      roomId,
      role,
      opponent: {
        userId: opponent.userId,
        nickname: opponent.nickname,
        avatarUrl: opponent.avatarUrl,
        ratingMmr: opponent.ratingMmr
      }
    });
  };

  emitMatchInit(player1.socket, 'p1', room.p2);
  emitMatchInit(player2.socket, 'p2', room.p1);

  io.to(roomId).emit('game:update', {
    p1: sanitizeStateForPlayer(room, 'p1'),
    p2: sanitizeStateForPlayer(room, 'p2')
  });

  console.log(`Match started: ${player1.nickname} vs ${player2.nickname} (${roomId})`);
  return room;
}

export function tryReconnectUser(io, socket, jwtUser) {
  const existingGameId = userActiveGames.get(jwtUser.id);
  if (!existingGameId) return false;

  const room = activeGames.get(existingGameId);
  if (!room || room.gameOver) return false;

  const role = room.p1.userId === jwtUser.id ? 'p1' : 'p2';
  room[role].socketId = socket.id;

  if (room.reconnectTimers?.[role]) {
    clearTimeout(room.reconnectTimers[role]);
    delete room.reconnectTimers[role];
  }

  socket.join(room.id);
  room.logs.push(`📶 Игрок ${jwtUser.nickname} вернулся в игру.`);

  const opp = role === 'p1' ? room.p2 : room.p1;
  socket.emit('match:init', {
    roomId: room.id,
    role,
    opponent: {
      userId: opp.userId,
      nickname: opp.nickname,
      avatarUrl: opp.avatarUrl,
      ratingMmr: opp.ratingMmr
    }
  });

  io.to(room.id).emit('game:update', {
    p1: sanitizeStateForPlayer(room, 'p1'),
    p2: sanitizeStateForPlayer(room, 'p2')
  });

  return true;
}

function sanitizeBattleState(battleState, role) {
  return {
    attacker: {
      ...battleState.attacker,
      pieceType: (battleState.attacker.owner === role || battleState.attacker.revealed) ? battleState.attacker.pieceType : null
    },
    defender: {
      ...battleState.defender,
      pieceType: (battleState.defender.owner === role || battleState.defender.revealed) ? battleState.defender.pieceType : null
    },
    newRow: battleState.newRow,
    newCol: battleState.newCol,
    isPlayerFirst: battleState.isPlayerFirst,
    drawRound: battleState.drawRound,
    p1Chosen: battleState.p1Choice !== null,
    p2Chosen: battleState.p2Choice !== null,
    myChoice: role === 'p1' ? battleState.p1Choice : battleState.p2Choice,
    lastRound: battleState.lastRound || null
  };
}

export function initSocket(io) {
  io.use(socketAuthenticate);

  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`Authenticated user connected to socket: ${user.nickname} (${socket.id})`);

    import('./onlineLobby.js').then((m) => {
      m.attachOnlineLobbyToSocket(io, socket, user);
    }).catch((err) => console.error('Lobby attach failed:', err));

    // SECRET PLACEMENT PHASE
    socket.on('game:setup_placement', ({ flagRow, flagCol, trapRow, trapCol }) => {
      const gameId = userActiveGames.get(user.id);
      if (!gameId) return;

      const room = activeGames.get(gameId);
      if (!room || room.phase !== 'setup') return;

      const role = room.p1.userId === user.id ? 'p1' : 'p2';
      const rowsAllowed = role === 'p1' ? GAME_CONFIG.BOARD.PLAYER_ROWS : GAME_CONFIG.BOARD.OPPONENT_ROWS;

      // Validate rows
      if (!rowsAllowed.includes(flagRow) || !rowsAllowed.includes(trapRow)) {
        socket.emit('game:error', { message: 'Неверная строка для расстановки в вашей зоне.' });
        return;
      }
      if (flagCol < 0 || flagCol >= GAME_CONFIG.BOARD.WIDTH || trapCol < 0 || trapCol >= GAME_CONFIG.BOARD.WIDTH) {
        socket.emit('game:error', { message: 'Неверные координаты.' });
        return;
      }
      if (flagRow === trapRow && flagCol === trapCol) {
        socket.emit('game:error', { message: 'Флаг и капкан не могут находиться в одной клетке.' });
        return;
      }

      room[role].flagPosition = [flagRow, flagCol];
      room[role].trapPosition = [trapRow, trapCol];
      room[role].setupDone = true;

      room.logs.push(`✅ Игрок ${room[role].nickname} завершил расстановку.`);

      // If both setup done, place pieces and start
      if (room.p1.setupDone && room.p2.setupDone) {
        // Place P1 Pieces
        const totalPieces = GAME_CONFIG.GAME.TOTAL_PIECES;
        const p1PieceTypes = generateBalancedPieceTypes(totalPieces - 2, 3);
        let p1PieceIdx = 0;
        
        room.p1Pieces = [];
        for (let i = 0; i < totalPieces; i++) {
          const col = i % 8;
          const row = Math.floor(i / 8) + 4; // rows 4 & 5
          
          let type;
          let pieceType = null;
          if (row === room.p1.flagPosition[0] && col === room.p1.flagPosition[1]) {
            type = FLAG;
          } else if (row === room.p1.trapPosition[0] && col === room.p1.trapPosition[1]) {
            type = TRAP;
          } else {
            type = 'piece';
            pieceType = p1PieceTypes[p1PieceIdx++];
          }
          
          const piece = {
            id: `p1_${i}`,
            type: type,
            pieceType: pieceType,
            owner: 'p1',
            row: row,
            col: col,
            revealed: false,
            immobilized: false,
            removed: false
          };
          
          room.p1Pieces.push(piece);
          room.board[row][col] = piece;
        }

        // Place P2 Pieces
        const p2PieceTypes = generateBalancedPieceTypes(totalPieces - 2, 3);
        let p2PieceIdx = 0;
        
        room.p2Pieces = [];
        for (let i = 0; i < totalPieces; i++) {
          const col = i % 8;
          const row = Math.floor(i / 8); // rows 0 & 1
          
          let type;
          let pieceType = null;
          if (row === room.p2.flagPosition[0] && col === room.p2.flagPosition[1]) {
            type = FLAG;
          } else if (row === room.p2.trapPosition[0] && col === room.p2.trapPosition[1]) {
            type = TRAP;
          } else {
            type = 'piece';
            pieceType = p2PieceTypes[p2PieceIdx++];
          }
          
          const piece = {
            id: `p2_${i}`,
            type: type,
            pieceType: pieceType,
            owner: 'p2',
            row: row,
            col: col,
            revealed: false,
            immobilized: false,
            removed: false
          };
          
          room.p2Pieces.push(piece);
          room.board[row][col] = piece;
        }

        room.phase = 'playing';
        room.movesWithoutCapture = 0;
        room.logs.push('⚔️ Бой начался! Ход Игрока 1.');
        resetTurnTimer(room, io);
      }

      io.to(room.id).emit('game:update', {
        p1: sanitizeStateForPlayer(room, 'p1'),
        p2: sanitizeStateForPlayer(room, 'p2')
      });
    });

    // MAKE GAME MOVE
    socket.on('game:make_move', ({ fromRow, fromCol, toRow, toCol }) => {
      const gameId = userActiveGames.get(user.id);
      if (!gameId) return;

      const room = activeGames.get(gameId);
      if (!room || room.phase !== 'playing') return;

      const role = room.p1.userId === user.id ? 'p1' : 'p2';
      
      // Validation: Is it my turn?
      if (room.currentPlayer !== role) {
        socket.emit('game:error', { message: 'Сейчас не ваш ход.' });
        return;
      }

      // Validation: Is there a tie break active?
      if (room.battleState) {
        socket.emit('game:error', { message: 'Сначала переиграйте ничью.' });
        return;
      }

      const piece = room.board[fromRow]?.[fromCol];
      if (!piece || piece.owner !== role) {
        socket.emit('game:error', { message: 'Вы не управляете этой фигурой.' });
        return;
      }

      // Check if move is legal
      const validMoves = getValidMoves(fromRow, fromCol, room.board, role);
      const isLegal = validMoves.some(([r, c]) => r === toRow && c === toCol);
      if (!isLegal) {
        socket.emit('game:error', { message: 'Недопустимый ход.' });
        return;
      }

      const targetPiece = room.board[toRow][toCol];
      const oldRow = fromRow;
      const oldCol = fromCol;
      const pieceName = piece.type === FLAG ? 'Флаг' : piece.type === TRAP ? 'Капкан' : 'Фигуру';

      if (!targetPiece) {
        // Simple Move
        room.board[fromRow][fromCol] = null;
        piece.row = toRow;
        piece.col = toCol;
        room.board[toRow][toCol] = piece;
        
        room.lastMove = { from: [oldRow, oldCol], to: [toRow, toCol] };
        room.logs.push(`🏃 ${room[role].nickname} передвинул ${pieceName} с ${formatCoord(oldRow, oldCol)} на ${formatCoord(toRow, toCol)}.`);

        checkGameEnd(room, io);
        if (!room.gameOver) advanceTurn(room, io);
      } else {
        // Battle!
        piece.revealed = true;
        targetPiece.revealed = true;
        const opponentRole = role === 'p1' ? 'p2' : 'p1';

        const pieceSymbols = { flag: '🏴', trap: '💥', rock: '🗿', paper: '📄', scissors: '✂️' };

        // 1. Target is FLAG
        if (targetPiece.type === FLAG) {
          removePiece(room, targetPiece);
          room.board[piece.row][piece.col] = null;
          piece.row = toRow;
          piece.col = toCol;
          room.board[toRow][toCol] = piece;

          room.lastMove = { from: [oldRow, oldCol], to: [toRow, toCol] };
          room.logs.push(`🚩 ${room[role].nickname} захватил Флаг игрока ${room[opponentRole].nickname} на ${formatCoord(toRow, toCol)}!`);
          
          endGameSession(room, io, role, 'flag_captured');
          return;
        }

        // 2. Target is TRAP
        if (targetPiece.type === TRAP) {
          removePiece(room, piece);
          targetPiece.immobilized = true;

          room.lastMove = { from: [oldRow, oldCol], to: [toRow, toCol] };
          room.logs.push(`💥 ${room[role].nickname} (${pieceSymbols[piece.pieceType] || '?'}) подорвался на Капкане на ${formatCoord(toRow, toCol)}!`);
          
          checkGameEnd(room, io);
          if (!room.gameOver) advanceTurn(room, io);
        }
        
        // 3. Attacking piece is TRAP (Should not happen since traps can't move, but for robustness)
        else if (piece.type === TRAP) {
          removePiece(room, targetPiece);
          room.board[piece.row][piece.col] = null;
          piece.row = toRow;
          piece.col = toCol;
          room.board[toRow][toCol] = piece;
          piece.immobilized = true;

          room.lastMove = { from: [oldRow, oldCol], to: [toRow, toCol] };
          room.logs.push(`💥 Капкан игрока ${room[role].nickname} поглотил фигуру на ${formatCoord(toRow, toCol)}.`);
          
          checkGameEnd(room, io);
          if (!room.gameOver) advanceTurn(room, io);
        }

        // 4. RPS Battle
        else {
          const result = resolveBattle(piece.pieceType, targetPiece.pieceType);

          if (result === 'win') {
            removePiece(room, targetPiece);
            room.board[piece.row][piece.col] = null;
            piece.row = toRow;
            piece.col = toCol;
            room.board[toRow][toCol] = piece;

            room.lastMove = { from: [oldRow, oldCol], to: [toRow, toCol] };
            room.logs.push(`⚔️ Битва: ${room[role].nickname} (${pieceSymbols[piece.pieceType]}) одолел ${room[opponentRole].nickname} (${pieceSymbols[targetPiece.pieceType]}) на ${formatCoord(toRow, toCol)}!`);
            
            checkGameEnd(room, io);
            if (!room.gameOver) advanceTurn(room, io);
          } else if (result === 'lose') {
            removePiece(room, piece);

            room.lastMove = { from: [oldRow, oldCol], to: [toRow, toCol] };
            room.logs.push(`⚔️ Битва: ${room[opponentRole].nickname} (${pieceSymbols[targetPiece.pieceType]}) защитился от ${room[role].nickname} (${pieceSymbols[piece.pieceType]}) на ${formatCoord(toRow, toCol)}!`);
            
            checkGameEnd(room, io);
            if (!room.gameOver) advanceTurn(room, io);
          } else {
            // Draw / Tie-break initialization
            room.battleState = {
              attacker: piece,
              defender: targetPiece,
              newRow: toRow,
              newCol: toCol,
              isPlayerFirst: role === 'p1',
              p1Choice: null,
              p2Choice: null,
              drawRound: 1
            };

            room.logs.push(`🤝 Ничья в битве: ${room[role].nickname} (${pieceSymbols[piece.pieceType]}) vs ${room[opponentRole].nickname} (${pieceSymbols[targetPiece.pieceType]}) на ${formatCoord(toRow, toCol)}! Начинается выбор переигрывания.`);
          }
        }
      }

      io.to(room.id).emit('game:update', {
        p1: sanitizeStateForPlayer(room, 'p1'),
        p2: sanitizeStateForPlayer(room, 'p2')
      });
    });

    // CHOOSE FIGURE TYPE DURING TIE BREAK
    socket.on('game:make_choice', ({ choice }) => {
      const gameId = userActiveGames.get(user.id);
      if (!gameId) return;

      const room = activeGames.get(gameId);
      if (!room || room.phase !== 'playing' || !room.battleState) return;

      if (!['rock', 'paper', 'scissors'].includes(choice)) {
        socket.emit('game:error', { message: 'Неверный выбор фигуры.' });
        return;
      }

      const role = room.p1.userId === user.id ? 'p1' : 'p2';

      if (role === 'p1') {
        room.battleState.p1Choice = choice;
      } else {
        room.battleState.p2Choice = choice;
      }

      room.logs.push(`✍️ Игрок ${room[role].nickname} сделал выбор для переигровки.`);

      // Both players made choice
      if (room.battleState.p1Choice && room.battleState.p2Choice) {
        const { attacker, defender, newRow, newCol } = room.battleState;
        
        const p1Choice = room.battleState.p1Choice;
        const p2Choice = room.battleState.p2Choice;

        const attackerChoice = attacker.owner === 'p1' ? p1Choice : p2Choice;
        const defenderChoice = defender.owner === 'p1' ? p1Choice : p2Choice;

        // Apply updated choices to pieces
        attacker.pieceType = attackerChoice;
        defender.pieceType = defenderChoice;

        const result = resolveBattle(attackerChoice, defenderChoice);
        const drawRound = room.battleState.drawRound;

        const pieceSymbols = { rock: '🗿', paper: '📄', scissors: '✂️' };

        const p1Name = room.p1.nickname;
        const p2Name = room.p2.nickname;
        const attackerName = attacker.owner === 'p1' ? p1Name : p2Name;
        const defenderName = defender.owner === 'p1' ? p1Name : p2Name;

        if (result === 'win') {
          // Attacker wins tie break
          removePiece(room, defender);
          const oldRow = attacker.row;
          const oldCol = attacker.col;
          
          room.board[attacker.row][attacker.col] = null;
          attacker.row = newRow;
          attacker.col = newCol;
          room.board[newRow][newCol] = attacker;

          room.lastMove = { from: [oldRow, oldCol], to: [newRow, newCol] };
          room.logs.push(`⚔️ Переигровка: ${attackerName} (${pieceSymbols[attackerChoice]}) одолел ${defenderName} (${pieceSymbols[defenderChoice]})!`);

          room.battleState = null;
          checkGameEnd(room, io);
          if (!room.gameOver) advanceTurn(room, io);
        } else if (result === 'lose') {
          // Defender wins tie break
          removePiece(room, attacker);
          
          room.lastMove = { from: [attacker.row, attacker.col], to: [defender.row, defender.col] };
          room.logs.push(`⚔️ Переигровка: ${defenderName} (${pieceSymbols[defenderChoice]}) защитился от ${attackerName} (${pieceSymbols[attackerChoice]})!`);

          room.battleState = null;
          checkGameEnd(room, io);
          if (!room.gameOver) advanceTurn(room, io);
        } else {
          // Draw again
          const nextRound = drawRound + 1;
          
          if (nextRound > 6) {
            // Mutual annihilation
            const attRow = attacker.row;
            const attCol = attacker.col;
            const defRow = defender.row;
            const defCol = defender.col;

            removePiece(room, attacker);
            removePiece(room, defender);

            room.lastMove = { from: [attRow, attCol], to: [defRow, defCol] };
            room.logs.push(`💥 Взаимоуничтожение фигур ${attackerName} и ${defenderName} после 6 ничьих!`);

            room.battleState = null;
            checkGameEnd(room, io);
            if (!room.gameOver) advanceTurn(room, io);
          } else {
            // Setup next tie break round
            room.battleState.lastRound = {
              p1Choice,
              p2Choice,
              attackerChoice,
              defenderChoice
            };
            room.battleState.drawRound = nextRound;
            room.battleState.p1Choice = null;
            room.battleState.p2Choice = null;
            room.logs.push(`🤝 Снова ничья (${pieceSymbols[attackerChoice]} vs ${pieceSymbols[defenderChoice]})! Раунд переигровки: ${nextRound}.`);
          }
        }
      }

      io.to(room.id).emit('game:update', {
        p1: sanitizeStateForPlayer(room, 'p1'),
        p2: sanitizeStateForPlayer(room, 'p2')
      });
    });

    // SURRENDER GAME
    socket.on('game:surrender', () => {
      const gameId = userActiveGames.get(user.id);
      if (!gameId) return;

      const room = activeGames.get(gameId);
      if (!room || room.gameOver) return;

      const role = room.p1.userId === user.id ? 'p1' : 'p2';
      const winnerRole = role === 'p1' ? 'p2' : 'p1';

      room.logs.push(`🏳️ Игрок ${room[role].nickname} сдался.`);
      endGameSession(room, io, winnerRole, 'surrender');
    });

    // DISCONNECT AND TIMEOUT
    socket.on('disconnect', () => {
      console.log(`User socket disconnected: ${user.nickname} (${socket.id})`);

      const gameId = userActiveGames.get(user.id);
      if (gameId) {
        const room = activeGames.get(gameId);
        if (room && !room.gameOver && room.phase === 'playing') {
          const role = room.p1.userId === user.id ? 'p1' : 'p2';
          const opponentRole = role === 'p1' ? 'p2' : 'p1';

          room.logs.push(`⚠️ Игрок ${user.nickname} временно отключился.`);

          io.to(room.id).emit('game:update', {
            p1: sanitizeStateForPlayer(room, 'p1'),
            p2: sanitizeStateForPlayer(room, 'p2')
          });

          io.to(room.id).emit('game:opponent_disconnected', { graceMs: RECONNECT_GRACE_MS });

          if (!room.reconnectTimers) room.reconnectTimers = {};

          room.reconnectTimers[role] = setTimeout(async () => {
            console.log(`User ${user.nickname} failed to reconnect in time.`);
            room.logs.push(`⏱️ Игрок ${user.nickname} не успел вернуться в игру (${RECONNECT_GRACE_MS / 60000} мин).`);
            await endGameSession(room, io, opponentRole, 'disconnect_timeout');
          }, RECONNECT_GRACE_MS);
        }
      }
    });
  });
}
