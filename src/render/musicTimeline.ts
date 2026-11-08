import type { BeatAnalysis } from '../audio/beats';
import { rankSongParts, type SongPart } from '../audio/structure';
import type { Clip, ReelSettings } from '../types';

export type SongStart = 'best' | 'start';

export interface MusicPlan {
  clips: Clip[];
  /** Song time (s) that plays at reel t = 0. Always a downbeat. */
  audioStart: number;
  /** Song time of the chosen highlight (chorus) — lands exactly on the 2nd photo's cut. Null for "from the start". */
  highlight: number | null;
  duration: number;
  beatsPerPhoto: number;
}

export const MUSIC_DEFAULTS = {
  minCut: 0.5,
  maxCut: 1.5,
  /** Preferred seconds per photo; the beat multiple closest to this wins. */
  targetCut: 0.9,
  /** Opener (when not a lead-in) and finale hold this many times longer than a normal photo. */
  holdFactor: 2,
  /** Start this long (rounded to whole bars) before the chorus so you hear it arrive. */
  leadInSec: 3,
  maxPhotos: 25,
};

function beatPeriod(a: BeatAnalysis): number {
  return a.bpm > 0 ? 60 / a.bpm : 0.5;
}

/** Whole bars (4 beats) closest to leadInSec, at least one bar. */
export function leadInBeats(P: number): number {
  return 4 * Math.max(1, Math.round(MUSIC_DEFAULTS.leadInSec / (4 * P)));
}

/** Beats per photo, from the multiples that keep a cut within 0.5–1.5 s. */
function allowedK(P: number): number[] {
  const ks: number[] = [];
  for (let k = 1; k <= 8; k++) if (k * P >= MUSIC_DEFAULTS.minCut - 1e-6 && k * P <= MUSIC_DEFAULTS.maxCut + 1e-6) ks.push(k);
  return ks.length ? ks : [Math.max(1, Math.round(MUSIC_DEFAULTS.targetCut / P))];
}

/**
 * Beats each photo gets. Opener = the lead-in (so the chorus hits on the cut
 * to photo 2) or a 2× hold; finale = 2× hold.
 */
function layout(n: number, k: number, lead: number): number[] {
  const hold = k * MUSIC_DEFAULTS.holdFactor;
  if (n <= 0) return [];
  if (n === 1) return [Math.max(lead, 0) + 2 * hold];
  return Array.from({ length: n }, (_, i) => (i === 0 ? (lead > 0 ? lead : hold) : i === n - 1 ? hold : k));
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

const leadFor = (mode: SongStart, P: number) => (mode === 'best' ? leadInBeats(P) : 0);

function preferredK(P: number): number {
  return allowedK(P).reduce((b, k) => (Math.abs(k * P - MUSIC_DEFAULTS.targetCut) < Math.abs(b * P - MUSIC_DEFAULTS.targetCut) ? k : b));
}

/** How many photos fit in maxSeconds at the preferred pace for this song. */
export function maxPhotosForMusic(a: BeatAnalysis, s: ReelSettings, mode: SongStart = 'best'): number {
  const P = beatPeriod(a);
  const k = preferredK(P);
  const lead = leadFor(mode, P);
  let n = MUSIC_DEFAULTS.maxPhotos;
  while (n > 1 && sum(layout(n, k, lead)) * P > s.maxSeconds + 1e-6) n--;
  return n;
}

/**
 * Pick beats-per-photo k: total must fit maxSeconds; prefer reaching minSeconds;
 * then the pace closest to targetCut.
 */
function chooseK(n: number, P: number, s: ReelSettings, lead: number): number {
  const ks = allowedK(P);
  const total = (k: number) => sum(layout(n, k, lead)) * P;
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

/** Ranked highlight (chorus) start beats for n photos. The reel starts a lead-in earlier. */
export function songParts(a: BeatAnalysis, n: number, s: ReelSettings): SongPart[] {
  const P = beatPeriod(a);
  const lead = leadInBeats(P);
  const k = chooseK(n, P, s, lead);
  // Rank by what plays from the chorus onward.
  return rankSongParts(a.features, a.downbeatPhase, Math.max(4, sum(layout(n, k, lead)) - lead), a.duration, a.beats);
}

/** Every cut lands on a detected beat; the reel starts on a downbeat. */
export function planMusicTimeline(photoIds: string[], a: BeatAnalysis, s: ReelSettings, mode: SongStart, part = 0): MusicPlan {
  const n = photoIds.length;
  const P = beatPeriod(a);
  const first = a.downbeatPhase < a.beats.length ? a.downbeatPhase : 0;

  let start = first;
  let highlightBeat: number | null = null;
  let lead = 0;
  if (mode === 'best') {
    const parts = songParts(a, n, s);
    if (parts.length) {
      highlightBeat = parts[Math.min(part, parts.length - 1)].beat;
      // Back up whole bars, never before the first downbeat.
      start = Math.max(first, highlightBeat - leadInBeats(P));
      lead = highlightBeat - start;
    }
  }
  const k = chooseK(n, P, s, lead);
  const t0 = beatAt(a, start);

  const clips: Clip[] = [];
  let b = start;
  layout(n, k, lead).forEach((len, i) => {
    const from = beatAt(a, b);
    const to = beatAt(a, b + len);
    clips.push({ photoId: photoIds[i], start: from - t0, duration: to - from });
    b += len;
  });
  const last = clips[clips.length - 1];
  return {
    clips,
    audioStart: t0,
    highlight: highlightBeat === null ? null : beatAt(a, highlightBeat),
    duration: last ? last.start + last.duration : 0,
    beatsPerPhoto: k,
  };
}
