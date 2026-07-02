import { Platform } from 'react-native';

const SAMPLE_RATE = 44100;
const DURATION_SEC = 2;

// Классические «та-та-та-тааа» фанфары (~2 с)
const FANFARE_NOTES = [
  { freq: 392.0, start: 0.0, dur: 0.16, gain: 0.72 },   // G4
  { freq: 392.0, start: 0.2, dur: 0.16, gain: 0.76 },   // G4
  { freq: 392.0, start: 0.4, dur: 0.16, gain: 0.8 },    // G4
  { freq: 523.25, start: 0.62, dur: 0.28, gain: 0.86 }, // C5
  { freq: 659.25, start: 0.96, dur: 0.24, gain: 0.9 },  // E5
  { freq: 783.99, start: 1.28, dur: 0.72, gain: 1.0 },  // G5
];

let ExpoAudio = null;
if (Platform.OS !== 'web') {
  try {
    ExpoAudio = require('expo-av').Audio;
  } catch (_) {
    ExpoAudio = null;
  }
}

function noteEnvelope(t, dur, gain) {
  const attack = 0.018;
  const decay = 0.06;
  const sustain = 0.68;
  const release = 0.1;
  let env = gain;
  if (t < attack) env *= t / attack;
  else if (t < attack + decay) env *= 1 - (1 - sustain) * ((t - attack) / decay);
  else env *= sustain;
  const relStart = Math.max(0, dur - release);
  if (t > relStart) env *= Math.max(0, 1 - (t - relStart) / release);
  return env;
}

function brassSample(phase, freq, t) {
  const sine = Math.sin(phase);
  const saw = 2 * ((freq * t) % 1) - 1;
  const tri = 2 * Math.abs(2 * ((freq * t) % 1) - 1) - 1;
  const h2 = Math.sin(phase * 2) * 0.22;
  const h3 = Math.sin(phase * 3) * 0.1;
  return sine * 0.55 + saw * 0.12 + tri * 0.08 + h2 + h3;
}

function renderFanfareBuffer() {
  const length = Math.floor(SAMPLE_RATE * DURATION_SEC);
  const mix = new Float32Array(length);

  for (const note of FANFARE_NOTES) {
    const startIdx = Math.floor(note.start * SAMPLE_RATE);
    const endIdx = Math.min(length, Math.floor((note.start + note.dur) * SAMPLE_RATE));
    for (let i = startIdx; i < endIdx; i++) {
      const t = (i - startIdx) / SAMPLE_RATE;
      const globalT = i / SAMPLE_RATE;
      const env = noteEnvelope(t, note.dur, note.gain);
      const phase = 2 * Math.PI * note.freq * globalT;
      mix[i] += brassSample(phase, note.freq, globalT) * env * 0.34;
    }
  }

  for (let i = 0; i < length; i++) {
    mix[i] = Math.tanh(mix[i] * 1.35);
  }
  return mix;
}

function encodeWav(samples) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function playWithWebAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;

  const ctx = new Ctx();
  const samples = renderFanfareBuffer();
  const audioBuffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
  audioBuffer.getChannelData(0).set(samples);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.82;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(0);
  source.onended = () => {
    ctx.close().catch(() => {});
  };
  return true;
}

function playWithHtmlAudio(wavBuffer) {
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new window.Audio();
  audio.volume = 0.82;
  audio.src = url;
  audio.onended = () => URL.revokeObjectURL(url);
  const p = audio.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return globalThis.btoa(binary);
  }
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(bytes).toString('base64');
  }
  return null;
}

async function playWithExpoAudio(wavBuffer) {
  if (!ExpoAudio) return false;
  const encoded = toBase64(wavBuffer);
  if (!encoded) return false;
  const uri = `data:audio/wav;base64,${encoded}`;
  const { sound } = await ExpoAudio.Sound.createAsync(
    { uri },
    { shouldPlay: true, volume: 0.82 },
    null,
    false
  );
  sound.setOnPlaybackStatusUpdate((status) => {
    if (status.didJustFinish) sound.unloadAsync().catch(() => {});
  });
  return true;
}

export async function playVictoryFanfare() {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (playWithWebAudio()) return;
      playWithHtmlAudio(encodeWav(renderFanfareBuffer()));
      return;
    }

    const wav = encodeWav(renderFanfareBuffer());
    if (await playWithExpoAudio(wav)) return;

    if (typeof window !== 'undefined' && window.Audio) {
      playWithHtmlAudio(wav);
    }
  } catch (err) {
    console.warn('[Victory Fanfare] playback failed:', err.message);
  }
}