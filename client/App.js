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
  TextInput,
  Animated,
  Easing
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
import { SKINS, SKIN_ORDER, getSkin, CellDecoration } from './skins';
import { t, SUPPORTED_LOCALES, LOCALE_DATE_TAGS, TRANSLATIONS } from './shared/translations.js';
import audioManager from './shared/audio-manager.js';


const getBaseUrl = () => {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      // Сборки, размещённые на чужом CDN (Яндекс Игры, FB Instant), ходят на наш API-домен,
      // который патчится в index.html скриптом scripts/patch-web-html.js
      if (window.__RPS_API_URL__) {
        return window.__RPS_API_URL__;
      }
      if (window.location) {
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          return 'http://localhost:3001';
        }
        return window.location.origin;
      }
    }
  } else {
    if (__DEV__) {
      return 'http://10.0.2.2:3001'; // Fallback for native development emulator
    }
  }
  return 'https://rps-battles.com';
};
const BASE_URL = getBaseUrl();

// Запуск внутри VK Mini Apps: игра открыта по пути /vk (адрес iframe в настройках
// приложения VK). Аккаунт задаётся самим VK, поэтому выход из аккаунта скрыт.
const IS_VK_ENTRY = Platform.OS === 'web'
  && typeof window !== 'undefined'
  && !!window.location
  && /^\/vk(\/|$)/.test(window.location.pathname);

const PIECE_TYPE_NAMES = { rock: 'Камень', paper: 'Бумага', scissors: 'Ножницы' };

const LANG_NAMES = {
  en: 'English',
  ru: 'Русский',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  tr: 'Türkçe',
  ar: 'العربية',
  zh: '中文'
};

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

function buildQuickOpponents(user, arenaPlayers, botList, playerFallback = 'Player') {
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
      name: row.opponent?.nickname || online.name || playerFallback,
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
      name: p.name || playerFallback,
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

// ─── Активная тема (скин) ────────────────────────────────────────────────────
// App выставляет это значение в начале каждого рендера; вспомогательные
// компоненты модуля читают её через useTheme().
let activeTheme = null;
function useTheme() {
  return activeTheme;
}

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
  const boardMaxWidth = Math.max(260, Math.min(680, windowWidth - padH * 2 - cardPad * 2 - 20));
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
  const { styles } = useTheme();
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
  const { styles } = useTheme();
  return (
    <View style={[styles.surfaceCard, accent && styles.surfaceCardAccent, style]}>
      {children}
    </View>
  );
}

const TURN_TIME_LIMIT = 120;
const SETUP_TIME_LIMIT = 60;

const BRAND_LOGO = require('./assets/brand/logo-shield.jpg');
const BRAND_ART = require('./assets/brand/battle-art.jpg');
// Цвет фона запечён в logo-shield.jpg — экран должен совпадать с ним пиксель в пиксель
const BRAND_BG = '#EAD3B6';

// Сплэш и экран входа всегда брендовые (бежевые), не зависят от выбранного скина
const brandStyles = StyleSheet.create({
  container: { flex: 1 },
  flex1: { flex: 1 },
  scrollFlex: { flex: 1 },
  brandBg: { backgroundColor: BRAND_BG },
  splashWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: BRAND_BG,
  },
  splashLogoImg: { width: 250, height: 275 },
  splashBarTrack: {
    marginTop: 30,
    width: 240,
    maxWidth: '80%',
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(124, 45, 18, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(124, 45, 18, 0.25)',
    overflow: 'hidden',
  },
  splashBarFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: 5,
    backgroundColor: '#f59e0b',
  },
  splashCaption: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '700',
    color: '#8a6a4a',
  },
  authScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 24,
  },
  authHero: { alignItems: 'center', marginBottom: 14 },
  authLogo: { width: 180, height: 198 },
  authArtFrame: {
    borderRadius: 24,
    overflow: 'hidden',
    marginBottom: 16,
    borderWidth: 3,
    borderColor: 'rgba(124, 45, 18, 0.25)',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 14px 40px rgba(124, 45, 18, 0.25)' }
      : {
          shadowColor: '#7c2d12',
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: 0.25,
          shadowRadius: 20,
          elevation: 8,
        }),
  },
  authArtImg: { width: '100%', height: 190 },
  authSurface: {
    backgroundColor: '#faf8f4',
    borderRadius: 24,
    marginBottom: 16,
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
  authCard: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 28 },
  authCardCompact: { paddingVertical: 26, paddingHorizontal: 18 },
  authCardTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#1c1917',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    color: '#6b5744',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 22,
  },
  loginBtn: {
    alignSelf: 'stretch',
    backgroundColor: '#ea580c',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  loginBtnVk: {
    alignSelf: 'stretch',
    backgroundColor: '#0077FF',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  loginBtnVkText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  loginBtnGuest: {
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#ea580c',
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  loginBtnGuestPrimary: { backgroundColor: '#ea580c' },
  loginBtnGuestText: { color: '#c2410c', fontSize: 16, fontWeight: '800' },
  loginBtnGuestTextPrimary: { color: '#fff' },
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
  loginBtnDevText: { color: '#047857', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#dc2626', marginTop: 20, fontSize: 14 },
});

/** Брендированный экран загрузки: логотип и прогресс реальной загрузки (0..1). */
function BrandSplash({ caption = 'Загрузка…', progress = 0 }) {
  const fill = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: Math.min(1, Math.max(0, progress)),
      duration: 220,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false
    }).start();
  }, [progress, fill]);

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.04, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: false })
      ])
    );
    pulseLoop.start();
    return () => pulseLoop.stop();
  }, [pulse]);

  const fillWidth = fill.interpolate({
    inputRange: [0, 1],
    outputRange: ['5%', '100%']
  });

  return (
    <View style={[brandStyles.container, brandStyles.splashWrap]}>
      <Animated.Image
        source={BRAND_LOGO}
        style={[brandStyles.splashLogoImg, { transform: [{ scale: pulse }] }]}
        resizeMode="contain"
      />
      <View style={brandStyles.splashBarTrack}>
        <Animated.View style={[brandStyles.splashBarFill, { width: fillWidth }]} />
      </View>
      <Text style={brandStyles.splashCaption}>{caption}</Text>
    </View>
  );
}

function countActivePieces(pieces) {
  return pieces.filter((p) => !p.removed && p.row >= 0).length;
}

const OCT_POINTS = '25,0 75,0 100,25 100,75 75,100 25,100 0,75 0,25';

/**
 * Восьмиугольный командный чип под фигурой (неоновая рамка + заливка).
 * halo — дополнительный цветной ореол свечения (раскрытая фигура игрока).
 * dashed — пунктирная рамка (раскрытый/взорванный капкан).
 */
function OctagonChip({ fill, border, glow, halo, dashed }) {
  if (Platform.OS === 'web') {
    const shadow = halo
      ? `drop-shadow(0 0 8px ${halo})`
      : `drop-shadow(0 0 5px ${glow})`;
    return (
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: '4%', left: '4%', right: '4%', bottom: '4%', zIndex: 0 }}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', filter: shadow, overflow: 'visible' }}
        >
          <polygon
            points={OCT_POINTS}
            fill={fill}
            stroke={border}
            strokeWidth={dashed ? 6 : 8}
            strokeLinejoin="round"
            strokeDasharray={dashed ? '12 7' : undefined}
          />
        </svg>
      </View>
    );
  }
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: '5%',
        left: '5%',
        right: '5%',
        bottom: '5%',
        borderRadius: 8,
        backgroundColor: fill,
        borderWidth: 2.5,
        borderColor: border,
        borderStyle: dashed ? 'dashed' : 'solid',
        zIndex: 0,
      }}
    />
  );
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
  compact = false,
  compactAlways = false
}) {
  const { styles, skin, tr } = useTheme();
  const isBlue = army === 'blue';
  compact = compact || compactAlways;
  return (
    <View
      style={[
        styles.opponentPanel,
        isBlue ? styles.panelBlue : styles.panelRed,
        isBlue ? skin.theme.scoreboard.blue : skin.theme.scoreboard.red,
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
          <Text style={[styles.panelMeta, compact && styles.panelMetaCompact]}>{tr('piecesCount', { n: pieceCount })}</Text>
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
  const { styles, tr } = useTheme();
  const safeMoves = Math.max(0, Math.min(limit, moves));
  const remaining = Math.max(0, limit - safeMoves);
  const percent = (safeMoves / limit) * 100;
  const urgent = safeMoves >= Math.floor(limit * 0.85);
  const warn = !urgent && safeMoves >= Math.floor(limit * 0.6);

  return (
    <View style={[styles.drawCountdown, compact && styles.drawCountdownCompact, urgent && styles.drawCountdownDanger]}>
      <View style={styles.drawCountdownHeader}>
        <Text style={[styles.drawCountdownTitle, compact && styles.drawCountdownTitleCompact]}>
          {tr('drawCountdownTitle')}
        </Text>
        <Text style={[styles.drawCountdownMeta, urgent && styles.drawCountdownMetaDanger]}>
          {tr('drawCountdownMeta', { moves: safeMoves, limit, remaining })}
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
          {urgent ? tr('drawUrgentHint') : tr('drawSoonHint')}
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

  // ─── Скин, язык, аудио ───
  const [skinId, setSkinId] = useState('cyberpunk');
  const [locale, setLocaleState] = useState('ru');
  const [audioSettings, setAudioSettings] = useState({
    bgmEnabled: true,
    sfxEnabled: true
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const skin = getSkin(skinId);
  const ui = skin.ui;
  const styles = React.useMemo(() => createStyles(skin), [skin]);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  // Стабильная ссылка: можно безопасно использовать в socket-обработчиках
  const tr = React.useCallback((key, params) => t(key, localeRef.current, params), []);
  // Вспомогательные компоненты модуля читают тему синхронно в этом же рендере
  activeTheme = { styles, skin, ui, tr, locale };

  const changeSkin = (id) => {
    setSkinId(id);
    storage.setItem('skin', id);
  };
  const changeLocale = (l) => {
    setLocaleState(l);
    storage.setItem('locale', l);
  };
  const changeAudio = (patch) => {
    setAudioSettings((prev) => {
      const next = { ...prev, ...patch };
      storage.setItem('audio_settings', JSON.stringify(next));
      audioManager.setSettings(next);
      return next;
    });
  };

  // Имя/описание бота с учётом локали (fallback — то, что задано в реестре ботов)
  const botName = (bot) => {
    if (!bot) return '';
    return TRANSLATIONS[locale]?.[`bot_${bot.id}_name`] || bot.name;
  };
  const botDesc = (bot) => {
    if (!bot) return '';
    return TRANSLATIONS[locale]?.[`bot_${bot.id}_desc`] || bot.shortDescription || bot.longDescription || '';
  };

  // Восстановление сохранённых настроек + автоопределение языка
  useEffect(() => {
    (async () => {
      const savedSkin = await storage.getItem('skin');
      if (savedSkin && SKINS[savedSkin]) setSkinId(savedSkin);

      const savedAudio = await storage.getItem('audio_settings');
      if (savedAudio) {
        try {
          const parsed = JSON.parse(savedAudio);
          setAudioSettings((prev) => ({ ...prev, ...parsed }));
          audioManager.initialize(parsed);
        } catch (e) {}
      }

      const savedLocale = await storage.getItem('locale');
      if (savedLocale && SUPPORTED_LOCALES.includes(savedLocale)) {
        setLocaleState(savedLocale);
        return;
      }
      // Язык платформы → язык устройства → английский
      let detected = null;
      if (typeof window !== 'undefined') {
        try {
          const ysdkLang = window.__YSDK__?.environment?.i18n?.lang;
          const params = new URLSearchParams(window.location?.search || '');
          const vkLang = params.get('vk_language') || params.get('language');
          const cand = ysdkLang || vkLang;
          if (cand && SUPPORTED_LOCALES.includes(String(cand).slice(0, 2))) {
            detected = String(cand).slice(0, 2);
          }
        } catch (e) {}
      }
      if (!detected && typeof navigator !== 'undefined') {
        const langs = navigator.languages || [navigator.language];
        for (const l of langs) {
          const code = String(l || '').slice(0, 2).toLowerCase();
          if (SUPPORTED_LOCALES.includes(code)) {
            detected = code;
            break;
          }
        }
      }
      setLocaleState(detected || 'en');
    })();
  }, []);

  // RTL для арабского (web)
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.setAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      document.documentElement.setAttribute('lang', locale);
    }
  }, [locale]);

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
  const [loadProgress, setLoadProgress] = useState(0.08);
  const [loadCaption, setLoadCaption] = useState(t('loading', 'en'));
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);

  // Прогресс сплэша: только вперёд, бар не откатывается назад
  const bumpProgress = (value, caption) => {
    setLoadProgress((prev) => Math.max(prev, value));
    if (caption) setLoadCaption(caption);
  };

  // Добиваем бар до 100% и быстро убираем сплэш
  const finishLoading = () => {
    setLoadProgress(1);
    setTimeout(() => setLoading(false), 240);
  };

  // Screen state: 'lobby', 'arena', 'arena_private', 'arena_open', 'bot_select', 'game', 'profile', 'matchmaking'
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

  // Фоновая музыка: лобби-эмбиент вне боя, боевой эмбиент в матче
  const bgmTypeRef = useRef(null);
  useEffect(() => {
    if (loading || !user) {
      bgmTypeRef.current = null;
      audioManager.stopBGM();
      return;
    }
    const type = screen === 'game' ? 'battle' : 'lobby';
    if (bgmTypeRef.current !== type) {
      bgmTypeRef.current = type;
      audioManager.playBGM(type);
    }
  }, [screen, loading, user]);

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
      bumpProgress(0.15, tr('connecting'));
      let isVK = false;
      let isFB = false;
      const isYandex = typeof window !== 'undefined'
        && (window.__RPS_PLATFORM__ === 'yandex' || typeof window.YaGames !== 'undefined');

      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        if (params.get('vk_user_id') && params.get('sign')) {
          isVK = true;
        }
      }

      if (typeof window !== 'undefined' && window.FBInstant) {
        isFB = true;
      }

      if (isYandex && typeof window.YaGames !== 'undefined') {
        try {
          bumpProgress(0.35, tr('authorizing'));
          const ysdk = await window.YaGames.init();
          window.__YSDK__ = ysdk; // оставляем для рекламы/лидербордов

          let payload = null;
          try {
            const player = await ysdk.getPlayer({ signed: true });
            payload = {
              signature: player.signature || null,
              id: player.getUniqueID(),
              name: player.getName() || null,
              avatar: typeof player.getPhoto === 'function' ? player.getPhoto('medium') : null
            };
          } catch (playerErr) {
            // Игрок не авторизован в Яндексе — играем анонимным yandex-профилем устройства
            let anonId = await storage.getItem('yandex_anon_id');
            if (!anonId) {
              anonId = 'ya_anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
              await storage.setItem('yandex_anon_id', anonId);
            }
            payload = { signature: null, id: anonId, name: null, avatar: null };
          }

          const res = await fetch(`${BASE_URL}/api/v2/auth/yandex`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (res.ok) {
            const data = await res.json();
            await storage.setItem('token', data.accessToken);
            await storage.setItem('refreshToken', data.refreshToken);
            setToken(data.accessToken);
            setUser(data.user);
            finishLoading();
            // Сообщаем Яндексу, что игра загружена и готова
            try { ysdk.features?.LoadingAPI?.ready?.(); } catch (e) {}
            return;
          }
        } catch (err) {
          console.error('Yandex Games login error:', err);
        }
      }

      if (isVK) {
        try {
          const vkBridge = window.vkBridge;
          if (vkBridge) {
            bumpProgress(0.35, tr('authorizing'));
            await vkBridge.send('VKWebAppInit');

            const searchParams = new URLSearchParams(window.location.search);
            const vkParams = {};
            for (const [key, value] of searchParams.entries()) {
              vkParams[key] = value;
            }
            // Имя/аватар — косметика: если игрок не дал доступ к профилю,
            // всё равно логинимся по подписанным параметрам запуска
            try {
              const vkUser = await vkBridge.send('VKWebAppGetUserInfo');
              vkParams.first_name = vkUser.first_name;
              vkParams.last_name = vkUser.last_name;
              vkParams.photo_200 = vkUser.photo_200;
            } catch (profileErr) {
              console.warn('VKWebAppGetUserInfo failed, continuing without profile info:', profileErr);
            }

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
              finishLoading();
              return;
            }
          }
        } catch (err) {
          console.error('VK Mini App login error:', err);
        }
      }

      if (isFB) {
        try {
          bumpProgress(0.35, tr('authorizing'));
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
            finishLoading();
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

      bumpProgress(0.45, tr('loadingProfile'));

      if (Platform.OS === 'web') {
        const savedToken = await storage.getItem('token');
        if (!savedToken && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
          const logoutFlag = await storage.getItem('logout_flag');
          if (logoutFlag !== 'true') {
            window.location.href = `${BASE_URL}/api/v2/auth/dev`;
            return;
          }
        }
        if (savedToken) {
          setToken(savedToken);
          bumpProgress(0.65);
          fetchUserProfile(savedToken);
        } else {
          finishLoading();
        }
      } else {
        // Mobile native: preserve login persistence in localStorage
        const savedToken = await storage.getItem('token');
        if (savedToken) {
          setToken(savedToken);
          bumpProgress(0.65);
          fetchUserProfile(savedToken);
        } else {
          finishLoading();
        }
      }
    };

    initializeAuth();
  }, []);

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
        audioManager.playSFX('move');
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

  /** Рендер фигуры по активному скину: PNG-ассеты, рамка и подсветка из skin.piece. */
  const renderSkinPiece = (type, pieceType, isEnemy, isImmobilized, isRevealed) => {
    const side = isEnemy ? 'enemy' : 'player';
    const pType = isEnemy ? (isRevealed ? (pieceType || type) : 'unknown') : (pieceType || type);
    const containerStyle = skin.piece.container(side, {
      immobilized: isImmobilized,
      revealed: isRevealed
    });
    let asset = pType !== 'unknown' ? skin.assets?.[pType] : null;
    // Взорванный/раскрытый капкан — картинка «взрыв» вместо бомбы
    if (pType === 'trap' && isRevealed && skin.assets?.trapOpen) {
      asset = skin.assets.trapOpen;
    }
    // Для скинов с командным чипом (киберпанк) — восьмиугольная подложка под фигурой
    const chip = skin.piece.chip
      ? skin.piece.chip(side, { type: pType, immobilized: isImmobilized, revealed: isRevealed })
      : null;

    return (
      <View style={containerStyle} pointerEvents="none">
        {chip ? <OctagonChip {...chip} /> : null}
        {skin.piece.showGloss ? <View style={styles.cartoonPieceGloss} /> : null}
        {asset ? (
          <Image source={asset} style={skin.piece.imageStyle(side, pType === 'trap' && isRevealed)} resizeMode="contain" />
        ) : (
          <Text style={skin.piece.unknown(side, layout.pieceFontSize)}>
            {pType === 'unknown' ? '?' : (skin.pieceEmoji?.[pType] || PIECE_SYMBOLS[pType] || '?')}
          </Text>
        )}
      </View>
    );
  };
  const renderCartoonPiece = renderSkinPiece;

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
          // Если игрок ищет соперника через «Быструю игру», не уводим его в арену
          setScreen((prev) => (prev === 'matchmaking' ? prev : 'arena'));
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
        setArenaStatus(tr('statusInQueue'));
      });

      socket.on('queue:left', () => {
        setIsSearchingMatch(false);
        setArenaStatus('');
      });

      socket.on('queue:timeout', (d) => {
        setIsSearchingMatch(false);
        setArenaStatus(d?.message || tr('opponentNotFound'));
        setScreen((prev) => (prev === 'matchmaking' ? 'lobby' : prev));
        alert(d?.message || tr('opponentNotFound5m'));
      });

      socket.on('room:created', ({ roomId, code, isPrivate }) => {
        setMyWaitingRoomId(roomId || null);
        setMyWaitingRoomPrivate(!!isPrivate);
        if (isPrivate && code) {
          setCreatedRoomCode(code);
          setArenaStatus(tr('statusShareCode', { code }));
        } else {
          setCreatedRoomCode(null);
          setArenaStatus(tr('statusOpenRoomCreated'));
        }
      });

      socket.on('room:closed', () => {
        setMyWaitingRoomId(null);
        setMyWaitingRoomPrivate(false);
        setCreatedRoomCode(null);
        setArenaStatus('');
      });

      socket.on('room:error', (d) => {
        const msg = d?.message || tr('roomError');
        setArenaStatus(msg);
        alert(msg);
      });

      socket.on('challenge:sent', () => {
        setArenaStatus(tr('statusChallengeSent'));
      });

      socket.on('challenge:error', (d) => {
        setArenaStatus(d?.message || tr('challengeError'));
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
        setBattleLogs([tr('matchFound')]);
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
            // Озвучка PvP-событий по переходам состояния
            if (prev && merged.phase === GAME_CONFIG.PHASES.PLAYING) {
              if (merged.battleState && !prev.battleState) {
                audioManager.playSFX('tie');
              } else if (
                prev.currentPlayer !== merged.currentPlayer
                && merged.currentPlayer === currentRole
              ) {
                audioManager.playSFX('turn');
              }
            }
            if (
              prev && prev.phase !== GAME_CONFIG.PHASES.FINISHED
              && merged.phase === GAME_CONFIG.PHASES.FINISHED
              && merged.endReason !== 'setup_timeout'
            ) {
              if (merged.winner === currentRole) audioManager.playSFX('victory');
              else if (merged.winner && merged.winner !== 'draw') audioManager.playSFX('defeat');
            }
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
        setArenaStatus(tr('statusOpponentDisconnected'));
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

  /** Чужая открытая комната, ожидающая второго игрока (для быстрого матча). */
  const findJoinableOpenRoom = () => publicRooms.find((room) =>
    (!user || String(room.creatorId) !== String(user.id)) && (room.playersCount || 1) < 2
  );

  /** Быстрый матч на арене: если есть чужая открытая комната — сразу в неё, иначе очередь подбора. */
  const handleArenaQuickMatch = () => {
    const room = findJoinableOpenRoom();
    if (room) {
      handleJoinPublicRoom(room.id);
      return;
    }
    handleJoinQueue();
  };

  /** Быстрая игра из лобби: открытая комната, если есть, иначе очередь + экран поиска. */
  const handleQuickMatch = () => {
    setProfileMenuOpen(false);
    setArenaStatus('');
    socketRef.current?.emit('lobby:enter');
    const room = findJoinableOpenRoom();
    if (room) {
      handleJoinPublicRoom(room.id);
      return;
    }
    handleJoinQueue();
    setScreen('matchmaking');
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
      alert(tr('rematchNoOpponent'));
      return;
    }
    socketRef.current?.emit('online:challenge', { targetId: opponentId });
    setArenaStatus(tr('statusRematchSent'));
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
        finishLoading();
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
        throw new Error(tr('profileLoadFailed'));
      }
      const data = await res.json();
      if (data.authenticated) {
        setUser(data.user);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      finishLoading();
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

  const handleVKIDLogin = () => {
    if (typeof window !== 'undefined') {
      window.location.href = `${BASE_URL}/api/v2/auth/vkid`;
    }
  };

  const handleDevLogin = async () => {
    if (typeof window !== 'undefined') {
      await storage.removeItem('logout_flag');
      window.location.href = `${BASE_URL}/api/v2/auth/dev`;
    }
  };

  // Гостевой вход: анонимный аккаунт, привязанный к устройству.
  // Единственный способ входа на iOS/Android без настройки нативного OAuth.
  const handleGuestLogin = async () => {
    try {
      setError(null);
      let deviceId = await storage.getItem('guest_device_id');
      if (!deviceId) {
        deviceId = 'guest_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        await storage.setItem('guest_device_id', deviceId);
      }
      const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
      const res = await fetch(`${BASE_URL}/api/v2/auth/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, platform })
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      await storage.setItem('token', data.accessToken);
      await storage.setItem('refreshToken', data.refreshToken);
      await storage.removeItem('logout_flag');
      setToken(data.accessToken);
      setUser(data.user);
    } catch (err) {
      console.error('Guest login error:', err);
      setError(tr('guestLoginFailed'));
    }
  };

  const handleLogout = async () => {
    await storage.removeItem('token');
    await storage.removeItem('refreshToken');
    if (Platform.OS === 'web') {
      await storage.setItem('logout_flag', 'true');
    }
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
      return new Date(iso).toLocaleDateString(LOCALE_DATE_TAGS[locale] || 'en-US', {
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
      web: tr('platformWeb'),
      android: 'Android',
      ios: 'iOS',
      vk: tr('platformVk'),
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
      tr('logSetupIntro'),
      tr('logSetupTime', { sec: SETUP_TIME_LIMIT })
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
    addLog(tr('logSetupTimeout'));
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
      addLog(tr('logOwnTerritoryOnly'));
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
      addLog(tr('logFlagPlaced', { coord: formatBoardCoord(row, col) }));
    } else if (game.setupPhase === GAME_CONFIG.SETUP_PHASES.TRAP) {
      if (game.flagPosition[0] === row && game.flagPosition[1] === col) {
        addLog(tr('logNoTrapOnFlag'));
        return;
      }
      const updatedGame = { ...game };
      updatedGame.trapPosition = [row, col];
      updatedGame.board = buildSetupPreviewBoard(updatedGame.flagPosition, [row, col], owner);
      updatedGame.setupPhase = GAME_CONFIG.SETUP_PHASES.DONE;
      setGame(updatedGame);
      addLog(tr('logTrapPlaced', { coord: formatBoardCoord(row, col) }));
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
    addLog(tr('logSetupReset'));
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
    addLog(tr('logBattleStarted'));
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
          audioManager.playSFX('move');
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

    // Озвучка события
    if (result.type === 'move') {
      audioManager.playSFX(result.piece && result.piece.owner === PLAYER ? 'move' : 'opponent_move');
    } else if (result.type === 'battle_trap') {
      audioManager.playSFX('trap');
    } else if (result.type === 'battle' || result.type === 'battle_flag') {
      audioManager.playSFX(result.result === 'draw' ? 'tie' : 'combat');
    }

    if (result.type === 'move') {
      const fromCoord = formatBoardCoord(result.from[0], result.from[1]);
      const toCoord = formatBoardCoord(result.to[0], result.to[1]);
      const who = result.piece.owner === PLAYER ? tr('you') : tr('bot');
      addLog(tr('logMoved', { who, from: fromCoord, to: toCoord }));
    } else if (result.type === 'battle' || result.type === 'battle_trap' || result.type === 'battle_flag') {
      const attackerName = result.attacker.owner === PLAYER ? tr('you') : tr('bot');
      const defenderName = result.defender.owner === PLAYER ? tr('you') : tr('bot');
      const attSym = PIECE_SYMBOLS[result.attacker.pieceType || result.attacker.type];
      const defSym = PIECE_SYMBOLS[result.defender.pieceType || result.defender.type];

      let battleDesc = tr('logBattle', { att: attackerName, attSym, def: defenderName, defSym });

      if (result.result === 'win') {
        battleDesc += tr('logBattleWin', { who: attackerName });
      } else if (result.result === 'lose') {
        battleDesc += tr('logBattleWin', { who: defenderName });
      } else {
        battleDesc += tr('logBattleTie');
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
    } else {
      const mover = (result.piece && result.piece.owner) || (result.attacker && result.attacker.owner);
      if (mover === COMPUTER && !updatedGame.battleState) {
        audioManager.playSFX('turn');
      }
    }
  };

  const triggerBotTurn = (currentGame) => {
    setIsBotThinking(true);
    addLog(tr('logBotThinking'));
    
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
    addLog(tr('logReplay', { mine: playerChoiceSym, opp: tr('bot'), theirs: aiChoiceSym }));
    
    if (result.type === 'tie_resolved') {
      addLog(tr('logTieResolved', { result: result.winner === PLAYER ? tr('victory') : tr('defeat') }));
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
      audioManager.playSFX('trap');
      addLog(tr('logMutualDestruction'));
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
      addLog(tr('logTieAgain', { round: result.drawRound }));
      setGame(updatedGame);
    }
  };

  const handleGameOver = async (winner, reason) => {
    const playerWon = winner === PLAYER;
    const isDraw = winner === 'draw';
    const skipRating = reason === 'setup_timeout';

    if (gameMode !== 'pvp' && reason !== 'setup_timeout') {
      if (playerWon) audioManager.playSFX('victory');
      else if (!isDraw) audioManager.playSFX('defeat');
    }

    let desc;
    if (reason === 'setup_timeout') {
      desc = tr('logSetupTimeout');
    } else {
      const resultText = isDraw
        ? tr('resultDraw')
        : (playerWon ? tr('resultPlayerWin') : tr('resultPlayerLose'));
      desc = tr('logGameOver', { result: resultText });
      const reasonKeys = {
        flag_captured: 'reasonFlagCaptured',
        no_pieces: 'reasonNoPieces',
        hopeless: 'reasonHopeless',
        no_moves: 'reasonNoMoves',
        surrender: 'reasonSurrender',
        no_captures_draw: 'reasonDrawNoCapture'
      };
      if (reasonKeys[reason]) {
        desc += ` (${tr(reasonKeys[reason])})`;
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

  // ─── Модалка настроек: скины, язык, аудио ───
  const settingsModal = (
    <Modal
      animationType="fade"
      transparent
      visible={settingsOpen}
      onRequestClose={() => setSettingsOpen(false)}
    >
      <View style={[styles.modalOverlay, layout.mobile && styles.modalOverlayMobile]}>
        <View style={[styles.modalCard, styles.settingsCard, layout.mobile && styles.modalCardMobile]}>
          <Text style={styles.modalTitle}>⚙️ {tr('settingsTitle')}</Text>
          <ScrollView style={styles.settingsScroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.settingsSectionTitle}>{tr('selectSkin')}</Text>
            <View style={styles.skinRow}>
              {SKIN_ORDER.map((id) => {
                const sk = SKINS[id];
                const active = id === skinId;
                return (
                  <TouchableOpacity
                    key={id}
                    style={[styles.skinOption, active && styles.skinOptionActive]}
                    activeOpacity={0.8}
                    onPress={() => changeSkin(id)}
                  >
                    <Text style={styles.skinOptionIcon}>{sk.icon}</Text>
                    <Text style={[styles.skinOptionLabel, active && styles.skinOptionLabelActive]}>
                      {tr(sk.nameKey)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.settingsSectionTitle}>{tr('selectLanguage')}</Text>
            <View style={styles.langGrid}>
              {SUPPORTED_LOCALES.map((l) => (
                <TouchableOpacity
                  key={l}
                  style={[styles.langChip, l === locale && styles.langChipActive]}
                  onPress={() => changeLocale(l)}
                >
                  <Text style={[styles.langChipText, l === locale && styles.langChipTextActive]}>
                    {LANG_NAMES[l] || l}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.settingsSectionTitle}>{tr('audioSettings')}</Text>
            {[
              ['bgmEnabled', 'bgmToggle'],
              ['sfxEnabled', 'sfxToggle']
            ].map(([key, labelKey]) => (
              <TouchableOpacity
                key={key}
                style={styles.audioRow}
                activeOpacity={0.7}
                onPress={() => changeAudio({ [key]: !audioSettings[key] })}
              >
                <Text style={styles.audioRowLabel}>{tr(labelKey)}</Text>
                <View style={[styles.togglePill, audioSettings[key] && styles.togglePillOn]}>
                  <View style={[styles.toggleKnob, audioSettings[key] && styles.toggleKnobOn]} />
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.settingsCloseBtn} onPress={() => setSettingsOpen(false)}>
            <Text style={styles.settingsCloseBtnText}>{tr('close')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // ─── Модалка вызова на дуэль (арена и её подстраницы) ───
  const inviteModal = (
    <Modal animationType="fade" transparent visible={!!pendingInvite}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{tr('duelChallenge')}</Text>
          <Text style={styles.modalSubtitle}>
            {tr('challengesYou', { name: pendingInvite?.from?.name || tr('playerFallback') })}
          </Text>
          <View style={[styles.choiceRow, { marginTop: 16 }]}>
            <TouchableOpacity style={styles.choiceBtn} onPress={() => setPendingInvite(null)}>
              <Text style={styles.choiceText}>{tr('decline')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.choiceBtn, { backgroundColor: ui.accent }]} onPress={handleAcceptInvite}>
              <Text style={[styles.choiceText, { color: ui.onAccent }]}>{tr('accept')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ─── Карточки «моя комната ожидает» и статуса — общие для арены и подстраниц ───
  const arenaStatusBlocks = (
    <>
      {myWaitingRoomId && (
        <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
          <View style={styles.arenaWaitingCard}>
            <ActivityIndicator size="small" color={ui.accent} />
            <View style={styles.arenaWaitingCardText}>
              <Text style={styles.arenaWaitingTitle}>
                {myWaitingRoomPrivate ? tr('privateRoom') : tr('yourOpenRoom')}
              </Text>
              <Text style={styles.arenaWaitingDesc}>
                {myWaitingRoomPrivate && createdRoomCode
                  ? tr('waitingOpponentCode', { code: createdRoomCode })
                  : tr('waitingOpponent')}
              </Text>
            </View>
            <TouchableOpacity style={styles.arenaWaitingCancelBtn} onPress={handleCloseMyWaitingRoom}>
              <Text style={styles.arenaWaitingCancelText}>{tr('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </SurfaceCard>
      )}

      {(arenaStatus || isSearchingMatch) && (
        <SurfaceCard accent style={[styles.arenaStatusCard, { padding: layout.cardPad, marginBottom: layout.gap }]}>
          {isSearchingMatch && (
            <ActivityIndicator size="small" color={ui.accent} style={{ marginBottom: 8 }} />
          )}
          <Text style={styles.arenaStatusText}>
            {isSearchingMatch ? tr('searchingOpponent') : arenaStatus}
          </Text>
          {isSearchingMatch && (
            <TouchableOpacity style={styles.arenaLinkBtn} onPress={handleLeaveQueue}>
              <Text style={styles.arenaLinkBtnText}>{tr('cancelSearch')}</Text>
            </TouchableOpacity>
          )}
        </SurfaceCard>
      )}
    </>
  );

  if (loading) {
    return <BrandSplash progress={loadProgress} caption={loadCaption} />;
  }

  // --- Login / Splash Screen ---
  if (!user) {
    const isWebPlatform = Platform.OS === 'web';
    const isLocalhost = isWebPlatform
      && typeof window !== 'undefined'
      && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    return (
      <View style={[brandStyles.container, brandStyles.brandBg]}>
        <StatusBar style="dark" />
        <SafeAreaView style={brandStyles.flex1}>
          <ScrollView
            style={brandStyles.scrollFlex}
            contentContainerStyle={brandStyles.authScroll}
            showsVerticalScrollIndicator={false}
          >
            <PageShell narrow padH={layout.padH}>
              <View style={brandStyles.authArtFrame}>
                <Image source={BRAND_ART} style={brandStyles.authArtImg} resizeMode="cover" />
              </View>

              <View style={[brandStyles.authSurface, brandStyles.authCard, layout.compact && brandStyles.authCardCompact]}>
                <Text style={brandStyles.authCardTitle}>{tr('authTitle')}</Text>
                <Text style={brandStyles.subtitle}>{tr('authDesc')}</Text>

                {isWebPlatform && (
                  <TouchableOpacity style={brandStyles.loginBtn} onPress={handleLogin}>
                    <Text style={brandStyles.loginBtnText}>{tr('loginGoogle')}</Text>
                  </TouchableOpacity>
                )}

                {isWebPlatform && !IS_VK_ENTRY && (
                  <TouchableOpacity style={brandStyles.loginBtnVk} onPress={handleVKIDLogin}>
                    <Text style={brandStyles.loginBtnVkText}>{tr('loginVkId')}</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[brandStyles.loginBtnGuest, !isWebPlatform && brandStyles.loginBtnGuestPrimary]}
                  onPress={handleGuestLogin}
                >
                  <Text style={[brandStyles.loginBtnGuestText, !isWebPlatform && brandStyles.loginBtnGuestTextPrimary]}>
                    {tr('playAsGuest')}
                  </Text>
                </TouchableOpacity>

                {isLocalhost && (
                  <TouchableOpacity style={brandStyles.loginBtnDev} onPress={handleDevLogin}>
                    <Text style={brandStyles.loginBtnDevText}>Войти как DevTester (Admin)</Text>
                  </TouchableOpacity>
                )}

                {error && <Text style={brandStyles.errorText}>{error}</Text>}
              </View>
            </PageShell>
          </ScrollView>
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
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
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
                <Text style={styles.botSelectBackBtnText}>← {tr('back')}</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.sectionHeader, { marginTop: layout.gap }]}>
              <Text style={[styles.sectionTitle, layout.compact && styles.sectionTitleCompact]}>
                {tr('arenaTitle')}
              </Text>
              <Text style={styles.sectionSubtitle}>
                {tr('arenaSubtitle')}
              </Text>
              <View style={styles.arenaStatRow}>
                <View style={styles.arenaStatPill}>
                  <Text style={styles.arenaStatPillValue}>{arenaOnlineCount}</Text>
                  <Text style={styles.arenaStatPillLabel}>{tr('pillOnline')}</Text>
                </View>
                <View style={styles.arenaStatPill}>
                  <Text style={styles.arenaStatPillValue}>{visiblePlayers.length}</Text>
                  <Text style={styles.arenaStatPillLabel}>{tr('pillAvailable')}</Text>
                </View>
                <View style={styles.arenaStatPill}>
                  <Text style={styles.arenaStatPillValue}>{publicRooms.length}</Text>
                  <Text style={styles.arenaStatPillLabel}>{tr('pillRooms')}</Text>
                </View>
              </View>
            </View>

            {arenaStatusBlocks}

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>{tr('gameModes')}</Text>
              <View style={styles.arenaModeGrid}>
                <TouchableOpacity
                  style={[
                    styles.arenaModeTile,
                    styles.arenaModeTileHero,
                    isSearchingMatch && styles.arenaModeTileDisabled
                  ]}
                  onPress={handleArenaQuickMatch}
                  disabled={isSearchingMatch}
                  activeOpacity={0.85}
                >
                  <Text style={styles.arenaModeEmoji}>⚡</Text>
                  <Text style={styles.arenaModeTitle}>{tr('quickMatch')}</Text>
                  <Text style={styles.arenaModeDesc}>{tr('quickMatchDesc')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.arenaModeNavTile}
                  onPress={() => setScreen('arena_private')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.arenaModeNavEmoji}>🔒</Text>
                  <Text style={styles.arenaModeNavTitle} numberOfLines={1}>{tr('privateModeTile')}</Text>
                  <Text style={styles.arenaModeNavChevron}>›</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.arenaModeNavTile}
                  onPress={() => setScreen('arena_open')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.arenaModeNavEmoji}>🌐</Text>
                  <Text style={styles.arenaModeNavTitle} numberOfLines={1}>{tr('openModeTile')}</Text>
                  <Text style={styles.arenaModeNavChevron}>›</Text>
                </TouchableOpacity>
              </View>
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: 0 }}>
                <Text style={styles.cardTitle}>{tr('playersOnline')}</Text>
                <Text style={[styles.infoBody, { marginBottom: 12 }]}>
                  {tr('upTo20List')}
                </Text>
                {visiblePlayers.length === 0 ? (
                  <View style={styles.arenaEmptyBox}>
                    <Text style={styles.arenaEmptyText}>{tr('nobodyElse')}</Text>
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
                          {p.name || tr('playerFallback')}
                        </Text>
                        <Text style={styles.arenaPlayerRating}>{p.ratingMmr ?? 1000} MMR</Text>
                        {(() => {
                          const stats = user?.pvpOpponentStats?.find(s => String(s.opponentId || s.opponent?.id) === String(p.id)) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
                          return (
                            <Text style={{ fontSize: 11, color: ui.textSecondary, marginTop: 2 }}>
                              {tr('statsLine', { games: stats.gamesPlayed, wins: stats.wins, losses: stats.losses, draws: stats.draws })}
                            </Text>
                          );
                        })()}
                      </View>
                      {p.inGame ? (
                        <View style={styles.arenaBusyBadge}>
                          <Text style={styles.arenaBusyLabel}>{tr('inGame')}</Text>
                        </View>
                      ) : (
                        <TouchableOpacity
                          style={styles.arenaChallengeBtn}
                          onPress={() => handleChallengePlayer(p.id)}
                        >
                          <Text style={styles.arenaChallengeBtnText}>{tr('challenge')}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ))
                )}
              </SurfaceCard>
          </PageShell>
        </ScrollView>

        {settingsModal}
        {inviteModal}
      </SafeAreaView>
    );
  }

  // --- Арена: приватная игра (создать комнату или войти по коду) ---
  if (screen === 'arena_private') {
    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
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
                onPress={() => setScreen('arena')}
              >
                <Text style={styles.botSelectBackBtnText}>← {tr('back')}</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.sectionHeader, { marginTop: layout.gap }]}>
              <Text style={[styles.sectionTitle, layout.compact && styles.sectionTitleCompact]}>
                🔒 {tr('privatePageTitle')}
              </Text>
              <Text style={styles.sectionSubtitle}>{tr('privatePageSubtitle')}</Text>
            </View>

            {arenaStatusBlocks}

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <TouchableOpacity
                style={[
                  styles.arenaModeTile,
                  styles.arenaModeTileHero,
                  roomsAtCap && styles.arenaModeTileDisabled
                ]}
                onPress={handleCreatePrivateRoom}
                disabled={roomsAtCap}
                activeOpacity={0.85}
              >
                <Text style={styles.arenaModeEmoji}>🔒</Text>
                <Text style={styles.arenaModeTitle}>{tr('createPrivateRoomBtn')}</Text>
                <Text style={styles.arenaModeDesc}>{tr('createPrivateRoomHint')}</Text>
              </TouchableOpacity>
              {roomsAtCap && (
                <Text style={[styles.infoBody, { marginTop: 12, color: ui.warning }]}>
                  {tr('roomsCapHint')}
                </Text>
              )}
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: 0 }}>
              <Text style={styles.cardTitle}>{tr('enterByCode')}</Text>
              <Text style={[styles.infoBody, { marginBottom: 12 }]}>
                {tr('privateRoomsHidden')}
              </Text>
              <View style={[styles.arenaCodeRow, layout.mobile && styles.arenaCodeRowStack]}>
                <TextInput
                  style={[
                    styles.arenaCodeInput,
                    layout.mobile ? styles.arenaCodeInputStack : styles.arenaCodeInputFlex
                  ]}
                  placeholder={tr('codePlaceholder')}
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
                  <Text style={styles.arenaCodeBtnText}>{tr('enter')}</Text>
                </TouchableOpacity>
              </View>
            </SurfaceCard>
          </PageShell>
        </ScrollView>

        {settingsModal}
        {inviteModal}
      </SafeAreaView>
    );
  }

  // --- Арена: открытые комнаты (создать свою или подключиться из списка) ---
  if (screen === 'arena_open') {
    const joinableRooms = publicRooms.filter((room) =>
      !user || String(room.creatorId) !== String(user.id)
    );
    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
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
                onPress={() => setScreen('arena')}
              >
                <Text style={styles.botSelectBackBtnText}>← {tr('back')}</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.sectionHeader, { marginTop: layout.gap }]}>
              <Text style={[styles.sectionTitle, layout.compact && styles.sectionTitleCompact]}>
                🌐 {tr('openRooms')}
              </Text>
              <Text style={styles.sectionSubtitle}>{tr('openPageSubtitle')}</Text>
            </View>

            {arenaStatusBlocks}

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <TouchableOpacity
                style={[
                  styles.arenaModeTile,
                  styles.arenaModeTileHero,
                  roomsAtCap && styles.arenaModeTileDisabled
                ]}
                onPress={handleCreateOpenRoom}
                disabled={roomsAtCap}
                activeOpacity={0.85}
              >
                <Text style={styles.arenaModeEmoji}>🌐</Text>
                <Text style={styles.arenaModeTitle}>{tr('createOpenRoomBtn')}</Text>
                <Text style={styles.arenaModeDesc}>{tr('createOpenRoomHint')}</Text>
              </TouchableOpacity>
              {roomsAtCap && (
                <Text style={[styles.infoBody, { marginTop: 12, color: ui.warning }]}>
                  {tr('roomsCapHint')}
                </Text>
              )}
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: 0 }}>
              <Text style={styles.cardTitle}>{tr('openRooms')}</Text>
              <Text style={[styles.infoBody, { marginBottom: 12 }]}>{tr('upTo10Rooms')}</Text>
              {joinableRooms.length === 0 ? (
                <View style={styles.arenaEmptyBox}>
                  <Text style={styles.arenaEmptyText}>{tr('noOpenRooms')}</Text>
                </View>
              ) : (
                joinableRooms.map((room) => (
                  <View key={room.id} style={styles.arenaPlayerCard}>
                    {room.creatorAvatar ? (
                      <Image source={{ uri: room.creatorAvatar }} style={styles.arenaPlayerAvatar} />
                    ) : (
                      <View style={[styles.arenaPlayerAvatar, styles.avatarPlaceholder]}>
                        <Text style={styles.profileHeroLetter}>
                          {(room.creatorName || '?')[0].toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <View style={styles.arenaPlayerInfo}>
                      <Text style={styles.arenaPlayerName} numberOfLines={1}>
                        {room.creatorName || tr('playerFallback')}
                      </Text>
                      <Text style={styles.arenaRoomMeta}>
                        {tr('openRoomMeta', { count: room.playersCount || 1 })}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.arenaJoinBtn}
                      onPress={() => handleJoinPublicRoom(room.id)}
                    >
                      <Text style={styles.arenaJoinBtnText}>{tr('enter')}</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </SurfaceCard>
          </PageShell>
        </ScrollView>

        {settingsModal}
        {inviteModal}
      </SafeAreaView>
    );
  }

  // --- Matchmaking View ---
  if (screen === 'matchmaking') {
    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
        <View style={styles.scrollFlex}>
          <PageShell narrow style={styles.centeredShell}>
            <SurfaceCard style={styles.loadingCard}>
              <ActivityIndicator size="large" color={ui.accent} />
              <Text style={[styles.loadingText, { fontSize: 20, fontWeight: '800', marginTop: 24 }]}>
                {tr('searchingOpponent')}
              </Text>
              <Text style={{ color: ui.textSecondary, marginTop: 8, fontSize: 14 }}>
                {tr('queueTime', { sec: matchmakingTime })}
              </Text>
              <TouchableOpacity
                style={[styles.actionBtn, styles.primaryBtnOutline, { marginTop: 24, alignSelf: 'stretch', justifyContent: 'center' }]}
                onPress={() => {
                  handleLeaveQueue();
                  setScreen('lobby');
                }}
              >
                <Text style={styles.primaryBtnOutlineText}>{tr('cancel')}</Text>
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
    const quickOpponents = buildQuickOpponents(user, arenaPlayers, botList, tr('playerFallback'));

    return (
      <SafeAreaView style={[styles.container, styles.appBg]}>
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
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
                      🏆 {user.stats?.ratingMmr ?? 1000} MMR · {tr('profile')} ›
                    </Text>
                  </View>
                </TouchableOpacity>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <TouchableOpacity
                    style={styles.headerIconBtn}
                    onPress={() => setSettingsOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={tr('settings')}
                  >
                    <Text style={styles.headerIconBtnText}>⚙️</Text>
                  </TouchableOpacity>
                  {!IS_VK_ENTRY && (
                    <TouchableOpacity
                      style={styles.lobbyLogoutBtn}
                      onPress={handleLogout}
                    >
                      <Text style={styles.lobbyLogoutBtnText}>{tr('logoutAccount')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

            </SurfaceCard>

            {/* Игровые режимы — главный элемент лобби */}
            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>{tr('playSection')}</Text>
              <TouchableOpacity
                style={styles.modeTileHero}
                activeOpacity={0.85}
                onPress={handleQuickMatch}
              >
                <Text style={styles.modeTileEmoji}>⚡</Text>
                <View style={styles.modeTileBody}>
                  <Text style={styles.modeTileHeroTitle}>{tr('quickGame')}</Text>
                  <Text style={styles.modeTileHeroDesc}>{tr('quickGameDesc')}</Text>
                </View>
                <Text style={styles.modeTileChevron}>›</Text>
              </TouchableOpacity>
              <View style={styles.modeTileRow}>
                <TouchableOpacity
                  style={styles.modeTile}
                  activeOpacity={0.85}
                  onPress={openArena}
                >
                  <Text style={styles.modeTileEmoji}>🌐</Text>
                  <Text style={styles.modeTileTitle}>{tr('arena')}</Text>
                  <Text style={styles.modeTileDesc}>{tr('arenaTileDesc')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modeTile}
                  activeOpacity={0.85}
                  onPress={() => {
                    setProfileMenuOpen(false);
                    setScreen('bot_select');
                    setBotSelectTab('free');
                  }}
                >
                  <Text style={styles.modeTileEmoji}>🤖</Text>
                  <Text style={styles.modeTileTitle}>{tr('botsTile')}</Text>
                  <Text style={styles.modeTileDesc}>{tr('botsTileDesc')}</Text>
                </TouchableOpacity>
              </View>
            </SurfaceCard>

            {quickOpponents.length > 0 && (
              <SurfaceCard style={{ padding: layout.cardPad, marginBottom: 0 }}>
                <Text style={styles.cardTitle}>{tr('quickMatchSection')}</Text>
                <Text style={[styles.profileSectionHint, { marginBottom: 12 }]}>
                  {tr('quickMatchHint')}
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
                          setArenaStatus(tr('challengeSentTo', { name: opp.name }));
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
                      <Text style={styles.quickOpponentName} numberOfLines={1}>
                        {opp.kind === 'bot'
                          ? (TRANSLATIONS[locale]?.[`bot_${opp.id}_name`] || opp.name)
                          : opp.name}
                      </Text>
                      <Text style={styles.quickOpponentMeta} numberOfLines={1}>
                        {opp.kind === 'human'
                          ? `${opp.ratingMmr ?? 1000} MMR · ${opp.online ? tr('online') : tr('offline')}`
                          : (opp.modelAuthor ? tr('modelBy', { author: opp.modelAuthor }) : tr('aiOpponent'))}
                      </Text>
                      <Text style={styles.quickOpponentGames}>
                        {tr('statsLine', { games: opp.games, wins: opp.wins || 0, losses: opp.losses || 0, draws: opp.draws || 0 })}
                      </Text>
                      <Text style={styles.quickOpponentPlay}>{tr('playNow')}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </SurfaceCard>
            )}
          </PageShell>
        </ScrollView>
        {settingsModal}
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
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
        <View style={[styles.profileScreenTopBar, { paddingHorizontal: layout.padH }]}>
          <PageShell padH={0} maxWidth={layout.shellMax} style={styles.botSelectTopBarInner}>
            <TouchableOpacity
              style={styles.botSelectBackBtn}
              onPress={() => setScreen('lobby')}
            >
              <Text style={styles.botSelectBackBtnText}>← {tr('back')}</Text>
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
                    {user.role === 'admin' ? tr('roleAdmin') : tr('rolePlayer')}
                  </Text>
                  {user.email ? (
                    <Text style={styles.profileHeroMeta} numberOfLines={1}>{user.email}</Text>
                  ) : null}
                  <Text style={styles.profileHeroMeta}>
                    {tr('platformLine', { platform: platformLabel(user.platform) })}
                  </Text>
                  <Text style={styles.profileHeroMeta}>
                    {tr('playingSince', { date: formatProfileDate(user.createdAt) })}
                  </Text>
                </View>
              </View>
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>{tr('vsHumans')}</Text>
              <Text style={styles.profileSectionHint}>{tr('pvpMmrHint')}</Text>
              <View style={styles.ratingRow}>
                <Text style={styles.ratingValue}>{user.stats?.ratingMmr ?? 1000}</Text>
                <Text style={styles.ratingLabel}>MMR</Text>
              </View>
              <View style={styles.statsDivider} />
              <View style={styles.winLossGrid}>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.greenText]}>{user.stats?.wins ?? 0}</Text>
                  <Text style={styles.gridLabel}>{tr('winsLabel')}</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.redText]}>{user.stats?.losses ?? 0}</Text>
                  <Text style={styles.gridLabel}>{tr('lossesLabel')}</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.grayText]}>{user.stats?.draws ?? 0}</Text>
                  <Text style={styles.gridLabel}>{tr('drawsLabel')}</Text>
                </View>
              </View>
            </SurfaceCard>

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>{tr('vsBots')}</Text>
              <Text style={styles.profileSectionHint}>
                {totalBotGames > 0
                  ? tr('pveTotalHint', { count: totalBotGames })
                  : tr('pveNoMmrHint')}
              </Text>
              <View style={styles.winLossGrid}>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.greenText]}>{botTotals.wins}</Text>
                  <Text style={styles.gridLabel}>{tr('winsLabel')}</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.redText]}>{botTotals.losses}</Text>
                  <Text style={styles.gridLabel}>{tr('lossesLabel')}</Text>
                </View>
                <View style={styles.gridItem}>
                  <Text style={[styles.gridValue, styles.grayText]}>{botTotals.draws}</Text>
                  <Text style={styles.gridLabel}>{tr('drawsLabel')}</Text>
                </View>
              </View>
            </SurfaceCard>

            {pvpStats.length > 0 && (
              <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
                <Text style={styles.cardTitle}>{tr('playersDuels')}</Text>
                {pvpStats.map((row) => {
                  const name = row.opponent?.nickname || tr('playerFallback');
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
                          <Text style={styles.greenText}>{row.wins} {tr('winsLabel')}</Text>
                          {' · '}
                          <Text style={styles.redText}>{row.losses} {tr('lossesLabel')}</Text>
                        </Text>
                        <Text style={styles.botStatMeta}>
                          {tr('totalWithDate', { count: row.gamesPlayed, date: formatProfileDate(row.lastPlayedAt) })}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </SurfaceCard>
            )}

            <SurfaceCard style={{ padding: layout.cardPad, marginBottom: layout.gap }}>
              <Text style={styles.cardTitle}>{tr('botsByOpponent')}</Text>
              <Text style={styles.profileSectionHint}>
                {totalBotGames > 0
                  ? tr('botsPlayedTotal', { count: totalBotGames })
                  : tr('noBotGames')}
              </Text>
              {botStats.length === 0 ? (
                <Text style={styles.profileEmptyBots}>
                  {tr('chooseBotHint')}
                </Text>
              ) : (
                botStats.map((row) => {
                  const botMeta = botRegistry.get(row.botId);
                  const name = botName(botMeta) || row.botId;
                  return (
                    <View key={row.botId} style={styles.botStatRow}>
                      <Image
                        source={{ uri: resolveAssetUrl(botMeta?.avatar) }}
                        style={styles.botStatAvatarImg}
                      />
                      <View style={styles.botStatBody}>
                        <Text style={styles.botStatName} numberOfLines={1}>{name}</Text>
                        <Text style={styles.botStatCounts}>
                          <Text style={styles.greenText}>{row.wins} {tr('winsLabel')}</Text>
                          {' · '}
                          <Text style={styles.redText}>{row.losses} {tr('lossesLabel')}</Text>
                          {row.draws > 0 ? (
                            <>
                              {' · '}
                              <Text style={styles.grayText}>{row.draws} {tr('drawsLabel')}</Text>
                            </>
                          ) : null}
                        </Text>
                        <Text style={styles.botStatMeta}>
                          {tr('totalWithLast', { count: row.gamesPlayed, date: formatProfileDate(row.lastPlayedAt) })}
                        </Text>
                      </View>
                    </View>
                  );
                })
              )}
            </SurfaceCard>

            {!IS_VK_ENTRY && (
              <TouchableOpacity style={styles.profileLogoutBtn} onPress={handleLogout}>
                <Text style={styles.profileLogoutBtnText}>{tr('logoutAccount')}</Text>
              </TouchableOpacity>
            )}
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
    // Три колонки по уровням — только на широких экранах; на телефоне сетка 2 колонки
    const isWeb = isWide;

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
        isWeb ? styles.botCardWeb : styles.botCardMobile,
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
                <Text style={styles.botName}>{botName(bot)}</Text>
                <Text style={styles.botAlgorithm}>{bot.tier ? tr(`diff_${bot.tier}`) : bot.difficultyLabel}</Text>
              </View>
            </View>
            <Text style={styles.botDescription} numberOfLines={isSelected ? 4 : 2}>
              {botDesc(bot)}
            </Text>
            {isSelected && bot.modelAuthor ? (
              <Text style={styles.botModelAuthor} numberOfLines={2}>
                {tr('modelBy', { author: bot.modelAuthor })}
              </Text>
            ) : null}
            {(() => {
              const stats = user?.botOpponentStats?.find((s) => s.botId === bot.id) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
              if (!stats.gamesPlayed && !isSelected) return null;
              return (
                <Text style={styles.botCardStatsLine}>
                  {tr('statsLine', { games: stats.gamesPlayed, wins: stats.wins, losses: stats.losses, draws: stats.draws })}
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
              <Text style={styles.botCardStartBtnText}>{tr('toBattle')}</Text>
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
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
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
                accessibilityLabel={tr('backToLobby')}
              >
                <Text style={styles.botSelectBackBtnText}>← {tr('back')}</Text>
              </TouchableOpacity>
              
              <View style={styles.botSelectTabs}>
                <TouchableOpacity
                  style={[styles.botSelectTab, botSelectTab === 'tournament' && styles.botSelectTabActive]}
                  onPress={() => setBotSelectTab('tournament')}
                >
                  <Text style={[styles.botSelectTabText, botSelectTab === 'tournament' && styles.botSelectTabTextActive]}>
                    {tr('towerTab')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.botSelectTab, botSelectTab === 'free' && styles.botSelectTabActive]}
                  onPress={() => setBotSelectTab('free')}
                >
                  <Text style={[styles.botSelectTabText, botSelectTab === 'free' && styles.botSelectTabTextActive]}>
                    {tr('freePlayTab')}
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
                      <Text style={styles.tournamentWinTitle}>{tr('congrats')}</Text>
                      <Text style={styles.tournamentWinSubtitle}>
                        {tr('towerComplete')}
                      </Text>
                      <TouchableOpacity
                        style={styles.tournamentResetBtn}
                        onPress={handleResetTournament}
                      >
                        <Text style={styles.tournamentResetBtnText}>{tr('restartTower')}</Text>
                      </TouchableOpacity>
                    </SurfaceCard>
                  ) : (
                    <View style={styles.tournamentIntro}>
                      <Text style={styles.tournamentIntroTitle}>{tr('towerIntroTitle')}</Text>
                      <Text style={styles.tournamentIntroSubtitle}>
                        {tr('towerIntroDesc', { stage: currentStage + 1, total: TOURNAMENT_LADDER.length })}
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
                            <Text style={styles.towerStepNumber}>{tr('stageN', { n: index + 1 })}</Text>
                          </View>
                          
                          <View style={styles.towerStepBotAvatarCol}>
                            <Image
                              source={{ uri: resolveAssetUrl(bot?.avatar) }}
                              style={styles.towerStepAvatar}
                            />
                          </View>

                          <View style={styles.towerStepInfoCol}>
                            <Text style={[styles.towerStepBotName, isLocked && styles.textMuted]}>
                              {botName(bot)}
                            </Text>
                            <Text style={styles.towerStepDifficulty}>
                              {isBeaten ? tr('beaten') : (bot?.tier ? tr(`diff_${bot.tier}`) : bot?.difficultyLabel)}
                            </Text>
                            {(() => {
                              const stats = user?.botOpponentStats?.find(s => s.botId === botId) || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
                              return (
                                <Text style={{ fontSize: 11, color: ui.textMuted, marginTop: 2 }}>
                                  {tr('statsLine', { games: stats.gamesPlayed, wins: stats.wins, losses: stats.losses, draws: stats.draws })}
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
                                <Text style={styles.towerChallengeBtnText}>{tr('fight')}</Text>
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
                      {tr('chooseOpponent')}
                    </Text>
                    <Text style={styles.sectionSubtitle}>
                      {tr('botsCountHint', { count: listBots.length })}
                    </Text>
                  </View>

                  <View style={[styles.botGrid, isWeb ? styles.botGridWebThreeCol : styles.botGridMobile, { gap: layout.gap }]}>
                    {isWeb ? (
                      <>
                        {renderBotColumn(tr('easyBots'), easyBots)}
                        {renderBotColumn(tr('mediumBots'), mediumBots)}
                        {renderBotColumn(tr('hardBots'), hardBots)}
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
      ? tr('setupFlag')
      : game.setupPhase === GAME_CONFIG.SETUP_PHASES.TRAP
        ? tr('setupTrap')
        : tr('setupDone');

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
      const label = ['rock', 'paper', 'scissors'].includes(type) ? tr(type) : pieceTypeLabel(type);
      let who;
      if (gameMode === 'pvp') {
        who = piece?.owner === 'p1'
          ? (game.p1?.nickname || tr('playerN', { n: 1 }))
          : (game.p2?.nickname || tr('playerN', { n: 2 }));
      } else {
        who = piece?.owner === PLAYER ? tr('you') : (botName(activeBot) || tr('bot'));
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
                  cellStyle.push(isDarkCell ? styles.cartoonDarkCell : styles.cartoonLightCell);
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
                        : (isPossibleMove || (isSetup && isSetupAllowed) ? 'pointer' : 'default'),
                      position: 'relative'
                    };
                    
                    if (typeof normalizedStyle.borderWidth === 'number') {
                      normalizedStyle.borderWidth = `${normalizedStyle.borderWidth}px`;
                    }

                    // Для октагональных ячеек форма и цвета рисуются декорацией,
                    // сам контейнер остаётся прозрачным
                    const isOctagon = skin.cellShape === 'octagon';
                    const octagonProps = isOctagon
                      ? {
                          backgroundColor: flatStyle.backgroundColor,
                          borderColor: flatStyle.borderColor,
                          borderWidth: flatStyle.borderWidth
                        }
                      : null;
                    if (isOctagon) {
                      normalizedStyle.backgroundColor = 'transparent';
                      normalizedStyle.borderColor = 'transparent';
                      normalizedStyle.boxShadow = 'none';
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
                        {skin.cellShape !== 'square' && (
                          <CellDecoration
                            skin={skin}
                            isDark={isDarkCell}
                            variant={(ar * 7 + ac * 3) % 4}
                            backgroundColor={octagonProps?.backgroundColor}
                            borderColor={octagonProps?.borderColor}
                            borderWidth={octagonProps?.borderWidth}
                          />
                        )}
                        {symbol && renderCartoonPiece(
                          isSetup ? (symbol === PIECE_SYMBOLS[FLAG] ? FLAG : TRAP) : (cell ? cell.type : FLAG),
                          cell ? cell.pieceType : null,
                          isEnemy,
                          isImmobilized,
                          isSetup ? true : (cell ? cell.revealed : false)
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
                      {skin.cellShape !== 'square' && (
                        <CellDecoration skin={skin} isDark={isDarkCell} variant={(ar * 7 + ac * 3) % 4} />
                      )}
                      {symbol && renderCartoonPiece(
                        isSetup ? (symbol === PIECE_SYMBOLS[FLAG] ? FLAG : TRAP) : (cell ? cell.type : FLAG),
                        cell ? cell.pieceType : null,
                        isEnemy,
                        isImmobilized,
                        isSetup ? true : (cell ? cell.revealed : false)
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

    const setupReady = game.setupPhase === GAME_CONFIG.SETUP_PHASES.DONE;
    const iconBtn = (emoji, label, onPress, variant = '', opts = {}) => (
      <TouchableOpacity
        style={[
          styles.iconBtn,
          variant === 'danger' && styles.iconBtnDanger,
          variant === 'accent' && styles.iconBtnAccent,
          variant === 'success' && styles.iconBtnSuccess,
          opts.active && styles.iconBtnActive,
          opts.disabled && styles.disabledBtn,
          opts.grow && styles.iconBtnGrow
        ]}
        disabled={!!opts.disabled}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Text style={styles.iconBtnEmoji}>{emoji}</Text>
        <Text
          style={[
            styles.iconBtnLabel,
            variant === 'danger' && styles.iconBtnLabelDanger,
            variant === 'accent' && styles.iconBtnLabelAccent,
            variant === 'success' && styles.iconBtnLabelSuccess
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </TouchableOpacity>
    );

    const controlsBlock = (
      <View style={styles.gameControls}>
        {(isSetup || isPlaying) && (
          <View style={styles.iconBtnRow}>
            {isSetup && iconBtn('🚪', tr('exit'), handleLeaveSetup, 'danger')}
            {isSetup && iconBtn('🔄', tr('reset'), handleResetSetup, 'accent')}
            {isSetup && iconBtn('⚔️', tr('startBattle'), handleStartBattle, 'success', {
              disabled: !setupReady,
              grow: true
            })}
            {isPlaying && iconBtn('🏳️', tr('surrender'), handleSurrender, 'danger')}
            {iconBtn('📜', tr('battleLog'), () => setLogOpen((v) => !v), '', { active: logOpen })}
            {iconBtn('⚙️', tr('settings'), () => setSettingsOpen(true))}
          </View>
        )}
        {isFinished && (
          <SurfaceCard style={styles.finishedCard}>
            <Text style={styles.finishedTitle}>
              {setupNotStarted
                ? `⏱️ ${tr('setupTimeout')}`
                : ((gameMode === 'pvp' ? game.winner === pvpRole : game.winner === PLAYER)
                    ? `🏆 ${tr('victory')}`
                    : game.winner === 'draw'
                      ? `🤝 ${tr('draw')}`
                      : `💀 ${tr('defeat')}`)}
            </Text>
            <Text style={styles.finishedBody}>
              {{
                setup_timeout: tr('setupTimeout'),
                flag_captured: tr('reasonFlagCaptured'),
                no_pieces: tr('reasonNoPieces'),
                hopeless: tr('reasonHopeless'),
                surrender: tr('reasonSurrender'),
                no_moves: tr('reasonNoMoves'),
                disconnect_timeout: tr('reasonDisconnectTimeout'),
                turn_timeout: tr('reasonTurnTimeout'),
                no_captures_draw: tr('reasonDrawNoCapture')
              }[game.endReason] || ''}
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
                <Text style={styles.rematchBtnText}>⚔️⏳ {tr('rematch')}</Text>
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
                {gameMode === 'pvp' ? tr('returnToArena') : (isTournamentActive ? tr('returnToTower') : tr('returnToLobby'))}
              </Text>
            </TouchableOpacity>
          </SurfaceCard>
        )}
      </View>
    );

    const logsBlock = (
      <SurfaceCard style={[styles.logsSection, { padding: layout.cardPad }]}>
        <View style={styles.logsHeader}>
          <Text style={styles.logsTitle}>{tr('battleLog')}</Text>
          {isPlaying && (
            <Text style={styles.logsDrawMeta}>
              {tr('drawMeta', { n: game.movesWithoutCapture || 0, limit: drawNoCaptureLimit })}
            </Text>
          )}
        </View>

        <ScrollView
          style={[styles.logsList, layout.mobile && styles.logsListMobile]}
          nestedScrollEnabled
        >
          {battleLogs.length === 0 ? (
            <Text style={styles.logLineMuted}>{tr('logsEmpty')}</Text>
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
        <StatusBar style={skin.statusBar === 'light' ? 'light' : 'dark'} />
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
                compactAlways
                name={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p1.nickname : game.p2.nickname) : (user?.nickname || tr('playerFallback'))}
                subtitle={isSetup ? setupStatus : (gameMode === 'pvp' ? (pvpRole === 'p1' ? (game.p1.setupDone ? tr('setupDone') : tr('thinking')) : (game.p2.setupDone ? tr('setupDone') : tr('thinking'))) : null)}
                compact={layout.compact}
                emoji="👤"
                avatarUrl={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p1.avatarUrl : game.p2.avatarUrl) : user?.avatarUrl}
                pieceCount={playerPieceCount}
                turnLabel={
                  isSetup
                    ? (gameMode === 'pvp' ? ((pvpRole === 'p1' ? game.p1.setupDone : game.p2.setupDone) ? tr('setupDone') : tr('thinking')) : `⏱ ${setupTimeLeft}s`)
                    : isFinished
                      ? (setupNotStarted
                        ? tr('setupTimeout')
                        : (game.winner === 'draw'
                            ? tr('draw')
                            : (game.winner === (gameMode === 'pvp' ? pvpRole : PLAYER) ? tr('victory') : tr('defeat'))))
                      : isPlayerTurn
                        ? tr('yourTurn')
                        : tr('waiting')
                }
                isTurnActive={isSetup || isPlayerTurn}
                fillPercent={isSetup ? setupFillPercent : turnFillPercent}
                urgent={(isSetup && setupTimerUrgent) || (isPlayerTurn && timerUrgent)}
              />
              <OpponentPanel
                army="red"
                compactAlways
                name={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p2.nickname : game.p1.nickname) : (botName(activeBot) || tr('bot'))}
                subtitle={gameMode === 'pvp' ? `${pvpRole === 'p1' ? game.p2.ratingMmr : game.p1.ratingMmr} MMR` : botDesc(activeBot)}
                emoji={gameMode === 'pvp' ? '👤' : activeBot?.emoji}
                avatarUrl={gameMode === 'pvp' ? (pvpRole === 'p1' ? game.p2.avatarUrl : game.p1.avatarUrl) : resolveAssetUrl(activeBot?.avatar)}
                compact={layout.compact}
                pieceCount={botPieceCount}
                turnLabel={
                  isSetup
                    ? (gameMode === 'pvp' ? ((pvpRole === 'p1' ? game.p2.setupDone : game.p1.setupDone) ? tr('setupDone') : tr('thinking')) : tr('waiting'))
                    : isFinished
                      ? (game.winner === 'draw'
                          ? tr('draw')
                          : (game.winner === (gameMode === 'pvp' ? (pvpRole === 'p1' ? 'p2' : 'p1') : COMPUTER) ? tr('victory') : tr('defeat')))
                      : isBotTurn
                        ? tr('opponentTurn')
                        : tr('waiting')
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
              {logOpen && (
                <View style={[styles.gameSidebar, isGameWide && styles.gameSidebarWide]}>
                  {logsBlock}
                </View>
              )}
            </View>
          </PageShell>
        </ScrollView>

        {battleBs ? (
        <Modal animationType="fade" transparent visible>
          <View style={[styles.modalOverlay, layout.mobile && styles.modalOverlayMobile]}>
            <View style={[styles.modalCard, layout.mobile && styles.modalCardMobile]}>
              <Text style={styles.modalTitle}>
                {tr('tieRound', { n: battleBs.drawRound || 1 })}
              </Text>
              <View style={styles.tieCountdownBadge}>
                <Text style={styles.tieCountdownNumber}>{tieAttemptsRemaining}</Text>
                <Text style={styles.tieCountdownLabel}>
                  {tr('tieAttemptsLeft', { n: tieAttemptsRemaining })}
                </Text>
              </View>

              {(() => {
                const att = describeBattlePiece(battleBs.attacker);
                const def = describeBattlePiece(battleBs.defender);
                return (
                  <View style={styles.tieCollisionBox}>
                    <Text style={styles.tieCollisionTitle}>{tr('collision')}</Text>
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
                  <Text style={styles.tieLastRoundTitle}>{tr('lastChoice')}</Text>
                  <Text style={styles.tieLastRoundText}>
                    {gameMode === 'pvp' && battleBs.lastRound.p1Choice && battleBs.lastRound.p2Choice
                      ? tr('tieAgainShort', {
                          a: PIECE_SYMBOLS[battleBs.lastRound.attackerChoice] || '?',
                          b: PIECE_SYMBOLS[battleBs.lastRound.defenderChoice] || '?'
                        })
                      : (battleBs.lastRound.playerChoice && battleBs.lastRound.opponentChoice
                          ? tr('youVsChoice', {
                              mine: PIECE_SYMBOLS[battleBs.lastRound.playerChoice],
                              opp: gameMode === 'pve' ? (botName(activeBot) || tr('bot')) : tr('opponent'),
                              theirs: PIECE_SYMBOLS[battleBs.lastRound.opponentChoice]
                            })
                          : null)}
                  </Text>
                  <Text style={styles.tieLastRoundHint}>{tr('chooseNewTypes')}</Text>
                </View>
              )}

              {tieLastChance && (
                <Text style={styles.tieLastChanceWarning}>
                  {tr('mutualDestructWarning')}
                </Text>
              )}

              {pvpWaitingOpponent ? (
                <View style={{ alignItems: 'center', padding: 16 }}>
                  <ActivityIndicator size="large" color={ui.accent} />
                  <Text style={[styles.modalSubtitle, { marginTop: 12, textAlign: 'center' }]}>
                    {tr('waitingOpponentChoice')}
                  </Text>
                </View>
              ) : (
                <>
                  <Text style={styles.modalSubtitle}>
                    {tr('chooseNewType')}
                  </Text>
                  <View style={[styles.choiceRow, layout.compact && styles.choiceRowStack]}>
                    {['rock', 'paper', 'scissors'].map((type) => (
                      <TouchableOpacity
                        key={type}
                        style={[styles.choiceBtn, layout.compact && styles.choiceBtnStack]}
                        onPress={() => handleChoiceClick(type)}
                        activeOpacity={0.85}
                      >
                        <View style={styles.choiceChipWrap}>
                          {skin.assets?.[type] ? (
                            <Image
                              source={skin.assets[type]}
                              style={styles.choiceImage}
                              resizeMode="contain"
                            />
                          ) : (
                            <Text style={styles.choiceEmoji}>{PIECE_SYMBOLS[type]}</Text>
                          )}
                        </View>
                        <Text style={styles.choiceText}>{tr(type)}</Text>
                      </TouchableOpacity>
                    ))}
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
              <Text style={styles.modalTitle}>{tr('surrenderTitle')}</Text>
              <Text style={styles.modalSubtitle}>
                {gameMode === 'pvp' ? tr('surrenderMmrBody') : tr('surrenderNoMmrBody')}
              </Text>
              <View style={styles.modalActionsRow}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={() => setSurrenderModalVisible(false)}
                >
                  <Text style={styles.modalCancelBtnText}>{tr('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalDangerBtn} onPress={confirmSurrender}>
                  <Text style={styles.modalDangerBtnText}>{tr('yesSurrender')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        <Modal animationType="fade" transparent visible={leaveSetupModalVisible}>
          <View style={[styles.modalOverlay, layout.mobile && styles.modalOverlayMobile]}>
            <View style={[styles.modalCard, layout.mobile && styles.modalCardMobile]}>
              <Text style={styles.modalTitle}>{tr('leaveSetupTitle')}</Text>
              <Text style={styles.modalSubtitle}>
                {tr('leaveSetupBody')}
              </Text>
              <View style={styles.modalActionsRow}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={() => setLeaveSetupModalVisible(false)}
                >
                  <Text style={styles.modalCancelBtnText}>{tr('stay')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalDangerBtn} onPress={confirmLeaveSetup}>
                  <Text style={styles.modalDangerBtnText}>{tr('exit')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
        {settingsModal}
      </SafeAreaView>
    );
  }

  return null;
}

function createStyles(skin) {
  const u = skin.ui;
  const hl = skin.highlights;
  return StyleSheet.create({
  container: {
    flex: 1,
  },
  flex1: {
    flex: 1,
  },
  appBg: {
    backgroundColor: u.bg,
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
    backgroundColor: u.surface,
    borderRadius: 16,
    padding: 20,
    marginBottom: LAYOUT.gap,
    borderWidth: 1,
    borderColor: u.surfaceBorder,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 4px 24px rgba(44, 30, 16, 0.06)' }
      : {
          shadowColor: u.textPrimary,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.06,
          shadowRadius: 12,
          elevation: 3,
        }),
  },
  surfaceCardAccent: {
    backgroundColor: u.accentSoftBg,
    borderColor: u.surfaceBorder,
  },
  loadingCard: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    color: u.accentText,
    marginTop: 16,
    fontSize: 15,
    fontWeight: '600',
  },
  // --- Splash / Loading screen ---
  brandBg: {
    backgroundColor: BRAND_BG,
  },
  splashWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: BRAND_BG,
  },
  splashLogoImg: {
    width: 250,
    height: 275,
  },
  splashBarTrack: {
    marginTop: 30,
    width: 240,
    maxWidth: '80%',
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(124, 45, 18, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(124, 45, 18, 0.25)',
    overflow: 'hidden',
  },
  splashBarFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: 5,
    backgroundColor: '#f59e0b',
  },
  splashCaption: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '700',
    color: '#8a6a4a',
  },
  // --- Auth screen ---
  authScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 24,
  },
  authHero: {
    alignItems: 'center',
    marginBottom: 14,
  },
  authLogo: {
    width: 180,
    height: 198,
  },
  authArtFrame: {
    borderRadius: 24,
    overflow: 'hidden',
    marginBottom: 16,
    borderWidth: 3,
    borderColor: 'rgba(124, 45, 18, 0.25)',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 14px 40px rgba(124, 45, 18, 0.25)' }
      : {
          shadowColor: '#7c2d12',
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: 0.25,
          shadowRadius: 20,
          elevation: 8,
        }),
  },
  authArtImg: {
    width: '100%',
    height: 190,
  },
  authCard: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 28,
    borderRadius: 24,
  },
  authCardCompact: {
    paddingVertical: 26,
    paddingHorizontal: 18,
  },
  authCardTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#1c1917',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    color: '#6b5744', // Dark brownish grey
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 22,
  },
  loginBtn: {
    alignSelf: 'stretch',
    backgroundColor: '#ea580c',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 8,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 6px 18px rgba(234, 88, 12, 0.35)' }
      : {
          shadowColor: '#ea580c',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.3,
          shadowRadius: 12,
          elevation: 6,
        }),
  },
  loginBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  loginBtnGuest: {
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#ea580c',
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  loginBtnGuestPrimary: {
    backgroundColor: '#ea580c',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 6px 18px rgba(234, 88, 12, 0.35)' }
      : {
          shadowColor: '#ea580c',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.3,
          shadowRadius: 12,
          elevation: 6,
        }),
  },
  loginBtnGuestText: {
    color: '#c2410c',
    fontSize: 16,
    fontWeight: '800',
  },
  loginBtnGuestTextPrimary: {
    color: '#fff',
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
  profileBarCard: {
    marginBottom: LAYOUT.gap,
    overflow: 'hidden',
  },
  profileTapRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileTapHint: {
    color: u.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  profileChevron: {
    color: u.textMuted,
    fontSize: 14,
    marginLeft: 8,
    flexShrink: 0,
  },
  profileMenu: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: u.divider,
    gap: 8,
  },
  profileMenuItem: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: u.surfaceAlt,
  },
  profileMenuItemText: {
    color: u.textPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
  profileMenuItemDanger: {
    backgroundColor: u.dangerSoftBg,
  },
  profileMenuItemDangerText: {
    color: u.danger,
    fontWeight: '700',
    fontSize: 15,
  },
  profileScreenTopBar: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: u.divider,
    backgroundColor: u.surfaceTranslucent,
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
    color: u.accentBright,
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
    color: u.textPrimary,
    marginBottom: 6,
  },
  profileHeroMeta: {
    fontSize: 13,
    color: u.textSecondary,
    lineHeight: 20,
  },
  profileSectionHint: {
    fontSize: 13,
    color: u.textMuted,
    marginBottom: 14,
  },
  profileEmptyBots: {
    fontSize: 14,
    color: u.textMuted,
    lineHeight: 21,
    fontStyle: 'italic',
  },
  botStatRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: u.surfaceAltBorder,
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
    color: u.textPrimary,
    marginBottom: 4,
  },
  botStatCounts: {
    fontSize: 14,
    lineHeight: 20,
  },
  botStatMeta: {
    fontSize: 12,
    color: u.textMuted,
    marginTop: 4,
  },
  profileLogoutBtn: {
    backgroundColor: u.danger,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  profileLogoutBtnText: {
    color: u.onAccent,
    fontWeight: '800',
    fontSize: 15,
  },
  lobbyLogoutBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: u.dangerSoftBg,
    borderWidth: 1,
    borderColor: u.danger,
    alignSelf: 'center',
  },
  lobbyLogoutBtnText: {
    color: u.danger,
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
    color: u.textPrimary,
    marginBottom: 4,
  },
  sectionTitleCompact: {
    fontSize: 19,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: u.textMuted,
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
    backgroundColor: u.surface,
    borderWidth: 1,
    borderColor: u.divider,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  avatarLetter: {
    color: u.accentBright,
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
    color: u.textPrimary, // Dark brown
    fontSize: 18,
    fontWeight: 'bold',
  },
  roleText: {
    color: u.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  logoutBtn: {
    flexShrink: 0,
    borderColor: u.danger,
    borderWidth: 1.5,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  logoutText: {
    color: u.danger,
    fontWeight: 'bold',
    fontSize: 13,
  },
  cardTitle: {
    color: u.title, // Gold title
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
    color: u.accentBright,
    fontSize: 48,
    fontWeight: '800',
    marginRight: 10,
  },
  ratingValueCompact: {
    fontSize: 36,
  },
  ratingLabel: {
    color: u.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  },
  statsDivider: {
    height: 1,
    backgroundColor: u.divider,
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
    color: u.textPrimary,
  },
  gridLabel: {
    color: u.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  greenText: { color: u.success },
  redText: { color: u.danger },
  grayText: { color: u.textMuted },
  yellowText: { color: u.accentBright },
  actionBtn: {
    backgroundColor: u.accent,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  disabledBtn: {
    backgroundColor: u.surfaceAlt,
    opacity: 0.6,
  },
  disabledText: {
    color: u.textMuted,
  },
  primaryBtnOutline: {
    backgroundColor: 'transparent',
    borderColor: u.accent,
    borderWidth: 2,
  },
  primaryBtnOutlineText: {
    color: u.accent,
    fontWeight: '700',
    fontSize: 16,
  },
  actionBtnText: {
    color: u.onAccent,
    fontWeight: '700',
    fontSize: 16,
  },
  // --- Lobby mode tiles ---
  modeTileHero: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: u.heroBg,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: u.heroBorder,
    paddingVertical: 18,
    paddingHorizontal: 18,
    marginBottom: 12,
    gap: 14,
    ...u.cardGlow,
  },
  modeTileBody: {
    flex: 1,
  },
  modeTileHeroTitle: {
    color: u.onAccent,
    fontSize: 18,
    fontWeight: '900',
  },
  modeTileHeroDesc: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  modeTileChevron: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 28,
    fontWeight: '700',
  },
  modeTileRow: {
    flexDirection: 'row',
    gap: 12,
  },
  modeTile: {
    flex: 1,
    backgroundColor: u.surface,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: u.surfaceBorder,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  modeTileEmoji: {
    fontSize: 30,
  },
  modeTileTitle: {
    marginTop: 6,
    color: u.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  modeTileDesc: {
    marginTop: 2,
    color: u.textMuted,
    fontSize: 11.5,
    fontWeight: '600',
    textAlign: 'center',
  },
  infoTitle: {
    color: u.title,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  infoBody: {
    color: u.textSecondary,
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
    backgroundColor: u.accentSoftBg,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: u.surfaceBorder,
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
    color: u.textPrimary,
    fontSize: 14,
    textAlign: 'center',
  },
  quickOpponentMeta: {
    color: u.textSecondary,
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  quickOpponentGames: {
    color: u.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  quickOpponentPlay: {
    marginTop: 8,
    color: u.accent,
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
    backgroundColor: u.accentSoftBg,
    borderWidth: 1,
    borderColor: u.surfaceBorder,
  },
  tieCountdownNumber: {
    fontSize: 36,
    fontWeight: '900',
    color: u.accent,
    lineHeight: 40,
  },
  tieCountdownLabel: {
    fontSize: 12,
    color: u.textSecondary,
    textAlign: 'center',
    marginTop: 2,
  },
  tieCollisionBox: {
    backgroundColor: u.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: u.divider,
  },
  tieCollisionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: u.textSecondary,
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
    color: u.textPrimary,
    flexShrink: 1,
  },
  tieCollisionVs: {
    fontSize: 18,
    color: u.textMuted,
  },
  tieLastRoundBox: {
    backgroundColor: u.surfaceAlt,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  tieLastRoundTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: u.textSecondary,
    marginBottom: 4,
  },
  tieLastRoundText: {
    fontSize: 14,
    color: u.textPrimary,
    fontWeight: '600',
  },
  tieLastRoundHint: {
    fontSize: 11,
    color: u.textMuted,
    marginTop: 4,
  },
  tieLastChanceWarning: {
    fontSize: 12,
    color: u.danger,
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
    color: u.textSecondary,
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
    backgroundColor: u.surface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1.5,
    borderColor: u.surfaceAltBorder,
    marginBottom: 0,
  },
  botCardWeb: {
    width: '100%',
    marginBottom: 0,
  },
  botCardMobile: {
    width: '48%',
  },
  botGridMobile: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  botCardStatsLine: {
    fontSize: 10,
    color: u.title,
    fontWeight: '700',
    marginTop: 4,
  },
  botCardWide: {
    width: '48%',
    maxWidth: 480,
  },
  botCardAvatar: {
    width: 34,
    height: 34,
    borderRadius: 9,
    marginRight: 8,
    backgroundColor: u.surfaceAlt,
  },
  botModelAuthor: {
    fontSize: 11,
    color: u.textMuted,
    marginTop: 6,
    fontStyle: 'italic',
  },
  botStatAvatarImg: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginRight: 12,
    backgroundColor: u.surfaceAlt,
  },
  botCardFullWidth: {
    width: '100%',
  },
  botCardSelected: {
    borderWidth: 2.5,
    borderColor: u.accent,
  },
  botCardBody: {
    width: '100%',
  },
  botCardStartBtn: {
    marginTop: 10,
    backgroundColor: u.accent,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  botCardStartBtnText: {
    color: u.onAccent,
    fontWeight: '800',
    fontSize: 13,
  },
  botSelectTopBar: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: u.divider,
    backgroundColor: u.surfaceTranslucent,
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
    backgroundColor: u.surfaceAlt,
  },
  botSelectBackBtnText: {
    color: u.textSecondary,
    fontWeight: '700',
    fontSize: 15,
  },
  stickyFooter: {
    borderTopWidth: 1,
    borderTopColor: u.divider,
    backgroundColor: u.surfaceTranslucent,
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
    color: u.textPrimary,
    fontSize: 14,
    fontWeight: 'bold',
  },
  botAlgorithm: {
    color: u.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  tierTag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tierEasy: { backgroundColor: u.successSoftBg },
  tierMedium: { backgroundColor: u.warningSoftBg },
  tierHard: { backgroundColor: u.dangerSoftBg },
  tierText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: u.textPrimary,
  },
  botDescription: {
    color: u.textSecondary,
    fontSize: 12,
    lineHeight: 16,
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
    backgroundColor: u.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 6,
  },
  tagText: {
    color: u.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  backBtn: {
    flex: 1,
    maxWidth: 140,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: u.surfaceAlt,
    marginRight: 12,
  },
  backBtnText: {
    color: u.textSecondary,
    fontWeight: 'bold',
    fontSize: 16,
  },
  startBtn: {
    flex: 2,
    backgroundColor: u.accent,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
  },
  startBtnText: {
    color: u.onAccent,
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
    backgroundColor: u.surface,
    position: 'relative',
  },
  panelBlue: {
    borderColor: u.blueSoft,
  },
  panelRed: {
    borderColor: u.redSoft,
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
    borderColor: u.blueSide,
  },
  panelUrgentRed: {
    borderColor: u.redSide,
  },
  turnFillBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 0,
  },
  turnFillBlue: {
    backgroundColor: u.blueSoft,
  },
  turnFillRed: {
    backgroundColor: u.redSoft,
  },
  drawCountdown: {
    marginBottom: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: u.surfaceAlt,
    borderWidth: 2,
    borderColor: u.purple,
    shadowColor: u.purple,
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
    borderColor: u.danger,
    backgroundColor: u.dangerSoftBg,
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
    color: u.textSecondary,
  },
  drawCountdownTitleCompact: {
    fontSize: 12,
  },
  drawCountdownMeta: {
    fontSize: 13,
    fontWeight: '700',
    color: u.textPrimary,
  },
  drawCountdownMetaDanger: {
    color: u.danger,
  },
  drawCountdownTrack: {
    width: '100%',
    height: 10,
    borderRadius: 999,
    backgroundColor: u.divider,
    overflow: 'hidden',
  },
  drawCountdownFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: u.success,
  },
  drawCountdownFillWarn: {
    backgroundColor: u.warning,
  },
  drawCountdownFillDanger: {
    backgroundColor: '#ef4444',
  },
  drawCountdownHint: {
    marginTop: 8,
    fontSize: 12,
    color: u.title,
    fontWeight: '500',
  },
  drawCountdownHintDanger: {
    color: u.danger,
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
    backgroundColor: u.dangerSoftBg,
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
    color: u.textPrimary,
  },
  panelNameCompact: {
    fontSize: 13,
  },
  panelSubtitle: {
    fontSize: 11,
    color: u.textMuted,
    marginTop: 2,
  },
  panelSubtitleCompact: {
    fontSize: 10,
  },
  panelMeta: {
    fontSize: 12,
    color: u.textSecondary,
    marginTop: 4,
  },
  panelMetaCompact: {
    fontSize: 11,
    marginTop: 2,
  },
  panelTurnLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: u.textMuted,
    marginTop: 4,
  },
  panelTurnLabelCompact: {
    fontSize: 12,
    marginTop: 2,
  },
  panelTurnLabelActive: {
    color: u.textPrimary,
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
    borderRadius: 12,
    padding: 8,
    gap: 3,
    ...skin.boardFrame,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    gap: 3,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: skin.cellShape === 'octagon' ? 2 : 5,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  setupZoneLight: {
    backgroundColor: hl.setupZoneBg,
    borderColor: hl.setupZoneBorder,
    borderWidth: 2,
  },
  setupZoneDark: {
    backgroundColor: hl.setupZoneBg,
    borderColor: hl.setupZoneBorder,
    borderWidth: 2,
  },
  setupZoneHover: {
    backgroundColor: hl.setupHoverBg,
    borderColor: hl.setupHoverBorder,
    ...(Platform.OS === 'web'
      ? { boxShadow: `0 0 12px ${hl.setupHoverBorder}` }
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
    borderColor: hl.selectedBorder,
    borderWidth: 2,
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 10px ${hl.selectedBorder}` } : {}),
  },
  possibleMoveCell: {
    borderColor: hl.possibleBorder,
    backgroundColor: hl.possibleBg,
  },
  validMoveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: hl.dot,
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 8px ${hl.dot}` } : {}),
  },
  
  gameControls: {
    marginBottom: LAYOUT.gap,
  },
  iconBtnRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: 10,
    flexWrap: 'wrap',
  },
  iconBtn: {
    minWidth: 66,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: u.surfaceAlt,
    borderColor: u.surfaceAltBorder,
  },
  iconBtnGrow: {
    flexGrow: 1,
    maxWidth: 220,
  },
  iconBtnActive: {
    borderColor: u.accentBright,
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 10px ${u.accentSoftBg}` } : {}),
  },
  iconBtnEmoji: {
    fontSize: 22,
    lineHeight: 26,
  },
  iconBtnLabel: {
    fontSize: 10,
    fontWeight: '800',
    marginTop: 2,
    color: u.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  iconBtnDanger: {
    backgroundColor: u.dangerSoftBg,
    borderColor: u.danger,
  },
  iconBtnLabelDanger: {
    color: u.danger,
  },
  iconBtnAccent: {
    backgroundColor: u.accentSoftBg,
    borderColor: u.accent,
  },
  iconBtnLabelAccent: {
    color: u.accentText,
  },
  iconBtnSuccess: {
    backgroundColor: u.successSoftBg,
    borderColor: u.success,
  },
  iconBtnLabelSuccess: {
    color: u.success,
  },
  setupControls: {
    gap: 10,
  },
  setupLeaveBtn: {
    backgroundColor: u.surfaceAlt,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: u.inputBorder,
  },
  setupLeaveBtnText: {
    color: u.textSecondary,
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
    backgroundColor: u.surfaceAlt,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    minWidth: 108,
  },
  setupResetBtnText: {
    color: u.textSecondary,
    fontWeight: 'bold',
    fontSize: 15,
  },
  setupStartBtn: {
    flex: 1,
    flexGrow: 1,
    minWidth: 0,
    backgroundColor: u.success,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  setupStartBtnText: {
    color: u.onAccent,
    fontWeight: 'bold',
    fontSize: 15,
    textAlign: 'center',
  },
  surrenderBtn: {
    backgroundColor: u.danger,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
  },
  surrenderBtnText: {
    color: u.onAccent,
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
    color: u.textPrimary,
    marginBottom: 8,
  },
  finishedBody: {
    color: u.textSecondary,
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
    backgroundColor: u.success,
    alignItems: 'center',
    alignSelf: 'stretch'
  },
  rematchBtnText: {
    color: u.onAccent,
    fontWeight: '800',
    fontSize: 15
  },
  lobbyReturnBtn: {
    backgroundColor: u.accent,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  lobbyReturnBtnText: {
    color: u.onAccent,
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
    color: u.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  logsDrawMeta: {
    fontSize: 12,
    fontWeight: '700',
    color: u.purple,
  },
  logsList: {
    maxHeight: Platform.OS === 'web' ? 420 : 260,
  },
  logsListMobile: {
    maxHeight: 200,
  },
  logLine: {
    color: u.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 6,
  },
  logLineMuted: {
    color: u.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  
  // Modal choice for Tie-Breaker
  modalOverlay: {
    flex: 1,
    backgroundColor: u.overlay,
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
    backgroundColor: u.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: u.accentBright,
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
    color: u.accentBright,
    marginBottom: 8,
  },
  modalSubtitle: {
    color: u.textSecondary,
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
    gap: 10,
  },
  choiceBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: u.surfaceAlt,
    borderWidth: 1.5,
    borderColor: u.surfaceBorder,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  choiceBtnStack: {
    flex: 0,
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: 14,
    paddingVertical: 8,
    paddingHorizontal: 14,
    width: '100%',
  },
  choiceChipWrap: {
    width: 46,
    height: 46,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(127, 127, 127, 0.12)',
    flexShrink: 0,
  },
  choiceEmoji: {
    fontSize: 30,
  },
  choiceImage: {
    width: 40,
    height: 40,
  },
  choiceText: {
    color: u.textPrimary,
    fontSize: 13,
    fontWeight: 'bold',
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
    backgroundColor: u.surfaceAlt,
    alignItems: 'center',
  },
  modalCancelBtnText: {
    color: u.textSecondary,
    fontWeight: '700',
    fontSize: 15,
  },
  modalDangerBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: u.danger,
    alignItems: 'center',
  },
  modalDangerBtnText: {
    color: u.onAccent,
    fontWeight: '700',
    fontSize: 15,
  },
  settingsCard: {
    maxWidth: 440,
    alignItems: 'stretch',
  },
  settingsScroll: {
    alignSelf: 'stretch',
    maxHeight: 440,
  },
  settingsSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: u.title,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 16,
    marginBottom: 10,
  },
  skinRow: {
    flexDirection: 'row',
    gap: 8,
  },
  skinOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1.5,
    backgroundColor: u.surfaceAlt,
    borderColor: u.surfaceAltBorder,
  },
  skinOptionActive: {
    borderColor: u.accentBright,
    backgroundColor: u.accentSoftBg,
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 12px ${u.accentSoftBg}` } : {}),
  },
  skinOptionIcon: {
    fontSize: 26,
  },
  skinOptionLabel: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '700',
    color: u.textSecondary,
    textAlign: 'center',
  },
  skinOptionLabelActive: {
    color: u.textPrimary,
  },
  langGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  langChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: u.surfaceAlt,
    borderColor: u.surfaceAltBorder,
  },
  langChipActive: {
    borderColor: u.accentBright,
    backgroundColor: u.accentSoftBg,
  },
  langChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: u.textSecondary,
  },
  langChipTextActive: {
    color: u.textPrimary,
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: u.divider,
  },
  audioRowLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: u.textPrimary,
  },
  togglePill: {
    width: 46,
    height: 26,
    borderRadius: 13,
    backgroundColor: u.surfaceAlt,
    borderWidth: 1.5,
    borderColor: u.surfaceAltBorder,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  togglePillOn: {
    backgroundColor: u.accentSoftBg,
    borderColor: u.accentBright,
  },
  toggleKnob: {
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: u.textMuted,
    alignSelf: 'flex-start',
  },
  toggleKnobOn: {
    backgroundColor: u.accentBright,
    alignSelf: 'flex-end',
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 8px ${u.accentBright}` } : {}),
  },
  settingsCloseBtn: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: u.accentSoftBg,
    borderWidth: 1.5,
    borderColor: u.accent,
  },
  settingsCloseBtnText: {
    color: u.accentText,
    fontWeight: '800',
    fontSize: 15,
  },
  headerIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: u.surfaceAlt,
    borderWidth: 1.5,
    borderColor: u.surfaceAltBorder,
  },
  headerIconBtnText: {
    fontSize: 18,
  },
  lastMoveFromCell: {
    backgroundColor: hl.lastFromBg,
    borderColor: hl.lastFromBorder,
    borderWidth: 1.5,
  },
  lastMoveToCell: {
    backgroundColor: hl.lastToBg,
    borderColor: hl.lastToBorder,
    borderWidth: 2,
  },
  arenaStatRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14
  },
  arenaStatPill: {
    backgroundColor: u.surface,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: u.divider,
    alignItems: 'center',
    minWidth: 88
  },
  arenaStatPillValue: {
    fontSize: 20,
    fontWeight: '800',
    color: u.accent
  },
  arenaStatPillLabel: {
    fontSize: 11,
    color: u.textSecondary,
    marginTop: 2,
    fontWeight: '600'
  },
  arenaStatusCard: {
    alignItems: 'center'
  },
  arenaStatusText: {
    color: u.textPrimary,
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
    color: u.accent,
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
    backgroundColor: u.surface,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: u.surfaceBorder
  },
  arenaModeTileHero: {
    backgroundColor: u.accentSoftBg,
    borderColor: u.accentBright,
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
    color: u.textPrimary,
    textAlign: 'center'
  },
  arenaModeDesc: {
    fontSize: 12,
    color: u.textSecondary,
    marginTop: 4,
    textAlign: 'center'
  },
  // Плитки-ссылки «Приватная (по коду)» / «Открытая (в списке)»: горизонтальная
  // раскладка, подпись одной строкой — надписи выровнены по вертикали
  arenaModeNavTile: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: u.surface,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: u.surfaceBorder,
    gap: 10
  },
  arenaModeNavEmoji: {
    fontSize: 22
  },
  arenaModeNavTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    color: u.textPrimary
  },
  arenaModeNavChevron: {
    fontSize: 22,
    lineHeight: 24,
    color: u.textSecondary,
    fontWeight: '600'
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
    color: u.textPrimary
  },
  arenaWaitingDesc: {
    fontSize: 13,
    color: u.textSecondary,
    marginTop: 4,
    lineHeight: 18
  },
  arenaWaitingCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: u.inputBorder,
    flexShrink: 0
  },
  arenaWaitingCancelText: {
    color: u.textSecondary,
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
    borderColor: u.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: u.inputBg,
    color: u.inputText,
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
    backgroundColor: u.accent,
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
    color: u.onAccent,
    fontWeight: '700',
    fontSize: 15
  },
  arenaEmptyBox: {
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: u.surface,
    alignItems: 'center'
  },
  arenaEmptyText: {
    color: u.textMuted,
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
    backgroundColor: u.surface,
    borderWidth: 1,
    borderColor: u.surfaceAltBorder
  },
  arenaRoomCardInfo: {
    flex: 1,
    minWidth: 0
  },
  arenaRoomName: {
    fontSize: 15,
    color: u.textPrimary,
    fontWeight: '700'
  },
  arenaRoomMeta: {
    fontSize: 12,
    color: u.textSecondary,
    marginTop: 2
  },
  arenaJoinBtn: {
    backgroundColor: u.success,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    flexShrink: 0
  },
  arenaJoinBtnText: {
    color: u.onAccent,
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
    backgroundColor: u.surface,
    borderWidth: 1,
    borderColor: u.surfaceAltBorder
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
    color: u.textPrimary
  },
  arenaPlayerRating: {
    fontSize: 12,
    color: u.textSecondary,
    marginTop: 2
  },
  arenaBusyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: u.surfaceAlt
  },
  arenaBusyLabel: {
    fontSize: 12,
    color: u.textMuted,
    fontWeight: '600'
  },
  arenaChallengeBtn: {
    backgroundColor: u.accent,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    flexShrink: 0
  },
  arenaChallengeBtnText: {
    color: u.onAccent,
    fontWeight: '700',
    fontSize: 13
  },
  
  // --- Tournament (Challenge Tower) Styles ---
  tournamentBtn: {
    backgroundColor: u.accent,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  tournamentBtnText: {
    color: u.onAccent,
    fontWeight: '800',
    fontSize: 16,
  },
  tournamentHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: u.textPrimary,
    marginLeft: 12,
  },
  tournamentWinCard: {
    padding: 24,
    alignItems: 'center',
    backgroundColor: u.warningSoftBg,
    borderColor: u.warning,
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
    color: u.title,
    marginBottom: 8,
  },
  tournamentWinSubtitle: {
    fontSize: 14,
    color: u.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  tournamentResetBtn: {
    backgroundColor: u.accent,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  tournamentResetBtnText: {
    color: u.onAccent,
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
    color: u.textPrimary,
    marginBottom: 4,
  },
  tournamentIntroSubtitle: {
    fontSize: 13,
    color: u.textSecondary,
  },
  towerLadderContainer: {
    gap: 12,
    paddingHorizontal: 4,
  },
  towerStep: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: u.surface,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: u.surfaceAltBorder,
  },
  towerStepCurrent: {
    borderColor: u.accent,
    backgroundColor: u.accentSoftBg,
    shadowColor: u.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  towerStepBeaten: {
    backgroundColor: u.successSoftBg,
    borderColor: u.success,
  },
  towerStepLocked: {
    opacity: 0.6,
    backgroundColor: u.surfaceAlt,
    borderColor: u.surfaceAltBorder,
  },
  towerStepNumberCol: {
    width: 65,
  },
  towerStepNumber: {
    fontSize: 12,
    fontWeight: '800',
    color: u.title,
    textTransform: 'uppercase',
  },
  towerStepBotAvatarCol: {
    marginRight: 12,
  },
  towerStepAvatar: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: u.surfaceAlt,
  },
  towerStepAvatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  towerStepAvatarLocked: {
    backgroundColor: u.surfaceAlt,
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
    color: u.textPrimary,
  },
  towerStepDifficulty: {
    fontSize: 12,
    color: u.textSecondary,
    marginTop: 2,
  },
  towerStepActionCol: {
    width: 70,
    alignItems: 'flex-end',
  },
  beatenBadge: {
    backgroundColor: u.success,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  beatenBadgeText: {
    color: u.onAccent,
    fontWeight: '800',
    fontSize: 14,
  },
  towerChallengeBtn: {
    backgroundColor: u.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  towerChallengeBtnText: {
    color: u.onAccent,
    fontWeight: '700',
    fontSize: 13,
  },
  towerLockedLabel: {
    fontSize: 16,
  },
  textMuted: {
    color: u.textMuted,
  },
  
  // --- Bot Select Segmented Tabs ---
  botSelectTabs: {
    flexDirection: 'row',
    backgroundColor: u.surfaceAlt,
    borderRadius: 8,
    padding: 3,
  },
  botSelectTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  botSelectTabActive: {
    backgroundColor: u.surface,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  botSelectTabText: {
    fontSize: 12,
    fontWeight: '700',
    color: u.textSecondary,
  },
  botSelectTabTextActive: {
    color: u.accent,
  },
  // Bot card difficulty styles
  botCardEasy: {
    backgroundColor: u.successSoftBg,
    borderColor: u.success,
  },
  botCardMedium: {
    backgroundColor: u.warningSoftBg,
    borderColor: u.warning,
  },
  botCardHard: {
    backgroundColor: u.dangerSoftBg,
    borderColor: u.danger,
  },

  // Board cartoon/animated skin cells
  cartoonLightCell: {
    ...skin.cells.light,
  },
  cartoonDarkCell: {
    ...skin.cells.dark,
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
    borderColor: u.danger, // Darker red border for enemy
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
    color: u.onAccent,
    fontSize: 9,
    fontWeight: '900',
  }
});
}
