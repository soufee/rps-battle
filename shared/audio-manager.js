import { Platform } from 'react-native';
import { playVictoryFanfare } from './victory-fanfare.js';

// Map of asset requires. Metro resolves these at compile time.
// Empty placeholder files must exist in assets/sounds/ to prevent build errors.
const SOUND_ASSETS = {
  bgm_lobby: require('../client/assets/sounds/bgm_lobby.mp3'),
  bgm_battle: require('../client/assets/sounds/bgm_battle.mp3'),
  sfx_move: require('../client/assets/sounds/move.mp3'),
  sfx_opponent_move: require('../client/assets/sounds/opponent_move.mp3'),
  sfx_combat: require('../client/assets/sounds/sfx_combat.wav'),
  sfx_trap: require('../client/assets/sounds/sfx_trap.wav'),
  sfx_tie: require('../client/assets/sounds/sfx_tie.wav'),
  sfx_turn: require('../client/assets/sounds/sfx_turn.wav'),
  sfx_victory: require('../client/assets/sounds/sfx_victory.wav'),
  sfx_defeat: require('../client/assets/sounds/sfx_defeat.wav'),
};

const isWeb = Platform.OS === 'web';
let ExpoAudio = null;
if (!isWeb) {
  try {
    ExpoAudio = require('expo-av').Audio;
  } catch (e) {
    console.warn('[Audio Manager] Failed to require expo-av on native platform:', e.message);
  }
}

// Схема виброотдачи по событиям (Vibration API: Android Chrome, PWA)
const VIBRATION_PATTERNS = {
  move: 10,
  opponent_move: 12,
  combat: 40,
  trap: [30, 40, 80],
  tie: [20, 30, 20],
  turn: 15,
  victory: [40, 60, 40, 60, 140],
  defeat: 90,
};

class AudioManager {
  constructor() {
    this.settings = {
      bgmEnabled: true,
      sfxEnabled: true,
    };
    this.bgmInstance = null;
    this.currentBgmType = null;
  }

  /**
   * Initialize settings
   */
  initialize(settings) {
    if (settings) {
      this.settings = { ...this.settings, ...settings };
    }
    console.log('[Audio Manager] Initialized with settings:', this.settings);
  }

  /**
   * Update audio settings on the fly
   */
  setSettings(newSettings) {
    const oldBgmEnabled = this.settings.bgmEnabled;
    this.settings = { ...this.settings, ...newSettings };

    // If BGM was disabled, stop any active music
    if (oldBgmEnabled && !this.settings.bgmEnabled) {
      this.stopBGM();
    } 
    // If BGM was enabled and we have a target track, resume it
    else if (!oldBgmEnabled && this.settings.bgmEnabled && this.currentBgmType) {
      this.playBGM(this.currentBgmType);
    }
  }

  /** Тактильный отклик (без падений там, где API нет). */
  _vibrate(type) {
    const pattern = VIBRATION_PATTERNS[type];
    if (!pattern) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch (e) {
      // Vibration API недоступен — молча пропускаем
    }
  }

  /**
   * Get raw asset URL/URI
   */
  _getAssetSource(asset) {
    if (!asset) return null;
    if (typeof asset === 'string') return asset;
    if (typeof asset === 'number') {
      // On web required assets resolve to resource paths or resource objects
      return asset; 
    }
    return asset.uri || asset.default || null;
  }

  /**
   * Play background music in a loop
   */
  async playBGM(type) {
    this.currentBgmType = type;

    if (!this.settings.bgmEnabled) {
      console.log(`[Audio Manager] BGM "${type}" ignored: BGM is disabled.`);
      return;
    }

    const asset = SOUND_ASSETS[`bgm_${type}`];
    if (!asset) {
      console.warn(`[Audio Manager] BGM asset "${type}" not found.`);
      return;
    }

    if (isWeb) {
      try {
        if (this.bgmInstance) {
          await this.stopBGM();
        }

        const source = this._getAssetSource(asset);
        console.log(`[Audio Manager Web] Loading BGM: bgm_${type}...`);
        
        const audio = new window.Audio();
        // Prevent crashes on web for empty files
        audio.onerror = (e) => {
          console.log(`[Audio Manager Web] Fallback active: Failed to load BGM "${type}". (File may be empty/invalid)`);
        };
        audio.src = typeof source === 'string' ? source : '';
        audio.loop = true;
        audio.volume = 0.4;
        
        this.bgmInstance = audio;
        
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.log(`[Audio Manager Web] BGM Playback deferred (waiting for interaction):`, err.message);
          });
        }
      } catch (error) {
        console.log(`[Audio Manager Web] Error playing BGM "${type}":`, error.message);
      }
    } else {
      if (!ExpoAudio) return;
      try {
        if (this.bgmInstance) {
          const status = await this.bgmInstance.getStatusAsync();
          if (status.isLoaded && status.isPlaying && this.currentBgmType === type) {
            return;
          }
          await this.stopBGM();
        }

        console.log(`[Audio Manager] Loading BGM: bgm_${type}...`);
        const { sound } = await ExpoAudio.Sound.createAsync(
          asset,
          { shouldPlay: true, isLooping: true, volume: 0.4 },
          null,
          false
        );
        this.bgmInstance = sound;
        await this.bgmInstance.playAsync();
        console.log(`[Audio Manager] Playing BGM: bgm_${type}`);
      } catch (error) {
        console.log(`[Audio Manager] Fallback active: Failed to play BGM "${type}". (File may be empty/invalid):`, error.message);
      }
    }
  }

  /**
   * Stop background music
   */
  async stopBGM() {
    if (!this.bgmInstance) return;

    if (isWeb) {
      try {
        console.log('[Audio Manager Web] Stopping BGM...');
        this.bgmInstance.pause();
        this.bgmInstance.src = '';
      } catch (error) {
        console.log('[Audio Manager Web] Error stopping BGM:', error.message);
      } finally {
        this.bgmInstance = null;
      }
    } else {
      try {
        console.log('[Audio Manager] Stopping BGM...');
        await this.bgmInstance.stopAsync();
        await this.bgmInstance.unloadAsync();
      } catch (error) {
        console.log('[Audio Manager] Error stopping BGM:', error.message);
      } finally {
        this.bgmInstance = null;
      }
    }
  }

  /**
   * Победа: ~2 с синтезированные фанфары (+ виброотдача).
   */
  async playVictoryCelebration() {
    if (!this.settings.sfxEnabled) return;
    this._vibrate('victory');
    await playVictoryFanfare();
  }

  /**
   * Play a short sound effect (+ тактильный отклик, где поддерживается)
   */
  async playSFX(type) {
    if (!this.settings.sfxEnabled) {
      return;
    }

    this._vibrate(type);

    const asset = SOUND_ASSETS[`sfx_${type}`];
    if (!asset) {
      console.warn(`[Audio Manager] SFX asset "${type}" not found.`);
      return;
    }

    if (isWeb) {
      try {
        const source = this._getAssetSource(asset);
        const audio = new window.Audio();
        
        audio.onerror = () => {
          // Silent fallback for empty audio files on web
        };
        audio.src = typeof source === 'string' ? source : '';
        audio.volume = 0.8;
        
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {
            // Ignored: playback blocked by browser security
          });
        }
      } catch (error) {
        // Ignored
      }
    } else {
      if (!ExpoAudio) return;
      try {
        const { sound } = await ExpoAudio.Sound.createAsync(
          asset,
          { shouldPlay: true, volume: 0.8 },
          null,
          false
        );

        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.didJustFinish) {
            sound.unloadAsync().catch((err) => {
              console.log('[Audio Manager] Error unloading sound:', err.message);
            });
          }
        });

        await sound.playAsync();
      } catch (error) {
        console.log(`[Audio Manager] Fallback active: Failed to play SFX "${type}". (File may be empty/invalid):`, error.message);
      }
    }
  }
}

export const audioManager = new AudioManager();
export default audioManager;
