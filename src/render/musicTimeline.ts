import type { BeatAnalysis } from '../audio/beats';
import { rankSongParts, type SongPart } from '../audio/structure';
import type { Clip, ReelSettings } from '../types';

export type SongStart = 'best' | 'start';

export interface MusicPlan {
  clips: Clip[];
  /** Song time (s) that plays at reel t = 0. Always a downbeat. */
  audioStart: number;
  duration: number;
  beatsPerPhoto: number;
}

export const MUSIC_DEFAULTS = {
  minCut: 0.5,
  maxCut: 1.5,
  /** Preferred seconds per photo; the beat multiple closest to this wins. */
  targetCut: 0.9,
  /** Opener and finale hold this many times longer than a normal photo. */
  holdFactor: 2,
  maxPhotos: 25,
};

function beatPeriod(a: BeatAnalysis): number {
  return a.bpm > 0 ? 60 / a.bpm : 0.5;
}

/** Beats per photo, from the multiples that keep a cut within 0.5–1.5 s. */
function allowedK(P: number): number[] {
  const ks: number[] = [];
  for (let k = 1; k <= 8; k++) if (k * P >= MUSIC_DEFAULTS.minCut - 1e-6 && k * P <= MUSIC_DEFAULTS.maxCut + 1e-6) ks.push(k);
  return ks.length ? ks : [Math.max(1, Math.round(MUSIC_DEFAULTS.targetCut / P))];
}

const beatsNeeded = (n: number, k: number) => (n <= 1 ? 2 * k * MUSIC_DEFAULTS.holdFactor : (n - 2 + 2 * MUSIC_DEFAULTS.holdFactor) * k);

/** How many photos fit in maxSeconds at the preferred pace for this song. */
export function maxPhotosForMusic(a: BeatAnalysis, s: ReelSettings): number {
  const P = beatPeriod(a);
  const k = allowedK(P).reduce((b, k) => (Math.abs(k * P - MUSIC_DEFAULTS.targetCut) < Math.abs(b * P - MUSIC_DEFAULTS.targetCut) ? k : b));
  const perPhoto = k * P;
  const n = Math.floor(s.maxSeconds / perPhoto) - 2 * (MUSIC_DEFAULTS.holdFactor - 1);
  return Math.max(1, Math.min(MUSIC_DEFAULTS.maxPhotos, n));
}

/**
 * Pick beats-per-photo k: total must fit maxSeconds; prefer reaching minSeconds;
 * then the pace closest to targetCut.
 */
function chooseK(n: number, P: number, s: ReelSettings): number {
  const ks = allowedK(P);
  const total = (k: number) => beatsNeeded(n, k) * P;
  const fits = ks.filter((k) => total(k) <= s.maxSeconds + 1e-6);
  const pool = fits.length ? fits : [ks[0]];
  const long = pool.filter((k) => total(k) >= s.minSeconds - 1e-6);
  const pick = long.length ? long : [pool[pool.length - 1]];
  return pick.reduce((b, k) => (Math.abs(k * P - MUSIC_DEFAULTS.targetCut) < Math.abs(b * P - MUSIC_DEFAULTS.targetCut) ? k : b));
}

/** Beat time i, extrapolating past the end of the detected beats if needed. */
function beatAt(a: BeatAnalysis, i: number): number {
  const P = beatPeriod(a);
  if (a.beats.length === 0) return i * P;
  if (i < a.beats.length) return a.beats[i];
  return a.beats[a.beats.length - 1] + (i - a.beats.length + 1) * P;
}

/** Ranked candidate start points ("best part" suggestions) for n photos. */
export function songParts(a: BeatAnalysis, n: number, s: ReelSettings): SongPart[] {
  const k = chooseK(n, beatPeriod(a), s);
  return rankSongParts(a.features, a.downbeatPhase, beatsNeeded(n, k), a.duration, a.beats);
}

function chooseStartBeat(a: BeatAnalysis, n: number, s: ReelSettings, mode: SongStart, part: number): number {
  const first = a.downbeatPhase < a.beats.length ? a.downbeatPhase : 0;
  if (mode === 'start') return first;
  const parts = songParts(a, n, s);
  if (!parts.length) return first;
  return parts[Math.min(part, parts.length - 1)].beat;
}

/** Every cut lands on a detected beat; the reel starts on a downbeat. */
export function planMusicTimeline(photoIds: string[], a: BeatAnalysis, s: ReelSettings, mode: SongStart, part = 0): MusicPlan {
  const n = photoIds.length;
  const P = beatPeriod(a);
  const k = chooseK(n, P, s);
  const hold = k * MUSIC_DEFAULTS.holdFactor;
  const start = chooseStartBeat(a, n, s, mode, part);
  const t0 = beatAt(a, start);

  const clips: Clip[] = [];
  let b = start;
  photoIds.forEach((photoId, i) => {
    const len = i === 0 || i === n - 1 ? hold : k;
    const from = beatAt(a, b);
    const to = beatAt(a, b + len);
    clips.push({ photoId, start: from - t0, duration: to - from });
    b += len;
  });
  const last = clips[clips.length - 1];
  return { clips, audioStart: t0, duration: last ? last.start + last.duration : 0, beatsPerPhoto: k };
}
