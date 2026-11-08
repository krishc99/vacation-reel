import { FFT } from './fft';
import { beatFeatures, type BeatFeatures } from './structure';

/**
 * Beat tracking, no dependencies (essentia.js is AGPL, so it's out).
 * 1. Onset strength: spectral flux of log-magnitude STFT.
 * 2. Tempo: autocorrelation of onset strength, weighted toward ~120 BPM.
 * 3. Beats: dynamic programming (Ellis 2007): beats sit on strong onsets and
 *    keep a steady spacing.
 * 4. Downbeats: the beat phase (of 4) with the most low-frequency (kick) onset.
 */

export interface BeatAnalysis {
  bpm: number;
  /** Beat times, seconds. */
  beats: number[];
  /** Index into `beats` of the first downbeat; downbeats are every 4th beat from it. */
  downbeatPhase: number;
  /** RMS loudness of each beat interval (beats.length − 1 values). */
  beatEnergy: number[];
  /** Per-beat chroma / intensity / section-change features for picking the best part. */
  features: BeatFeatures;
  duration: number;
}

const N = 1024;
const HOP = 256;
const ONSET_LAG_SEC = 0.011;

export interface BeatOptions {
  minBpm: number;
  maxBpm: number;
  /** Tempo prior: centre and width (octaves). */
  preferBpm: number;
  preferOctaves: number;
  /** Higher = steadier beat spacing. */
  tightness: number;
}

export const BEAT_DEFAULTS: BeatOptions = {
  minBpm: 60,
  maxBpm: 200,
  preferBpm: 120,
  preferOctaves: 0.9,
  tightness: 100,
};

/** Onset strength envelopes (full band and kick band), one value per hop. */
export function onsetEnvelopes(mono: Float32Array, sampleRate: number) {
  const fft = new FFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 1 / peak : 1;

  const frames = Math.max(0, Math.floor((mono.length - N) / HOP) + 1);
  const hiBin = Math.min(N / 2, Math.round((8000 / sampleRate) * N));
  const kickBin = Math.max(2, Math.round((150 / sampleRate) * N));
  const full = new Float32Array(frames);
  const kick = new Float32Array(frames);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let prev = new Float32Array(hiBin);
  let cur = new Float32Array(hiBin);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = mono[off + i] * gain * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let sFull = 0;
    let sKick = 0;
    for (let k = 1; k < hiBin; k++) {
      cur[k] = Math.log(1 + 10 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0 && f > 0) {
        sFull += d;
        if (k <= kickBin) sKick += d;
      }
    }
    full[f] = sFull;
    kick[f] = sKick;
    [prev, cur] = [cur, prev];
  }
  return { full: normalizeOnsets(full), kick: normalizeOnsets(kick), fps: sampleRate / HOP, frames };
}

/** Remove slow trend (~0.4 s), keep positive part, scale to unit std. */
function normalizeOnsets(env: Float32Array): Float32Array {
  const n = env.length;
  const out = new Float32Array(n);
  const w = 16;
  let sum = 0;
  const pre: number[] = [0];
  for (let i = 0; i < n; i++) pre.push((sum += env[i]));
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const v = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
    out[i] = v;
    s2 += v * v;
  }
  const std = Math.sqrt(s2 / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= std;
  return out;
}

/** Beat period in frames (fractional), from weighted autocorrelation. */
export function estimatePeriod(env: Float32Array, fps: number, o = BEAT_DEFAULTS): number {
  const minLag = Math.floor((60 * fps) / o.maxBpm);
  const maxLag = Math.ceil((60 * fps) / o.minBpm);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag || 1);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / o.preferBpm) / o.preferOctaves) ** 2);
    const score = ac[lag] * w;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement around the peak.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return best + Math.max(-0.5, Math.min(0.5, delta));
}

/** Ellis DP beat tracker; returns beat frame indices. */
export function trackBeats(env: Float32Array, period: number, tightness: number): number[] {
  const n = env.length;
  if (n === 0) return [];
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const v = score[tau] - tightness * Math.log((t - tau) / period) ** 2;
      if (arg === -1 || v > best) {
        best = v;
        arg = tau;
      }
    }
    score[t] = env[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Start from the best-scoring frame in the last period.
  let t = n - 1;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > score[t]) t = i;
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t];
  }
  return beats.reverse();
}

/** Drop weak beats in silent intros/outros (fade-ins, trailing silence). */
function trimQuiet(beats: number[], env: Float32Array): number[] {
  const local = beats.map((b) => {
    let s = 0;
    for (let i = Math.max(0, b - 2); i <= Math.min(env.length - 1, b + 2); i++) s = Math.max(s, env[i]);
    return s;
  });
  const sorted = [...local].sort((a, b) => a - b);
  const thresh = 0.1 * (sorted[Math.floor(sorted.length / 2)] ?? 0);
  let first = 0;
  let last = beats.length - 1;
  while (first < last && local[first] < thresh) first++;
  while (last > first && local[last] < thresh) last--;
  return beats.slice(first, last + 1);
}

export function analyzeBeats(mono: Float32Array, sampleRate: number, o = BEAT_DEFAULTS): BeatAnalysis {
  const duration = mono.length / sampleRate;
  const { full, kick, fps } = onsetEnvelopes(mono, sampleRate);
  if (full.length < fps * 4)
    return { bpm: 0, beats: [], downbeatPhase: 0, beatEnergy: [], duration, features: { chroma: [], intensity: [], novelty: [] } };

  const period = estimatePeriod(full, fps, o);
  const frames = trimQuiet(trackBeats(full, period, o.tightness), full);
  // Flux at frame f compares windows centred at f and f−1: onset ≈ midway.
  // Plus a measured ~11 ms detector lag (synthetic drums, 87–140 BPM).
  const toSec = (f: number) => (f * HOP + N / 2 - HOP / 2) / sampleRate + ONSET_LAG_SEC;
  const beats = frames.map(toSec);

  let downbeatPhase = 0;
  let bestKick = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    for (let i = p; i < frames.length; i += 4) s += kick[frames[i]] + 0.25 * full[frames[i]];
    if (s > bestKick) {
      bestKick = s;
      downbeatPhase = p;
    }
  }

  const beatEnergy: number[] = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = Math.floor(beats[i] * sampleRate);
    const b = Math.min(mono.length, Math.floor(beats[i + 1] * sampleRate));
    let s = 0;
    for (let j = a; j < b; j++) s += mono[j] * mono[j];
    beatEnergy.push(Math.sqrt(s / Math.max(1, b - a)));
  }

  // Average over the whole track: per-beat intervals are quantised to the 10.7 ms hop.
  const meanInterval = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : period / fps;
  const features = beatFeatures(mono, sampleRate, beats, full, fps);
  return { bpm: 60 / meanInterval, beats, downbeatPhase, beatEnergy, duration, features };
}
