import crypto from 'crypto';
import prisma from '../models/db.js';
import {
  createPvPMatch,
  isUserInActiveGame,
  tryReconnectUser
} from './gameManager.js';

const MAX_OPEN_ROOMS = 10;
const MAX_PRESENCE_VISIBLE = 20;
const QUEUE_TIMEOUT_MS = 5 * 60 * 1000;

function randomCode(len = 6) {
  return crypto.randomBytes(4).toString('hex').slice(0, len).toUpperCase();
}

function playerPayload(entry) {
  if (!entry) return null;
  return {
    id: entry.userId,
    name: entry.nickname,
    avatar: entry.avatarUrl,
    ratingMmr: entry.ratingMmr ?? 1000,
    inGame: !!entry.inGame
  };
}

class OnlineLobbyManager {
  constructor(io) {
    this.io = io;
    this.onlineUsers = new Map(); // userId -> entry
    this.userToSockets = new Map(); // userId -> Set<socket>
    this.waitingRooms = new Map(); // roomId -> room
    this.roomCodes = new Map(); // code -> roomId
    this.queue = [];
  }

  async _loadUserMeta(userId) {
    try {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        include: { stats: true }
      });
      if (!row) return { avatarUrl: null, ratingMmr: 1000 };
      return {
        avatarUrl: row.avatarUrl,
        ratingMmr: row.stats?.ratingMmr ?? 1000
      };
    } catch {
      return { avatarUrl: null, ratingMmr: 1000 };
    }
  }

  _trackSocket(userId, socket) {
    if (!this.userToSockets.has(userId)) {
      this.userToSockets.set(userId, new Set());
    }
    this.userToSockets.get(userId).add(socket);
  }

  _untrackSocket(userId, socket) {
    const set = this.userToSockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.userToSockets.delete(userId);
  }

  _emitToUser(userId, event, data) {
    const sockets = this.userToSockets.get(userId);
    if (!sockets) return;
    for (const s of sockets) {
      s.emit(event, data);
    }
  }

  _bindUserInGame(userId, inGame) {
    const entry = this.onlineUsers.get(userId);
    if (entry) entry.inGame = inGame;
  }

  _isWaitingRoom(room) {
    if (!room || room.started) return false;
    return !room.p2Joined;
  }

  _findUserWaitingRoom(userId) {
    for (const room of this.waitingRooms.values()) {
      if (room.creator.userId === userId && this._isWaitingRoom(room)) {
        return room;
      }
    }
    return null;
  }

  _closeWaitingRoom(roomId, reason = 'closed') {
    const room = this.waitingRooms.get(roomId);
    if (!room) return;
    if (room.code) this.roomCodes.delete(room.code);
    this.waitingRooms.delete(roomId);
    this._emitToUser(room.creator.userId, 'room:closed', { roomId, reason });
  }

  _closeUserWaitingRoom(userId, reason = 'started_other_game') {
    const room = this._findUserWaitingRoom(userId);
    if (!room) return false;
    this._closeWaitingRoom(room.id, reason);
    return true;
  }

  getActiveRoomsCount() {
    return this.waitingRooms.size;
  }

  getPublicWaitingRooms() {
    const list = [];
    for (const room of this.waitingRooms.values()) {
      if (room.isPrivate || room.started) continue;
      list.push({
        id: room.id,
        isPrivate: false,
        creatorId: room.creator.userId,
        creatorName: room.creator.nickname,
        creatorAvatar: room.creator.avatarUrl || null,
        playersCount: room.p2Joined ? 2 : 1,
        p1Name: room.creator.nickname,
        p2Name: room.p2Joined ? room.joiner?.nickname : null
      });
    }
    return list;
  }

  buildPresencePayload(excludeUserId = null) {
    const players = [];
    for (const entry of this.onlineUsers.values()) {
      if (excludeUserId && entry.userId === excludeUserId) continue;
      players.push(playerPayload(entry));
    }
    players.sort((a, b) => (b.ratingMmr || 0) - (a.ratingMmr || 0));
    return {
      players: players.slice(0, MAX_PRESENCE_VISIBLE),
      onlineCount: this.onlineUsers.size
    };
  }

  _broadcastPresence() {
    this.io.emit('presence:list', this.buildPresencePayload());
  }

  _broadcastRoomsList() {
    this.io.emit('rooms:list', {
      rooms: this.getPublicWaitingRooms(),
      onlineCount: this.onlineUsers.size,
      activeRoomsCount: this.getActiveRoomsCount()
    });
  }

  sendLobbySnapshot(socket) {
    socket.emit('rooms:list', {
      rooms: this.getPublicWaitingRooms(),
      onlineCount: this.onlineUsers.size,
      activeRoomsCount: this.getActiveRoomsCount()
    });
    socket.emit('presence:list', this.buildPresencePayload());
  }

  leaveQueue(socket, user) {
    const entry = this.queue.find((q) => q.userId === user.id);
    if (entry?.timeoutId) clearTimeout(entry.timeoutId);
    this.queue = this.queue.filter((q) => q.userId !== user.id);
    if (socket) socket.emit('queue:left');
    socket?.emit('matchmaking:status', { status: 'idle' });
  }

  joinQueue(socket, user) {
    this.leaveQueue(null, user);
    this._closeUserWaitingRoom(user.id);

    if (isUserInActiveGame(user.id)) {
      socket.emit('room:error', { message: 'Сначала завершите текущую игру' });
      return;
    }

    const timeoutId = setTimeout(() => {
      const still = this.queue.find((q) => q.userId === user.id);
      if (!still) return;
      this.leaveQueue(null, user);
      this._emitToUser(user.id, 'queue:timeout', {
        message: 'За 5 минут соперник не найден. Попробуйте снова или создайте приватную комнату.'
      });
    }, QUEUE_TIMEOUT_MS);

    this.queue.push({
      socket,
      userId: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      ratingMmr: user.ratingMmr,
      timeoutId
    });

    socket.emit('queue:joined');
    socket.emit('matchmaking:status', { status: 'queued' });

    if (this.queue.length >= 2) {
      const a = this.queue.shift();
      const b = this.queue.shift();
      if (a.timeoutId) clearTimeout(a.timeoutId);
      if (b.timeoutId) clearTimeout(b.timeoutId);
      this._startQuickMatch(a, b);
    }
  }

  async _startQuickMatch(a, b) {
    if (isUserInActiveGame(a.userId) || isUserInActiveGame(b.userId)) return;

    this._closeUserWaitingRoom(a.userId);
    this._closeUserWaitingRoom(b.userId);

    if (this.getActiveRoomsCount() >= MAX_OPEN_ROOMS) {
      this._emitToUser(a.userId, 'room:error', { message: 'Достигнут лимит 10 комнат.' });
      this._emitToUser(b.userId, 'room:error', { message: 'Достигнут лимит 10 комнат.' });
      return;
    }

    await createPvPMatch(this.io, {
      socket: a.socket,
      userId: a.userId,
      nickname: a.nickname,
      avatarUrl: a.avatarUrl
    }, {
      socket: b.socket,
      userId: b.userId,
      nickname: b.nickname,
      avatarUrl: b.avatarUrl
    });

    this._bindUserInGame(a.userId, true);
    this._bindUserInGame(b.userId, true);
    this._broadcastPresence();
    this._broadcastRoomsList();
  }

  async _startMatchFromWaitingRoom(room, joinerSocket, joiner) {
    room.p2Joined = true;
    room.joiner = joiner;
    room.started = true;
    if (room.code) this.roomCodes.delete(room.code);
    this.waitingRooms.delete(room.id);

    const creatorSockets = this.userToSockets.get(room.creator.userId);
    const creatorSocket = creatorSockets ? creatorSockets.values().next().value : null;

    await createPvPMatch(
      this.io,
      {
        socket: creatorSocket,
        userId: room.creator.userId,
        nickname: room.creator.nickname,
        avatarUrl: room.creator.avatarUrl
      },
      {
        socket: joinerSocket,
        userId: joiner.userId,
        nickname: joiner.nickname,
        avatarUrl: joiner.avatarUrl
      }
    );

    this._bindUserInGame(room.creator.userId, true);
    this._bindUserInGame(joiner.userId, true);
    this._broadcastPresence();
    this._broadcastRoomsList();
  }

  createPrivateRoom(socket, user) {
    this.leaveQueue(null, user);
    this._closeUserWaitingRoom(user.id);

    if (isUserInActiveGame(user.id)) {
      socket.emit('room:error', { message: 'Сначала завершите текущую игру' });
      return;
    }
    if (this.getActiveRoomsCount() >= MAX_OPEN_ROOMS) {
      socket.emit('room:error', { message: 'Достигнут лимит 10 комнат. Присоединяйтесь к уже созданной.' });
      return;
    }

    const code = randomCode(6);
    const roomId = `wait_${crypto.randomBytes(4).toString('hex')}`;
    const room = {
      id: roomId,
      code,
      isPrivate: true,
      creator: { ...user },
      p2Joined: false,
      started: false
    };
    this.waitingRooms.set(roomId, room);
    this.roomCodes.set(code, roomId);
    socket.join(roomId);

    socket.emit('room:created', { roomId, code, isPrivate: true });
    this._broadcastRoomsList();
  }

  createOpenRoom(socket, user) {
    this.leaveQueue(null, user);
    this._closeUserWaitingRoom(user.id);

    if (isUserInActiveGame(user.id)) {
      socket.emit('room:error', { message: 'Сначала завершите текущую игру' });
      return;
    }
    if (this.getActiveRoomsCount() >= MAX_OPEN_ROOMS) {
      socket.emit('room:error', { message: 'Достигнут лимит 10 комнат. Присоединяйтесь к уже созданной.' });
      return;
    }

    const roomId = `wait_${crypto.randomBytes(4).toString('hex')}`;
    const room = {
      id: roomId,
      code: null,
      isPrivate: false,
      creator: { ...user },
      p2Joined: false,
      started: false
    };
    this.waitingRooms.set(roomId, room);
    socket.join(roomId);

    socket.emit('room:created', { roomId, code: null, isPrivate: false });
    this._broadcastPresence();
    this._broadcastRoomsList();
  }

  async joinByCode(socket, user, code) {
    if (!code) {
      socket.emit('room:error', { message: 'Код не указан' });
      return;
    }
    this._closeUserWaitingRoom(user.id);
    this.leaveQueue(null, user);

    if (isUserInActiveGame(user.id)) {
      socket.emit('room:error', { message: 'Сначала завершите текущую игру' });
      return;
    }

    const roomId = this.roomCodes.get(String(code).trim().toUpperCase());
    const room = roomId && this.waitingRooms.get(roomId);
    if (!room || !room.isPrivate) {
      socket.emit('room:error', { message: 'Комната не найдена или истекла' });
      return;
    }
    if (room.creator.userId === user.id) {
      socket.emit('room:error', { message: 'Нельзя играть с самим собой' });
      return;
    }
    if (room.p2Joined) {
      socket.emit('room:error', { message: 'Комната уже заполнена' });
      return;
    }

    socket.join(room.id);
    await this._startMatchFromWaitingRoom(room, socket, { ...user });
  }

  async joinByRoomId(socket, user, roomId) {
    if (!roomId) {
      socket.emit('room:error', { message: 'Комната не указана' });
      return;
    }
    this._closeUserWaitingRoom(user.id);
    this.leaveQueue(null, user);

    if (isUserInActiveGame(user.id)) {
      socket.emit('room:error', { message: 'Сначала завершите текущую игру' });
      return;
    }

    const room = this.waitingRooms.get(roomId);
    if (!room) {
      socket.emit('room:error', { message: 'Комната не найдена или истекла' });
      return;
    }
    if (room.isPrivate) {
      socket.emit('room:error', { message: 'Приватная комната — войдите по коду' });
      return;
    }
    if (room.creator.userId === user.id) {
      socket.emit('room:error', { message: 'Нельзя играть с самим собой' });
      return;
    }
    if (room.p2Joined) {
      socket.emit('room:error', { message: 'Комната уже заполнена' });
      return;
    }

    socket.join(room.id);
    await this._startMatchFromWaitingRoom(room, socket, { ...user });
  }

  closeRoom(socket, user, roomId) {
    let room = roomId ? this.waitingRooms.get(roomId) : this._findUserWaitingRoom(user.id);
    if (!room) {
      socket.emit('room:error', { message: 'Нет открытой комнаты для закрытия' });
      return;
    }
    if (room.creator.userId !== user.id) {
      socket.emit('room:error', { message: 'Только создатель может закрыть комнату' });
      return;
    }
    this._closeWaitingRoom(room.id, 'closed_by_creator');
    this._broadcastRoomsList();
  }

  handleChallenge(socket, user, targetId) {
    if (!targetId || targetId === user.id) return;

    if (isUserInActiveGame(user.id)) {
      socket.emit('challenge:error', { message: 'Сначала завершите текущую игру' });
      return;
    }

    this._closeUserWaitingRoom(user.id);
    this.leaveQueue(null, user);

    const target = this.onlineUsers.get(targetId);
    if (!target) {
      socket.emit('challenge:error', { message: 'Игрок не в сети или занят' });
      return;
    }
    if (target.inGame || isUserInActiveGame(targetId)) {
      socket.emit('challenge:error', { message: 'Игрок не в сети или занят' });
      return;
    }

    if (this.getActiveRoomsCount() >= MAX_OPEN_ROOMS) {
      socket.emit('challenge:error', { message: 'Достигнут лимит 10 комнат.' });
      return;
    }

    const code = randomCode(6);
    const roomId = `wait_${crypto.randomBytes(4).toString('hex')}`;
    const room = {
      id: roomId,
      code,
      isPrivate: true,
      creator: { ...user },
      challengeTargetId: targetId,
      p2Joined: false,
      started: false
    };
    this.waitingRooms.set(roomId, room);
    this.roomCodes.set(code, roomId);
    socket.join(roomId);

    this.io.to(`user:${targetId}`).emit('invite:received', {
      from: {
        id: user.userId,
        name: user.nickname,
        avatar: user.avatarUrl,
        ratingMmr: user.ratingMmr ?? 1000
      },
      roomId,
      code
    });

    socket.emit('challenge:sent', { roomId, code });
    this._broadcastRoomsList();
  }

  async handleAcceptInvite(socket, user, roomId) {
    this._closeUserWaitingRoom(user.id);
    this.leaveQueue(null, user);

    if (isUserInActiveGame(user.id)) {
      socket.emit('room:error', { message: 'Сначала завершите текущую игру' });
      return;
    }

    const room = this.waitingRooms.get(roomId);
    if (!room) {
      socket.emit('room:error', { message: 'Приглашение истекло' });
      return;
    }
    if (room.challengeTargetId && room.challengeTargetId !== user.id) {
      socket.emit('room:error', { message: 'Это приглашение не для вас' });
      return;
    }

    socket.join(room.id);
    await this._startMatchFromWaitingRoom(room, socket, { ...user });
  }

  async handleConnection(socket, jwtUser) {
    const meta = await this._loadUserMeta(jwtUser.id);
    const user = {
      userId: jwtUser.id,
      id: jwtUser.id,
      nickname: jwtUser.nickname,
      avatarUrl: meta.avatarUrl,
      ratingMmr: meta.ratingMmr,
      inGame: isUserInActiveGame(jwtUser.id)
    };

    this._trackSocket(user.userId, socket);
    this.onlineUsers.set(user.userId, user);
    socket.join(`user:${user.userId}`);

    const reconnected = tryReconnectUser(this.io, socket, jwtUser);
    if (reconnected) {
      user.inGame = true;
    }

    this.sendLobbySnapshot(socket);
    this._broadcastPresence();
    this._broadcastRoomsList();

    socket.on('lobby:enter', () => this.sendLobbySnapshot(socket));
    socket.on('presence:request', () => this.sendLobbySnapshot(socket));

    socket.on('online:join_queue', () => this.joinQueue(socket, user));
    socket.on('online:leave_queue', () => this.leaveQueue(socket, { id: user.userId }));
    socket.on('matchmaking:join', () => this.joinQueue(socket, user));
    socket.on('matchmaking:leave', () => this.leaveQueue(socket, { id: user.userId }));

    socket.on('online:create_room', () => this.createPrivateRoom(socket, user));
    socket.on('online:create_open_room', () => this.createOpenRoom(socket, user));
    socket.on('online:join_code', (data) => this.joinByCode(socket, user, data?.code));
    socket.on('online:join_room', (data) => this.joinByRoomId(socket, user, data?.roomId));
    socket.on('online:close_room', (data) => this.closeRoom(socket, user, data?.roomId));
    socket.on('online:challenge', (data) => this.handleChallenge(socket, user, data?.targetId));
    socket.on('online:rematch', (data) => this.handleChallenge(socket, user, data?.targetId));
    socket.on('online:accept_invite', (data) => this.handleAcceptInvite(socket, user, data?.roomId));

    socket.on('disconnect', () => {
      this._untrackSocket(user.userId, socket);
      this.leaveQueue(null, { id: user.userId });

      const set = this.userToSockets.get(user.userId);
      if (!set || set.size === 0) {
        this.onlineUsers.delete(user.userId);
      }

      this._broadcastPresence();
      this._broadcastRoomsList();
    });
  }
}

let lobbyInstance = null;

export function initOnlineLobby(io) {
  lobbyInstance = new OnlineLobbyManager(io);
  return lobbyInstance;
}

export function attachOnlineLobbyToSocket(io, socket, user) {
  if (!lobbyInstance) initOnlineLobby(io);
  return lobbyInstance.handleConnection(socket, user);
}

export function notifyUserLeftGame(userId) {
  if (!lobbyInstance) return;
  lobbyInstance._bindUserInGame(userId, false);
  lobbyInstance._broadcastPresence();
}