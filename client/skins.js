import React from 'react';
import { View, Platform } from 'react-native';

/**
 * Реестр визуальных скинов. Каждый скин описывает ВСЁ своё оформление:
 * ассеты фигур, рамку доски, цвета и форму ячеек, контейнеры фигур.
 * Чтобы добавить новый скин — достаточно добавить запись сюда и папку ассетов,
 * код рендера в App.js менять не нужно.
 */

const web = Platform.OS === 'web';

/** Тень/свечение кроссплатформенно: boxShadow на вебе, shadow* на нативе. */
function glow(color, radius = 8, opacity = 0.5) {
  return web
    ? { boxShadow: `0 0 ${radius}px ${color}` }
    : {
        shadowColor: color,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: opacity,
        shadowRadius: radius / 2,
        elevation: 3,
      };
}

export const SKINS = {
  // ─── NEON CYBERPUNK ────────────────────────────────────────────────────────
  cyberpunk: {
    id: 'cyberpunk',
    icon: '🌌',
    nameKey: 'themeCyberpunk',
    statusBar: 'light',
    /** Семантическая палитра всего UI (не только доски). */
    ui: {
      bg: '#05060f',
      surface: '#0a101c',
      surfaceBorder: 'rgba(14, 165, 233, 0.22)',
      surfaceAlt: '#0d1526',
      surfaceAltBorder: 'rgba(14, 165, 233, 0.16)',
      textPrimary: '#e0f2fe',
      textSecondary: '#9db8d4',
      textMuted: '#5b7390',
      title: '#38bdf8',
      accent: '#0ea5e9',
      accentBright: '#00e5ff',
      accentSoftBg: 'rgba(14, 165, 233, 0.12)',
      accentText: '#7dd3fc',
      onAccent: '#e6fbff',
      heroBg: 'rgba(14, 165, 233, 0.22)',
      heroBorder: '#0ea5e9',
      danger: '#f43f5e',
      dangerSoftBg: 'rgba(244, 63, 94, 0.10)',
      success: '#22c55e',
      successSoftBg: 'rgba(34, 197, 94, 0.12)',
      warning: '#facc15',
      purple: '#a78bfa',
      inputBg: '#020617',
      inputBorder: 'rgba(14, 165, 233, 0.35)',
      inputText: '#e0f2fe',
      placeholder: '#475569',
      overlay: 'rgba(2, 6, 23, 0.8)',
      modalBg: '#0a101c',
      modalBorder: '#0ea5e9',
      divider: 'rgba(14, 165, 233, 0.15)',
      blueSide: '#0ea5e9',
      redSide: '#f43f5e',
      warningSoftBg: 'rgba(250, 204, 21, 0.10)',
      surfaceTranslucent: 'rgba(10, 16, 28, 0.92)',
      blueSoft: 'rgba(14, 165, 233, 0.30)',
      redSoft: 'rgba(244, 63, 94, 0.30)',
      cardGlow: glow('rgba(14, 165, 233, 0.18)', 14),
      font: web ? { fontFamily: "'Rajdhani', 'Orbitron', 'Segoe UI', sans-serif" } : {},
      titleFont: web ? { fontFamily: "'Orbitron', 'Rajdhani', 'Segoe UI', sans-serif", letterSpacing: 1.2 } : {},
    },
    /** Подсветки игровой доски. */
    highlights: {
      setupZoneBg: 'rgba(14, 165, 233, 0.14)',
      setupZoneBorder: 'rgba(14, 165, 233, 0.55)',
      setupHoverBg: 'rgba(0, 229, 255, 0.30)',
      setupHoverBorder: '#00e5ff',
      selectedBorder: '#00e5ff',
      possibleBg: 'rgba(0, 229, 255, 0.10)',
      possibleBorder: 'rgba(0, 229, 255, 0.55)',
      dot: '#00e5ff',
      lastFromBg: 'rgba(167, 139, 250, 0.16)',
      lastFromBorder: 'rgba(167, 139, 250, 0.45)',
      lastToBg: 'rgba(167, 139, 250, 0.32)',
      lastToBorder: '#a78bfa',
    },
    assets: {
      rock: require('./assets/skins/cyberpunk/rock.png'),
      paper: require('./assets/skins/cyberpunk/paper.png'),
      scissors: require('./assets/skins/cyberpunk/scissors.png'),
      trap: require('./assets/skins/cyberpunk/trap.png'),
      flag: require('./assets/skins/cyberpunk/flag.png'),
      trapOpen: require('./assets/skins/cyberpunk/trap_open.png'),
    },
    boardCard: {
      backgroundColor: '#101a2e',
      borderWidth: 1.5,
      borderColor: '#38bdf8',
      ...glow('rgba(56, 189, 248, 0.35)', 16),
    },
    boardFrame: {
      backgroundColor: '#1b2942',
      borderColor: '#38bdf8',
      borderWidth: 2,
    },
    cellShape: 'octagon',
    cutColor: '#1b2942',
    cutEdgeColor: 'rgba(56, 189, 248, 0.5)',
    cells: {
      light: {
        backgroundColor: '#33476b',
        borderColor: '#4f74a8',
        borderWidth: 1,
        overflow: 'hidden',
      },
      dark: {
        backgroundColor: '#26385a',
        borderColor: '#456193',
        borderWidth: 1,
        overflow: 'hidden',
      },
    },
    piece: {
      chipShape: 'octagon',
      sides: {
        player: { accent: '#38bdf8', tint: '#7dd3fc' },
        enemy: { accent: '#fb7185', tint: '#fb7185' },
      },
      // Командный восьмиугольный чип под фигурой: синий — игрок, красный — соперник,
      // золотой — флаг, оранжевый — капкан (бомба). Даёт явный контраст и различие сторон.
      chip(side, { type, revealed }) {
        const teams = {
          player: { fill: '#0b2c4a', border: '#38bdf8', glow: 'rgba(56, 189, 248, 0.9)' },
          enemy: { fill: '#451222', border: '#fb7185', glow: 'rgba(251, 113, 133, 0.9)' },
        };
        if (type === 'flag') return { fill: '#3a2d07', border: '#fbbf24', glow: 'rgba(251, 191, 36, 0.95)' };
        if (type === 'trap') {
          // Взорванный (раскрытый) капкан — пунктирная огненная рамка
          if (revealed) return { fill: '#2a0a06', border: '#f97316', glow: 'rgba(249, 115, 22, 0.95)', dashed: true };
          return { fill: '#3a1707', border: '#fb923c', glow: 'rgba(251, 146, 60, 0.95)' };
        }
        const c = teams[side];
        // Раскрытая боевая фигура игрока: командный чип + жёлтый ореол свечения вокруг
        if (side === 'player' && revealed) {
          return { ...c, border: '#fbbf24', glow: 'rgba(251, 191, 36, 0.95)', halo: 'rgba(253, 224, 71, 0.95)' };
        }
        return c;
      },
      container(side, { immobilized, revealed }) {
        return [
          {
            width: '100%',
            height: '100%',
            alignSelf: 'center',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'transparent',
            position: 'relative',
          },
          immobilized && { opacity: 0.45 },
        ];
      },
      imageStyle(side, isTrapOpen) {
        if (isTrapOpen) {
          // trap_open.png - красная картинка.
          // Для синей стороны игрока (player) смещаем оттенок в синий.
          // Для красной стороны соперника (enemy) оставляем красный цвет без изменений.
          return {
            width: '66%',
            height: '66%',
            zIndex: 2,
            ...(web
              ? (side === 'enemy'
                ? { filter: 'brightness(1.1) drop-shadow(0 0 4px rgba(0,0,0,0.6))' }
                : { filter: 'hue-rotate(240deg) saturate(1.6) brightness(1.15) drop-shadow(0 0 4px rgba(0,0,0,0.6))' })
              : { tintColor: undefined }),
          };
        }
        return {
          width: '66%',
          height: '66%',
          zIndex: 2,
          ...(web
            ? (side === 'enemy'
              ? { filter: 'hue-rotate(300deg) saturate(1.6) brightness(1.15) drop-shadow(0 0 4px rgba(0,0,0,0.6))' }
              : { filter: 'brightness(1.1) drop-shadow(0 0 4px rgba(0,0,0,0.6))' })
            : { tintColor: undefined }),
        };
      },
      unknown(side, fontSize) {
        return { fontSize: fontSize * 1.5, color: '#ffffff', fontWeight: '900', zIndex: 2 };
      },
    },
    theme: {
      appBg: {
        backgroundColor: '#05070e',
      },
      scoreboard: {
        blue: {
          backgroundColor: '#020d1c',
          borderColor: '#0ea5e9',
          borderWidth: 2,
          ...glow('rgba(14, 165, 233, 0.45)', 12, 0.6),
        },
        red: {
          backgroundColor: '#16020c',
          borderColor: '#f43f5e',
          borderWidth: 2,
          ...glow('rgba(244, 63, 94, 0.45)', 12, 0.6),
        },
      },
      card: {
        backgroundColor: '#090d16',
        borderColor: '#1e293b',
        borderWidth: 1.5,
        borderRadius: 12,
        ...glow('rgba(14, 165, 233, 0.15)', 10),
      },
      cardTitle: {
        color: '#38bdf8',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        letterSpacing: 1,
      },
      buttons: {
        exit: {
          container: {
            backgroundColor: 'rgba(244, 63, 94, 0.08)',
            borderColor: '#f43f5e',
            borderWidth: 1.5,
            borderRadius: 8,
            ...glow('rgba(244, 63, 94, 0.2)', 8, 0.4),
          },
          text: {
            color: '#f43f5e',
            textTransform: 'uppercase',
            fontWeight: 'bold',
            fontSize: 13,
            letterSpacing: 1,
          },
        },
        reset: {
          container: {
            backgroundColor: 'rgba(14, 165, 233, 0.08)',
            borderColor: '#0ea5e9',
            borderWidth: 1.5,
            borderRadius: 8,
            ...glow('rgba(14, 165, 233, 0.2)', 8, 0.4),
          },
          text: {
            color: '#38bdf8',
            textTransform: 'uppercase',
            fontWeight: 'bold',
            fontSize: 13,
            letterSpacing: 1,
          },
        },
        start: {
          container: {
            backgroundColor: 'rgba(34, 197, 94, 0.12)',
            borderColor: '#22c55e',
            borderWidth: 2,
            borderRadius: 8,
            ...glow('rgba(34, 197, 94, 0.4)', 12, 0.6),
          },
          text: {
            color: '#4ade80',
            textTransform: 'uppercase',
            fontWeight: '900',
            fontSize: 14,
            letterSpacing: 1.2,
          },
        },
      },
    },
  },

  // ─── CASUAL TOON ───────────────────────────────────────────────────────────
  toon: {
    id: 'toon',
    icon: '🎨',
    nameKey: 'themeToon',
    statusBar: 'dark',
    ui: {
      bg: '#f6f1e5',
      surface: '#fffcf7',
      surfaceBorder: 'rgba(141, 110, 99, 0.28)',
      surfaceAlt: '#f5f0e8',
      surfaceAltBorder: 'rgba(141, 110, 99, 0.18)',
      textPrimary: '#2c1e10',
      textSecondary: '#6b5744',
      textMuted: '#9a8a78',
      title: '#5d4037',
      accent: '#ea580c',
      accentBright: '#f97316',
      accentSoftBg: 'rgba(234, 88, 12, 0.10)',
      accentText: '#c2410c',
      onAccent: '#ffffff',
      heroBg: '#ea580c',
      heroBorder: '#c2410c',
      danger: '#d84315',
      dangerSoftBg: 'rgba(216, 67, 21, 0.10)',
      success: '#2e7d32',
      successSoftBg: 'rgba(46, 125, 50, 0.12)',
      warning: '#f59e0b',
      purple: '#7c3aed',
      inputBg: '#ffffff',
      inputBorder: '#c9b8a0',
      inputText: '#2c1e10',
      placeholder: '#9ca3af',
      overlay: 'rgba(44, 30, 16, 0.6)',
      modalBg: '#fffcf7',
      modalBorder: '#8d6e63',
      divider: 'rgba(141, 110, 99, 0.2)',
      blueSide: '#1d4ed8',
      redSide: '#b91c1c',
      warningSoftBg: 'rgba(245, 158, 11, 0.14)',
      surfaceTranslucent: 'rgba(255, 252, 247, 0.95)',
      blueSoft: 'rgba(37, 99, 235, 0.30)',
      redSoft: 'rgba(220, 38, 38, 0.30)',
      cardGlow: web ? { boxShadow: '0 4px 18px rgba(93, 64, 55, 0.10)' } : {},
      font: {},
      titleFont: {},
    },
    highlights: {
      setupZoneBg: 'rgba(22, 163, 74, 0.18)',
      setupZoneBorder: 'rgba(22, 163, 74, 0.55)',
      setupHoverBg: 'rgba(22, 163, 74, 0.38)',
      setupHoverBorder: 'rgba(22, 163, 74, 0.85)',
      selectedBorder: '#f59e0b',
      possibleBg: 'rgba(22, 163, 74, 0.18)',
      possibleBorder: 'rgba(22, 163, 74, 0.8)',
      dot: '#16a34a',
      lastFromBg: 'rgba(217, 119, 6, 0.15)',
      lastFromBorder: 'rgba(217, 119, 6, 0.4)',
      lastToBg: 'rgba(217, 119, 6, 0.3)',
      lastToBorder: '#d97706',
    },
    assets: {
      rock: require('./assets/skins/toon/rock.png'),
      paper: require('./assets/skins/toon/paper.png'),
      scissors: require('./assets/skins/toon/scissors.png'),
      trap: require('./assets/skins/toon/trap.png'),
      flag: require('./assets/skins/toon/flag.png'),
      trapOpen: require('./assets/skins/toon/trap_open.png'),
    },
    boardCard: {
      backgroundColor: '#e8f5e9',
      borderWidth: 1.5,
      borderColor: '#a5d6a7',
    },
    boardFrame: {
      backgroundColor: '#8d6e63',
      borderColor: '#5d4037',
      borderWidth: 3,
    },
    cellShape: 'terrain',
    cells: {
      light: {
        backgroundColor: '#8bc34a',
        borderColor: '#7cb342',
        borderWidth: 1,
        overflow: 'hidden',
      },
      dark: {
        backgroundColor: '#a98467',
        borderColor: '#8d6e52',
        borderWidth: 1,
        overflow: 'hidden',
      },
    },
    piece: {
      sides: {
        player: { accent: '#1d4ed8', bg: '#3b82f6' },
        enemy: { accent: '#b91c1c', bg: '#ef4444' },
      },
      container(side, { immobilized, revealed }) {
        const s = this.sides[side];
        return [
          {
            width: '96%',
            height: '96%',
            borderRadius: 22,
            justifyContent: 'center',
            alignItems: 'center',
            borderWidth: 2.5,
            position: 'relative',
            overflow: 'hidden',
            borderColor: s.accent,
            backgroundColor: s.bg,
            ...(web
              ? {
                  boxShadow: '0 4px 6px rgba(0,0,0,0.15)',
                  backgroundImage: side === 'player'
                    ? 'radial-gradient(circle, #60a5fa 10%, #1d4ed8 100%)'
                    : 'radial-gradient(circle, #f87171 10%, #b91c1c 100%)'
                }
              : {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.15,
                  shadowRadius: 3,
                  elevation: 4,
                }),
          },
          immobilized && { opacity: 0.5, borderStyle: 'dashed' },
          side === 'player' && revealed && {
            borderColor: '#fbbf24',
            borderWidth: 3.5,
            ...glow('#fbbf24', 12, 0.8),
          },
        ];
      },
      imageStyle(side) {
        return {
          width: '94%',
          height: '94%',
        };
      },
      unknown(side, fontSize) {
        return { fontSize: fontSize * 1.5, color: '#ffffff', fontWeight: '900' };
      },
    },
    theme: {
      appBg: {
        backgroundColor: '#f6f1e5',
      },
      scoreboard: {
        blue: {
          backgroundColor: '#eff6ff',
          borderColor: '#2563eb',
          borderWidth: 2.5,
          borderRadius: 16,
        },
        red: {
          backgroundColor: '#fef2f2',
          borderColor: '#dc2626',
          borderWidth: 2.5,
          borderRadius: 16,
        },
      },
      card: {
        backgroundColor: '#fffcf7',
        borderColor: '#8d6e63',
        borderWidth: 2,
        borderRadius: 16,
      },
      cardTitle: {
        color: '#5d4037',
        fontWeight: 'bold',
      },
      buttons: {
        exit: {
          container: {
            backgroundColor: '#fff1f0',
            borderColor: '#d84315',
            borderWidth: 2.5,
            borderRadius: 24,
          },
          text: {
            color: '#d84315',
            fontWeight: '800',
            fontSize: 13,
          },
        },
        reset: {
          container: {
            backgroundColor: '#fafafa',
            borderColor: '#8d6e63',
            borderWidth: 2.5,
            borderRadius: 24,
          },
          text: {
            color: '#5d4037',
            fontWeight: '800',
            fontSize: 13,
          },
        },
        start: {
          container: {
            backgroundColor: '#e8f5e9',
            borderColor: '#2e7d32',
            borderWidth: 2.5,
            borderRadius: 24,
          },
          text: {
            color: '#2e7d32',
            fontWeight: '900',
            fontSize: 14,
          },
        },
      },
    },
  },

  // ─── CLASSIC CHESS ─────────────────────────────────────────────────────────
  chess: {
    id: 'chess',
    icon: '♟️',
    nameKey: 'themeChess',
    statusBar: 'dark',
    // Emoji map matching the legacy server skin (circular badge style)
    pieceEmoji: { rock: '🪨', paper: '📄', scissors: '✂️', trap: '💣', flag: '🚩' },
    ui: {
      bg: '#e8e2d8',
      surface: '#fffcf7',
      surfaceBorder: '#d4b980',
      surfaceAlt: '#f6f1e6',
      surfaceAltBorder: 'rgba(139, 105, 20, 0.2)',
      textPrimary: '#1c1917',
      textSecondary: '#57534e',
      textMuted: '#78716c',
      title: '#78350f',
      accent: '#b45309',
      accentBright: '#d97706',
      accentSoftBg: 'rgba(180, 83, 9, 0.10)',
      accentText: '#92400e',
      onAccent: '#ffffff',
      heroBg: '#b45309',
      heroBorder: '#92400e',
      danger: '#b91c1c',
      dangerSoftBg: 'rgba(185, 28, 28, 0.08)',
      success: '#16a34a',
      successSoftBg: 'rgba(22, 163, 74, 0.10)',
      warning: '#d97706',
      purple: '#6d28d9',
      inputBg: '#fffdf8',
      inputBorder: '#d4b980',
      inputText: '#1c1917',
      placeholder: '#a8a29e',
      overlay: 'rgba(41, 31, 18, 0.55)',
      modalBg: '#faf7f2',
      modalBorder: '#b45309',
      divider: 'rgba(139, 105, 20, 0.22)',
      blueSide: '#1d4ed8',
      redSide: '#b91c1c',
      warningSoftBg: 'rgba(217, 119, 6, 0.12)',
      surfaceTranslucent: 'rgba(255, 252, 247, 0.95)',
      blueSoft: 'rgba(29, 78, 216, 0.28)',
      redSoft: 'rgba(185, 28, 28, 0.28)',
      cardGlow: web ? { boxShadow: '0 3px 14px rgba(120, 53, 15, 0.10)' } : {},
      font: web ? { fontFamily: "Georgia, 'Times New Roman', serif" } : {},
      titleFont: web ? { fontFamily: "Georgia, 'Times New Roman', serif" } : {},
    },
    highlights: {
      setupZoneBg: 'rgba(22, 163, 74, 0.18)',
      setupZoneBorder: 'rgba(22, 163, 74, 0.55)',
      setupHoverBg: 'rgba(22, 163, 74, 0.38)',
      setupHoverBorder: 'rgba(22, 163, 74, 0.85)',
      selectedBorder: '#d97706',
      possibleBg: 'rgba(22, 163, 74, 0.12)',
      possibleBorder: '#16a34a',
      dot: '#16a34a',
      lastFromBg: 'rgba(217, 119, 6, 0.15)',
      lastFromBorder: 'rgba(217, 119, 6, 0.4)',
      lastToBg: 'rgba(217, 119, 6, 0.3)',
      lastToBorder: '#d97706',
    },
    assets: null,
    boardCard: {
      backgroundColor: '#faf7f2',
      borderColor: '#d97706',
      borderWidth: 1.5,
    },
    boardFrame: {
      backgroundColor: '#d4b980',
      borderColor: '#8b6914',
      borderWidth: 3,
      borderRadius: 12,
    },
    cellShape: 'square',
    cells: {
      light: {
        backgroundColor: '#FFF9C4',
        borderColor: '#d4b980',
        borderWidth: 1,
      },
      dark: {
        backgroundColor: '#C8E6C9',
        borderColor: '#d4b980',
        borderWidth: 1,
      },
    },
    piece: {
      showGloss: true,
      sides: {
        player: { border: '#1d4ed8', bg: '#3b82f6' },
        enemy: { border: '#b91c1c', bg: '#ef4444' },
      },
      container(side, { immobilized, revealed }) {
        const s = this.sides[side];
        return [
          {
            width: '90%',
            height: '90%',
            borderRadius: 999,
            borderWidth: 2.5,
            borderColor: s.border,
            backgroundColor: s.bg,
            justifyContent: 'center',
            alignItems: 'center',
            position: 'relative',
            overflow: 'hidden',
            ...(web
              ? { boxShadow: '0 4px 6px rgba(0,0,0,0.15)' }
              : {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.15,
                  shadowRadius: 3,
                  elevation: 4,
                }),
          },
          immobilized && { opacity: 0.5, borderStyle: 'dashed' },
          side === 'player' && revealed && {
            borderColor: '#fbbf24',
            borderWidth: 3.5,
            ...(web ? { boxShadow: '0 0 12px #fbbf24' } : {
              shadowColor: '#fbbf24',
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.8,
              shadowRadius: 6,
              elevation: 5,
            }),
          },
        ];
      },
      imageStyle(side) {
        return { width: '96%', height: '96%', zIndex: 2 };
      },
      unknown(side, fontSize) {
        return {
          fontSize: fontSize * 1.15,
          color: '#000',
          fontWeight: 'bold',
          zIndex: 1,
          ...(web ? { filter: 'drop-shadow(0px 2px 2px rgba(0,0,0,0.2))' } : {}),
        };
      },
    },
    theme: {
      appBg: {
        backgroundColor: '#e8e2d8',
      },
      scoreboard: {
        blue: {
          backgroundColor: '#f5f8ff',
          borderColor: '#1d4ed8',
          borderWidth: 2,
          borderRadius: 10,
        },
        red: {
          backgroundColor: '#fff6f5',
          borderColor: '#b91c1c',
          borderWidth: 2,
          borderRadius: 10,
        },
      },
      card: {
        backgroundColor: '#fffcf7',
        borderColor: '#d4b980',
        borderWidth: 1.5,
        borderRadius: 10,
      },
      cardTitle: {
        color: '#78350f',
        fontWeight: '700',
      },
      buttons: {
        exit: {
          container: {
            backgroundColor: '#fafaf9',
            borderColor: '#44403c',
            borderWidth: 1.5,
            borderRadius: 10,
          },
          text: {
            color: '#44403c',
            fontWeight: '700',
            fontSize: 13,
          },
        },
        reset: {
          container: {
            backgroundColor: '#fafaf9',
            borderColor: '#78716c',
            borderWidth: 1.5,
            borderRadius: 10,
          },
          text: {
            color: '#78716c',
            fontWeight: '700',
            fontSize: 13,
          },
        },
        start: {
          container: {
            backgroundColor: '#f0fdf4',
            borderColor: '#16a34a',
            borderWidth: 1.5,
            borderRadius: 10,
          },
          text: {
            color: '#15803d',
            fontWeight: '800',
            fontSize: 14,
          },
        },
      },
    },
  },
};

export const SKIN_ORDER = ['cyberpunk', 'toon', 'chess'];

export function getSkin(id) {
  return SKINS[id] || SKINS.cyberpunk;
}

// ─── Декорации ячеек ──────────────────────────────────────────────────────────

const OCT_CUT_SIZE = '34%';
const OCT_CUT_OFFSET = '-17%';
const OCT_CORNERS = [
  { top: OCT_CUT_OFFSET, left: OCT_CUT_OFFSET },
  { top: OCT_CUT_OFFSET, right: OCT_CUT_OFFSET },
  { bottom: OCT_CUT_OFFSET, left: OCT_CUT_OFFSET },
  { bottom: OCT_CUT_OFFSET, right: OCT_CUT_OFFSET },
];

function OctagonCorners({ skin }) {
  return (
    <>
      {OCT_CORNERS.map((pos, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: OCT_CUT_SIZE,
            height: OCT_CUT_SIZE,
            backgroundColor: skin.cutColor,
            borderWidth: 1,
            borderColor: skin.cutEdgeColor,
            transform: [{ rotate: '45deg' }],
            zIndex: 5,
            ...pos,
          }}
        />
      ))}
    </>
  );
}

function CyberpunkOctagon({ skin, isDark, backgroundColor, borderColor, borderWidth }) {
  if (!web) return <OctagonCorners skin={skin} />;
  const cellDef = isDark ? skin.cells.dark : skin.cells.light;
  const finalBorderColor = borderColor || cellDef.borderColor || '#1b3a55';
  const finalBackgroundColor = backgroundColor || cellDef.backgroundColor || '#0f172a';
  const finalBorderWidth = typeof borderWidth === 'number'
    ? `${borderWidth}px`
    : (borderWidth || '1.5px');
  
  const OCT_CLIP = 'polygon(25% 0%, 75% 0%, 100% 25%, 100% 75%, 75% 100%, 25% 100%, 0% 75%, 0% 25%)';
  const baseColor = skin.cutColor || '#090d16';
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
      {/* Слой рамки */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: finalBorderColor,
          clipPath: OCT_CLIP,
        }}
      />
      {/* Непрозрачная подложка, чтобы полупрозрачные подсветки не смешивались с цветом рамки */}
      <div
        style={{
          position: 'absolute',
          top: finalBorderWidth,
          left: finalBorderWidth,
          right: finalBorderWidth,
          bottom: finalBorderWidth,
          backgroundColor: baseColor,
          clipPath: OCT_CLIP,
        }}
      />
      {/* Фон ячейки (может быть полупрозрачной подсветкой) */}
      <div
        style={{
          position: 'absolute',
          top: finalBorderWidth,
          left: finalBorderWidth,
          right: finalBorderWidth,
          bottom: finalBorderWidth,
          backgroundColor: finalBackgroundColor,
          clipPath: OCT_CLIP,
        }}
      />
    </View>
  );
}

/** Декорация формы ячейки. variant — детерминированное число от координат ячейки. */
export function CellDecoration({ skin, isDark, variant = 0, backgroundColor, borderColor, borderWidth }) {
  if (skin.cellShape === 'octagon') {
    return (
      <CyberpunkOctagon
        skin={skin}
        isDark={isDark}
        backgroundColor={backgroundColor}
        borderColor={borderColor}
        borderWidth={borderWidth}
      />
    );
  }
  // Для Toon (terrain) мы возвращаем null, чтобы убрать мешающие некорректные полосы и мазки
  return null;
}
