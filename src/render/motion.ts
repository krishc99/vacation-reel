// Milestone 8: Ken Burns motion, beat-aware transitions, salient crop.
import type { CropRect } from './crop';

export const MOTION = {
  /** Most a photo zooms over its time on screen (8%). */
  maxZoom: 0.08,
  /** Zoom speed cap, per second on screen, so 1 s cuts don't feel jumpy. */
  zoomPerSec: 0.05,
  /** Crossfade length (s), centred on the cut. */
  fade: 0.2,
  /** Caption fade in/out (s). */
  captionFade: 0.3,
};

export type Transition = 'cut' | 'fade';

/** Box in source pixels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Mostly linear (steady drift) with soft ends. */
export function ease(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return 0.7 * u + 0.3 * (0.5 - 0.5 * Math.cos(Math.PI * u));
}

/**
 * Largest zoom (≤ want) about (ax, ay) that keeps `keep` inside `win`.
 * Zooming about a point keeps that point still on screen while everything
 * else moves away from it, so the people stay put and the frame closes in.
 */
export function safeZoom(win: CropRect, ax: number, ay: number, keep: Box | null, want: number): number {
  if (!keep) return want;
  let z = want;
  const lim = (room: number, need: number) => {
    if (need > 1e-6) z = Math.min(z, room / need);
  };
  lim(ax - win.sx, ax - keep.x0);
  lim(win.sx + win.sw - ax, keep.x1 - ax);
  lim(ay - win.sy, ay - keep.y0);
  lim(win.sy + win.sh - ay, keep.y1 - ay);
  return Math.max(1, z);
}

/** The part of `win` visible at zoom z about (ax, ay). */
export function zoomed(win: CropRect, ax: number, ay: number, z: number): CropRect {
  return { sx: ax - (ax - win.sx) / z, sy: ay - (ay - win.sy) / z, sw: win.sw / z, sh: win.sh / z };
}

/** Zoom amount for a photo on screen `seconds` long. */
export function zoomFor(seconds: number): number {
  return 1 + Math.min(MOTION.maxZoom, MOTION.zoomPerSec * Math.max(0, seconds));
}

/** Zoom at progress u (0..1): even clips push in, odd clips pull out, for variety. */
export function zoomAt(index: number, z: number, u: number): number {
  const e = ease(u);
  return index % 2 === 0 ? 1 + (z - 1) * e : z - (z - 1) * e;
}

/**
 * Cuts on the music: a hard cut on a downbeat (every 4th beat from the first
 * downbeat) and into the chorus; a short crossfade on the beats in between.
 * Without music every change is a crossfade.
 */
export function transitionFor(beatIndex: number | null, downbeatPhase: number, isHighlight: boolean): Transition {
  if (beatIndex === null) return 'fade';
  if (isHighlight) return 'cut';
  return (((beatIndex - downbeatPhase) % 4) + 4) % 4 === 0 ? 'cut' : 'fade';
}

/**
 * Where the interesting part of a photo is, along one axis: given edge energy
 * per column (or row) and the window share that fits, returns the window centre
 * (0..1) with the most detail, nudged toward the middle so plain photos stay centred.
 */
export function salientCentre(profile: ArrayLike<number>, windowShare: number): number {
  const n = profile.length;
  const w = Math.max(1, Math.min(n, Math.round(n * windowShare)));
  if (w >= n) return 0.5;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + profile[i];
  const total = pre[n] || 1;
  let best = 0.5;
  let bestScore = -Infinity;
  for (let s = 0; s + w <= n; s++) {
    const c = (s + w / 2) / n;
    // Share of all detail in the window, minus a small pull toward the centre.
    const score = (pre[s + w] - pre[s]) / total - 0.15 * Math.abs(c - 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
