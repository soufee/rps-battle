import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import io from 'socket.io-client';

const COLORS = {
  bg: '#09090b',
  bgMid: '#1a103c',
  panel: 'rgba(20, 20, 30, 0.85)',
  panelBorder: 'rgba(255, 255, 255, 0.08)',
  text: '#e2e8f0',
  muted: '#94a3b8',
  dim: '#64748b',
  white: '#ffffff',
  cyan: '#00f0ff',
  cyanDim: 'rgba(0, 240, 255, 0.12)',
  purple: '#b026ff',
  purpleDim: 'rgba(176, 38, 255, 0.15)',
  emerald: '#34d399',
  red: '#f87171',
  amber: '#fbbf24',
  white05: 'rgba(255,255,255,0.05)',
  white10: 'rgba(255,255,255,0.10)',
  white20: 'rgba(255,255,255,0.20)',
};

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8];

const REASON_RU = {
  flag_captured: 'захват флага',
  no_pieces: 'все фигуры уничтожены',
  hopeless: 'безнадежная позиция',
  surrender: 'сдача',
  no_moves: 'нет доступных ходов',
};

function getBackendUrl(baseUrl) {
  if (baseUrl) return baseUrl.replace(/\/$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    return window.location.origin;
  }
  return 'https://rps-battles.com';
}

function matchOutcomeLabel(m) {
  if (m.winner === 'top') return { text: m.topBotName, color: COLORS.emerald };
  if (m.winner === 'bottom') return { text: m.bottomBotName, color: COLORS.emerald };
  return { text: 'Ничья', color: COLORS.amber };
}

function formatDateRu(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ru-RU');
  } catch {
    return String(value);
  }
}

/**
 * Admin Bot Championship dashboard — runs inside Expo/RN client (port 8081 in dev).
 */
export default function BotChampionshipDashboard({ token, baseUrl, onBack }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 960;
  const backendUrl = useMemo(() => getBackendUrl(baseUrl), [baseUrl]);

  const [bots, setBots] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [currentScheduleFile, setCurrentScheduleFile] = useState(null);
  const [standings, setStandings] = useState([]);
  const [tournamentName, setTournamentName] = useState(null);
  const [recentMatches, setRecentMatches] = useState([]);
  const [archives, setArchives] = useState([]);
  const [isActive, setIsActive] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, activeMatches: [] });
  const [socketConnected, setSocketConnected] = useState(false);
  const [statusText, setStatusText] = useState('Готов к запуску');
  const [statusTone, setStatusTone] = useState('ready'); // ready | running | finished | error
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Options
  const [optDouble, setOptDouble] = useState(true);
  const [optHeaded, setOptHeaded] = useState(false);
  const [optAccelerate, setOptAccelerate] = useState(true);
  const [concurrency, setConcurrency] = useState(1);

  // Modal
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalKind, setModalKind] = useState(null); // 'match' | 'archive'
  const [modalMatch, setModalMatch] = useState(null);
  const [modalArchive, setModalArchive] = useState(null);
  const [modalArchiveId, setModalArchiveId] = useState(null);
  const [modalLoading, setModalLoading] = useState(false);

  const socketRef = useRef(null);
  const pollRef = useRef(null);
  const statusResetRef = useRef(null);

  const authFetch = useCallback(
    async (path, options = {}) => {
      const headers = { ...(options.headers || {}) };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`${backendUrl}${path}`, { ...options, headers });
      return res;
    },
    [backendUrl, token]
  );

  const updateLiveUI = useCallback((payload) => {
    const p = payload?.progress || payload;
    if (p && typeof p.completed === 'number') {
      setIsActive(true);
      setProgress({
        completed: p.completed || 0,
        total: p.total || 0,
        activeMatches: p.activeMatches || [],
      });
      setStatusText('Чемпионат идет');
      setStatusTone('running');
    }
    if (payload?.standings?.standings) {
      setStandings(payload.standings.standings);
    }
  }, []);

  const refreshStandings = useCallback(async () => {
    try {
      const res = await authFetch('/botchamp/api/standings');
      if (!res.ok) return;
      const data = await res.json();
      setStandings(data.standings || []);
      setTournamentName(data.tournamentName || null);
    } catch (e) {
      /* ignore */
    }
  }, [authFetch]);

  const loadRecentMatches = useCallback(async () => {
    try {
      const res = await authFetch('/botchamp/api/results');
      if (!res.ok) return;
      const matches = await res.json();
      setRecentMatches(Array.isArray(matches) ? matches : []);
    } catch (e) {
      /* ignore */
    }
  }, [authFetch]);

  const loadArchives = useCallback(async () => {
    try {
      const res = await authFetch('/botchamp/api/archives');
      if (!res.ok) return;
      const list = await res.json();
      setArchives(Array.isArray(list) ? list : []);
    } catch (e) {
      /* ignore */
    }
  }, [authFetch]);

  const handleTournamentEnd = useCallback(() => {
    setIsActive(false);
    setProgress({ completed: 0, total: 0, activeMatches: [] });
    setStatusText('Чемпионат завершен!');
    setStatusTone('finished');
    refreshStandings();
    loadRecentMatches();
    loadArchives();
    if (statusResetRef.current) clearTimeout(statusResetRef.current);
    statusResetRef.current = setTimeout(() => {
      setStatusText('Готов к запуску');
      setStatusTone('ready');
    }, 5000);
  }, [refreshStandings, loadRecentMatches, loadArchives]);

  // Initial load + socket + poll
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      setErrorMsg(null);
      try {
        const [botsRes, schedulesRes] = await Promise.all([
          authFetch('/botchamp/api/bots'),
          authFetch('/botchamp/api/schedules'),
        ]);
        if (cancelled) return;
        if (botsRes.ok) {
          const data = await botsRes.json();
          setBots(Array.isArray(data) ? data : []);
        }
        if (schedulesRes.ok) {
          const data = await schedulesRes.json();
          setSchedules(Array.isArray(data) ? data : []);
        }
        await Promise.all([refreshStandings(), loadRecentMatches(), loadArchives()]);
        if (cancelled) return;

        // Restore live state if tournament already running
        try {
          const stateRes = await authFetch('/botchamp/api/tournament/state');
          if (stateRes.ok) {
            const state = await stateRes.json();
            if (state?.progress && state.progress.completed < state.progress.total) {
              updateLiveUI(state);
            }
          }
        } catch (e) {
          /* ignore */
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMsg('Не удалось загрузить данные чемпионата. Проверьте, что backend запущен на :3001.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();

    // Socket.IO for live updates
    const socket = io(backendUrl, { path: '/v2/socket.io' });
    socketRef.current = socket;
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('match:start', (data) => updateLiveUI(data?.progress != null ? data : { progress: data }));
    socket.on('match:finished', (data) => {
      updateLiveUI(data);
      loadRecentMatches();
    });
    socket.on('tournament:finished', () => handleTournamentEnd());
    socket.on('tournament:started', () => {
      setIsActive(true);
      setStatusText('Чемпионат идет');
      setStatusTone('running');
      refreshStandings();
      loadRecentMatches();
    });

    pollRef.current = setInterval(async () => {
      try {
        const res = await authFetch('/botchamp/api/tournament/state');
        if (!res.ok) return;
        const state = await res.json();
        if (state?.progress && state.progress.completed < state.progress.total) {
          updateLiveUI(state);
        }
      } catch (e) {
        /* ignore */
      }
    }, 2000);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      if (statusResetRef.current) clearTimeout(statusResetRef.current);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [
    authFetch,
    backendUrl,
    updateLiveUI,
    refreshStandings,
    loadRecentMatches,
    loadArchives,
    handleTournamentEnd,
  ]);

  const selectSchedule = (file) => {
    setCurrentScheduleFile(file);
  };

  const generateRoundRobin = () => {
    setCurrentScheduleFile('__roundrobin');
  };

  const startTournament = async () => {
    if (!currentScheduleFile) {
      setErrorMsg('Сначала выберите расписание или сгенерируйте круговой турнир.');
      return;
    }
    setActionBusy(true);
    setErrorMsg(null);
    try {
      const resp = await authFetch('/botchamp/api/tournament/start', {
        method: 'POST',
        body: JSON.stringify({
          scheduleFile: currentScheduleFile,
          options: {
            concurrency,
            double: optDouble,
            headed: optHeaded,
            accelerate: optAccelerate,
          },
        }),
      });
      if (resp.status === 409) {
        setErrorMsg('Чемпионат уже идет!');
        return;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setErrorMsg('Не удалось запустить: ' + (err.error || resp.status));
        return;
      }
      const data = await resp.json();
      if (data.ok) {
        setIsActive(true);
        setStatusText('Чемпионат идет');
        setStatusTone('running');
        refreshStandings();
        loadRecentMatches();
      }
    } catch (e) {
      setErrorMsg('Ошибка сети при запуске чемпионата.');
    } finally {
      setActionBusy(false);
    }
  };

  const stopTournament = async () => {
    setActionBusy(true);
    try {
      await authFetch('/botchamp/api/tournament/stop', { method: 'POST' });
      setIsActive(false);
      setProgress({ completed: 0, total: 0, activeMatches: [] });
      setStatusText('Готов к запуску');
      setStatusTone('ready');
    } catch (e) {
      setErrorMsg('Не удалось остановить чемпионат.');
    } finally {
      setActionBusy(false);
    }
  };

  const openMatch = async (matchId, archiveId = null) => {
    setModalVisible(true);
    setModalLoading(true);
    setModalKind('match');
    setModalMatch(null);
    setModalArchiveId(archiveId);
    setModalTitle('Детали матча');
    try {
      const url = archiveId
        ? `/botchamp/api/archive/${encodeURIComponent(archiveId)}/match/${encodeURIComponent(matchId)}`
        : `/botchamp/api/result/${matchId}`;
      const res = await authFetch(url);
      const data = await res.json();
      setModalMatch(data);
      setModalTitle(`${data.topBotName || '?'} vs ${data.bottomBotName || '?'}`);
    } catch (e) {
      setModalMatch({ error: 'Не удалось загрузить матч' });
    } finally {
      setModalLoading(false);
    }
  };

  const openArchive = async (archiveId) => {
    setModalVisible(true);
    setModalLoading(true);
    setModalKind('archive');
    setModalArchive(null);
    setModalMatch(null);
    setModalArchiveId(archiveId);
    setModalTitle('Архив турнира');
    try {
      const res = await authFetch(`/botchamp/api/archive/${encodeURIComponent(archiveId)}`);
      const data = await res.json();
      if (data?.error) {
        setModalArchive({ error: data.error });
      } else {
        setModalArchive(data);
        setModalTitle(data.name || 'Архив');
      }
    } catch (e) {
      setModalArchive({ error: 'Не удалось загрузить архив' });
    } finally {
      setModalLoading(false);
    }
  };

  const closeModal = () => {
    setModalVisible(false);
    setModalMatch(null);
    setModalArchive(null);
    setModalKind(null);
  };

  const progressPct =
    progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;

  const statusDotColor =
    statusTone === 'running'
      ? COLORS.cyan
      : statusTone === 'finished'
        ? COLORS.purple
        : socketConnected
          ? COLORS.emerald
          : COLORS.red;

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.cyan} />
          <Text style={styles.loadingText}>Загрузка панели чемпионата…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, isWide && styles.scrollContentWide]}
      >
        {/* Header */}
        <View style={[styles.header, !isWide && styles.headerStack]}>
          <View style={styles.headerLeft}>
            <View style={styles.logoBox}>
              <Text style={styles.logoEmoji}>🏆</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>RPS Championship</Text>
              <Text style={styles.subtitle}>Automated Battle Arena & Standings</Text>
            </View>
          </View>
          <View style={[styles.headerRight, !isWide && styles.headerRightStack]}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={onBack} activeOpacity={0.8}>
              <Text style={styles.secondaryBtnText}>← Вернуться в игру</Text>
            </TouchableOpacity>
            <View
              style={[
                styles.statusPill,
                statusTone === 'running' && styles.statusPillRunning,
              ]}
            >
              <View style={[styles.statusDot, { backgroundColor: statusDotColor }]} />
              <Text
                style={[
                  styles.statusText,
                  statusTone === 'running' && { color: COLORS.cyan },
                  statusTone === 'finished' && { color: COLORS.purple },
                ]}
              >
                {statusText}
              </Text>
            </View>
            {isActive && (
              <TouchableOpacity
                style={styles.stopBtn}
                onPress={stopTournament}
                disabled={actionBusy}
                activeOpacity={0.8}
              >
                <Text style={styles.stopBtnText}>■ Остановить</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {errorMsg ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{errorMsg}</Text>
            <TouchableOpacity onPress={() => setErrorMsg(null)}>
              <Text style={styles.errorDismiss}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={[styles.grid, isWide && styles.gridWide]}>
          {/* Left column */}
          <View style={[styles.leftCol, isWide && styles.leftColWide]}>
            {/* Controls */}
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>⚙️  Настройка чемпионата</Text>

              <Text style={styles.fieldLabel}>Расписание</Text>
              <ScrollView style={styles.scheduleList} nestedScrollEnabled>
                {schedules.length === 0 ? (
                  <Text style={styles.emptyHint}>Нет готовых расписаний</Text>
                ) : (
                  schedules.map((s) => {
                    const selected = currentScheduleFile === s.file;
                    return (
                      <TouchableOpacity
                        key={s.file}
                        style={[styles.scheduleItem, selected && styles.scheduleItemSelected]}
                        onPress={() => selectSchedule(s.file)}
                        activeOpacity={0.8}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.scheduleName}>{s.name}</Text>
                          <Text style={styles.scheduleMeta}>
                            {s.rounds} раундов • {s.matches} матчей
                          </Text>
                        </View>
                        {selected ? <Text style={styles.checkMark}>✓</Text> : null}
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>

              <TouchableOpacity
                style={[
                  styles.rrBtn,
                  currentScheduleFile === '__roundrobin' && styles.rrBtnSelected,
                ]}
                onPress={generateRoundRobin}
                activeOpacity={0.8}
              >
                <Text
                  style={[
                    styles.rrBtnText,
                    currentScheduleFile === '__roundrobin' && styles.rrBtnTextSelected,
                  ]}
                >
                  {currentScheduleFile === '__roundrobin'
                    ? '✓  Круговой турнир выбран'
                    : '↻  Сгенерировать круговой турнир'}
                </Text>
              </TouchableOpacity>

              <View style={styles.divider} />

              <OptionRow
                label="Двойной круговой (Round-Robin)"
                value={optDouble}
                onValueChange={setOptDouble}
              />
              <OptionRow
                label="Показывать окна браузеров"
                value={optHeaded}
                onValueChange={setOptHeaded}
              />
              <OptionRow
                label="Ускорять матчи (убрать задержки)"
                value={optAccelerate}
                onValueChange={setOptAccelerate}
              />

              <View style={styles.concurrencyBlock}>
                <View style={styles.concurrencyHeader}>
                  <Text style={styles.optionLabel}>Параллельные матчи</Text>
                  <Text style={styles.concurrencyVal}>{concurrency}</Text>
                </View>
                <View style={styles.concurrencyRow}>
                  {CONCURRENCY_OPTIONS.map((n) => (
                    <TouchableOpacity
                      key={n}
                      style={[
                        styles.concurrencyChip,
                        concurrency === n && styles.concurrencyChipActive,
                      ]}
                      onPress={() => setConcurrency(n)}
                    >
                      <Text
                        style={[
                          styles.concurrencyChipText,
                          concurrency === n && styles.concurrencyChipTextActive,
                        ]}
                      >
                        {n}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.hint}>
                  Каждый матч идёт в параллельном инстансе браузера. Значение &gt; 4 может вызвать
                  сильную нагрузку.
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, actionBusy && styles.primaryBtnDisabled]}
                onPress={startTournament}
                disabled={actionBusy || isActive}
                activeOpacity={0.85}
              >
                {actionBusy ? (
                  <ActivityIndicator color={COLORS.white} />
                ) : (
                  <Text style={styles.primaryBtnText}>ЗАПУСТИТЬ ЧЕМПИОНАТ  🚀</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Bots */}
            <View style={styles.panel}>
              <View style={styles.panelTitleRow}>
                <Text style={styles.panelTitle}>🤖  Боты</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{bots.length}</Text>
                </View>
              </View>
              <View style={styles.botsGrid}>
                {bots.map((b) => (
                  <View key={b.id} style={styles.botChip}>
                    <Text style={styles.botEmoji}>{b.emoji || '🤖'}</Text>
                    <Text style={styles.botName} numberOfLines={1}>
                      {b.name}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>

          {/* Right column */}
          <View style={[styles.rightCol, isWide && styles.rightColWide]}>
            {/* Progress */}
            {isActive && (
              <View style={[styles.panel, styles.progressPanel]}>
                <View style={styles.progressHeader}>
                  <Text style={styles.progressTitle}>◌  Текущий прогресс</Text>
                  <Text style={styles.progressCounter}>
                    {progress.completed} / {progress.total}
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
                </View>
                <Text style={styles.fieldLabel}>Запущенные матчи</Text>
                <View style={styles.activeMatches}>
                  {(progress.activeMatches || []).length === 0 ? (
                    <Text style={styles.emptyHint}>Нет активных матчей…</Text>
                  ) : (
                    (progress.activeMatches || []).map((m, idx) => (
                      <View key={idx} style={styles.activeMatchCard}>
                        <Text style={styles.activeMatchText}>{m.text || String(m)}</Text>
                        <ActivityIndicator size="small" color={COLORS.cyan} />
                      </View>
                    ))
                  )}
                </View>
              </View>
            )}

            {/* Standings */}
            <View style={styles.panel}>
              <View style={styles.panelTitleRow}>
                <Text style={styles.panelTitle}>📋  Турнирная таблица</Text>
                {tournamentName ? (
                  <View style={styles.tournamentNamePill}>
                    <Text style={styles.tournamentNameText}>Текущий: {tournamentName}</Text>
                  </View>
                ) : null}
              </View>

              {standings.length === 0 ? (
                <Text style={[styles.emptyHint, { paddingVertical: 24, textAlign: 'center' }]}>
                  Таблица появится после завершения матчей.
                </Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ minWidth: isWide ? 560 : width - 48 }}>
                    <View style={styles.tableHeader}>
                      <Text style={[styles.th, styles.colRank]}>#</Text>
                      <Text style={[styles.th, styles.colName]}>Участник</Text>
                      <Text style={[styles.th, styles.colStat]}>И</Text>
                      <Text style={[styles.th, styles.colStat]}>В</Text>
                      <Text style={[styles.th, styles.colStat]}>П</Text>
                      <Text style={[styles.th, styles.colStat]}>Н</Text>
                      <Text style={[styles.th, styles.colPts]}>Очки</Text>
                    </View>
                    {standings.map((row, idx) => (
                      <View key={row.id || idx} style={styles.tableRow}>
                        <Text style={[styles.td, styles.colRank, styles.rankNum]}>{idx + 1}</Text>
                        <View style={styles.colName}>
                          <Text style={styles.rowName}>{row.name}</Text>
                          <Text style={styles.rowId}>{row.id}</Text>
                        </View>
                        <Text style={[styles.td, styles.colStat]}>{row.games}</Text>
                        <Text style={[styles.td, styles.colStat, { color: COLORS.emerald }]}>
                          {row.wins}
                        </Text>
                        <Text style={[styles.td, styles.colStat, { color: COLORS.red }]}>
                          {row.losses}
                        </Text>
                        <Text style={[styles.td, styles.colStat, { color: COLORS.amber }]}>
                          {row.draws}
                        </Text>
                        <Text style={[styles.td, styles.colPts, styles.ptsNum]}>{row.points}</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              )}
            </View>

            {/* Matches + Archives */}
            <View style={[styles.bottomRow, isWide && styles.bottomRowWide]}>
              <View style={[styles.panel, styles.halfPanel]}>
                <Text style={styles.panelTitle}>🎮  Сыгранные матчи</Text>
                <ScrollView style={styles.listMax} nestedScrollEnabled>
                  {recentMatches.length === 0 ? (
                    <Text style={styles.emptyHint}>Матчей пока нет.</Text>
                  ) : (
                    recentMatches.map((m) => {
                      const oc = matchOutcomeLabel(m);
                      return (
                        <TouchableOpacity
                          key={m.id}
                          style={styles.matchCard}
                          onPress={() => openMatch(m.id, null)}
                          activeOpacity={0.8}
                        >
                          <View style={styles.matchCardTop}>
                            <Text style={styles.matchPair} numberOfLines={1}>
                              {m.topBotName}{' '}
                              <Text style={{ color: COLORS.dim }}>vs</Text> {m.bottomBotName}
                            </Text>
                            <Text style={styles.matchDur}>{m.durationSec || 0}s</Text>
                          </View>
                          <Text style={[styles.matchWinner, { color: oc.color }]}>
                            🏆 {oc.text}
                          </Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>
              </View>

              <View style={[styles.panel, styles.halfPanel]}>
                <Text style={styles.panelTitle}>📦  Архив турниров</Text>
                <ScrollView style={styles.listMax} nestedScrollEnabled>
                  {archives.length === 0 ? (
                    <Text style={styles.emptyHint}>Архив пуст.</Text>
                  ) : (
                    archives.map((a) => {
                      const winnerName =
                        a.standings?.standings?.[0]?.name ||
                        a.standings?.[0]?.name ||
                        '';
                      return (
                        <TouchableOpacity
                          key={a.id}
                          style={styles.archiveItem}
                          onPress={() => openArchive(a.id)}
                          activeOpacity={0.8}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.archiveName} numberOfLines={1}>
                              {a.name}
                            </Text>
                            <Text style={styles.archiveMeta}>
                              {formatDateRu(a.startedAt)} • {a.totalMatches} матчей
                              {winnerName ? ` • 🏆 ${winnerName}` : ''}
                            </Text>
                          </View>
                          <Text style={styles.chevron}>›</Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Detail modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeModal}
      >
        <Pressable style={styles.modalOverlay} onPress={closeModal}>
          <Pressable
            style={[styles.modalCard, { maxWidth: Math.min(640, width - 32) }]}
            onPress={(e) => e.stopPropagation?.()}
          >
            <View style={styles.modalHeader}>
              {modalKind === 'match' && modalArchiveId ? (
                <TouchableOpacity
                  onPress={() => openArchive(modalArchiveId)}
                  style={{ marginRight: 8 }}
                >
                  <Text style={styles.modalBack}>← К архиву</Text>
                </TouchableOpacity>
              ) : null}
              <Text style={styles.modalTitle} numberOfLines={2}>
                {modalTitle}
              </Text>
              <TouchableOpacity style={styles.modalClose} onPress={closeModal}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {modalLoading ? (
              <ActivityIndicator color={COLORS.cyan} style={{ marginVertical: 40 }} />
            ) : modalKind === 'match' && modalMatch ? (
              <MatchDetailBody match={modalMatch} backendUrl={backendUrl} />
            ) : modalKind === 'archive' && modalArchive ? (
              <ArchiveDetailBody
                archive={modalArchive}
                onOpenMatch={(id) => openMatch(id, modalArchiveId)}
              />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function OptionRow({ label, value, onValueChange }) {
  return (
    <View style={styles.optionRow}>
      <Text style={styles.optionLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#374151', true: 'rgba(0, 240, 255, 0.45)' }}
        thumbColor={value ? COLORS.cyan : '#9ca3af'}
      />
    </View>
  );
}

function MatchDetailBody({ match, backendUrl }) {
  if (match.error) {
    return <Text style={styles.emptyHint}>{match.error}</Text>;
  }

  let outcomeStr = match.timedOut ? 'Не завершен (таймаут)' : 'Ничья';
  let outcomeColor = COLORS.amber;
  if (match.winner === 'top') {
    outcomeStr = `Победа: ${match.topBotName} (верх)`;
    outcomeColor = COLORS.emerald;
  } else if (match.winner === 'bottom') {
    outcomeStr = `Победа: ${match.bottomBotName} (низ)`;
    outcomeColor = COLORS.emerald;
  }
  const reasonStr = match.reason ? REASON_RU[match.reason] || match.reason : null;
  const log = Array.isArray(match.battleLog) ? match.battleLog : [];
  const shotUrl = match.screenshotPath
    ? `${backendUrl}/botchamp/${match.screenshotPath}`
    : null;

  return (
    <ScrollView style={styles.modalBody} nestedScrollEnabled>
      <View style={styles.outcomeBox}>
        <Text style={styles.outcomeLabel}>
          Итог{reasonStr ? ` (${reasonStr})` : ''}
        </Text>
        <Text style={[styles.outcomeValue, { color: outcomeColor }]}>{outcomeStr}</Text>
      </View>
      {match.durationSec != null && (
        <Text style={[styles.hint, { marginBottom: 12 }]}>Длительность: {match.durationSec}s</Text>
      )}

      {log.length > 0 ? (
        <View>
          <Text style={styles.fieldLabel}>Журнал боя ({log.length})</Text>
          <View style={styles.logBox}>
            {log.map((entry, i) => (
              <Text key={i} style={styles.logLine}>
                {entry?.message || (typeof entry === 'string' ? entry : JSON.stringify(entry))}
              </Text>
            ))}
          </View>
        </View>
      ) : (
        <Text style={styles.emptyHint}>Журнал боя недоступен для этого матча.</Text>
      )}

      {shotUrl && Platform.OS === 'web' ? (
        <TouchableOpacity
          style={styles.shotLink}
          onPress={() => {
            if (typeof window !== 'undefined') window.open(shotUrl, '_blank');
          }}
        >
          <Text style={styles.shotLinkText}>🖼  Финальный скриншот</Text>
        </TouchableOpacity>
      ) : shotUrl ? (
        <Image source={{ uri: shotUrl }} style={styles.screenshot} resizeMode="contain" />
      ) : null}
    </ScrollView>
  );
}

function ArchiveDetailBody({ archive, onOpenMatch }) {
  if (archive.error) {
    return <Text style={styles.emptyHint}>{archive.error}</Text>;
  }
  const standingsList = archive.standings?.standings || archive.standings || [];
  const matches = archive.matches || [];

  return (
    <ScrollView style={styles.modalBody} nestedScrollEnabled>
      <Text style={styles.hint}>
        Запущен: {formatDateRu(archive.startedAt)} • {archive.totalMatches} матчей
      </Text>

      <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Турнирная таблица</Text>
      {standingsList.length === 0 ? (
        <Text style={styles.emptyHint}>Нет данных</Text>
      ) : (
        standingsList.map((row, idx) => (
          <View key={row.id || idx} style={styles.archiveStandingRow}>
            <Text style={styles.rankNum}>{idx + 1}.</Text>
            <Text style={[styles.rowName, { flex: 1 }]} numberOfLines={1}>
              {row.name}
            </Text>
            <Text style={{ color: COLORS.emerald, fontSize: 12 }}>{row.wins}В</Text>
            <Text style={{ color: COLORS.red, fontSize: 12, marginLeft: 6 }}>{row.losses}П</Text>
            <Text style={[styles.ptsNum, { marginLeft: 8, fontSize: 14 }]}>{row.points}</Text>
          </View>
        ))
      )}

      <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Матчи (нажмите для лога)</Text>
      {matches.map((m) => {
        const oc = matchOutcomeLabel(m);
        return (
          <TouchableOpacity
            key={m.id}
            style={styles.matchCard}
            onPress={() => onOpenMatch(m.id)}
            activeOpacity={0.8}
          >
            <Text style={styles.matchPair} numberOfLines={1}>
              {m.topBotName} vs {m.bottomBotName}
            </Text>
            <Text style={[styles.matchWinner, { color: oc.color }]}>🏆 {oc.text}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    paddingBottom: 48,
  },
  scrollContentWide: {
    paddingHorizontal: 28,
    maxWidth: 1440,
    alignSelf: 'center',
    width: '100%',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  loadingText: { color: COLORS.muted, fontSize: 14 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
    gap: 16,
  },
  headerStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  headerRightStack: {
    justifyContent: 'flex-start',
  },
  logoBox: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: COLORS.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoEmoji: { fontSize: 26 },
  title: {
    color: COLORS.white,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: COLORS.muted,
    fontSize: 13,
    marginTop: 2,
  },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white10,
  },
  secondaryBtnText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '500',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white10,
  },
  statusPillRunning: {
    backgroundColor: 'rgba(8, 47, 73, 0.45)',
    borderColor: 'rgba(0, 240, 255, 0.45)',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '500',
  },
  stopBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.25)',
  },
  stopBtnText: {
    color: COLORS.red,
    fontSize: 13,
    fontWeight: '600',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    gap: 12,
  },
  errorBannerText: { flex: 1, color: COLORS.red, fontSize: 13 },
  errorDismiss: { color: COLORS.red, fontSize: 16, paddingHorizontal: 4 },

  grid: {
    flexDirection: 'column',
    gap: 20,
  },
  gridWide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  leftCol: { gap: 20 },
  leftColWide: { width: '34%', flexShrink: 0 },
  rightCol: { gap: 20, flex: 1 },
  rightColWide: { flex: 1 },

  panel: {
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 20,
    padding: 20,
  },
  panelTitle: {
    color: COLORS.white,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14,
  },
  panelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
    flexWrap: 'wrap',
  },
  fieldLabel: {
    color: COLORS.dim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  emptyHint: {
    color: COLORS.dim,
    fontSize: 13,
    fontStyle: 'italic',
  },
  scheduleList: {
    maxHeight: 180,
    marginBottom: 10,
  },
  scheduleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.white10,
    backgroundColor: COLORS.white05,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  scheduleItemSelected: {
    borderColor: COLORS.cyan,
    backgroundColor: COLORS.cyanDim,
  },
  scheduleName: {
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 14,
  },
  scheduleMeta: {
    color: COLORS.dim,
    fontSize: 11,
    marginTop: 2,
  },
  checkMark: {
    color: COLORS.cyan,
    fontSize: 18,
    fontWeight: '700',
  },
  rrBtn: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.white20,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 4,
  },
  rrBtnSelected: {
    borderStyle: 'solid',
    borderColor: COLORS.cyan,
    backgroundColor: COLORS.cyanDim,
  },
  rrBtnText: {
    color: COLORS.muted,
    fontSize: 13,
  },
  rrBtnTextSelected: {
    color: COLORS.cyan,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.white10,
    marginVertical: 16,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 12,
  },
  optionLabel: {
    color: COLORS.text,
    fontSize: 13,
    flex: 1,
  },
  concurrencyBlock: {
    marginTop: 4,
    marginBottom: 8,
  },
  concurrencyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  concurrencyVal: {
    color: COLORS.cyan,
    fontWeight: '700',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    backgroundColor: COLORS.cyanDim,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  concurrencyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  concurrencyChip: {
    minWidth: 40,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.white10,
    backgroundColor: COLORS.white05,
    alignItems: 'center',
  },
  concurrencyChipActive: {
    borderColor: COLORS.cyan,
    backgroundColor: COLORS.cyanDim,
  },
  concurrencyChipText: {
    color: COLORS.muted,
    fontWeight: '600',
  },
  concurrencyChipTextActive: {
    color: COLORS.cyan,
  },
  hint: {
    color: COLORS.dim,
    fontSize: 10,
    marginTop: 8,
    lineHeight: 14,
  },
  primaryBtn: {
    marginTop: 16,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: COLORS.purple,
    // gradient-ish fallback: purple with cyan border
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.35)',
  },
  primaryBtnDisabled: {
    opacity: 0.55,
  },
  primaryBtnText: {
    color: COLORS.white,
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.5,
  },
  badge: {
    backgroundColor: COLORS.purpleDim,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeText: {
    color: '#d8b4fe',
    fontWeight: '700',
    fontSize: 12,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  botsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  botChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white10,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    width: '48%',
    minWidth: 120,
    flexGrow: 1,
  },
  botEmoji: { fontSize: 14 },
  botName: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
  },

  progressPanel: {
    borderColor: 'rgba(0, 240, 255, 0.2)',
    backgroundColor: 'rgba(8, 30, 48, 0.55)',
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  progressTitle: {
    color: COLORS.cyan,
    fontWeight: '700',
    fontSize: 14,
  },
  progressCounter: {
    color: '#67e8f9',
    fontWeight: '700',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    backgroundColor: '#083344',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.2)',
    overflow: 'hidden',
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white05,
    overflow: 'hidden',
    marginBottom: 16,
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.cyan,
    borderRadius: 999,
  },
  activeMatches: {
    gap: 8,
  },
  activeMatchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0, 240, 255, 0.08)',
    borderLeftWidth: 3,
    borderLeftColor: COLORS.cyan,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  activeMatchText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
    marginRight: 8,
  },

  tournamentNamePill: {
    backgroundColor: COLORS.cyanDim,
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.25)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  tournamentNameText: {
    color: COLORS.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white05,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.white05,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.white05,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  th: {
    color: COLORS.dim,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  td: {
    color: COLORS.text,
    fontSize: 13,
    textAlign: 'center',
  },
  colRank: { width: 36, textAlign: 'center' },
  colName: { flex: 1, minWidth: 120, paddingRight: 8 },
  colStat: { width: 40, textAlign: 'center' },
  colPts: { width: 56, textAlign: 'right', paddingRight: 4 },
  rankNum: {
    color: COLORS.dim,
    fontWeight: '700',
    textAlign: 'center',
  },
  rowName: {
    color: COLORS.white,
    fontWeight: '600',
    fontSize: 14,
  },
  rowId: {
    color: COLORS.dim,
    fontSize: 10,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    marginTop: 2,
  },
  ptsNum: {
    color: COLORS.cyan,
    fontWeight: '800',
    fontSize: 18,
    textAlign: 'right',
  },

  bottomRow: {
    gap: 20,
  },
  bottomRowWide: {
    flexDirection: 'row',
  },
  halfPanel: {
    flex: 1,
  },
  listMax: {
    maxHeight: 320,
    gap: 8,
  },
  matchCard: {
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white10,
    borderRadius: 12,
    padding: 12,
    marginBottom: 4,
  },
  matchCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  matchPair: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
  },
  matchDur: {
    color: COLORS.dim,
    fontSize: 10,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  matchWinner: {
    fontSize: 11,
    fontWeight: '700',
  },
  archiveItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.white10,
    backgroundColor: COLORS.white05,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 4,
  },
  archiveName: {
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 13,
  },
  archiveMeta: {
    color: COLORS.dim,
    fontSize: 10,
    marginTop: 2,
  },
  chevron: {
    color: COLORS.dim,
    fontSize: 22,
    marginLeft: 8,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxHeight: '85%',
    backgroundColor: 'rgba(18, 13, 38, 0.96)',
    borderWidth: 1,
    borderColor: COLORS.white10,
    borderRadius: 24,
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.white05,
    paddingBottom: 12,
    marginBottom: 12,
    gap: 8,
  },
  modalTitle: {
    flex: 1,
    color: COLORS.white,
    fontSize: 18,
    fontWeight: '700',
  },
  modalBack: {
    color: COLORS.amber,
    fontSize: 12,
    fontWeight: '600',
  },
  modalClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseText: {
    color: COLORS.muted,
    fontSize: 14,
  },
  modalBody: {
    maxHeight: 480,
  },
  outcomeBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.white05,
    borderWidth: 1,
    borderColor: COLORS.white10,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 12,
  },
  outcomeLabel: {
    color: COLORS.muted,
    fontSize: 13,
  },
  outcomeValue: {
    fontWeight: '700',
    fontSize: 15,
    textAlign: 'right',
    flexShrink: 1,
  },
  logBox: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: COLORS.white05,
    borderRadius: 12,
    padding: 12,
    maxHeight: 260,
  },
  logLine: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    lineHeight: 16,
    marginBottom: 2,
  },
  shotLink: {
    marginTop: 14,
    alignSelf: 'flex-end',
  },
  shotLinkText: {
    color: '#c084fc',
    fontSize: 13,
    fontWeight: '600',
  },
  screenshot: {
    marginTop: 12,
    width: '100%',
    height: 200,
    borderRadius: 12,
  },
  archiveStandingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.white05,
  },
});
