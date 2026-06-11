import React, { useState, useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  ScrollView,
  SafeAreaView,
  Modal,
  useWindowDimensions,
  Platform,
  TextInput
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import io from 'socket.io-client';

// Import game core and AI registry from shared
import {
  initGame,
  startGame,
  makeMove,
  makeChoice,
  makeBotMove,
  removePiece,
  endGame,
  endTurn
} from './shared/game-core.js';
import { getValidMoves } from './shared/game-rules.js';
import { botRegistry } from './shared/ai/index.js';
import {
  GAME_CONFIG,
  PIECE_SYMBOLS,
  PLAYER,
  COMPUTER,
  FLAG,
  TRAP,
  BOARD_WIDTH,
  BOARD_HEIGHT,
  formatBoardCoord
} from './shared/game-config.js';


const getBaseUrl = () => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.location) {
      return window.location.origin;
    }
  } else {
    if (__DEV__) {
      return 'http://10.0.2.2:3001'; // Fallback for native development emulator
    }
  }
  return 'https://rps-battles.com';
};
const BASE_URL = getBaseUrl();

const PIECE_TYPE_NAMES = { rock: 'Камень', paper: 'Бумага', scissors: 'Ножницы' };

function resolveAssetUrl(path) {
  if (!path) return null;
  if (String(path).startsWith('http')) return path;
  const clean = String(path).replace(/^\//, '');
  const onV2 =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.pathname?.startsWith('/v2');
  if (onV2 && clean.startsWith('js/bots/')) {
    return `${BASE_URL}/v2/${clean}`;
  }
  return `${BASE_URL}/${clean}`;
}

function pieceTypeLabel(type) {
  return PIECE_TYPE_NAMES[type] || type || '—';
}

function aggregateBotStats(rows) {
  return (rows || []).reduce(
    (acc, row) => ({
      wins: acc.wins + (row.wins || 0),
      losses: acc.losses + (row.losses || 0),
      draws: acc.draws + (row.draws || 0),
      games: acc.games + (row.gamesPlayed || 0)
    }),
    { wins: 0, losses: 0, draws: 0, games: 0 }
  );
}

function buildQuickOpponents(user, arenaPlayers, botList) {
  const out = [];
  const seen = new Set();
  const onlineMap = new Map((arenaPlayers || []).map((p) => [String(p.id), p]));
  const myId = String(user?.id || '');

  const push = (item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key) || out.length >= 3) return;
    seen.add(key);
    out.push(item);
  };

  for (const row of user?.pvpOpponentStats || []) {
    const oppId = row.opponentId || row.opponent?.id;
    if (!oppId) continue;
    const online = onlineMap.get(String(oppId));
    if (!online || online.inGame || String(oppId) === myId) continue;
    push({
      kind: 'human',
      id: oppId,
      name: row.opponent?.nickname || online.name || 'Игрок',
      avatar: row.opponent?.avatarUrl || online.avatar,
      ratingMmr: online.ratingMmr ?? 1000,
      games: row.gamesPlayed || 0,
      wins: row.wins || 0,
      losses: row.losses || 0,
      draws: row.draws || 0,
      online: true
    });
  }

  for (const p of arenaPlayers || []) {
    if (String(p.id) === myId || p.inGame) continue;
    const pvpStats = user?.pvpOpponentStats?.find(s => String(s.opponentId || s.opponent?.id) === String(p.id)) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
    push({
      kind: 'human',
      id: p.id,
      name: p.name || 'Игрок',
      avatar: p.avatar,
      ratingMmr: p.ratingMmr ?? 1000,
      games: pvpStats.gamesPlayed || 0,
      wins: pvpStats.wins || 0,
      losses: pvpStats.losses || 0,
      draws: pvpStats.draws || 0,
      online: true
    });
  }

  for (const row of user?.botOpponentStats || []) {
    const bot = botList.find((b) => b.id === row.botId) || botRegistry.get(row.botId);
    if (!bot) continue;
    push({
      kind: 'bot',
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      games: row.gamesPlayed || 0,
      wins: row.wins || 0,
      losses: row.losses || 0,
      draws: row.draws || 0,
      modelAuthor: bot.modelAuthor,
      online: false
    });
  }

  return out;
}

function tieAttemptsLeft(drawRound) {
  return Math.max(1, 7 - (drawRound || 1));
}

// Local storage helper (hybrid Web LocalStorage / Native AsyncStorage)
const storage = {
  async getItem(key) {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.localStorage) {
          return window.localStorage.getItem(key);
        }
        return null;
      }
      return await AsyncStorage.getItem(key);
    } catch (e) {
      console.error('storage.getItem error:', e);
      return null;
    }
  },
  async setItem(key, value) {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, value);
        }
      } else {
        await AsyncStorage.setItem(key, value);
      }
    } catch (e) {
      console.error('storage.setItem error:', e);
    }
  },
  async removeItem(key) {
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem(key);
        }
      } else {
        await AsyncStorage.removeItem(key);
      }
    } catch (e) {
      console.error('storage.removeItem error:', e);
    }
  }
};

const LAYOUT = {
  maxWidth: 1040,
  narrowWidth: 440,
  gameWidth: 1120,
  pad: 20,
  gap: 16,
};

/** Responsive metrics from viewport width (mobile browser + narrow desktop). */
function getLayoutMetrics(windowWidth) {
  const compact = windowWidth < 400;
  const mobile = windowWidth < 768;
  const wide = windowWidth >= 768;
  const gameWide = windowWidth >= 900;
  const stackPanels = windowWidth < 560;
  const padH = compact ? 10 : mobile ? 12 : 20;
  const cardPad = compact ? 12 : mobile ? 16 : 20;
  const gap = compact ? 8 : mobile ? 12 : 16;
  const shellMax = wide ? LAYOUT.maxWidth : windowWidth;
  const gameShellMax = gameWide ? LAYOUT.gameWidth : windowWidth;
  const boardMaxWidth = Math.max(260, Math.min(420, windowWidth - padH * 2 - cardPad * 2 - 20));
  const pieceFontSize = compact ? 11 : mobile ? 14 : 18;
  const validMoveDotSize = compact ? 6 : mobile ? 8 : 10;
  return {
    compact,
    mobile,
    wide,
    gameWide,
    stackPanels,
    padH,
    cardPad,
    gap,
    shellMax,
    gameShellMax,
    boardMaxWidth,
    pieceFontSize,
    validMoveDotSize,
  };
}

function PageShell({ children, narrow = false, style, padH, maxWidth }) {
  return (
    <View
      style={[
        styles.pageShell,
        narrow && styles.pageShellNarrow,
        padH != null && { paddingHorizontal: padH },
        maxWidth != null && { maxWidth },
        style
      ]}
    >
      {children}
    </View>
  );
}

function SurfaceCard({ children, style, accent }) {
  return (
    <View style={[styles.surfaceCard, accent && styles.surfaceCardAccent, style]}>
      {children}
    </View>
  );
}

const TURN_TIME_LIMIT = 120;
const SETUP_TIME_LIMIT = 60;

function countActivePieces(pieces) {
  return pieces.filter((p) => !p.removed && p.row >= 0).length;
}

function OpponentPanel({
  army,
  name,
  subtitle,
  emoji,
  avatarUrl,
  pieceCount,
  turnLabel,
  isTurnActive,
  fillPercent,
  urgent,
  compact = false
}) {
  const isBlue = army === 'blue';
  return (
    <View
      style={[
        styles.opponentPanel,
        isBlue ? styles.panelBlue : styles.panelRed,
        isTurnActive && styles.panelTurnActive,
        isTurnActive && urgent && (isBlue ? styles.panelUrgentBlue : styles.panelUrgentRed)
      ]}
    >
      {isTurnActive && (
        <View
          style={[
            styles.turnFillBar,
            isBlue ? styles.turnFillBlue : styles.turnFillRed,
            { width: `${Math.min(100, Math.max(0, fillPercent))}%` }
          ]}
        />
      )}
      <View style={[styles.panelInner, compact && styles.panelInnerCompact]}>
        {avatarUrl ? (
          <Image
            source={{ uri: avatarUrl }}
            style={[styles.panelAvatar, compact && styles.panelAvatarCompact]}
          />
        ) : (
          <View
            style={[
              styles.panelAvatar,
              compact && styles.panelAvatarCompact,
              isBlue ? styles.panelAvatarBlue : styles.panelAvatarRed
            ]}
          >
            <Text style={[styles.panelAvatarEmoji, compact && styles.panelAvatarEmojiCompact]}>
              {emoji || (isBlue ? '👤' : '🤖')}
            </Text>
          </View>
        )}
        <View style={styles.panelDetails}>
          <Text style={[styles.panelName, compact && styles.panelNameCompact]} numberOfLines={1}>
            {name}
          </Text>
          {subtitle ? (
            <Text style={[styles.panelSubtitle, compact && styles.panelSubtitleCompact]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <Text style={[styles.panelMeta, compact && styles.panelMetaCompact]}>Фигур: {pieceCount}</Text>
          <Text
            style={[
              styles.panelTurnLabel,
              compact && styles.panelTurnLabelCompact,
              isTurnActive && styles.panelTurnLabelActive
            ]}
          >
            {turnLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

function DrawCountdownBar({ moves = 0, limit = 20, compact = false }) {
  const safeMoves = Math.max(0, Math.min(limit, moves));
  const remaining = Math.max(0, limit - safeMoves);
  const percent = (safeMoves / limit) * 100;
  const urgent = safeMoves >= Math.floor(limit * 0.85);
  const warn = !urgent && safeMoves >= Math.floor(limit * 0.6);

  return (
    <View style={[styles.drawCountdown, compact && styles.drawCountdownCompact, urgent && styles.drawCountdownDanger]}>
      <View style={styles.drawCountdownHeader}>
        <Text style={[styles.drawCountdownTitle, compact && styles.drawCountdownTitleCompact]}>
          До ничьи без взятий
        </Text>
        <Text style={[styles.drawCountdownMeta, urgent && styles.drawCountdownMetaDanger]}>
          {safeMoves} / {limit} · осталось {remaining}
        </Text>
      </View>
      <View style={styles.drawCountdownTrack}>
        <View
          style={[
            styles.drawCountdownFill,
            warn && styles.drawCountdownFillWarn,
            urgent && styles.drawCountdownFillDanger,
            { width: `${percent}%` }
          ]}
        />
      </View>
      {safeMoves >= Math.floor(limit * 0.5) && (
        <Text style={[styles.drawCountdownHint, urgent && styles.drawCountdownHintDanger]}>
          {urgent ? 'Срочно нужно взятие — иначе ничья!' : 'Скоро ничья — атакуйте или берите фигуры.'}
        </Text>
      )}
    </View>
  );
}

export default function App() {
  const { width: windowWidth } = useWindowDimensions();
  const layout = getLayoutMetrics(windowWidth);
  const isWide = layout.wide;
  const isGameWide = layout.gameWide;

  // Mobile browsers: allow page scroll when content is taller than viewport
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => {
      const mobile = mq.matches;
      document.documentElement.style.height = mobile ? 'auto' : '100%';
      document.body.style.height = mobile ? 'auto' : '100%';
      document.body.style.overflow = mobile ? 'auto' : 'hidden';
      const root = document.getElementById('root');
      if (root) {
        root.style.height = mobile ? 'auto' : '100%';
        root.style.minHeight = mobile ? '100vh' : '';
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => {
      mq.removeEventListener('change', apply);
      document.documentElement.style.height = '';
      document.body.style.height = '';
      document.body.style.overflow = '';
      const root = document.getElementById('root');
      if (root) {
        root.style.height = '';
        root.style.minHeight = '';
      }
    };
  }, []);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);

  // Screen state: 'lobby', 'arena', 'bot_select', 'game', 'profile', 'matchmaking'
  const [screen, setScreen] = useState('lobby');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState('rabbit');
  const [isTournamentActive, setIsTournamentActive] = useState(false);
  const [botSelectTab, setBotSelectTab] = useState('free'); // 'free' or 'tournament'
  
  // Game states
  const [gameMode, setGameMode] = useState('pve'); // 'pve' or 'pvp'
  const [pvpRole, setPvpRole] = useState(null); // 'p1' or 'p2'
  const [pvpOpponent, setPvpOpponent] = useState(null);
  const [matchmakingTime, setMatchmakingTime] = useState(0);
  const [arenaOnlineCount, setArenaOnlineCount] = useState(0);
  const [arenaPlayers, setArenaPlayers] = useState([]);
  const [publicRooms, setPublicRooms] = useState([]);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [createdRoomCode, setCreatedRoomCode] = useState(null);
  const [arenaStatus, setArenaStatus] = useState('');
  const [pendingInvite, setPendingInvite] = useState(null);
  const [roomsAtCap, setRoomsAtCap] = useState(false);
  const [isSearchingMatch, setIsSearchingMatch] = useState(false);
  const [myWaitingRoomId, setMyWaitingRoomId] = useState(null);
  const [myWaitingRoomPrivate, setMyWaitingRoomPrivate] = useState(false);

  const [game, setGame] = useState(null);
  const [selectedPiece, setSelectedPiece] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [battleLogs, setBattleLogs] = useState([]);
  const [isBotThinking, setIsBotThinking] = useState(false);
  const [ratingUpdate, setRatingUpdate] = useState(null);
  const [turnTimeLeft, setTurnTimeLeft] = useState(TURN_TIME_LIMIT);
  const [setupTimeLeft, setSetupTimeLeft] = useState(SETUP_TIME_LIMIT);
  const [surrenderModalVisible, setSurrenderModalVisible] = useState(false);
  const [leaveSetupModalVisible, setLeaveSetupModalVisible] = useState(false);
  const [hoveredSetupCell, setHoveredSetupCell] = useState(null);
  const setupTimeoutHandledRef = useRef(false);

  const socketRef = useRef(null);
  const pvpRoleRef = useRef(null);
  const refreshPromiseRef = useRef(null);

  // Countdown turn timer effect (PvE only; PvP syncs from server turnDeadline)
  useEffect(() => {
    if (gameMode === 'pvp') return;
    if (!game || game.phase !== GAME_CONFIG.PHASES.PLAYING || game.gameOver) {
      setTurnTimeLeft(TURN_TIME_LIMIT);
      return;
    }

    setTurnTimeLeft(TURN_TIME_LIMIT);
    const interval = setInterval(() => {
      setTurnTimeLeft((prev) => {
        if (prev <= 1) {
          return TURN_TIME_LIMIT;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [game?.currentPlayer, game?.phase, gameMode]);

  // PvP turn timer synced from server deadline
  useEffect(() => {
    if (gameMode !== 'pvp' || !game?.turnDeadline) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.ceil((game.turnDeadline - Date.now()) / 1000));
      setTurnTimeLeft(left);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [gameMode, game?.turnDeadline, game?.currentPlayer]);

  // Countdown setup timer (flag + trap placement)
  useEffect(() => {
    if (!game || game.phase !== GAME_CONFIG.PHASES.SETUP) {
      setSetupTimeLeft(SETUP_TIME_LIMIT);
      setupTimeoutHandledRef.current = false;
      return;
    }

    setSetupTimeLeft(SETUP_TIME_LIMIT);
    setupTimeoutHandledRef.current = false;

    const interval = setInterval(() => {
      setSetupTimeLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [game?.phase, game?.botId]);

  useEffect(() => {
    if (!game || game.phase !== GAME_CONFIG.PHASES.SETUP) {
      setHoveredSetupCell(null);
    }
  }, [game?.phase]);

  // Check login callback tokens on mount
  useEffect(() => {
    const initializeAuth = async () => {
      let isVK = false;
      let isFB = false;

      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        if (params.get('vk_user_id') && params.get('sign')) {
          isVK = true;
        }
      }

      if (typeof window !== 'undefined' && window.FBInstant) {
        isFB = true;
      }

      if (isVK) {
        try {
          const vkBridge = window.vkBridge;
          if (vkBridge) {
            await vkBridge.send('VKWebAppInit');
            const vkUser = await vkBridge.send('VKWebAppGetUserInfo');
            
            const searchParams = new URLSearchParams(window.location.search);
            const vkParams = {};
            for (const [key, value] of searchParams.entries()) {
              vkParams[key] = value;
            }
            vkParams.first_name = vkUser.first_name;
            vkParams.last_name = vkUser.last_name;
            vkParams.photo_200 = vkUser.photo_200;

            const res = await fetch(`${BASE_URL}/api/v2/auth/vk`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(vkParams)
            });

            if (res.ok) {
              const data = await res.json();
              await storage.setItem('token', data.accessToken);
              await storage.setItem('refreshToken', data.refreshToken);
              setToken(data.accessToken);
              setUser(data.user);
              setLoading(false);
              return;
            }
          }
        } catch (err) {
          console.error('VK Mini App login error:', err);
        }
      }

      if (isFB) {
        try {
          const FBInstant = window.FBInstant;
          await FBInstant.initializeAsync();
          await FBInstant.setLoadingProgress(100);
          await FBInstant.startGameAsync();

          const signedInfo = await FBInstant.player.getSignedPlayerInfoAsync();
          
          const res = await fetch(`${BASE_URL}/api/v2/auth/facebook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signedRequest: signedInfo.getSignature() })
          });

          if (res.ok) {
            const data = await res.json();
            await storage.setItem('token', data.accessToken);
            await storage.setItem('refreshToken', data.refreshToken);
            setToken(data.accessToken);
            setUser(data.user);
            setLoading(false);
            return;
          }
        } catch (err) {
          console.error('FB Instant Games login error:', err);
        }
      }

      let justGotTokenFromUrl = false;
      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get('token');
        const urlRefreshToken = params.get('refreshToken');

        if (urlToken && urlRefreshToken) {
          await storage.setItem('token', urlToken);
          await storage.setItem('refreshToken', urlRefreshToken);
          // Clean URL params without page reload
          window.history.replaceState({}, document.title, window.location.pathname);
          justGotTokenFromUrl = true;
        }
      }

      if (Platform.OS === 'web') {
        const savedToken = await storage.getItem('token');
        if (savedToken) {
          setToken(savedToken);
          fetchUserProfile(savedToken);
        } else {
          setLoading(false);
        }
      } else {
        // Mobile native: preserve login persistence in localStorage
        const savedToken = await storage.getItem('token');
        if (savedToken) {
          setToken(savedToken);
          fetchUserProfile(savedToken);
        } else {
          setLoading(false);
        }
      }
    };

    initializeAuth();
  }, []);

  const [boardSkin, setBoardSkin] = useState('classic');

  useEffect(() => {
    const loadSkin = async () => {
      const savedSkin = await storage.getItem('boardSkin');
      if (savedSkin === 'animated' || savedSkin === 'classic') {
        setBoardSkin(savedSkin);
      }
    };
    loadSkin();
  }, []);

  const changeSkin = async (skin) => {
    setBoardSkin(skin);
    await storage.setItem('boardSkin', skin);
  };

  const handlePieceDragStart = (e, visualRow, visualCol) => {
    if (!game || game.gameOver) return;
    const { ar: row, ac: col } = getVisualRowCol(visualRow, visualCol);
    const target = game.board[row][col];
    
    const side = gameMode === 'pvp' ? pvpRole : PLAYER;
    const isMyTurn = gameMode === 'pvp' ? game.currentPlayer === pvpRole : game.currentPlayer === PLAYER;
    
    if (isMyTurn && !game.battleState && target && target.owner === side && !target.immobilized) {
      selectPiece(target);
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', JSON.stringify({ row, col }));
        e.dataTransfer.effectAllowed = 'move';
      }
    }
  };

  const handlePieceDrop = (e, visualRow, visualCol) => {
    if (e.preventDefault) e.preventDefault();
    if (!selectedPiece) return;
    
    const { ar: row, ac: col } = getVisualRowCol(visualRow, visualCol);
    const isMoveValid = validMoves.some(([r, c]) => r === row && c === col);
    
    if (isMoveValid) {
      if (gameMode === 'pvp') {
        socketRef.current.emit('game:make_move', {
          fromRow: selectedPiece.row,
          fromCol: selectedPiece.col,
          toRow: row,
          toCol: col
        });
        deselectPiece();
      } else {
        const updatedGame = { ...game };
        const pieceRef = updatedGame.board[selectedPiece.row][selectedPiece.col];
        const result = makeMove(updatedGame, pieceRef, row, col);
        if (result.type !== 'battle' || result.result !== 'draw') {
          endTurn(updatedGame);
        }
        processMoveResult(updatedGame, result);
      }
    } else {
      deselectPiece();
    }
  };

  const renderCartoonPiece = (type, pieceType, isEnemy, isImmobilized, isRevealed) => {
    const pType = isEnemy ? (isRevealed ? (pieceType || type) : 'unknown') : (pieceType || type);
    
    // Team background color: Blue for player, Red for enemy
    const bgColor = isEnemy ? '#ef4444' : '#3b82f6';
    
    // Literal, clearly identifiable symbols
    let emoji = '❓';
    if (pType === 'rock') {
      emoji = '🪨'; // Stone
    } else if (pType === 'paper') {
      emoji = '📄'; // Paper sheet
    } else if (pType === 'scissors') {
      emoji = '✂️'; // Scissors
    } else if (pType === 'trap') {
      emoji = '💣'; // Bomb
    } else if (pType === 'flag') {
      emoji = '🚩'; // Flag
    } else {
      emoji = '❓';
    }

    const containerStyle = [
      styles.cartoonPieceBadge,
      isEnemy ? styles.cartoonEnemyBadge : styles.cartoonPlayerBadge,
      isImmobilized && styles.cartoonImmobilizedBadge,
      (!isEnemy && isRevealed) && styles.cartoonRevealedBadge,
      { backgroundColor: bgColor }
    ];

    return (
      <View style={containerStyle}>
        {/* Shiny Glossy Reflection Overlay */}
        <View style={styles.cartoonPieceGloss} />

        {/* Center Emoji */}
        <Text style={[
          styles.cartoonPieceEmojiText,
          { fontSize: layout.pieceFontSize * 1.15 }
        ]}>
          {emoji}
        </Text>
      </View>
    );
  };

  // Socket.IO PvP Connection & Event Listeners
  useEffect(() => {
    if (token) {
      console.log('Connecting to Socket.IO at:', BASE_URL);
      const socket = io(BASE_URL, {
        path: '/v2/socket.io',
        auth: { token }
      });

      socketRef.current = socket;

      socket.on('connect', () => {
        console.log('Connected to socket!');
      });

      socket.on('disconnect', () => {
        console.log('Disconnected from socket!');
      });

      socket.on('connect_error', async (err) => {
        console.error('Socket connection error:', err.message);
        if (err.message === 'INVALID_TOKEN' || err.message === 'AUTH_REQUIRED') {
          const refreshedToken = await refreshTokenOnServer();
          if (!refreshedToken) {
            await handleLogout();
          }
        }
      });

      socket.on('matchmaking:status', ({ status }) => {
        if (status === 'queued') {
          setIsSearchingMatch(true);
          setScreen('arena');
        } else if (status === 'idle') {
          setIsSearchingMatch(false);
        }
      });

      socket.on('presence:list', (data) => {
        const list = Array.isArray(data) ? data : (data?.players || []);
        const count = Array.isArray(data) ? list.length : (data?.onlineCount ?? list.length);
        setArenaPlayers(list);
        setArenaOnlineCount(count);
      });

      socket.on('rooms:list', (data) => {
        setPublicRooms(data?.rooms || []);
        if (data?.onlineCount != null) setArenaOnlineCount(data.onlineCount);
        setRoomsAtCap((data?.activeRoomsCount ?? 0) >= 10);
      });

      socket.on('queue:joined', () => {
        setIsSearchingMatch(true);
        setArenaStatus('В очереди... Ожидание противника');
      });

      socket.on('queue:left', () => {
        setIsSearchingMatch(false);
        setArenaStatus('');
      });

      socket.on('queue:timeout', (d) => {
        setIsSearchingMatch(false);
        setArenaStatus(d?.message || 'Соперник не найден');
        alert(d?.message || 'Соперник не найден за 5 минут');
      });

      socket.on('room:created', ({ roomId, code, isPrivate }) => {
        setMyWaitingRoomId(roomId || null);
        setMyWaitingRoomPrivate(!!isPrivate);
        if (isPrivate && code) {
          setCreatedRoomCode(code);
          setArenaStatus(`Ожидание соперника. Передайте код: ${code}`);
        } else {
          setCreatedRoomCode(null);
          setArenaStatus('Открытая комната создана. Ожидаем второго игрока...');
        }
      });

      socket.on('room:closed', () => {
        setMyWaitingRoomId(null);
        setMyWaitingRoomPrivate(false);
        setCreatedRoomCode(null);
        setArenaStatus('');
      });

      socket.on('room:error', (d) => {
        const msg = d?.message || 'Ошибка комнаты';
        setArenaStatus(msg);
        alert(msg);
      });

      socket.on('challenge:sent', () => {
        setArenaStatus('Вызов отправлен. Ожидание ответа...');
      });

      socket.on('challenge:error', (d) => {
        setArenaStatus(d?.message || 'Ошибка вызова');
      });

      socket.on('invite:received', (data) => {
        setPendingInvite(data);
      });

      socket.on('match:init', ({ roomId, role, opponent }) => {
        setIsSearchingMatch(false);
        setMyWaitingRoomId(null);
        setMyWaitingRoomPrivate(false);
        setCreatedRoomCode(null);
        setPendingInvite(null);
        setPvpRole(role);
        pvpRoleRef.current = role;
        setPvpOpponent(opponent);
        setGameMode('pvp');
        setScreen('game');
        setBattleLogs(['🎮 Матч найден! Начинается расстановка.']);
        setGame({
          id: roomId,
          phase: GAME_CONFIG.PHASES.SETUP,
          setupPhase: GAME_CONFIG.SETUP_PHASES.FLAG,
          flagPosition: null,
          trapPosition: null,
          board: Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(null)),
          currentPlayer: 'p1',
          p1: { setupDone: false, nickname: role === 'p1' ? user?.nickname : opponent?.nickname },
          p2: { setupDone: false, nickname: role === 'p2' ? user?.nickname : opponent?.nickname }
        });
      });

      socket.on('game:update', (data) => {
        const currentRole = pvpRoleRef.current;
        const targetState = currentRole === 'p1' ? data.p1 : data.p2;
        if (targetState) {
          if (targetState.phase === 'finished') {
            fetchUserProfile(token);
          }
          setGame((prev) => {
            const merged = { ...targetState };
            if (merged.phase === GAME_CONFIG.PHASES.FINISHED && merged.endReason !== 'setup_timeout') {
              if (merged.winner === currentRole) {
                setRatingUpdate(25);
              } else if (merged.winner && merged.winner !== 'draw') {
                setRatingUpdate(-25);
              } else {
                setRatingUpdate(null);
              }
              if (token) fetchUserProfile(token);
            }
            if (merged.phase === GAME_CONFIG.PHASES.SETUP) {
              merged.setupPhase = merged.setupPhase ?? prev?.setupPhase ?? GAME_CONFIG.SETUP_PHASES.FLAG;
              merged.flagPosition = merged.flagPosition ?? prev?.flagPosition ?? null;
              merged.trapPosition = merged.trapPosition ?? prev?.trapPosition ?? null;
              const hasLocalPieces = prev?.board?.some((row) =>
                row?.some((cell) => cell && (cell.type === FLAG || cell.type === TRAP))
              );
              if (hasLocalPieces && prev?.board) {
                merged.board = prev.board;
              } else if (!merged.board) {
                merged.board = Array.from({ length: BOARD_HEIGHT }, () =>
                  Array(BOARD_WIDTH).fill(null)
                );
              }
            }
            return merged;
          });
          setBattleLogs(targetState.logs || []);
          if (targetState.turnDeadline) {
            const left = Math.max(0, Math.ceil((targetState.turnDeadline - Date.now()) / 1000));
            setTurnTimeLeft(left);
          }
        }
      });

      socket.on('game:error', ({ message }) => {
        alert(message);
      });

      socket.on('game:opponent_disconnected', () => {
        setArenaStatus('Соперник отключился. Ожидание переподключения (до 2 мин)...');
      });

      return () => {
        socket.disconnect();
        socketRef.current = null;
      };
    }
  }, [token]);

  // Queue duration counter
  useEffect(() => {
    let interval = null;
    if (screen === 'matchmaking') {
      setMatchmakingTime(0);
      interval = setInterval(() => {
        setMatchmakingTime((prev) => prev + 1);
      }, 1000);
    } else {
      setMatchmakingTime(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [screen]);

  useEffect(() => {
    if (screen === 'lobby' && token && socketRef.current) {
      socketRef.current.emit('lobby:enter');
    }
  }, [screen, token]);

  const openArena = () => {
    setProfileMenuOpen(false);
    setScreen('arena');
    setArenaStatus('');
    socketRef.current?.emit('lobby:enter');
  };

  const handleJoinQueue = () => {
    if (socketRef.current) {
      socketRef.current.emit('online:join_queue');
      setIsSearchingMatch(true);
    }
  };

  const handleLeaveQueue = () => {
    if (socketRef.current) {
      socketRef.current.emit('online:leave_queue');
    }
    setIsSearchingMatch(false);
    setArenaStatus('');
  };

  const handleCreatePrivateRoom = () => {
    socketRef.current?.emit('online:create_room');
  };

  const handleCreateOpenRoom = () => {
    socketRef.current?.emit('online:create_open_room');
  };

  const handleJoinByCode = () => {
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) return;
    socketRef.current?.emit('online:join_code', { code });
  };

  const handleJoinPublicRoom = (roomId) => {
    socketRef.current?.emit('online:join_room', { roomId });
  };

  const handleCloseMyWaitingRoom = () => {
    socketRef.current?.emit('online:close_room', { roomId: myWaitingRoomId || undefined });
    setMyWaitingRoomId(null);
    setMyWaitingRoomPrivate(false);
    setCreatedRoomCode(null);
    setArenaStatus('');
  };

  const handleChallengePlayer = (targetId) => {
    socketRef.current?.emit('online:challenge', { targetId });
  };

  const handleAcceptInvite = () => {
    if (!pendingInvite?.roomId) return;
    socketRef.current?.emit('online:accept_invite', { roomId: pendingInvite.roomId });
    setPendingInvite(null);
  };

  /** Реванш = новый вызов сопернику (как в v1). */
  const handleRematch = () => {
    const opponentId =
      pvpOpponent?.userId
      ?? (pvpRole === 'p1' ? game?.p2?.userId : game?.p1?.userId);
    if (!opponentId) {
      alert('Не удалось определить соперника для реванша');
      return;
    }
    socketRef.current?.emit('online:challenge', { targetId: opponentId });
    setArenaStatus('Вызов на реванш отправлен. Ожидание ответа...');
    setGame(null);
    setSelectedPiece(null);
    setValidMoves([]);
    setPvpRole(null);
    pvpRoleRef.current = null;
    setScreen('arena');
    socketRef.current?.emit('lobby:enter');
  };

  const getVisualRowCol = (r, c) => {
    if (gameMode === 'pvp' && pvpRole === 'p2') {
      return { ar: BOARD_HEIGHT - 1 - r, ac: BOARD_WIDTH - 1 - c };
    }
    return { ar: r, ac: c };
  };

  const refreshTokenOnServer = async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }
    refreshPromiseRef.current = (async () => {
      try {
        const storedRefreshToken = await storage.getItem('refreshToken');
        if (!storedRefreshToken) {
          console.warn('No refresh token found in storage');
          return null;
        }
        const res = await fetch(`${BASE_URL}/api/v2/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ refreshToken: storedRefreshToken })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.accessToken && data.refreshToken) {
            await storage.setItem('token', data.accessToken);
            await storage.setItem('refreshToken', data.refreshToken);
            setToken(data.accessToken);
            return data.accessToken;
          }
        } else {
          console.warn('Refresh endpoint returned error status:', res.status);
        }
      } catch (err) {
        console.error('Failed to refresh token:', err);
      } finally {
        refreshPromiseRef.current = null;
      }
      return null;
    })();
    return refreshPromiseRef.current;
  };

  const fetchUserProfile = async (authToken) => {
    try {
      let currentToken = authToken || token || (await storage.getItem('token'));
      if (!currentToken) {
        setLoading(false);
        return;
      }
      let res = await fetch(`${BASE_URL}/api/v2/auth/status`, {
        headers: {
          'Authorization': `Bearer ${currentToken}`
        }
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          const refreshedToken = await refreshTokenOnServer();
          if (refreshedToken) {
            res = await fetch(`${BASE_URL}/api/v2/auth/status`, {
              headers: {
                'Authorization': `Bearer ${refreshedToken}`
              }
            });
            if (res.ok) {
              const data = await res.json();
              if (data.authenticated) {
                setUser(data.user);
              }
              return;
            }
          }
          await handleLogout();
          return;
        }
        throw new Error('Не удалось загрузить профиль');
      }
      const data = await res.json();
      if (data.authenticated) {
        setUser(data.user);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateStatsOnServer = async (result, botId) => {
    let currentToken = token || (await storage.getItem('token'));
    if (!currentToken) return;
    try {
      let res = await fetch(`${BASE_URL}/api/v2/stats/update`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ result, botId: botId || undefined })
      });
      if (!res.ok && (res.status === 401 || res.status === 403)) {
        const refreshedToken = await refreshTokenOnServer();
        if (refreshedToken) {
          currentToken = refreshedToken;
          res = await fetch(`${BASE_URL}/api/v2/stats/update`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${currentToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ result, botId: botId || undefined })
          });
        } else {
          await handleLogout();
          return;
        }
      }
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setUser((prev) => {
            if (!prev) return prev;
            let botOpponentStats = prev.botOpponentStats || [];
            if (data.botRecord) {
              const idx = botOpponentStats.findIndex((b) => b.botId === data.botRecord.botId);
              if (idx >= 0) {
                botOpponentStats = botOpponentStats.map((b, i) => (i === idx ? data.botRecord : b));
              } else {
                botOpponentStats = [data.botRecord, ...botOpponentStats];
              }
              botOpponentStats = [...botOpponentStats].sort(
                (a, b) => b.gamesPlayed - a.gamesPlayed
              );
            }
            return { ...prev, stats: data.stats, botOpponentStats };
          });
        }
      }
    } catch (err) {
      console.error('Не удалось обновить статистику в БД:', err);
    }
  };

  const handleLogin = () => {
    if (typeof window !== 'undefined') {
      window.location.href = `${BASE_URL}/api/v2/auth/google`;
    }
  };

  const handleDevLogin = () => {
    if (typeof window !== 'undefined') {
      window.location.href = `${BASE_URL}/api/v2/auth/dev`;
    }
  };

  const handleLogout = async () => {
    await storage.removeItem('token');
    await storage.removeItem('refreshToken');
    setToken(null);
    setUser(null);
    setError(null);
    setProfileMenuOpen(false);
    setScreen('lobby');
  };

  const handleResetTournament = async () => {
    let currentToken = token || (await storage.getItem('token'));
    if (!currentToken) return;
    try {
      let res = await fetch(`${BASE_URL}/api/v2/stats/reset-tournament`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok && (res.status === 401 || res.status === 403)) {
        const refreshedToken = await refreshTokenOnServer();
        if (refreshedToken) {
          currentToken = refreshedToken;
          res = await fetch(`${BASE_URL}/api/v2/stats/reset-tournament`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${currentToken}`,
              'Content-Type': 'application/json'
            }
          });
        } else {
          await handleLogout();
          return;
        }
      }
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setUser((prev) => {
            if (!prev) return prev;
            return { ...prev, stats: data.stats };
          });
        }
      }
    } catch (err) {
      console.error('Не удалось сбросить прогресс турнира:', err);
    }
  };

  const formatProfileDate = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    } catch {
      return '—';
    }
  };

  const platformLabel = (platform) => {
    const map = {
      web: 'Веб',
      android: 'Android',
      ios: 'iOS',
      vk: 'ВКонтакте',
      facebook: 'Facebook'
    };
    return map[platform] || platform || '—';
  };

  // --- Logger helper ---
  const addLog = (message) => {
    setBattleLogs(prev => [message, ...prev]);
  };

  // --- Game actions ---
  const handleStartBotGame = (botIdOverride) => {
    const botId = botIdOverride || selectedBotId;
    setSelectedBotId(botId);
    setGameMode('pve');
    const freshGame = initGame(botId);
    setupTimeoutHandledRef.current = false;
    setSetupTimeLeft(SETUP_TIME_LIMIT);
    setGame(freshGame);
    setScreen('game');
    setBattleLogs([
      '🎮 Настройка: разместите флаг и капкан в нижних 2 рядах.',
      `⏱️ На расстановку — ${SETUP_TIME_LIMIT} секунд.`
    ]);
    setSelectedPiece(null);
    setValidMoves([]);
    setRatingUpdate(null);
  };

  const handleSetupTimeout = () => {
    if (!game || game.phase !== GAME_CONFIG.PHASES.SETUP || setupTimeoutHandledRef.current) {
      return;
    }
    setupTimeoutHandledRef.current = true;
    if (gameMode === 'pvp') return; // Managed by server in PvP
    const updatedGame = { ...game };
    endGame(updatedGame, false, 'setup_timeout');
    setGame(updatedGame);
    addLog('⏱️ Время на расстановку истекло. Партия не началась.');
    handleGameOver(COMPUTER, 'setup_timeout');
  };

  useEffect(() => {
    if (
      !game
      || game.phase !== GAME_CONFIG.PHASES.SETUP
      || setupTimeLeft > 0
      || setupTimeoutHandledRef.current
    ) {
      return;
    }
    handleSetupTimeout();
  }, [setupTimeLeft, game?.phase]);

  const handleLeaveSetup = () => {
    setLeaveSetupModalVisible(true);
  };

  const confirmLeaveSetup = () => {
    setLeaveSetupModalVisible(false);
    setupTimeoutHandledRef.current = true;
    if (gameMode === 'pvp') {
      socketRef.current.emit('game:surrender');
      setGame(null);
      setScreen('lobby');
      return;
    }
    setGame(null);
    setScreen('lobby');
    setBattleLogs([]);
    setSelectedPiece(null);
    setValidMoves([]);
    setRatingUpdate(null);
    setHoveredSetupCell(null);
    setSetupTimeLeft(SETUP_TIME_LIMIT);
  };

  /** Собрать превью доски при расстановке (визуальные coords → серверные на board). */
  const buildSetupPreviewBoard = (flagPos, trapPos, owner) => {
    const board = Array.from({ length: BOARD_HEIGHT }, () =>
      Array(BOARD_WIDTH).fill(null)
    );
    const place = (visualRow, visualCol, type) => {
      const { ar, ac } = getVisualRowCol(visualRow, visualCol);
      board[ar][ac] = { type, owner, row: ar, col: ac };
    };
    if (flagPos) place(flagPos[0], flagPos[1], FLAG);
    if (trapPos) place(trapPos[0], trapPos[1], TRAP);
    return board;
  };

  const handleSetupCellClick = (row, col) => {
    if (!game) return;

    // Визуально всегда свои нижние 2 ряда (и p1, и p2)
    if (row < 4) {
      addLog('⚠️ Вы можете размещать фигуры только в своей территории (нижние 2 ряда)!');
      return;
    }

    const owner = gameMode === 'pvp' ? pvpRole : PLAYER;

    if (game.setupPhase === GAME_CONFIG.SETUP_PHASES.FLAG) {
      const updatedGame = { ...game };
      updatedGame.flagPosition = [row, col];
      updatedGame.trapPosition = null;
      updatedGame.board = buildSetupPreviewBoard([row, col], null, owner);
      updatedGame.setupPhase = GAME_CONFIG.SETUP_PHASES.TRAP;
      setGame(updatedGame);
      addLog(`Flag placed at ${formatBoardCoord(row, col)}. Choose Trap position.`);
    } else if (game.setupPhase === GAME_CONFIG.SETUP_PHASES.TRAP) {
      if (game.flagPosition[0] === row && game.flagPosition[1] === col) {
        addLog('⚠️ Нельзя ставить капкан на клетку с флагом!');
        return;
      }
      const updatedGame = { ...game };
      updatedGame.trapPosition = [row, col];
      updatedGame.board = buildSetupPreviewBoard(updatedGame.flagPosition, [row, col], owner);
      updatedGame.setupPhase = GAME_CONFIG.SETUP_PHASES.DONE;
      setGame(updatedGame);
      addLog(`Trap placed at ${formatBoardCoord(row, col)}. Ready to start.`);
    }
  };

  const handleResetSetup = () => {
    if (!game) return;
    const updatedGame = { ...game };
    updatedGame.flagPosition = null;
    updatedGame.trapPosition = null;
    updatedGame.setupPhase = GAME_CONFIG.SETUP_PHASES.FLAG;
    // Clear the board of any temporary flag/trap pieces
    updatedGame.board = updatedGame.board.map(rArr => rArr.map(() => null));
    setGame(updatedGame);
    setSetupTimeLeft(SETUP_TIME_LIMIT);
    setupTimeoutHandledRef.current = false;
    addLog('🔄 Настройка сброшена. Установите флаг.');
  };

  const handleStartBattle = () => {
    if (!game || game.setupPhase !== GAME_CONFIG.SETUP_PHASES.DONE) return;
    if (gameMode === 'pvp') {
      const flagPos = game.flagPosition;
      const trapPos = game.trapPosition;
      const fRow = pvpRole === 'p2' ? 5 - flagPos[0] : flagPos[0];
      const fCol = pvpRole === 'p2' ? 7 - flagPos[1] : flagPos[1];
      const tRow = pvpRole === 'p2' ? 5 - trapPos[0] : trapPos[0];
      const tCol = pvpRole === 'p2' ? 7 - trapPos[1] : trapPos[1];
      
      socketRef.current.emit('game:setup_placement', {
        flagRow: fRow,
        flagCol: fCol,
        trapRow: tRow,
        trapCol: tCol
      });
      return;
    }
    const updatedGame = { ...game };
    startGame(updatedGame);
    setGame(updatedGame);
    addLog('⚔️ Бой начался! Ваш ход.');
  };

  const handleCellClick = async (visualRow, visualCol) => {
    if (!game || game.gameOver) return;

    const { ar: row, ac: col } = getVisualRowCol(visualRow, visualCol);

    if (gameMode === 'pvp') {
      const isMyTurn = game.currentPlayer === pvpRole;
      if (!isMyTurn || game.battleState) return;

      if (selectedPiece) {
        const isMoveValid = validMoves.some(([r, c]) => r === row && c === col);
        if (isMoveValid) {
          socketRef.current.emit('game:make_move', {
            fromRow: selectedPiece.row,
            fromCol: selectedPiece.col,
            toRow: row,
            toCol: col
          });
          deselectPiece();
          return;
        } else {
          const target = game.board[row][col];
          if (target && target.owner === pvpRole && !target.immobilized) {
            selectPiece(target);
          } else {
            deselectPiece();
          }
        }
      } else {
        const target = game.board[row][col];
        if (target && target.owner === pvpRole && !target.immobilized) {
          selectPiece(target);
        }
      }
      return;
    }

    if (game.currentPlayer !== PLAYER || isBotThinking) return;

    if (selectedPiece) {
      const isMoveValid = validMoves.some(([r, c]) => r === row && c === col);
      if (isMoveValid) {
        const updatedGame = { ...game };
        const pieceRef = updatedGame.board[selectedPiece.row][selectedPiece.col];
        
        const result = makeMove(updatedGame, pieceRef, row, col);
        if (result.type !== 'battle' || result.result !== 'draw') {
          endTurn(updatedGame);
        }
        processMoveResult(updatedGame, result);
        return;
      } else {
        const target = game.board[row][col];
        if (target && target.owner === PLAYER && !target.immobilized) {
          selectPiece(target);
        } else {
          deselectPiece();
        }
      }
    } else {
      const target = game.board[row][col];
      if (target && target.owner === PLAYER && !target.immobilized) {
        selectPiece(target);
      }
    }
  };

  const selectPiece = (piece) => {
    setSelectedPiece(piece);
    const side = gameMode === 'pvp' ? pvpRole : PLAYER;
    const moves = getValidMoves(piece.row, piece.col, game.board, side);
    setValidMoves(moves);
  };

  const deselectPiece = () => {
    setSelectedPiece(null);
    setValidMoves([]);
  };

  const processMoveResult = (updatedGame, result) => {
    deselectPiece();
    
    if (result.type === 'move') {
      const fromCoord = formatBoardCoord(result.from[0], result.from[1]);
      const toCoord = formatBoardCoord(result.to[0], result.to[1]);
      addLog(`🏃‍♂️ ${result.piece.owner === PLAYER ? 'Игрок' : 'Бот'} переместился с ${fromCoord} на ${toCoord}`);
    } else if (result.type === 'battle' || result.type === 'battle_trap' || result.type === 'battle_flag') {
      const attackerName = result.attacker.owner === PLAYER ? 'Игрок' : 'Бот';
      const defenderName = result.defender.owner === PLAYER ? 'Игрок' : 'Бот';
      const attSym = PIECE_SYMBOLS[result.attacker.pieceType || result.attacker.type];
      const defSym = PIECE_SYMBOLS[result.defender.pieceType || result.defender.type];
      
      let battleDesc = `⚔️ Битва: ${attackerName} (${attSym}) vs ${defenderName} (${defSym})`;
      
      if (result.result === 'win') {
        battleDesc += ` -> Победа ${result.attacker.owner === PLAYER ? 'Игрока' : 'Бота'}!`;
      } else if (result.result === 'lose') {
        battleDesc += ` -> Победа ${result.defender.owner === PLAYER ? 'Игрока' : 'Бота'}!`;
      } else {
        battleDesc += ` -> НИЧЬЯ! Требуется выбор для переигровки.`;
      }
      
      addLog(battleDesc);
    }
    
    setGame({ ...updatedGame });
    
    if (updatedGame.gameOver) {
      handleGameOver(updatedGame.winner, updatedGame.endReason);
      return;
    }
    
    if (updatedGame.battleState) {
      return;
    }
    
    if (updatedGame.currentPlayer === COMPUTER) {
      triggerBotTurn(updatedGame);
    }
  };

  const triggerBotTurn = (currentGame) => {
    setIsBotThinking(true);
    addLog('🤖 Бот размышляет над ходом...');
    
    setTimeout(() => {
      const updatedGame = { ...currentGame };
      const result = makeBotMove(updatedGame);
      setIsBotThinking(false);
      processMoveResult(updatedGame, result);
    }, GAME_CONFIG.TIMING.AI_THINK_DELAY || 1000);
  };

  const handleChoiceClick = (type) => {
    if (!game || !game.battleState) return;
    
    if (gameMode === 'pvp') {
      socketRef.current.emit('game:make_choice', { choice: type });
      return;
    }
    
    const updatedGame = { ...game };
    const playerChoice = type;
    const aiChoice = updatedGame.battleState.aiChoice;
    
    const result = makeChoice(updatedGame, type);
    
    const playerChoiceSym = PIECE_SYMBOLS[playerChoice];
    const aiChoiceSym = PIECE_SYMBOLS[aiChoice];
    addLog(`🎯 Переигровка: Вы (${playerChoiceSym}) vs Бот (${aiChoiceSym})`);
    
    if (result.type === 'tie_resolved') {
      addLog(`⚔️ Ничья разрешена: ${result.winner === PLAYER ? 'Победа!' : 'Поражение.'}`);
      endTurn(updatedGame);
      setGame(updatedGame);
      
      if (updatedGame.gameOver) {
        handleGameOver(updatedGame.winner, updatedGame.endReason);
        return;
      }
      
      if (updatedGame.currentPlayer === COMPUTER) {
        triggerBotTurn(updatedGame);
      }
    } else if (result.type === 'mutual_annihilation') {
      addLog(`💥 Взаимоуничтожение после 6 ничьих! Обе фигуры погибли.`);
      endTurn(updatedGame);
      setGame(updatedGame);
      
      if (updatedGame.gameOver) {
        handleGameOver(updatedGame.winner, updatedGame.endReason);
        return;
      }
      
      if (updatedGame.currentPlayer === COMPUTER) {
        triggerBotTurn(updatedGame);
      }
    } else {
      addLog(`🤝 Снова ничья! Раунд переигровки: ${result.drawRound}`);
      setGame(updatedGame);
    }
  };

  const handleGameOver = async (winner, reason) => {
    const playerWon = winner === PLAYER;
    const isDraw = winner === 'draw';
    const skipRating = reason === 'setup_timeout';

    let desc;
    if (reason === 'setup_timeout') {
      desc = '⏱️ Время на расстановку вышло — партия не началась.';
    } else {
      desc = `🏁 Игра окончена: ${isDraw ? 'Ничья!' : (playerWon ? 'Победа игрока!' : 'Поражение игрока!')}`;
      if (reason === 'flag_captured') {
        desc += ' (Флаг захвачен)';
      } else if (reason === 'no_pieces') {
        desc += ' (Все боевые фигуры уничтожены)';
      } else if (reason === 'hopeless') {
        desc += ' (Положение безнадежно)';
      } else if (reason === 'no_moves') {
        desc += ' (Нет доступных ходов)';
      } else if (reason === 'surrender') {
        desc += ' (Сдался)';
      } else if (reason === 'no_captures_draw') {
        desc += ' (20 ходов без взятий)';
      }
    }

    addLog(desc);

    if (skipRating || gameMode === 'pvp') {
      setRatingUpdate(null);
      return;
    }

    const resultType = isDraw ? 'draw' : (playerWon ? 'win' : 'lose');
    const botId = game?.botId;
    setRatingUpdate(null);
    await updateStatsOnServer(resultType, botId);
    if (token) {
      await fetchUserProfile(token);
    }
  };

  const handleSurrender = () => {
    setSurrenderModalVisible(true);
  };

  const confirmSurrender = () => {
    if (!game) return;
    setSurrenderModalVisible(false);
    if (gameMode === 'pvp') {
      socketRef.current.emit('game:surrender');
      return;
    }
    const updatedGame = { ...game };
    endGame(updatedGame, false, 'surrender');
    setGame({ ...updatedGame });
    handleGameOver(COMPUTER, 'surrender');
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.appBg]}>
        <PageShell narrow style={styles.centeredShell}>
          <SurfaceCard style={styles.loadingCard}>
            <ActivityIndicator size="large" color="#c2410c" />
            <Text style={styles.loadingText}>Загрузка RPS Battle v2...</Text>
          </SurfaceCard>
        </PageShell>
      </View>
    );
  }

  // --- Login / Splash Screen ---
  if (!user) {
    return (
      <View style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <SafeAreaView style={styles.flex1}>
          <View style={styles.authScreen}>
            <PageShell narrow padH={layout.padH}>
              <SurfaceCard style={[styles.authCard, layout.compact && styles.authCardCompact]}>
                <Text style={styles.brandMark}>⚔️</Text>
                <Text style={styles.logoText}>
                  RPS Battle <Text style={styles.v2Badge}>v2</Text>
                </Text>
                <Text style={styles.subtitle}>
                  Тактические бои камень·бумага·ножницы с ИИ-оппонентами
                </Text>

                <TouchableOpacity style={styles.loginBtn} onPress={handleLogin}>
                  <Text style={styles.loginBtnText}>Войти через Google</Text>
                </TouchableOpacity>



                {error && <Text style={styles.errorText}>{error}</Text>}
              </SurfaceCard>
            </PageShell>
            <Text style={styles.footerText}>React Native · Node.js · MySQL</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // --- PvP Arena ---
  if (screen === 'arena') {
    const visiblePlayers = arenaPlayers
      .filter((p) => String(p.id) !== String(user?.id))
      .slice(0, 20);

    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <ScrollView
          style={styles.scrollFlex}
          contentContainerStyle={[
            styles.scrollPage,
            { paddingVertical: layout.padH, paddingBottom: layout.padH + 16 }
          ]}
          showsVerticalScrollIndicator={false}
        >
          <PageShell padH={layout.padH} maxWidth={layout.shellMax}>
            <View style={styles.botSelectTopBarInner}>
              <TouchableOpacity
                style={styles.botSelectBackBtn}
                onPress={() => {
                  handleLeaveQueue();
                  setScreen('lobby');
                }}
              >
                <Text style={styles.botSelectBackBtnText}>← Назад</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.sectionHeader, { marginTop: layout.gap }]}>
              <Text style={[styles.sectionTitle, layout.compact && styles.sectionTitleCompact]}>
                🌐 PvP арена
              </Text>
              <Text style={styles.sectionSubtitle}>
                Найдите соперника или создайте комнату
              </Text>
              <View style={styles.arenaStatRow}>
                <View style={styles.arenaStatPill}>
                  <Text style={styles.arenaStatPillValue}>{arenaOnlineCount}</Text>
                  <Text style={styles.arenaStatPillLabel}>онлайн</Text>
                </View>
                <View style={styles.arenaStatPill}>
                  <Text style={styles.arenaStatPillValue}>{visiblePlayers.length}</Text>
                  <Text style={styles.arenaStatPillLabel}>доступны</Text>
                </View>
                <View style={styles.arenaStatPill}>
                  <Text style={styles.arenaStatPillValue}>{publicRooms.length}</Text>
                  <Text style={styles.arenaStatPillLabel}>комнат</Text>
                </View>
              </View>
            </View>

            {myWaitingRoomId && (
              <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
                <View style={styles.arenaWaitingCard}>
                  <ActivityIndicator size="small" color="#c2410c" />
                  <View style={styles.arenaWaitingCardText}>
                    <Text style={styles.arenaWaitingTitle}>
                      {myWaitingRoomPrivate ? 'Приватная комната' : 'Ваша открытая комната'}
                    </Text>
                    <Text style={styles.arenaWaitingDesc}>
                      {myWaitingRoomPrivate && createdRoomCode
                        ? `Ожидание соперника. Код: ${createdRoomCode}`
                        : 'Ожидание соперника…'}
                    </Text>
                  </View>
                  <TouchableOpacity style={styles.arenaWaitingCancelBtn} onPress={handleCloseMyWaitingRoom}>
                    <Text style={styles.arenaWaitingCancelText}>Отмена</Text>
                  </TouchableOpacity>
                </View>
              </SurfaceCard>
            )}

            {(arenaStatus || isSearchingMatch) && (
              <SurfaceCard accent style={[styles.arenaStatusCard, { padding: layout.cardPad, marginBottom: layout.gap }]}>
                {isSearchingMatch && (
                  <ActivityIndicator size="small" color="#c2410c" style={{ marginBottom: 8 }} />
                )}
                <Text style={styles.arenaStatusText}>
                  {isSearchingMatch ? 'Поиск соперника...' : arenaStatus}
                </Text>
                {isSearchingMatch && (
                  <TouchableOpacity style={styles.arenaLinkBtn} onPress={handleLeaveQueue}>
                    <Text style={styles.arenaLinkBtnText}>Отменить поиск</Text>
                  </TouchableOpacity>
                )}
              </SurfaceCard>
            )}

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>Режимы игры</Text>
              <View style={styles.arenaModeGrid}>
                <TouchableOpacity
                  style={[
                    styles.arenaModeTile,
                    styles.arenaModeTileHero,
                    isSearchingMatch && styles.arenaModeTileDisabled
                  ]}
                  onPress={handleJoinQueue}
                  disabled={isSearchingMatch}
                  activeOpacity={0.85}
                >
                  <Text style={styles.arenaModeEmoji}>⚡</Text>
                  <Text style={styles.arenaModeTitle}>Быстрый матч</Text>
                  <Text style={styles.arenaModeDesc}>Автоподбор соперника</Text>
                </TouchableOpacity>

                <View style={[styles.arenaModeRow, isWide && styles.arenaModeRowWide]}>
                  <TouchableOpacity
                    style={[styles.arenaModeTile, roomsAtCap && styles.arenaModeTileDisabled]}
                    onPress={handleCreatePrivateRoom}
                    disabled={roomsAtCap}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.arenaModeEmoji}>🔒</Text>
                    <Text style={styles.arenaModeTitle}>Приватная</Text>
                    <Text style={styles.arenaModeDesc}>По коду</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.arenaModeTile, roomsAtCap && styles.arenaModeTileDisabled]}
                    onPress={handleCreateOpenRoom}
                    disabled={roomsAtCap}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.arenaModeEmoji}>🌐</Text>
                    <Text style={styles.arenaModeTitle}>Открытая</Text>
                    <Text style={styles.arenaModeDesc}>В списке</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {roomsAtCap && (
                <Text style={[styles.infoBody, { marginTop: 12, color: '#b45309' }]}>
                  Лимит 10 комнат — присоединяйтесь к существующей
                </Text>
              )}
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>Войти по коду</Text>
              <Text style={[styles.infoBody, { marginBottom: 12 }]}>
                Приватные комнаты не видны в списке
              </Text>
              <View style={[styles.arenaCodeRow, layout.mobile && styles.arenaCodeRowStack]}>
                <TextInput
                  style={[
                    styles.arenaCodeInput,
                    layout.mobile ? styles.arenaCodeInputStack : styles.arenaCodeInputFlex
                  ]}
                  placeholder="Код"
                  placeholderTextColor="#9ca3af"
                  value={roomCodeInput}
                  onChangeText={setRoomCodeInput}
                  autoCapitalize="characters"
                  maxLength={8}
                />
                <TouchableOpacity
                  style={[styles.arenaCodeBtn, layout.mobile && styles.arenaCodeBtnStack]}
                  onPress={handleJoinByCode}
                >
                  <Text style={styles.arenaCodeBtnText}>Войти</Text>
                </TouchableOpacity>
              </View>
            </SurfaceCard>

            <View style={[styles.blockRow, isWide && styles.blockRowWide, { gap: layout.gap }]}>
              <SurfaceCard
                style={[
                  styles.blockFlex,
                  isWide && styles.blockHalf,
                  { padding: layout.cardPad, marginBottom: isWide ? 0 : layout.gap }
                ]}
              >
                <Text style={styles.cardTitle}>Открытые комнаты</Text>
                <Text style={[styles.infoBody, { marginBottom: 12 }]}>До 10 одновременно</Text>
                {publicRooms.filter((room) =>
                  !user || String(room.creatorId) !== String(user.id)
                ).length === 0 ? (
                  <View style={styles.arenaEmptyBox}>
                    <Text style={styles.arenaEmptyText}>Пока нет открытых комнат</Text>
                  </View>
                ) : (
                  publicRooms
                    .filter((room) => !user || String(room.creatorId) !== String(user.id))
                    .map((room) => (
                      <View key={room.id} style={styles.arenaRoomCard}>
                        <View style={styles.arenaRoomCardInfo}>
                          <Text style={styles.arenaRoomName} numberOfLines={1}>
                            {room.creatorName || 'Игрок'}
                          </Text>
                          <Text style={styles.arenaRoomMeta}>
                            {room.playersCount || 1}/2 · открытая
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.arenaJoinBtn}
                          onPress={() => handleJoinPublicRoom(room.id)}
                        >
                          <Text style={styles.arenaJoinBtnText}>Войти</Text>
                        </TouchableOpacity>
                      </View>
                    ))
                )}
              </SurfaceCard>

              <SurfaceCard
                style={[
                  styles.blockFlex,
                  isWide && styles.blockHalf,
                  { padding: layout.cardPad, marginBottom: 0 }
                ]}
              >
                <Text style={styles.cardTitle}>Игроки онлайн</Text>
                <Text style={[styles.infoBody, { marginBottom: 12 }]}>
                  До 20 в списке
                </Text>
                {visiblePlayers.length === 0 ? (
                  <View style={styles.arenaEmptyBox}>
                    <Text style={styles.arenaEmptyText}>Пока никого кроме вас</Text>
                  </View>
                ) : (
                  visiblePlayers.map((p) => (
                    <View key={p.id} style={styles.arenaPlayerCard}>
                      {p.avatar ? (
                        <Image source={{ uri: p.avatar }} style={styles.arenaPlayerAvatar} />
                      ) : (
                        <View style={[styles.arenaPlayerAvatar, styles.avatarPlaceholder]}>
                          <Text style={styles.profileHeroLetter}>{(p.name || '?')[0]}</Text>
                        </View>
                      )}
                      <View style={styles.arenaPlayerInfo}>
                        <Text style={styles.arenaPlayerName} numberOfLines={1}>
                          {p.name || 'Игрок'}
                        </Text>
                        <Text style={styles.arenaPlayerRating}>{p.ratingMmr ?? 1000} MMR</Text>
                        {(() => {
                          const stats = user?.pvpOpponentStats?.find(s => String(s.opponentId || s.opponent?.id) === String(p.id)) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
                          return (
                            <Text style={{ fontSize: 11, color: '#6b5744', marginTop: 2 }}>
                              Игр: {stats.gamesPlayed} · В:{stats.wins} П:{stats.losses} Н:{stats.draws}
                            </Text>
                          );
                        })()}
                      </View>
                      {p.inGame ? (
                        <View style={styles.arenaBusyBadge}>
                          <Text style={styles.arenaBusyLabel}>В игре</Text>
                        </View>
                      ) : (
                        <TouchableOpacity
                          style={styles.arenaChallengeBtn}
                          onPress={() => handleChallengePlayer(p.id)}
                        >
                          <Text style={styles.arenaChallengeBtnText}>Вызов</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ))
                )}
              </SurfaceCard>
            </View>
          </PageShell>
        </ScrollView>

        <Modal animationType="fade" transparent visible={!!pendingInvite}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Вызов на дуэль</Text>
              <Text style={styles.modalSubtitle}>
                {pendingInvite?.from?.name || 'Игрок'} вызывает вас на бой
              </Text>
              <View style={[styles.choiceRow, { marginTop: 16 }]}>
                <TouchableOpacity style={styles.choiceBtn} onPress={() => setPendingInvite(null)}>
                  <Text style={styles.choiceText}>Отклонить</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.choiceBtn, { backgroundColor: '#c2410c' }]} onPress={handleAcceptInvite}>
                  <Text style={[styles.choiceText, { color: '#fff' }]}>Принять</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // --- Matchmaking View ---
  if (screen === 'matchmaking') {
    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <View style={styles.scrollFlex}>
          <PageShell narrow style={styles.centeredShell}>
            <SurfaceCard style={styles.loadingCard}>
              <ActivityIndicator size="large" color="#c2410c" />
              <Text style={[styles.loadingText, { fontSize: 20, fontWeight: '800', marginTop: 24 }]}>
                Поиск соперника...
              </Text>
              <Text style={{ color: '#6b5744', marginTop: 8, fontSize: 14 }}>
                Время в очереди: {matchmakingTime} сек.
              </Text>
              <TouchableOpacity
                style={[styles.actionBtn, styles.primaryBtnOutline, { marginTop: 24, alignSelf: 'stretch', justifyContent: 'center' }]}
                onPress={handleLeaveQueue}
              >
                <Text style={styles.primaryBtnOutlineText}>Отмена</Text>
              </TouchableOpacity>
            </SurfaceCard>
          </PageShell>
        </View>
      </SafeAreaView>
    );
  }

  // --- Lobby View ---
  if (screen === 'lobby') {
    const botList = botRegistry.list();
    const quickOpponents = buildQuickOpponents(user, arenaPlayers, botList);
    const pvpWins = user.stats?.wins ?? 0;
    const pvpLosses = user.stats?.losses ?? 0;
    const pvpDraws = user.stats?.draws ?? 0;

    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <ScrollView
          style={styles.scrollFlex}
          contentContainerStyle={[
            styles.scrollPage,
            { paddingVertical: layout.padH, paddingBottom: layout.padH + 16 }
          ]}
          showsVerticalScrollIndicator={false}
        >
          <PageShell padH={layout.padH} maxWidth={layout.shellMax}>
            <SurfaceCard style={styles.profileBarCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <TouchableOpacity
                  style={[styles.profileTapRow, { flex: 1 }]}
                  activeOpacity={0.8}
                  onPress={() => {
                    setScreen('profile');
                  }}
                >
                  {user.avatarUrl ? (
                    <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarPlaceholder]}>
                      <Text style={styles.avatarLetter}>{user.nickname[0].toUpperCase()}</Text>
                    </View>
                  )}
                  <View style={styles.profileInfo}>
                    <Text style={styles.nickname} numberOfLines={1} ellipsizeMode="tail">
                      {user.nickname}
                    </Text>
                    <Text style={styles.profileTapHint} numberOfLines={1}>
                      Мой профиль ›
                    </Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.lobbyLogoutBtn}
                  onPress={handleLogout}
                >
                  <Text style={styles.lobbyLogoutBtnText}>Выйти</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>Скин доски и фигур:</Text>
                <View style={styles.skinToggleGroup}>
                  <TouchableOpacity
                    style={[styles.skinToggleBtn, boardSkin === 'classic' && styles.skinToggleBtnActive]}
                    onPress={() => changeSkin('classic')}
                  >
                    <Text style={[styles.skinToggleBtnText, boardSkin === 'classic' && styles.skinToggleBtnTextActive]}>
                      Классика (Эмодзи)
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.skinToggleBtn, boardSkin === 'animated' && styles.skinToggleBtnActive]}
                    onPress={() => changeSkin('animated')}
                  >
                    <Text style={[styles.skinToggleBtnText, boardSkin === 'animated' && styles.skinToggleBtnTextActive]}>
                      Анимация
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </SurfaceCard>

            <View style={[styles.blockRow, isWide && styles.blockRowWide, { gap: layout.gap }]}>
              <SurfaceCard
                style={[
                  styles.blockFlex,
                  isWide && styles.blockHalf,
                  { padding: layout.cardPad, marginBottom: layout.gap }
                ]}
              >
                <Text style={styles.cardTitle}>🏆 Рейтинг (PvP)</Text>
                <Text style={styles.profileSectionHint}>Только игры с живыми людьми</Text>
                <View style={styles.ratingRow}>
                  <Text style={[styles.ratingValue, layout.compact && styles.ratingValueCompact]}>
                    {user.stats?.ratingMmr ?? 1000}
                  </Text>
                  <Text style={styles.ratingLabel}>MMR</Text>
                </View>
                <View style={styles.statsDivider} />
                <View style={styles.winLossGrid}>
                  <View style={styles.gridItem}>
                    <Text style={[styles.gridValue, styles.greenText]}>{pvpWins}</Text>
                    <Text style={styles.gridLabel}>Побед</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={[styles.gridValue, styles.redText]}>{pvpLosses}</Text>
                    <Text style={styles.gridLabel}>Поражений</Text>
                  </View>
                  <View style={styles.gridItem}>
                    <Text style={[styles.gridValue, styles.grayText]}>{pvpDraws}</Text>
                    <Text style={styles.gridLabel}>Ничьих</Text>
                  </View>
                </View>
              </SurfaceCard>

              <SurfaceCard
                style={[
                  styles.blockFlex,
                  isWide && styles.blockHalf,
                  { padding: layout.cardPad, marginBottom: layout.gap }
                ]}
              >
                <Text style={styles.cardTitle}>🎲 Режим игры</Text>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={openArena}
                >
                  <Text style={styles.actionBtnText}>PvP арена</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.primaryBtnOutline]}
                  onPress={() => {
                    setProfileMenuOpen(false);
                    setScreen('bot_select');
                    setBotSelectTab('free');
                  }}
                >
                  <Text style={styles.primaryBtnOutlineText}>Сыграть с ботом</Text>
                </TouchableOpacity>
              </SurfaceCard>
            </View>

            {quickOpponents.length > 0 && (
              <SurfaceCard style={{ padding: layout.cardPad, marginBottom: 0 }}>
                <Text style={styles.cardTitle}>⚡ Быстрый матч</Text>
                <Text style={[styles.profileSectionHint, { marginBottom: 12 }]}>
                  Частые соперники · в приоритете люди онлайн
                </Text>
                <View style={styles.quickOpponentsRow}>
                  {quickOpponents.map((opp) => (
                    <TouchableOpacity
                      key={`${opp.kind}-${opp.id}`}
                      style={styles.quickOpponentCard}
                      activeOpacity={0.85}
                      onPress={() => {
                        if (opp.kind === 'human') {
                          handleChallengePlayer(opp.id);
                          setArenaStatus(`Вызов отправлен: ${opp.name}`);
                          openArena();
                        } else {
                          handleStartBotGame(opp.id);
                        }
                      }}
                    >
                      {opp.kind === 'human' ? (
                        opp.avatar ? (
                          <Image source={{ uri: opp.avatar }} style={styles.quickOpponentAvatar} />
                        ) : (
                          <View style={[styles.quickOpponentAvatar, styles.avatarPlaceholder]}>
                            <Text style={styles.profileHeroLetter}>{(opp.name || '?')[0]}</Text>
                          </View>
                        )
                      ) : (
                        <Image
                          source={{ uri: resolveAssetUrl(opp.avatar) }}
                          style={styles.quickOpponentAvatar}
                        />
                      )}
                      <Text style={styles.quickOpponentName} numberOfLines={1}>{opp.name}</Text>
                      <Text style={styles.quickOpponentMeta} numberOfLines={1}>
                        {opp.kind === 'human'
                          ? `${opp.ratingMmr ?? 1000} MMR · ${opp.online ? 'онлайн' : 'офлайн'}`
                          : (opp.modelAuthor ? `Модель: ${opp.modelAuthor}` : 'ИИ-соперник')}
                      </Text>
                      <Text style={styles.quickOpponentGames}>
                        Игр: {opp.games} · В:{opp.wins || 0} П:{opp.losses || 0} Н:{opp.draws || 0}
                      </Text>
                      <Text style={styles.quickOpponentPlay}>Играть →</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </SurfaceCard>
            )}
          </PageShell>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // --- Profile View ---
  if (screen === 'profile') {
    const botStats = user.botOpponentStats || [];
    const pvpStats = user.pvpOpponentStats || [];
    const botTotals = aggregateBotStats(botStats);
    const totalBotGames = botTotals.games;

    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <View style={[styles.profileScreenTopBar, { paddingHorizontal: layout.padH }]}>
          <PageShell padH={0} maxWidth={layout.shellMax} style={styles.botSelectTopBarInner}>
            <TouchableOpacity
              style={styles.botSelectBackBtn}
              onPress={() => setScreen('lobby')}
            >
              <Text style={styles.botSelectBackBtnText}>← Назад</Text>
            </TouchableOpacity>
          </PageShell>
        </View>
        <ScrollView
          style={styles.scrollFlex}
          contentContainerStyle={[
            styles.scrollPage,
            { paddingTop: layout.gap, paddingBottom: layout.padH + 24 }
          ]}
          showsVerticalScrollIndicator={false}
        >
          <PageShell padH={layout.padH} maxWidth={layout.shellMax}>
            <SurfaceCard style={{ padding: layout.cardPad }}>
              <View style={styles.profileHero}>
                {user.avatarUrl ? (
                  <Image source={{ uri: user.avatarUrl }} style={styles.profileHeroAvatar} />
                ) : (
                  <View style={[styles.profileHeroAvatar, styles.avatarPlaceholder]}>
                    <Text style={styles.profileHeroLetter}>{user.nickname[0].toUpperCase()}</Text>
                  </View>
                )}
                <View style={styles.profileHeroInfo}>
                  <Text style={styles.profileHeroName}>{user.nickname}</Text>
                  <Text style={styles.profileHeroMeta}>
                    {user.role === 'admin' ? '🛡️ Администратор' : '🎮 Игрок'}
                  </Text>
                  {user.email ? (
                    <Text style={styles.profileHeroMeta} numberOfLines={1}>{user.email}</Text>
                  ) : null}
                  <Text style={styles.profileHeroMeta}>
                    Платформа: {platformLabel(user.platform)}
                  </Text>
                  <Text style={styles.profileHeroMeta}>
                    В игре с {formatProfileDate(user.createdAt)}
                  </Text>
                </View>
              </View>
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>Против людей (PvP)</Text>
              <Text style={styles.profileSectionHint}>Рейтинг MMR учитывает только дуэли с игроками</Text>
              <View style={styles.ratingRow}>
                <Text style={styles.ratingValue}>{user.stats?.ratingMmr ?? 1000}</Text>
                <Text style={styles.ratingLabel}>MMR</Text>
              </View>
              <View style={styles.statsDivider} />
              <View style={styles.winLossGrid}>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.greenText]}>{user.stats?.wins ?? 0}</Text>
                  <Text style={styles.gridLabel}>Побед</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.redText]}>{user.stats?.losses ?? 0}</Text>
                  <Text style={styles.gridLabel}>Поражений</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.grayText]}>{user.stats?.draws ?? 0}</Text>
                  <Text style={styles.gridLabel}>Ничьих</Text>
                </View>
              </View>
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>Против ботов (PvE)</Text>
              <Text style={styles.profileSectionHint}>
                {totalBotGames > 0
                  ? `Всего ${totalBotGames} партий · рейтинг не меняется`
                  : 'Рейтинг MMR за ботов не начисляется'}
              </Text>
              <View style={styles.winLossGrid}>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.greenText]}>{botTotals.wins}</Text>
                  <Text style={styles.gridLabel}>Побед</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.redText]}>{botTotals.losses}</Text>
                  <Text style={styles.gridLabel}>Поражений</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.grayText]}>{botTotals.draws}</Text>
                  <Text style={styles.gridLabel}>Ничьих</Text>
                </View>
              </View>
            </SurfaceCard>

            {pvpStats.length > 0 && (
              <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
                <Text style={styles.cardTitle}>Игроки (дуэли)</Text>
                {pvpStats.map((row) => {
                  const name = row.opponent?.nickname || 'Игрок';
                  return (
                    <View key={row.opponentId || row.id} style={styles.botStatRow}>
                      {row.opponent?.avatarUrl ? (
                        <Image source={{ uri: row.opponent.avatarUrl }} style={styles.botStatAvatarImg} />
                      ) : (
                        <View style={[styles.botStatAvatarImg, styles.avatarPlaceholder]}>
                          <Text style={styles.profileHeroLetter}>{name[0]}</Text>
                        </View>
                      )}
                      <View style={styles.botStatBody}>
                        <Text style={styles.botStatName} numberOfLines={1}>{name}</Text>
                        <Text style={styles.botStatCounts}>
                          <Text style={styles.greenText}>{row.wins} побед</Text>
                          {' · '}
                          <Text style={styles.redText}>{row.losses} поражений</Text>
                        </Text>
                        <Text style={styles.botStatMeta}>
                          Всего {row.gamesPlayed} · {formatProfileDate(row.lastPlayedAt)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </SurfaceCard>
            )}

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>Боты (по оппонентам)</Text>
              <Text style={styles.profileSectionHint}>
                {totalBotGames > 0
                  ? `Сыграно ${totalBotGames} партий против ИИ`
                  : 'Пока нет завершённых партий с ботами'}
              </Text>
              {botStats.length === 0 ? (
                <Text style={styles.profileEmptyBots}>
                  Выберите бота в лобби и сыграйте — здесь появится счёт побед и поражений.
                </Text>
              ) : (
                botStats.map((row) => {
                  const botMeta = botRegistry.get(row.botId);
                  const name = botMeta?.name || row.botId;
                  return (
                    <View key={row.botId} style={styles.botStatRow}>
                      <Image
                        source={{ uri: resolveAssetUrl(botMeta?.avatar) }}
                        style={styles.botStatAvatarImg}
                      />
                      <View style={styles.botStatBody}>
                        <Text style={styles.botStatName} numberOfLines={1}>{name}</Text>
                        <Text style={styles.botStatCounts}>
                          <Text style={styles.greenText}>{row.wins} побед</Text>
                          {' · '}
                          <Text style={styles.redText}>{row.losses} поражений</Text>
                          {row.draws > 0 ? (
                            <>
                              {' · '}
                              <Text style={styles.grayText}>{row.draws} ничьих</Text>
                            </>
                          ) : null}
                        </Text>
                        <Text style={styles.botStatMeta}>
                          Всего {row.gamesPlayed} · последняя партия{' '}
                          {formatProfileDate(row.lastPlayedAt)}
                        </Text>
                      </View>
                    </View>
                  );
                })
              )}
            </SurfaceCard>

            <TouchableOpacity style={styles.profileLogoutBtn} onPress={handleLogout}>
              <Text style={styles.profileLogoutBtnText}>Выйти из аккаунта</Text>
            </TouchableOpacity>
          </PageShell>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // --- Bot Selection View ---
  if (screen === 'bot_select') {
    const listBots = botRegistry.list();
    const easyBots = listBots.filter((b) => b.tier === 'easy');
    const mediumBots = listBots.filter((b) => b.tier === 'medium');
    const hardBots = listBots.filter((b) => b.tier === 'hard');
    const isWeb = Platform.OS === 'web';

    const TOURNAMENT_LADDER_V1 = [
      'rabbit',
      'raccoon',
      'fox',
      'owl',
      'lion',
      'wolf',
      'hedgehog',
      'raven',
      'kimi_2_5',
      'codex_5_3_medium',
      'composer_2_5',
      'gemini_3_1_pro',
      'gemini_3_5_flash',
      'gpt_5_5',
      'grok_apex',
      'grok_build_0_1',
      'haiku_4_5',
      'opus_4_7_flash',
      'opus_4_8_high',
      'sonnet_4_6_medium'
    ];

    const TOURNAMENT_LADDER_V2 = [
      'grok_build_0_1',
      'gemini_3_1_pro',
      'sonnet_4_6_medium',
      'haiku_4_5',
      'grok_apex',
      'rabbit',
      'kimi_2_5',
      'lion',
      'codex_5_3_medium',
      'raccoon',
      'raven',
      'fox',
      'gpt_5_5',
      'opus_4_8_high',
      'hedgehog',
      'wolf',
      'gemini_3_5_flash',
      'owl',
      'opus_4_7_flash',
      'composer_2_5'
    ];

    const TOURNAMENT_LADDER = (user?.stats?.tournamentVersion === 2)
      ? TOURNAMENT_LADDER_V2
      : TOURNAMENT_LADDER_V1;
    
    const currentStage = user?.stats?.tournamentStage ?? 0;
    const isCompleted = currentStage >= TOURNAMENT_LADDER.length;

    const handleChallengeTournamentBot = (botId) => {
      setIsTournamentActive(true);
      handleStartBotGame(botId);
    };

    const renderBotCard = (bot) => {
      const isSelected = selectedBotId === bot.id;
      const cardStyles = [
        styles.botCard,
        isWeb && styles.botCardWeb,
        bot.tier === 'easy' && styles.botCardEasy,
        bot.tier === 'medium' && styles.botCardMedium,
        bot.tier === 'hard' && styles.botCardHard,
        isSelected && styles.botCardSelected
      ];
      return (
        <View
          key={bot.id}
          style={cardStyles}
        >
          <TouchableOpacity
            style={styles.botCardBody}
            activeOpacity={0.85}
            onPress={() => setSelectedBotId(bot.id)}
          >
            <View style={styles.botCardHeader}>
              <Image
                source={{ uri: resolveAssetUrl(bot.avatar) }}
                style={styles.botCardAvatar}
              />
              <View style={styles.botNameCol}>
                <Text style={styles.botName}>{bot.name}</Text>
                <Text style={styles.botAlgorithm}>{bot.difficultyLabel}</Text>
              </View>
            </View>
            <Text style={styles.botDescription} numberOfLines={3}>
              {bot.longDescription || bot.shortDescription}
            </Text>
            {bot.modelAuthor ? (
              <Text style={styles.botModelAuthor} numberOfLines={2}>
                Модель: {bot.modelAuthor}
              </Text>
            ) : null}
            {(() => {
              const stats = user?.botOpponentStats?.find((s) => s.botId === bot.id) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
              return (
                <Text style={{ fontSize: 11, color: '#7c2d12', fontWeight: '700', marginTop: 4 }}>
                  Статистика: Игр: {stats.gamesPlayed} · В:{stats.wins} П:{stats.losses} Н:{stats.draws}
                </Text>
              );
            })()}
          </TouchableOpacity>
          {isSelected && (
            <TouchableOpacity
              style={styles.botCardStartBtn}
              activeOpacity={0.9}
              onPress={() => {
                setIsTournamentActive(false); // Free play
                handleStartBotGame(bot.id);
              }}
            >
              <Text style={styles.botCardStartBtnText}>Начать с {bot.name}</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    };

    const renderBotColumn = (title, bots) => (
      <View style={[styles.botColumn, isWeb && styles.botColumnWeb]}>
        <Text style={styles.botColumnTitle}>{title}</Text>
        {bots.map(renderBotCard)}
      </View>
    );

    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <View style={styles.flex1}>
          <View style={[styles.botSelectTopBar, { paddingHorizontal: layout.padH }]}>
            <PageShell padH={0} maxWidth={layout.shellMax} style={styles.botSelectTopBarInner}>
              <TouchableOpacity
                style={styles.botSelectBackBtn}
                onPress={() => {
                  setIsTournamentActive(false);
                  setScreen('lobby');
                }}
                accessibilityRole="button"
                accessibilityLabel="Назад в лобби"
              >
                <Text style={styles.botSelectBackBtnText}>← Назад</Text>
              </TouchableOpacity>
              
              <View style={styles.botSelectTabs}>
                <TouchableOpacity
                  style={[styles.botSelectTab, botSelectTab === 'tournament' && styles.botSelectTabActive]}
                  onPress={() => setBotSelectTab('tournament')}
                >
                  <Text style={[styles.botSelectTabText, botSelectTab === 'tournament' && styles.botSelectTabTextActive]}>
                    🏆 Башня
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.botSelectTab, botSelectTab === 'free' && styles.botSelectTabActive]}
                  onPress={() => setBotSelectTab('free')}
                >
                  <Text style={[styles.botSelectTabText, botSelectTab === 'free' && styles.botSelectTabTextActive]}>
                    🎲 Свободная игра
                  </Text>
                </TouchableOpacity>
              </View>
            </PageShell>
          </View>

          <ScrollView
            style={styles.scrollFlex}
            contentContainerStyle={[
              styles.scrollPage,
              { paddingTop: layout.gap, paddingBottom: layout.padH + 24 }
            ]}
            showsVerticalScrollIndicator={false}
          >
            <PageShell padH={layout.padH} maxWidth={layout.shellMax}>
              {botSelectTab === 'tournament' ? (
                <View>
                  {isCompleted ? (
                    <SurfaceCard style={[styles.tournamentWinCard, { marginBottom: 24 }]}>
                      <Text style={styles.tournamentWinEmoji}>👑</Text>
                      <Text style={styles.tournamentWinTitle}>Поздравляем!</Text>
                      <Text style={styles.tournamentWinSubtitle}>
                        {user?.stats?.tournamentVersion === 2
                          ? 'Вы прошли Башню испытаний и одолели всех ИИ-соперников от Ленивчика до Лосёнка!'
                          : 'Вы прошли Башню испытаний и одолели всех ИИ-соперников от Зайчика до Капибарыша!'}
                      </Text>
                      <TouchableOpacity
                        style={styles.tournamentResetBtn}
                        onPress={handleResetTournament}
                      >
                        <Text style={styles.tournamentResetBtnText}>Начать сначала</Text>
                      </TouchableOpacity>
                    </SurfaceCard>
                  ) : (
                    <View style={styles.tournamentIntro}>
                      <Text style={styles.tournamentIntroTitle}>Пройдите испытание Башни</Text>
                      <Text style={styles.tournamentIntroSubtitle}>
                        Побеждайте соперников одного за другим. Текущий этап: {currentStage + 1} из {TOURNAMENT_LADDER.length}
                      </Text>
                    </View>
                  )}

                  <View style={styles.towerLadderContainer}>
                    {TOURNAMENT_LADDER.map((botId, index) => {
                      const bot = botRegistry.get(botId);
                      const isBeaten = index < currentStage;
                      const isCurrent = index === currentStage;
                      const isLocked = index > currentStage;

                      return (
                        <View
                          key={botId}
                          style={[
                            styles.towerStep,
                            isCurrent && styles.towerStepCurrent,
                            isBeaten && styles.towerStepBeaten,
                            isLocked && styles.towerStepLocked
                          ]}
                        >
                          <View style={styles.towerStepNumberCol}>
                            <Text style={styles.towerStepNumber}>Этап {index + 1}</Text>
                          </View>
                          
                          <View style={styles.towerStepBotAvatarCol}>
                            <Image
                              source={{ uri: resolveAssetUrl(bot?.avatar) }}
                              style={styles.towerStepAvatar}
                            />
                          </View>

                          <View style={styles.towerStepInfoCol}>
                            <Text style={[styles.towerStepBotName, isLocked && styles.textMuted]}>
                              {bot?.name}
                            </Text>
                            <Text style={styles.towerStepDifficulty}>
                              {isBeaten ? '🏆 Побежден' : bot?.difficultyLabel}
                            </Text>
                            {(() => {
                              const stats = user?.botOpponentStats?.find(s => s.botId === botId) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
                              return (
                                <Text style={{ fontSize: 11, color: '#9a8a78', marginTop: 2 }}>
                                  Игр: {stats.gamesPlayed} · В:{stats.wins} П:{stats.losses} Н:{stats.draws}
                                </Text>
                              );
                            })()}
                          </View>

                          <View style={styles.towerStepActionCol}>
                            {isBeaten && (
                              <View style={styles.beatenBadge}>
                                <Text style={styles.beatenBadgeText}>✓</Text>
                              </View>
                            )}
                            {isCurrent && (
                              <TouchableOpacity
                                style={styles.towerChallengeBtn}
                                onPress={() => handleChallengeTournamentBot(botId)}
                              >
                                <Text style={styles.towerChallengeBtnText}>Бой</Text>
                              </TouchableOpacity>
                            )}
                            {isLocked && (
                              <Text style={styles.towerLockedLabel}>🔒</Text>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ) : (
                <View>
                  <View style={styles.sectionHeader}>
                    <Text style={[styles.sectionTitle, layout.compact && styles.sectionTitleCompact]}>
                      Выберите оппонента
                    </Text>
                    <Text style={styles.sectionSubtitle}>
                      {listBots.length} ботов · нажмите карточку, затем начните партию
                    </Text>
                  </View>

                  <View style={[styles.botGrid, isWeb && styles.botGridWebThreeCol, { gap: layout.gap }]}>
                    {isWeb ? (
                      <>
                        {renderBotColumn('Лёгкие', easyBots)}
                        {renderBotColumn('Средние', mediumBots)}
                        {renderBotColumn('Сложные', hardBots)}
                      </>
                    ) : (
                      listBots.map(renderBotCard)
                    )}
                  </View>
                </View>
              )}
            </PageShell>
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  }

  // --- Game Board View (Setup & Playing) ---
  if (screen === 'game' && game) {
    const activeBot = gameMode === 'pvp' ? null : botRegistry.get(game.botId);
    const isSetup = game.phase === GAME_CONFIG.PHASES.SETUP;
    const isPlaying = game.phase === GAME_CONFIG.PHASES.PLAYING;
    const isFinished = game.phase === GAME_CONFIG.PHASES.FINISHED;
    
    const setupStatus = game.setupPhase === GAME_CONFIG.SETUP_PHASES.FLAG
      ? 'Расстановка: флаг 🏴'
      : game.setupPhase === GAME_CONFIG.SETUP_PHASES.TRAP
        ? 'Расстановка: капкан 💥'
        : 'Готовы к бою';

    const isMyTurn = gameMode === 'pvp' ? game.currentPlayer === pvpRole : game.currentPlayer === PLAYER;
    const isPlayerTurn = isPlaying && (gameMode === 'pvp' ? game.currentPlayer === pvpRole : game.currentPlayer === PLAYER);
    const isBotTurn = isPlaying && (gameMode === 'pvp' ? game.currentPlayer !== pvpRole : game.currentPlayer === COMPUTER);
    const turnFillPercent = isPlaying
      ? ((TURN_TIME_LIMIT - turnTimeLeft) / TURN_TIME_LIMIT) * 100
      : 0;
    const setupFillPercent = isSetup
      ? ((SETUP_TIME_LIMIT - setupTimeLeft) / SETUP_TIME_LIMIT) * 100
      : 0;
    const timerUrgent = isPlaying && turnTimeLeft <= 30;
    const setupTimerUrgent = isSetup && setupTimeLeft <= 15;
    const setupNotStarted = isFinished && game.endReason === 'setup_timeout';
    const drawNoCaptureLimit = GAME_CONFIG.GAME.DRAW_NO_CAPTURE_LIMIT || 20;

    const describeBattlePiece = (piece) => {
      const type = piece?.pieceType || piece?.type;
      const sym = PIECE_SYMBOLS[type] || '❓';
      const label = pieceTypeLabel(type);
      let who = 'Фигура';
      if (gameMode === 'pvp') {
        who = piece?.owner === 'p1'
          ? (game.p1?.nickname || 'Игрок 1')
          : (game.p2?.nickname || 'Игрок 2');
      } else {
        who = piece?.owner === PLAYER ? 'Вы' : (activeBot?.name || 'Бот');
      }
      return { who, sym, label };
    };

    const battleBs = game.battleState;
    const tieAttemptsRemaining = battleBs ? tieAttemptsLeft(battleBs.drawRound) : 0;
    const tieLastChance = tieAttemptsRemaining === 1;
    const pvpWaitingOpponent = gameMode === 'pvp' && battleBs && (
      (pvpRole === 'p1' ? battleBs.p1Chosen : battleBs.p2Chosen)
    );

    const playerPieceCount = gameMode === 'pvp'
      ? (pvpRole === 'p1' ? game.p1.pieceCount : game.p2.pieceCount)
      : countActivePieces(game.playerPieces);
    const botPieceCount = gameMode === 'pvp'
      ? (pvpRole === 'p1' ? game.p2.pieceCount : game.p1.pieceCount)
      : countActivePieces(game.aiPieces);

    const boardBlock = (
      <SurfaceCard style={[styles.boardCard, { padding: layout.cardPad }]}>
        <View
          style={[
            styles.board,
            {
              maxWidth: layout.boardMaxWidth,
              padding: layout.compact ? 4 : layout.mobile ? 6 : 8,
              gap: layout.compact ? 2 : 3
            }
          ]}
        >
            {Array.from({ length: BOARD_HEIGHT }).map((_, r) => (
              <View key={r} style={styles.row}>
                {Array.from({ length: BOARD_WIDTH }).map((_, c) => {
                  const { ar, ac } = getVisualRowCol(r, c);
                  const cell = game.board[ar][ac];
                  const isSetupAllowed = isSetup && [4, 5].includes(r);
                  const isSetupForbidden = isSetup && !isSetupAllowed;
                  const isSetupHovered = isSetupAllowed
                    && hoveredSetupCell?.row === r
                    && hoveredSetupCell?.col === c;
                  
                  // Selection & Move highlights
                  const isSelected = selectedPiece && selectedPiece.row === ar && selectedPiece.col === ac;
                  const isPossibleMove = validMoves.some(([mr, mc]) => mr === ar && mc === ac);
                  const isLastMoveFrom = game.lastMove && game.lastMove.from && game.lastMove.from[0] === ar && game.lastMove.from[1] === ac;
                  const isLastMoveTo = game.lastMove && game.lastMove.to && game.lastMove.to[0] === ar && game.lastMove.to[1] === ac;
                  
                  // Style configurations
                  const isDarkCell = (r + c) % 2 !== 0;
                  let cellStyle = [styles.cell];
                  if (boardSkin === 'animated') {
                    cellStyle.push(isDarkCell ? styles.cartoonDarkCell : styles.cartoonLightCell);
                  } else {
                    cellStyle.push(isDarkCell ? styles.darkCell : styles.lightCell);
                  }
                  if (isSetupAllowed) {
                    cellStyle.push(isDarkCell ? styles.setupZoneDark : styles.setupZoneLight);
                  }
                  if (isSetupHovered) cellStyle.push(styles.setupZoneHover);
                  if (isSetupForbidden) cellStyle.push(styles.setupZoneForbidden);
                  if (isSelected) cellStyle.push(styles.selectedCell);
                  if (isPossibleMove) cellStyle.push(styles.possibleMoveCell);
                  if (isLastMoveFrom) cellStyle.push(styles.lastMoveFromCell);
                  if (isLastMoveTo) cellStyle.push(styles.lastMoveToCell);
                  
                  // Render occupant
                  let symbol = null;
                  let isEnemy = false;
                  let isImmobilized = false;
                  
                  if (isSetup) {
                    // Только визуальные позиции — не дублировать через зеркало board
                    if (game.flagPosition && game.flagPosition[0] === r && game.flagPosition[1] === c) {
                      symbol = PIECE_SYMBOLS[FLAG];
                    } else if (game.trapPosition && game.trapPosition[0] === r && game.trapPosition[1] === c) {
                      symbol = PIECE_SYMBOLS[TRAP];
                    }
                  } else if (cell) {
                    isEnemy = gameMode === 'pvp' ? cell.owner !== pvpRole : cell.owner === COMPUTER;
                    isImmobilized = cell.immobilized;

                    if (isEnemy) {
                      symbol = cell.revealed ? PIECE_SYMBOLS[cell.pieceType || cell.type] : PIECE_SYMBOLS.unknown;
                    } else {
                      symbol = PIECE_SYMBOLS[cell.pieceType || cell.type];
                    }
                  }
                  
                  const webPointerProps = Platform.OS === 'web' && isSetup
                    ? {
                        onMouseEnter: () => {
                          if (isSetupAllowed) setHoveredSetupCell({ row: r, col: c });
                        },
                        onMouseLeave: () => setHoveredSetupCell(null)
                      }
                    : {};

                  const dragProps = Platform.OS === 'web' && isPlaying && isMyTurn && cell && !isEnemy && !isImmobilized
                    ? {
                        draggable: true,
                        onDragStart: (e) => handlePieceDragStart(e, r, c),
                      }
                    : {};

                  const dropProps = Platform.OS === 'web' && isPlaying && isMyTurn
                    ? {
                        onDragOver: (e) => e.preventDefault(),
                        onDrop: (e) => handlePieceDrop(e, r, c),
                      }
                    : {};

                  if (Platform.OS === 'web') {
                    const flatStyle = StyleSheet.flatten([
                      cellStyle,
                      isSetup && (isSetupAllowed ? styles.cursorPointer : styles.cursorNotAllowed)
                    ]);
                    
                    const normalizedStyle = {
                      ...flatStyle,
                      borderStyle: flatStyle.borderStyle || (flatStyle.borderWidth ? 'solid' : undefined),
                      cursor: dragProps.draggable
                        ? 'grab'
                        : (isPossibleMove || (isSetup && isSetupAllowed) ? 'pointer' : 'default')
                    };
                    
                    if (typeof normalizedStyle.borderWidth === 'number') {
                      normalizedStyle.borderWidth = `${normalizedStyle.borderWidth}px`;
                    }

                    return (
                      <div
                        key={c}
                        style={normalizedStyle}
                        onClick={() => {
                          if (isSetup) {
                            handleSetupCellClick(r, c);
                          } else {
                            if (!isFinished && (isPlaying && isMyTurn)) {
                              handleCellClick(r, c);
                            }
                          }
                        }}
                        onMouseEnter={webPointerProps.onMouseEnter}
                        onMouseLeave={webPointerProps.onMouseLeave}
                        draggable={!!dragProps.draggable}
                        onDragStart={dragProps.onDragStart}
                        onDragOver={dropProps.onDragOver}
                        onDrop={dropProps.onDrop}
                      >
                        {symbol && (
                          boardSkin === 'animated' ? (
                            renderCartoonPiece(
                              isSetup ? (symbol === PIECE_SYMBOLS[FLAG] ? FLAG : TRAP) : (cell ? cell.type : FLAG),
                              cell ? cell.pieceType : null,
                              isEnemy,
                              isImmobilized,
                              isSetup ? true : (cell ? cell.revealed : false)
                            )
                          ) : (
                            <View style={[
                              styles.pieceContainer,
                              isEnemy ? styles.enemyPiece : styles.playerPiece,
                              isImmobilized && styles.immobilizedPiece,
                              cell && cell.revealed && styles.revealedPiece
                            ]}>
                              <Text style={[styles.pieceText, { fontSize: layout.pieceFontSize }]}>
                                {symbol}
                              </Text>
                            </View>
                          )
                        )}
                        {isPossibleMove && !cell && (
                          <View
                            style={[
                              styles.validMoveDot,
                              {
                                width: layout.validMoveDotSize,
                                height: layout.validMoveDotSize,
                                borderRadius: layout.validMoveDotSize / 2
                              }
                            ]}
                          />
                        )}
                      </div>
                    );
                  }

                  return (
                    <TouchableOpacity
                      key={c}
                      style={[
                        cellStyle,
                        isFinished || (isPlaying && !isMyTurn) ? { opacity: 0.8 } : {}
                      ]}
                      disabled={isFinished || (isPlaying && !isMyTurn)}
                      onPress={() => {
                        if (isSetup) {
                          handleSetupCellClick(r, c);
                        } else {
                          handleCellClick(r, c);
                        }
                      }}
                    >
                      {symbol && (
                        boardSkin === 'animated' ? (
                          renderCartoonPiece(
                            isSetup ? (symbol === PIECE_SYMBOLS[FLAG] ? FLAG : TRAP) : (cell ? cell.type : FLAG),
                            cell ? cell.pieceType : null,
                            isEnemy,
                            isImmobilized,
                            isSetup ? true : (cell ? cell.revealed : false)
                          )
                        ) : (
                          <View style={[
                            styles.pieceContainer,
                            isEnemy ? styles.enemyPiece : styles.playerPiece,
                            isImmobilized && styles.immobilizedPiece,
                            cell && cell.revealed && styles.revealedPiece
                          ]}>
                            <Text style={[styles.pieceText, { fontSize: layout.pieceFontSize }]}>
                              {symbol}
                            </Text>
                          </View>
                        )
                      )}
                      {/* Valid move indicator on empty cells */}
                      {isPossibleMove && !cell && (
                        <View
                          style={[
                            styles.validMoveDot,
                            {
                              width: layout.validMoveDotSize,
                              height: layout.validMoveDotSize,
                              borderRadius: layout.validMoveDotSize / 2
                            }
                          ]}
                        />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
        </View>
      </SurfaceCard>
    );

    const controlsBlock = (
      <View style={styles.gameControls}>
        {isSetup && (
          <View style={styles.setupControls}>
            <TouchableOpacity style={styles.setupLeaveBtn} onPress={handleLeaveSetup}>
              <Text style={styles.setupLeaveBtnText}>Выйти</Text>
            </TouchableOpacity>
            <View style={[styles.setupActionRow, layout.mobile && styles.setupActionRowStack]}>
              <TouchableOpacity
                style={[styles.setupResetBtn, layout.mobile && styles.setupBtnFullWidth]}
                onPress={handleResetSetup}
              >
                <Text style={styles.setupResetBtnText}>Сбросить</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.setupStartBtn,
                  layout.mobile && styles.setupBtnFullWidth,
                  game.setupPhase !== GAME_CONFIG.SETUP_PHASES.DONE && styles.disabledBtn
                ]}
                disabled={game.setupPhase !== GAME_CONFIG.SETUP_PHASES.DONE}
                onPress={handleStartBattle}
              >
                <Text style={styles.setupStartBtnText}>Начать бой</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {isPlaying && (
          <TouchableOpacity style={styles.surrenderBtn} onPress={handleSurrender}>
            <Text style={styles.surrenderBtnText}>Сдаться</Text>
          </TouchableOpacity>
        )}
        {isFinished && (
          <SurfaceCard style={styles.finishedCard}>
            <Text style={styles.finishedTitle}>
              {setupNotStarted
                ? '⏱️ Партия не началась'
                : (gameMode === 'pvp'
                    ? (game.winner === pvpRole
                        ? '🏆 Победа'
                        : game.winner === 'draw'
                          ? '🤝 Ничья'
                          : '💀 Поражение')
                    : (game.winner === PLAYER
                        ? '🏆 Победа'
                        : game.winner === 'draw'
                          ? '🤝 Ничья'
                          : '💀 Поражение'))}
            </Text>
            <Text style={styles.finishedBody}>
              {game.endReason === 'setup_timeout'
                && 'Время на расстановку флага и капкана истекло (1 минута). Бой не был начат, рейтинг не изменился.'}
              {game.endReason === 'flag_captured'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'Вражеский флаг захвачен!' : 'Ваш флаг захвачен.')
                    : 'Вражеский флаг захвачен.')}
              {game.endReason === 'no_pieces'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'Все боевые фигуры противника уничтожены.' : 'Все ваши боевые фигуры уничтожены.')
                    : 'Все боевые фигуры противника уничтожены.')}
              {game.endReason === 'hopeless'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'Положение соперника безнадёжно.' : 'Ваше положение безнадёжно.')
                    : 'Положение оппонента безнадёжно.')}
              {game.endReason === 'surrender'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'Соперник сдался.' : 'Вы признали поражение.')
                    : 'Вы признали поражение.')}
              {game.endReason === 'no_moves'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'У соперника не осталось ходов.' : 'У вас не осталось ходов.')
                    : 'У оппонента не осталось ходов.')}
              {game.endReason === 'disconnect_timeout'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'Соперник не переподключился.' : 'Вы не успели вернуться в игру.')
                    : 'Соперник отключился и не вернулся в игру.')}
              {game.endReason === 'turn_timeout'
                && (gameMode === 'pvp'
                    ? (game.winner === pvpRole ? 'У соперника истекло время хода.' : 'Время вашего хода истекло.')
                    : 'Время хода истекло.')}
              {game.endReason === 'no_captures_draw' && '20 ходов без взятий — объявлена ничья.'}
            </Text>
            {gameMode === 'pvp' && ratingUpdate !== null && (
              <Text style={[
                styles.mmrChangeText,
                ratingUpdate > 0 ? styles.greenText : styles.redText
              ]}>
                {ratingUpdate > 0 ? `+${ratingUpdate}` : ratingUpdate} MMR
              </Text>
            )}
            {gameMode === 'pvp' && (
              <TouchableOpacity style={styles.rematchBtn} onPress={handleRematch}>
                <Text style={styles.rematchBtnText}>Реванш</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.lobbyReturnBtn}
              onPress={() => {
                const wasPvp = gameMode === 'pvp';
                setGame(null);
                setGameMode('pve');
                setPvpRole(null);
                pvpRoleRef.current = null;
                if (wasPvp) {
                  setScreen('arena');
                } else if (isTournamentActive) {
                  setScreen('bot_select');
                  setBotSelectTab('tournament');
                } else {
                  setScreen('lobby');
                }
                socketRef.current?.emit('lobby:enter');
              }}
            >
              <Text style={styles.lobbyReturnBtnText}>
                {gameMode === 'pvp' ? 'В арену' : (isTournamentActive ? 'В турнир' : 'В лобби')}
              </Text>
            </TouchableOpacity>
          </SurfaceCard>
        )}
      </View>
    );

    const logsBlock = (
      <SurfaceCard style={[styles.logsSection, { padding: layout.cardPad }]}>
        <View style={styles.logsHeader}>
          <Text style={styles.logsTitle}>Лог боя</Text>
          {isPlaying && (
            <Text style={styles.logsDrawMeta}>
              Ничья: {game.movesWithoutCapture || 0}/{drawNoCaptureLimit}
            </Text>
          )}
        </View>

        <ScrollView
          style={[styles.logsList, layout.mobile && styles.logsListMobile]}
          nestedScrollEnabled
        >
          {battleLogs.length === 0 ? (
            <Text style={styles.logLineMuted}>События появятся здесь…</Text>
          ) : (
            battleLogs.map((log, idx) => (
              <Text key={idx} style={styles.logLine}>{log}</Text>
            ))
          )}
        </ScrollView>
      </SurfaceCard>
    );

    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style="dark" />
        <ScrollView
          style={styles.scrollFlex}
          contentContainerStyle={[
            styles.scrollPage,
            { paddingVertical: layout.padH, paddingBottom: layout.padH + 16 }
          ]}
          showsVerticalScrollIndicator={false}
        >
          <PageShell style={styles.gamePageShell} padH={layout.padH} maxWidth={layout.gameShellMax}>
            <View style={[styles.matchPanelsRow, layout.stackPanels && styles.matchPanelsRowStack]}>
              <OpponentPanel
                army="blue"
                name={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p1.nickname : game.p2.nickname) : (user?.nickname || 'Игрок')}
                subtitle={isSetup ? setupStatus : (gameMode === 'pvp' ? (pvpRole === 'p1' ? (game.p1.setupDone ? 'Готов' : 'Выбирает...') : (game.p2.setupDone ? 'Готов' : 'Выбирает...')) : null)}
                compact={layout.compact}
                emoji="👤"
                avatarUrl={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p1.avatarUrl : game.p2.avatarUrl) : user?.avatarUrl}
                pieceCount={playerPieceCount}
                turnLabel={
                  isSetup
                    ? (gameMode === 'pvp' ? ((pvpRole === 'p1' ? game.p1.setupDone : game.p2.setupDone) ? 'Готов' : 'Выбирает...') : `Осталось ${setupTimeLeft} с`)
                    : isFinished
                      ? (setupNotStarted
                        ? 'Время вышло'
                        : (game.winner === 'draw'
                            ? 'Ничья'
                            : (game.winner === (gameMode === 'pvp' ? pvpRole : PLAYER) ? 'Победа' : 'Поражение')))
                      : isPlayerTurn
                        ? 'Ваш ход'
                        : 'Ждёт'
                }
                isTurnActive={isSetup || isPlayerTurn}
                fillPercent={isSetup ? setupFillPercent : turnFillPercent}
                urgent={(isSetup && setupTimerUrgent) || (isPlayerTurn && timerUrgent)}
              />
              <OpponentPanel
                army="red"
                name={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p2.nickname : game.p1.nickname) : (activeBot?.name || 'Бот')}
                subtitle={gameMode === 'pvp' ? `${pvpRole === 'p1' ? game.p2.ratingMmr : game.p1.ratingMmr} MMR` : activeBot?.algorithmLabel}
                emoji={gameMode === 'pvp' ? '👤' : activeBot?.emoji}
                avatarUrl={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p2.avatarUrl : game.p1.avatarUrl) : resolveAssetUrl(activeBot?.avatar)}
                compact={layout.compact}
                pieceCount={botPieceCount}
                turnLabel={
                  isSetup
                    ? (gameMode === 'pvp' ? ((pvpRole === 'p1' ? game.p2.setupDone : game.p1.setupDone) ? 'Готов' : 'Выбирает...') : 'Ждёт')
                    : isFinished
                      ? (game.winner === 'draw'
                          ? 'Ничья'
                          : (game.winner === (gameMode === 'pvp' ? (pvpRole === 'p1' ? 'p2' : 'p1') : COMPUTER) ? 'Победа' : 'Поражение'))
                      : isBotTurn
                        ? 'Ходит'
                        : 'Ждёт'
                }
                isTurnActive={isBotTurn}
                fillPercent={turnFillPercent}
                urgent={isBotTurn && timerUrgent}
              />
            </View>

            {isPlaying && (
              <DrawCountdownBar
                moves={game.movesWithoutCapture || 0}
                limit={drawNoCaptureLimit}
                compact={layout.compact}
              />
            )}

            <View style={[styles.gameLayout, { gap: layout.gap }, isGameWide && styles.gameLayoutWide]}>
              <View style={styles.gameMain}>
                {boardBlock}
                {controlsBlock}
              </View>
              <View style={[styles.gameSidebar, isGameWide && styles.gameSidebarWide]}>
                {logsBlock}
              </View>
            </View>
          </PageShell>
        </ScrollView>

        {battleBs ? (
        <Modal animationType="fade" transparent visible>
          <View style={[styles.modalOverlay, layout.mobile && styles.modalOverlayMobile]}>
            <View style={[styles.modalCard, layout.mobile && styles.modalCardMobile]}>
              <Text style={styles.modalTitle}>
                Ничья · раунд {battleBs.drawRound || 1}
              </Text>
              <View style={styles.tieCountdownBadge}>
                <Text style={styles.tieCountdownNumber}>{tieAttemptsRemaining}</Text>
                <Text style={styles.tieCountdownLabel}>
                  {tieAttemptsRemaining === 1
                    ? 'попытка до взаимоуничтожения'
                    : 'попыток до взаимоуничтожения'}
                </Text>
              </View>

              {(() => {
                const att = describeBattlePiece(battleBs.attacker);
                const def = describeBattlePiece(battleBs.defender);
                return (
                  <View style={styles.tieCollisionBox}>
                    <Text style={styles.tieCollisionTitle}>Столкновение</Text>
                    <View style={styles.tieCollisionRow}>
                      <Text style={styles.tieCollisionPiece}>
                        {att.who}: {att.sym} {att.label}
                      </Text>
                      <Text style={styles.tieCollisionVs}>↔</Text>
                      <Text style={styles.tieCollisionPiece}>
                        {def.who}: {def.sym} {def.label}
                      </Text>
                    </View>
                  </View>
                );
              })()}

              {battleBs.lastRound && (
                <View style={styles.tieLastRoundBox}>
                  <Text style={styles.tieLastRoundTitle}>Прошлый выбор</Text>
                  <Text style={styles.tieLastRoundText}>
                    {gameMode === 'pvp' && battleBs.lastRound.p1Choice && battleBs.lastRound.p2Choice
                      ? `${PIECE_SYMBOLS[battleBs.lastRound.attackerChoice] || '?'} vs ${PIECE_SYMBOLS[battleBs.lastRound.defenderChoice] || '?'} — снова ничья`
                      : (battleBs.lastRound.playerChoice && battleBs.lastRound.opponentChoice
                          ? `Вы: ${PIECE_SYMBOLS[battleBs.lastRound.playerChoice]} · ${gameMode === 'pve' ? (activeBot?.name || 'Бот') : 'Соперник'}: ${PIECE_SYMBOLS[battleBs.lastRound.opponentChoice]}`
                          : null)}
                  </Text>
                  <Text style={styles.tieLastRoundHint}>Выберите новые типы для обеих фигур</Text>
                </View>
              )}

              {tieLastChance && (
                <Text style={styles.tieLastChanceWarning}>
                  Если снова будет ничья, обе фигуры будут уничтожены.
                </Text>
              )}

              {pvpWaitingOpponent ? (
                <View style={{ alignItems: 'center', padding: 16 }}>
                  <ActivityIndicator size="large" color="#c2410c" />
                  <Text style={[styles.modalSubtitle, { marginTop: 12, textAlign: 'center' }]}>
                    Ожидание выбора соперника…
                  </Text>
                </View>
              ) : (
                <>
                  <Text style={styles.modalSubtitle}>
                    Выберите новый тип фигуры для переигровки:
                  </Text>
                  <View style={[styles.choiceRow, layout.compact && styles.choiceRowStack]}>
                    <TouchableOpacity
                      style={[styles.choiceBtn, layout.compact && styles.choiceBtnStack]}
                      onPress={() => handleChoiceClick('rock')}
                    >
                      <Text style={styles.choiceEmoji}>🗿</Text>
                      <Text style={styles.choiceText}>Камень</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.choiceBtn, layout.compact && styles.choiceBtnStack]}
                      onPress={() => handleChoiceClick('paper')}
                    >
                      <Text style={styles.choiceEmoji}>📄</Text>
                      <Text style={styles.choiceText}>Бумага</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.choiceBtn, layout.compact && styles.choiceBtnStack]}
                      onPress={() => handleChoiceClick('scissors')}
                    >
                      <Text style={styles.choiceEmoji}>✂️</Text>
                      <Text style={styles.choiceText}>Ножницы</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>
        ) : null}

        <Modal animationType="fade" transparent visible={surrenderModalVisible}>
          <View style={[styles.modalOverlay, layout.mobile && styles.modalOverlayMobile]}>
            <View style={[styles.modalCard, layout.mobile && styles.modalCardMobile]}>
              <Text style={styles.modalTitle}>Сдаться?</Text>
              <Text style={styles.modalSubtitle}>
                {gameMode === 'pvp'
                  ? 'Партия будет засчитана как поражение (−25 MMR).'
                  : 'Партия будет засчитана как поражение (рейтинг не изменится).'}
              </Text>
              <View style={styles.modalActionsRow}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={() => setSurrenderModalVisible(false)}
                >
                  <Text style={styles.modalCancelBtnText}>Отмена</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalDangerBtn} onPress={confirmSurrender}>
                  <Text style={styles.modalDangerBtnText}>Да, сдаться</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        <Modal animationType="fade" transparent visible={leaveSetupModalVisible}>
          <View style={[styles.modalOverlay, layout.mobile && styles.modalOverlayMobile]}>
            <View style={[styles.modalCard, layout.mobile && styles.modalCardMobile]}>
              <Text style={styles.modalTitle}>Выйти из расстановки?</Text>
              <Text style={styles.modalSubtitle}>
                Партия ещё не началась. Вы вернётесь в лобби, расстановка не сохранится, рейтинг не изменится.
              </Text>
              <View style={styles.modalActionsRow}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={() => setLeaveSetupModalVisible(false)}
                >
                  <Text style={styles.modalCancelBtnText}>Остаться</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalDangerBtn} onPress={confirmLeaveSetup}>
                  <Text style={styles.modalDangerBtnText}>Выйти</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex1: {
    flex: 1,
  },
  appBg: {
    backgroundColor: '#e8e2d8',
    ...(Platform.OS === 'web' ? { minHeight: '100vh' } : {}),
  },
  pageShell: {
    width: '100%',
    maxWidth: LAYOUT.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: LAYOUT.pad,
  },
  pageShellNarrow: {
    maxWidth: LAYOUT.narrowWidth,
  },
  gamePageShell: {
    maxWidth: LAYOUT.gameWidth,
  },
  centeredShell: {
    flex: 1,
    justifyContent: 'center',
  },
  scrollFlex: {
    flex: 1,
  },
  scrollPage: {
    flexGrow: 1,
  },
  surfaceCard: {
    backgroundColor: '#faf8f4',
    borderRadius: 16,
    padding: 20,
    marginBottom: LAYOUT.gap,
    borderWidth: 1,
    borderColor: 'rgba(100, 75, 50, 0.1)',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 4px 24px rgba(44, 30, 16, 0.06)' }
      : {
          shadowColor: '#2c1e10',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.06,
          shadowRadius: 12,
          elevation: 3,
        }),
  },
  surfaceCardAccent: {
    backgroundColor: 'rgba(194, 65, 12, 0.04)',
    borderColor: 'rgba(194, 65, 12, 0.12)',
  },
  loadingCard: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    color: '#9a3412',
    marginTop: 16,
    fontSize: 15,
    fontWeight: '600',
  },
  authScreen: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 24,
  },
  authCard: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 28,
  },
  authCardCompact: {
    paddingVertical: 28,
    paddingHorizontal: 18,
  },
  brandMark: {
    fontSize: 48,
    marginBottom: 8,
  },
  logoText: {
    fontSize: 26,
    fontWeight: '800',
    color: '#1c1917',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  v2Badge: {
    color: '#d97706', // Accent amber
    fontSize: 18,
    fontWeight: '800',
    backgroundColor: '#faf7f2',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(180, 160, 130, 0.25)',
  },
  subtitle: {
    color: '#6b5744', // Dark brownish grey
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 40,
    lineHeight: 22,
  },
  loginBtn: {
    alignSelf: 'stretch',
    backgroundColor: '#c2410c',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  loginBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  loginBtnDev: {
    alignSelf: 'stretch',
    backgroundColor: '#ecfdf5',
    borderWidth: 1.5,
    borderColor: '#10b981',
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  loginBtnDevText: {
    color: '#047857',
    fontSize: 15,
    fontWeight: '700',
  },
  errorText: {
    color: '#dc2626',
    marginTop: 20,
    fontSize: 14,
  },
  footerText: {
    color: '#a8a29e',
    textAlign: 'center',
    fontSize: 12,
    marginTop: 16,
    marginBottom: 8,
  },
  profileBarCard: {
    marginBottom: LAYOUT.gap,
    overflow: 'hidden',
  },
  profileTapRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileTapHint: {
    color: '#9a8a78',
    fontSize: 12,
    marginTop: 2,
  },
  profileChevron: {
    color: '#9a8a78',
    fontSize: 14,
    marginLeft: 8,
    flexShrink: 0,
  },
  profileMenu: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(100, 75, 50, 0.12)',
    gap: 8,
  },
  profileMenuItem: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#f5f0e8',
  },
  profileMenuItemText: {
    color: '#2c1e10',
    fontWeight: '700',
    fontSize: 15,
  },
  profileMenuItemDanger: {
    backgroundColor: 'rgba(220, 38, 38, 0.08)',
  },
  profileMenuItemDangerText: {
    color: '#dc2626',
    fontWeight: '700',
    fontSize: 15,
  },
  profileScreenTopBar: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(100, 75, 50, 0.12)',
    backgroundColor: 'rgba(250, 248, 244, 0.98)',
  },
  profileHero: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  profileHeroAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  profileHeroLetter: {
    color: '#d97706',
    fontSize: 32,
    fontWeight: 'bold',
  },
  profileHeroInfo: {
    flex: 1,
    minWidth: 0,
  },
  profileHeroName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1c1917',
    marginBottom: 6,
  },
  profileHeroMeta: {
    fontSize: 13,
    color: '#6b5744',
    lineHeight: 20,
  },
  profileSectionHint: {
    fontSize: 13,
    color: '#78716c',
    marginBottom: 14,
  },
  profileEmptyBots: {
    fontSize: 14,
    color: '#9a8a78',
    lineHeight: 21,
    fontStyle: 'italic',
  },
  botStatRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(100, 75, 50, 0.08)',
    gap: 12,
  },
  botStatEmoji: {
    fontSize: 28,
    width: 36,
    textAlign: 'center',
  },
  botStatBody: {
    flex: 1,
    minWidth: 0,
  },
  botStatName: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1c1917',
    marginBottom: 4,
  },
  botStatCounts: {
    fontSize: 14,
    lineHeight: 20,
  },
  botStatMeta: {
    fontSize: 12,
    color: '#9a8a78',
    marginTop: 4,
  },
  profileLogoutBtn: {
    backgroundColor: '#dc2626',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  profileLogoutBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
  },
  lobbyLogoutBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fca5a5',
    alignSelf: 'center',
  },
  lobbyLogoutBtnText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '800',
  },
  blockRow: {
    gap: LAYOUT.gap,
  },
  blockRowWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  blockFlex: {
    marginBottom: LAYOUT.gap,
  },
  blockHalf: {
    flex: 1,
    marginBottom: 0,
  },
  sectionHeader: {
    marginBottom: LAYOUT.gap,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1c1917',
    marginBottom: 4,
  },
  sectionTitleCompact: {
    fontSize: 19,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#78716c',
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    marginRight: 15,
  },
  avatarPlaceholder: {
    backgroundColor: '#faf7f2',
    borderWidth: 1,
    borderColor: 'rgba(180, 160, 130, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  avatarLetter: {
    color: '#d97706',
    fontSize: 22,
    fontWeight: 'bold',
  },
  profileInfo: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    marginRight: 4,
  },
  nickname: {
    color: '#2c1e10', // Dark brown
    fontSize: 18,
    fontWeight: 'bold',
  },
  roleText: {
    color: '#6b5744',
    fontSize: 13,
    marginTop: 2,
  },
  logoutBtn: {
    flexShrink: 0,
    borderColor: '#dc2626',
    borderWidth: 1.5,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  logoutText: {
    color: '#dc2626',
    fontWeight: 'bold',
    fontSize: 13,
  },
  cardTitle: {
    color: '#b45309', // Gold title
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 15,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginVertical: 10,
  },
  ratingValue: {
    color: '#d97706',
    fontSize: 48,
    fontWeight: '800',
    marginRight: 10,
  },
  ratingValueCompact: {
    fontSize: 36,
  },
  ratingLabel: {
    color: '#6b5744',
    fontSize: 16,
    fontWeight: '600',
  },
  statsDivider: {
    height: 1,
    backgroundColor: 'rgba(180, 160, 130, 0.25)',
    marginVertical: 15,
  },
  winLossGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  gridItem: {
    alignItems: 'center',
  },
  gridValue: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#2c1e10',
  },
  gridLabel: {
    color: '#9a8a78',
    fontSize: 12,
    marginTop: 4,
  },
  greenText: { color: '#16a34a' },
  redText: { color: '#dc2626' },
  grayText: { color: '#9a8a78' },
  yellowText: { color: '#d97706' },
  actionBtn: {
    backgroundColor: '#d97706',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  disabledBtn: {
    backgroundColor: '#e5ded4',
    opacity: 0.6,
  },
  disabledText: {
    color: '#9a8a78',
  },
  primaryBtnOutline: {
    backgroundColor: 'transparent',
    borderColor: '#c2410c',
    borderWidth: 2,
  },
  primaryBtnOutlineText: {
    color: '#c2410c',
    fontWeight: '700',
    fontSize: 16,
  },
  actionBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  infoTitle: {
    color: '#b45309',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  infoBody: {
    color: '#6b5744',
    fontSize: 14,
    lineHeight: 22,
  },
  
  quickOpponentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  quickOpponentCard: {
    flex: 1,
    minWidth: 140,
    maxWidth: 220,
    backgroundColor: '#fff7ed',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(194, 65, 12, 0.2)',
    alignItems: 'center',
  },
  quickOpponentAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    marginBottom: 8,
  },
  quickOpponentName: {
    fontWeight: '800',
    color: '#2c1e10',
    fontSize: 14,
    textAlign: 'center',
  },
  quickOpponentMeta: {
    color: '#6b5744',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  quickOpponentGames: {
    color: '#9a8a78',
    fontSize: 10,
    marginTop: 2,
  },
  quickOpponentPlay: {
    marginTop: 8,
    color: '#c2410c',
    fontWeight: '700',
    fontSize: 12,
  },
  tieCountdownBadge: {
    alignSelf: 'center',
    alignItems: 'center',
    marginVertical: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: 'rgba(194, 65, 12, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(194, 65, 12, 0.25)',
  },
  tieCountdownNumber: {
    fontSize: 36,
    fontWeight: '900',
    color: '#c2410c',
    lineHeight: 40,
  },
  tieCountdownLabel: {
    fontSize: 12,
    color: '#6b5744',
    textAlign: 'center',
    marginTop: 2,
  },
  tieCollisionBox: {
    backgroundColor: '#faf8f4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(100, 75, 50, 0.12)',
  },
  tieCollisionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b5744',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tieCollisionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  tieCollisionPiece: {
    fontSize: 15,
    fontWeight: '700',
    color: '#2c1e10',
    flexShrink: 1,
  },
  tieCollisionVs: {
    fontSize: 18,
    color: '#9a8a78',
  },
  tieLastRoundBox: {
    backgroundColor: '#f5f0e8',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  tieLastRoundTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b5744',
    marginBottom: 4,
  },
  tieLastRoundText: {
    fontSize: 14,
    color: '#2c1e10',
    fontWeight: '600',
  },
  tieLastRoundHint: {
    fontSize: 11,
    color: '#9a8a78',
    marginTop: 4,
  },
  tieLastChanceWarning: {
    fontSize: 12,
    color: '#dc2626',
    textAlign: 'center',
    marginBottom: 12,
    lineHeight: 18,
  },
  botGrid: {
    gap: 12,
  },
  botGridWebThreeCol: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  botColumn: {
    flex: 1,
    gap: 10,
    minWidth: 0,
  },
  botColumnWeb: {
    maxWidth: '32%',
  },
  botColumnTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#6b5744',
    textAlign: 'center',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  botGridWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  botCard: {
    backgroundColor: '#faf8f4',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(100, 75, 50, 0.08)',
    marginBottom: 0,
  },
  botCardWeb: {
    width: '100%',
    marginBottom: 0,
  },
  botCardWide: {
    width: '48%',
    maxWidth: 480,
  },
  botCardAvatar: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginRight: 10,
    backgroundColor: '#e7e5e4',
  },
  botModelAuthor: {
    fontSize: 11,
    color: '#9a8a78',
    marginTop: 6,
    fontStyle: 'italic',
  },
  botStatAvatarImg: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginRight: 12,
    backgroundColor: '#e7e5e4',
  },
  botCardFullWidth: {
    width: '100%',
  },
  botCardSelected: {
    borderWidth: 2.5,
    borderColor: '#c2410c',
  },
  botCardBody: {
    width: '100%',
  },
  botCardStartBtn: {
    marginTop: 12,
    backgroundColor: '#c2410c',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  botCardStartBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
  },
  botSelectTopBar: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(100, 75, 50, 0.12)',
    backgroundColor: 'rgba(250, 248, 244, 0.98)',
    zIndex: 20,
    ...(Platform.OS === 'web'
      ? { position: 'sticky', top: 0, backdropFilter: 'blur(8px)' }
      : {}),
  },
  botSelectTopBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 0,
    paddingHorizontal: 0,
  },
  botSelectBackBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#e7e5e4',
  },
  botSelectBackBtnText: {
    color: '#44403c',
    fontWeight: '700',
    fontSize: 15,
  },
  stickyFooter: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(100, 75, 50, 0.12)',
    backgroundColor: 'rgba(250, 248, 244, 0.95)',
    paddingVertical: 14,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(8px)' } : {}),
  },
  stickyFooterMobile: {
    paddingBottom: Platform.OS === 'web' ? 12 : 0,
  },
  stickyFooterInner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 0,
    gap: 10,
  },
  footerBtnCompact: {
    paddingVertical: 12,
  },
  botCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  botEmoji: {
    fontSize: 30,
    marginRight: 12,
  },
  botNameCol: {
    flex: 1,
  },
  botName: {
    color: '#2c1e10',
    fontSize: 18,
    fontWeight: 'bold',
  },
  botAlgorithm: {
    color: '#9a8a78',
    fontSize: 11,
    marginTop: 2,
  },
  tierTag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tierEasy: { backgroundColor: 'rgba(22, 163, 74, 0.15)' },
  tierMedium: { backgroundColor: 'rgba(217, 119, 6, 0.15)' },
  tierHard: { backgroundColor: 'rgba(239, 68, 68, 0.15)' },
  tierText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#2c1e10',
  },
  botDescription: {
    color: '#6b5744',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  botFooter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  starRating: {
    marginRight: 'auto',
  },
  tagBadge: {
    backgroundColor: '#e5ded4',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 6,
  },
  tagText: {
    color: '#6b5744',
    fontSize: 10,
    fontWeight: '600',
  },
  backBtn: {
    flex: 1,
    maxWidth: 140,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#e7e5e4',
    marginRight: 12,
  },
  backBtnText: {
    color: '#6b5744',
    fontWeight: 'bold',
    fontSize: 16,
  },
  startBtn: {
    flex: 2,
    backgroundColor: '#c2410c',
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
  },
  startBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },

  gameLayout: {
    gap: LAYOUT.gap,
  },
  gameLayoutWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  gameMain: {
    flex: 1,
    minWidth: 0,
  },
  gameSidebar: {
    width: '100%',
  },
  gameSidebarWide: {
    width: 300,
    flexShrink: 0,
  },
  matchPanelsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: LAYOUT.gap,
  },
  matchPanelsRowStack: {
    flexDirection: 'column',
  },
  opponentPanel: {
    flex: 1,
    minWidth: 0,
    borderRadius: 14,
    borderWidth: 2,
    overflow: 'hidden',
    backgroundColor: '#faf8f4',
    position: 'relative',
  },
  panelBlue: {
    borderColor: 'rgba(37, 99, 235, 0.25)',
  },
  panelRed: {
    borderColor: 'rgba(220, 38, 38, 0.25)',
  },
  panelTurnActive: {
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 18px rgba(0, 0, 0, 0.08)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.1,
          shadowRadius: 8,
          elevation: 4
        }),
  },
  panelUrgentBlue: {
    borderColor: 'rgba(37, 99, 235, 0.85)',
  },
  panelUrgentRed: {
    borderColor: 'rgba(220, 38, 38, 0.85)',
  },
  turnFillBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 0,
  },
  turnFillBlue: {
    backgroundColor: 'rgba(37, 99, 235, 0.32)',
  },
  turnFillRed: {
    backgroundColor: 'rgba(220, 38, 38, 0.32)',
  },
  drawCountdown: {
    marginBottom: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#eef2ff',
    borderWidth: 2,
    borderColor: '#6366f1',
    shadowColor: '#4f46e5',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  drawCountdownCompact: {
    marginBottom: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  drawCountdownDanger: {
    borderColor: 'rgba(239, 68, 68, 0.55)',
    backgroundColor: 'rgba(254, 242, 242, 0.95)',
  },
  drawCountdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  drawCountdownTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#312e81',
  },
  drawCountdownTitleCompact: {
    fontSize: 12,
  },
  drawCountdownMeta: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1e293b',
  },
  drawCountdownMetaDanger: {
    color: '#b91c1c',
  },
  drawCountdownTrack: {
    width: '100%',
    height: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(148, 163, 184, 0.28)',
    overflow: 'hidden',
  },
  drawCountdownFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#22c55e',
  },
  drawCountdownFillWarn: {
    backgroundColor: '#f59e0b',
  },
  drawCountdownFillDanger: {
    backgroundColor: '#ef4444',
  },
  drawCountdownHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#b45309',
    fontWeight: '500',
  },
  drawCountdownHintDanger: {
    color: '#b91c1c',
    fontWeight: '700',
  },
  panelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    zIndex: 1,
  },
  panelInnerCompact: {
    padding: 8,
  },
  panelAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    marginRight: 12,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.8)',
  },
  panelAvatarCompact: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 8,
  },
  panelAvatarBlue: {
    backgroundColor: '#dbeafe',
    justifyContent: 'center',
    alignItems: 'center',
  },
  panelAvatarRed: {
    backgroundColor: '#fee2e2',
    justifyContent: 'center',
    alignItems: 'center',
  },
  panelAvatarEmoji: {
    fontSize: 26,
  },
  panelAvatarEmojiCompact: {
    fontSize: 20,
  },
  panelDetails: {
    flex: 1,
    minWidth: 0,
  },
  panelName: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1c1917',
  },
  panelNameCompact: {
    fontSize: 13,
  },
  panelSubtitle: {
    fontSize: 11,
    color: '#78716c',
    marginTop: 2,
  },
  panelSubtitleCompact: {
    fontSize: 10,
  },
  panelMeta: {
    fontSize: 12,
    color: '#57534e',
    marginTop: 4,
  },
  panelMetaCompact: {
    fontSize: 11,
    marginTop: 2,
  },
  panelTurnLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#a8a29e',
    marginTop: 4,
  },
  panelTurnLabelCompact: {
    fontSize: 12,
    marginTop: 2,
  },
  panelTurnLabelActive: {
    color: '#1c1917',
    fontWeight: '800',
  },
  boardCard: {
    padding: 14,
    alignItems: 'center',
    marginBottom: LAYOUT.gap,
  },
  board: {
    width: '100%',
    alignSelf: 'center',
    aspectRatio: 8 / 6,
    backgroundColor: '#d4b980',
    borderRadius: 12,
    padding: 8,
    borderWidth: 3,
    borderColor: '#8b6914',
    gap: 3,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    gap: 3,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 5,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(80, 55, 30, 0.18)',
  },
  lightCell: {
    backgroundColor: '#faf3e3',
  },
  darkCell: {
    backgroundColor: '#8f6535',
  },
  setupZoneLight: {
    backgroundColor: 'rgba(22, 163, 74, 0.18)',
    borderColor: 'rgba(22, 163, 74, 0.55)',
    borderWidth: 2,
  },
  setupZoneDark: {
    backgroundColor: 'rgba(22, 163, 74, 0.26)',
    borderColor: 'rgba(22, 163, 74, 0.6)',
    borderWidth: 2,
  },
  setupZoneHover: {
    backgroundColor: 'rgba(22, 163, 74, 0.38)',
    borderColor: 'rgba(22, 163, 74, 0.85)',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 12px rgba(22, 163, 74, 0.35)' }
      : {}),
  },
  setupZoneForbidden: {
    opacity: 0.5,
  },
  cursorPointer: {
    cursor: 'pointer',
  },
  cursorNotAllowed: {
    cursor: 'not-allowed',
  },
  selectedCell: {
    borderColor: '#d97706',
  },
  possibleMoveCell: {
    borderColor: '#16a34a',
    backgroundColor: 'rgba(22, 163, 74, 0.1)',
  },
  pieceContainer: {
    width: '90%',
    height: '90%',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
  },
  playerPiece: {
    backgroundColor: '#3b82f6',
    borderColor: '#1d4ed8',
  },
  enemyPiece: {
    backgroundColor: '#ef4444',
    borderColor: '#b91c1c',
  },
  immobilizedPiece: {
    opacity: 0.5,
  },
  pieceText: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: 'bold',
  },
  validMoveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#16a34a',
  },
  
  gameControls: {
    marginBottom: LAYOUT.gap,
  },
  setupControls: {
    gap: 10,
  },
  setupLeaveBtn: {
    backgroundColor: '#f5f0e8',
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c9b8a0',
  },
  setupLeaveBtnText: {
    color: '#6b5744',
    fontWeight: 'bold',
    fontSize: 15,
  },
  setupActionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
  },
  setupActionRowStack: {
    flexDirection: 'column',
  },
  setupBtnFullWidth: {
    width: '100%',
    flex: 0,
    alignSelf: 'stretch',
  },
  setupResetBtn: {
    flexShrink: 0,
    backgroundColor: '#e5ded4',
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    minWidth: 108,
  },
  setupResetBtnText: {
    color: '#6b5744',
    fontWeight: 'bold',
    fontSize: 15,
  },
  setupStartBtn: {
    flex: 1,
    flexGrow: 1,
    minWidth: 0,
    backgroundColor: '#16a34a',
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  setupStartBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
    textAlign: 'center',
  },
  surrenderBtn: {
    backgroundColor: '#dc2626',
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
  },
  surrenderBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
  
  finishedCard: {
    alignItems: 'center',
    marginBottom: 0,
  },
  finishedTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#2c1e10',
    marginBottom: 8,
  },
  finishedBody: {
    color: '#6b5744',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 10,
  },
  mmrChangeText: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 14,
  },
  rematchBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: '#0d9488',
    alignItems: 'center',
    alignSelf: 'stretch'
  },
  rematchBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15
  },
  lobbyReturnBtn: {
    backgroundColor: '#d97706',
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  lobbyReturnBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  
  logsSection: {
    marginBottom: 0,
    minHeight: 200,
    maxHeight: Platform.OS === 'web' ? 480 : 320,
  },
  logsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  logsTitle: {
    color: '#1c1917',
    fontSize: 14,
    fontWeight: '800',
  },
  logsDrawMeta: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4f46e5',
  },
  logsList: {
    maxHeight: Platform.OS === 'web' ? 420 : 260,
  },
  logsListMobile: {
    maxHeight: 200,
  },
  logLine: {
    color: '#57534e',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 6,
  },
  logLineMuted: {
    color: '#a8a29e',
    fontSize: 13,
    fontStyle: 'italic',
  },
  
  // Modal choice for Tie-Breaker
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(44, 30, 16, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalOverlayMobile: {
    padding: 14,
    justifyContent: 'flex-end',
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#faf7f2',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#d97706',
  },
  modalCardMobile: {
    maxWidth: '100%',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    marginBottom: 0,
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#d97706',
    marginBottom: 8,
  },
  modalSubtitle: {
    color: '#6b5744',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  choiceRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    gap: 8,
  },
  choiceRowStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  choiceBtn: {
    alignItems: 'center',
    backgroundColor: '#e5ded4',
    padding: 12,
    borderRadius: 10,
    flex: 1,
  },
  choiceBtnStack: {
    flex: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    width: '100%',
    borderWidth: 1.5,
    borderColor: 'rgba(180, 160, 130, 0.25)',
  },
  choiceEmoji: {
    fontSize: 32,
    marginBottom: 6,
  },
  choiceText: {
    color: '#2c1e10',
    fontSize: 11,
    fontWeight: 'bold',
  },
  revealedPiece: {
    borderColor: '#fbbf24',
    borderWidth: 3,
  },
  modalActionsRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginTop: 8,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#e7e5e4',
    alignItems: 'center',
  },
  modalCancelBtnText: {
    color: '#44403c',
    fontWeight: '700',
    fontSize: 15,
  },
  modalDangerBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#dc2626',
    alignItems: 'center',
  },
  modalDangerBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  lastMoveFromCell: {
    backgroundColor: 'rgba(217, 119, 6, 0.15)',
    borderColor: 'rgba(217, 119, 6, 0.4)',
    borderWidth: 1.5,
  },
  lastMoveToCell: {
    backgroundColor: 'rgba(217, 119, 6, 0.3)',
    borderColor: '#d97706',
    borderWidth: 2,
  },
  arenaStatRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14
  },
  arenaStatPill: {
    backgroundColor: '#faf8f4',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(180, 160, 130, 0.2)',
    alignItems: 'center',
    minWidth: 88
  },
  arenaStatPillValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#c2410c'
  },
  arenaStatPillLabel: {
    fontSize: 11,
    color: '#6b5744',
    marginTop: 2,
    fontWeight: '600'
  },
  arenaStatusCard: {
    alignItems: 'center'
  },
  arenaStatusText: {
    color: '#2c1e10',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 20
  },
  arenaLinkBtn: {
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 12
  },
  arenaLinkBtnText: {
    color: '#c2410c',
    fontWeight: '700',
    fontSize: 14
  },
  arenaModeGrid: {
    gap: 10
  },
  arenaModeRow: {
    flexDirection: 'row',
    gap: 10
  },
  arenaModeRowWide: {
    flex: 1
  },
  arenaModeTile: {
    flex: 1,
    backgroundColor: '#faf8f4',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(100, 75, 50, 0.1)'
  },
  arenaModeTileHero: {
    backgroundColor: '#fff7ed',
    borderColor: '#d97706',
    paddingVertical: 20
  },
  arenaModeTileDisabled: {
    opacity: 0.5
  },
  arenaModeEmoji: {
    fontSize: 28,
    marginBottom: 6
  },
  arenaModeTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#2c1e10',
    textAlign: 'center'
  },
  arenaModeDesc: {
    fontSize: 12,
    color: '#6b5744',
    marginTop: 4,
    textAlign: 'center'
  },
  arenaWaitingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  arenaWaitingCardText: {
    flex: 1,
    minWidth: 0
  },
  arenaWaitingTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#2c1e10'
  },
  arenaWaitingDesc: {
    fontSize: 13,
    color: '#6b5744',
    marginTop: 4,
    lineHeight: 18
  },
  arenaWaitingCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#c9b8a0',
    flexShrink: 0
  },
  arenaWaitingCancelText: {
    color: '#6b5744',
    fontWeight: '700',
    fontSize: 13
  },
  arenaCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  arenaCodeRowStack: {
    flexDirection: 'column',
    alignItems: 'stretch'
  },
  arenaCodeInput: {
    borderWidth: 1,
    borderColor: '#c9b8a0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: '#fff',
    color: '#2c1e10',
    letterSpacing: 2
  },
  arenaCodeInputFlex: {
    flex: 1,
    minWidth: 0
  },
  arenaCodeInputStack: {
    width: '100%'
  },
  arenaCodeBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  arenaCodeBtnStack: {
    alignSelf: 'flex-start'
  },
  arenaCodeBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15
  },
  arenaEmptyBox: {
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#faf8f4',
    alignItems: 'center'
  },
  arenaEmptyText: {
    color: '#9a8a78',
    fontSize: 14,
    fontStyle: 'italic'
  },
  arenaRoomCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    marginBottom: 8,
    borderRadius: 12,
    backgroundColor: '#faf8f4',
    borderWidth: 1,
    borderColor: 'rgba(100, 75, 50, 0.08)'
  },
  arenaRoomCardInfo: {
    flex: 1,
    minWidth: 0
  },
  arenaRoomName: {
    fontSize: 15,
    color: '#2c1e10',
    fontWeight: '700'
  },
  arenaRoomMeta: {
    fontSize: 12,
    color: '#6b5744',
    marginTop: 2
  },
  arenaJoinBtn: {
    backgroundColor: '#0d9488',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    flexShrink: 0
  },
  arenaJoinBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13
  },
  arenaPlayerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    marginBottom: 8,
    borderRadius: 12,
    backgroundColor: '#faf8f4',
    borderWidth: 1,
    borderColor: 'rgba(100, 75, 50, 0.08)'
  },
  arenaPlayerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    flexShrink: 0
  },
  arenaPlayerInfo: {
    flex: 1,
    minWidth: 0
  },
  arenaPlayerName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#2c1e10'
  },
  arenaPlayerRating: {
    fontSize: 12,
    color: '#6b5744',
    marginTop: 2
  },
  arenaBusyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f5f5f4'
  },
  arenaBusyLabel: {
    fontSize: 12,
    color: '#78716c',
    fontWeight: '600'
  },
  arenaChallengeBtn: {
    backgroundColor: '#c2410c',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    flexShrink: 0
  },
  arenaChallengeBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13
  },
  
  // --- Tournament (Challenge Tower) Styles ---
  tournamentBtn: {
    backgroundColor: '#c2410c',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  tournamentBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
  },
  tournamentHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#2c1e10',
    marginLeft: 12,
  },
  tournamentWinCard: {
    padding: 24,
    alignItems: 'center',
    backgroundColor: '#fffbeb',
    borderColor: '#f59e0b',
    borderWidth: 2,
    borderRadius: 16,
  },
  tournamentWinEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  tournamentWinTitle: {
    fontSize: 22,
    fontWeight: '850',
    color: '#78350f',
    marginBottom: 8,
  },
  tournamentWinSubtitle: {
    fontSize: 14,
    color: '#92400e',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  tournamentResetBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  tournamentResetBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  tournamentIntro: {
    marginBottom: 20,
    alignItems: 'center',
  },
  tournamentIntroTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#2c1e10',
    marginBottom: 4,
  },
  tournamentIntroSubtitle: {
    fontSize: 13,
    color: '#6b5744',
  },
  towerLadderContainer: {
    gap: 12,
    paddingHorizontal: 4,
  },
  towerStep: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#faf8f4',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(100, 75, 50, 0.08)',
  },
  towerStepCurrent: {
    borderColor: '#c2410c',
    backgroundColor: '#fff7ed',
    shadowColor: '#c2410c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  towerStepBeaten: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  towerStepLocked: {
    opacity: 0.6,
    backgroundColor: '#f5f5f4',
    borderColor: '#e5e5e0',
  },
  towerStepNumberCol: {
    width: 65,
  },
  towerStepNumber: {
    fontSize: 12,
    fontWeight: '800',
    color: '#7c2d12',
    textTransform: 'uppercase',
  },
  towerStepBotAvatarCol: {
    marginRight: 12,
  },
  towerStepAvatar: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#e7e5e4',
  },
  towerStepAvatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  towerStepAvatarLocked: {
    backgroundColor: '#d6d3d1',
  },
  towerStepLockEmoji: {
    fontSize: 18,
  },
  towerStepInfoCol: {
    flex: 1,
  },
  towerStepBotName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#2c1e10',
  },
  towerStepDifficulty: {
    fontSize: 12,
    color: '#6b5744',
    marginTop: 2,
  },
  towerStepActionCol: {
    width: 70,
    alignItems: 'flex-end',
  },
  beatenBadge: {
    backgroundColor: '#22c55e',
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  beatenBadgeText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  towerChallengeBtn: {
    backgroundColor: '#c2410c',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  towerChallengeBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  towerLockedLabel: {
    fontSize: 16,
  },
  textMuted: {
    color: '#78716c',
  },
  
  // --- Bot Select Segmented Tabs ---
  botSelectTabs: {
    flexDirection: 'row',
    backgroundColor: '#e7e5e4',
    borderRadius: 8,
    padding: 3,
  },
  botSelectTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  botSelectTabActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  botSelectTabText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#57534e',
  },
  botSelectTabTextActive: {
    color: '#c2410c',
  },
  // Bot card difficulty styles
  botCardEasy: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  botCardMedium: {
    backgroundColor: '#fefce8',
    borderColor: '#fef08a',
  },
  botCardHard: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },

  // Settings & Skin styles
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(100, 75, 50, 0.12)',
  },
  settingsLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#2c1e10',
  },
  skinToggleGroup: {
    flexDirection: 'row',
    backgroundColor: '#e7e5e4',
    borderRadius: 8,
    padding: 3,
  },
  skinToggleBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  skinToggleBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  skinToggleBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#57534e',
  },
  skinToggleBtnTextActive: {
    color: '#c2410c',
  },

  // Board cartoon/animated skin cells
  cartoonLightCell: {
    backgroundColor: '#FFF9C4', // Soft cream/yellow
  },
  cartoonDarkCell: {
    backgroundColor: '#C8E6C9', // Soft pastel green
  },

  cartoonPieceBadge: {
    width: '90%',
    height: '90%',
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2.5,
    position: 'relative',
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 4px 6px rgba(0,0,0,0.15)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.15,
          shadowRadius: 3,
          elevation: 4
        }),
  },
  cartoonPlayerBadge: {
    borderColor: '#1d4ed8', // Darker blue border for player
  },
  cartoonEnemyBadge: {
    borderColor: '#b91c1c', // Darker red border for enemy
  },
  cartoonImmobilizedBadge: {
    opacity: 0.5,
    borderStyle: 'dashed',
  },
  cartoonRevealedBadge: {
    borderColor: '#fbbf24', // Bright yellow/gold border
    borderWidth: 3.5,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 12px #fbbf24' }
      : {
          shadowColor: '#fbbf24',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.8,
          shadowRadius: 6,
          elevation: 5
        }),
  },
  cartoonPieceGloss: {
    position: 'absolute',
    top: 2,
    left: '10%',
    width: '80%',
    height: '35%',
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
    borderTopLeftRadius: 100,
    borderTopRightRadius: 100,
    zIndex: 2,
  },
  cartoonPieceEmojiText: {
    color: '#000',
    fontWeight: 'bold',
    zIndex: 1,
    // Add text shadow for cartoon-like look
    ...(Platform.OS === 'web'
      ? { filter: 'drop-shadow(0px 2px 2px rgba(0,0,0,0.2))' }
      : {}),
  },
  cartoonPieceMiniLabel: {
    position: 'absolute',
    bottom: 2,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 4,
    paddingHorizontal: 3.5,
    paddingVertical: 0.5,
    zIndex: 3,
  },
  cartoonPieceMiniLabelText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '900',
  }
});
