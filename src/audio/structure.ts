import { FFT } from './fft';

/**
 * Song structure for picking the "best part" of a song.
 * Loudness alone doesn't work: commercial masters are almost equally loud
 * throughout. A chorus is (a) a section that repeats, (b) more intense than
 * the verse (denser, brighter, more low end), and (c) starts at a section
 * boundary. Features are computed per beat so everything lines up with cuts.
 */

export interface BeatFeatures {
  /** Per beat interval: 12-bin chroma (unit length). */
  chroma: number[][];
  /** Per beat interval: intensity (z-scored blend of loudness, brightness, onset density). */
  intensity: number[];
  /** Per beat: section-change strength (Foote novelty, z-scored). Index = beat. */
  novelty: number[];
}

const N = 4096;
const HOP = 1024;
const BANDS = [60, 250, 500, 1000, 2000, 4000, 8000, 11000];

function zscore(v: number[]): number[] {
  const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length)) || 1;
  return v.map((x) => (x - m) / sd);
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export function beatFeatures(mono: Float32Array, sampleRate: number, beats: number[], onset: Float32Array, onsetFps: number): BeatFeatures {
  const nb = beats.length - 1;
  if (nb < 2) return { chroma: [], intensity: [], novelty: [] };

  // STFT frames → accumulate into the beat interval containing the frame centre.
  const fft = new FFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const binPc = new Int8Array(N / 2).fill(-1);
  const binBand = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sampleRate) / N;
    if (f >= 80 && f <= 5000) binPc[k] = (((Math.round(12 * Math.log2(f / 440)) + 69) % 12) + 12) % 12;
    for (let b = 0; b + 1 < BANDS.length; b++) if (f >= BANDS[b] && f < BANDS[b + 1]) binBand[k] = b;
  }
  const nBands = BANDS.length - 1;
  const chroma = Array.from({ length: nb }, () => new Array<number>(12).fill(0));
  const bands = Array.from({ length: nb }, () => new Array<number>(nBands).fill(0));
  const counts = new Array<number>(nb).fill(0);

  let bi = 0;
  for (let off = 0; off + N <= mono.length; off += HOP) {
    const t = (off + N / 2) / sampleRate;
    while (bi < nb && t >= beats[bi + 1]) bi++;
    if (bi >= nb) break;
    if (t < beats[0]) continue;
    for (let i = 0; i < N; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (binPc[k] >= 0) chroma[bi][binPc[k]] += Math.sqrt(p);
      if (binBand[k] >= 0) bands[bi][binBand[k]] += p;
    }
    counts[bi]++;
  }

  // Beats with no frame (very fast tempo): copy the previous one.
  for (let i = 0; i < nb; i++) {
    if (counts[i] === 0 && i > 0) {
      chroma[i] = [...chroma[i - 1]];
      bands[i] = [...bands[i - 1]];
      counts[i] = counts[i - 1] || 1;
    }
  }
  const chromaN = chroma.map(normalize);
  const logBands = bands.map((b, i) => b.map((x) => Math.log(1e-9 + x / Math.max(1, counts[i]))));

  // Intensity: overall level, high-band share (brightness), low-band level, onset density.
  const level = logBands.map((b) => Math.log(b.reduce((s, x) => s + Math.exp(x), 0) + 1e-12));
  const bright = logBands.map((b) => b[4] + b[5] + b[6] - (b[1] + b[2] + b[3]));
  const low = logBands.map((b) => b[0]);
  const dens = beats.slice(0, nb).map((t, i) => {
    const a = Math.floor(t * onsetFps);
    const z = Math.max(a + 1, Math.floor(beats[i + 1] * onsetFps));
    let s = 0;
    for (let f = a; f < z && f < onset.length; f++) s += onset[f];
    return s / (z - a);
  });
  const [zl, zb, zlo, zd] = [level, bright, low, dens].map(zscore);
  const intensity = zl.map((_, i) => 0.35 * zl[i] + 0.25 * zb[i] + 0.15 * zlo[i] + 0.25 * zd[i]);

  // Novelty: Foote checkerboard kernel along the diagonal of a self-similarity
  // matrix of [chroma, timbre] features.
  const timbre = logBands.map((b) => b.slice());
  for (let k = 0; k < nBands; k++) {
    const z = zscore(timbre.map((t) => t[k]));
    timbre.forEach((t, i) => (t[k] = z[i]));
  }
  const feat = chromaN.map((c, i) => normalize([...c, ...timbre[i].map((x) => 0.35 * x)]));
  const L = 8;
  const nov = new Array<number>(nb + 1).fill(0);
  for (let i = L; i <= nb - L; i++) {
    let s = 0;
    for (let a = -L; a < L; a++) {
      for (let b = -L; b < L; b++) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (L / 2) ** 2));
        s += sign * g * dot(feat[i + a], feat[i + b]);
      }
    }
    nov[i] = Math.max(0, s);
  }
  return { chroma: chromaN, intensity, novelty: zscore(nov) };
}

export interface SongPart {
  /** Beat index where the reel would start (a downbeat). */
  beat: number;
  score: number;
}

/**
 * Rank downbeats as reel start points for a reel `span` beats long.
 * score = 1.0·intensity(window) + 1.0·repetition(chorus-ness) + 0.6·boundary
 * minus a penalty for the intro / outro. Returns distinct parts (≥ 16 beats apart).
 */
export function rankSongParts(f: BeatFeatures, downbeatPhase: number, span: number, duration: number, beats: number[]): SongPart[] {
  const nb = f.intensity.length;
  if (nb < 8) return [];
  const starts: number[] = [];
  for (let b = downbeatPhase; b < nb; b += 4) if (b + Math.min(span, nb) <= nb || starts.length === 0) starts.push(b);
  const usable = starts.filter((b) => b + span <= nb);
  const cand = usable.length ? usable : [starts[0]];

  const W = Math.min(span, 32, nb);
  const repetition = (b: number) => {
    let best = 0;
    for (let j = 0; j + W <= nb; j++) {
      if (Math.abs(j - b) < Math.max(8, W / 2)) continue;
      let s = 0;
      for (let t = 0; t < W && b + t < nb; t++) s += dot(f.chroma[b + t], f.chroma[j + t]);
      best = Math.max(best, s / W);
    }
    return best;
  };
  const meanIntensity = (b: number) => {
    const end = Math.min(nb, b + span);
    let s = 0;
    for (let i = b; i < end; i++) s += f.intensity[i];
    return s / Math.max(1, end - b);
  };
  const boundary = (b: number) => Math.max(...[-1, 0, 1].map((d) => f.novelty[b + d] ?? -1));

  const rep = zscore(cand.map(repetition));
  const inten = zscore(cand.map(meanIntensity));
  const bound = zscore(cand.map(boundary));
  const scored = cand.map((b, i) => {
    const t = beats[b] / duration;
    const tEnd = (beats[Math.min(b + span, beats.length - 1)] ?? duration) / duration;
    const edge = (t < 0.08 ? 1.5 : 0) + (tEnd > 0.97 ? 1 : 0);
    return { beat: b, score: 1.0 * inten[i] + 1.0 * rep[i] + 0.6 * bound[i] - edge };
  });
  scored.sort((a, b) => b.score - a.score);

  const picked: SongPart[] = [];
  for (const s of scored) {
    if (picked.every((p) => Math.abs(p.beat - s.beat) >= 16)) picked.push(s);
    if (picked.length >= 6) break;
  }
  return picked;
}

/**
 * Length (beats) of the section starting at `start`. Sections end on phrase
 * boundaries, so only whole 2-bar lengths are considered, in order of how common
 * they are for a chorus (8 bars, 16, 4, 12, …). The first with a clear section
 * change there wins (the strongest change overall is often the NEXT chorus).
 * Falls back to 8 bars.
 */
export function sectionLength(f: BeatFeatures, start: number): number {
  const nb = f.novelty.length;
  for (const m of [32, 64, 16, 48, 24, 40, 56]) {
    const c = start + m;
    if (c + 1 >= nb) continue;
    if (Math.max(f.novelty[c - 1], f.novelty[c], f.novelty[c + 1]) >= 1.0) return m;
  }
  return 32;
}
