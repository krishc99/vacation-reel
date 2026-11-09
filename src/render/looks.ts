// Creative looks (after M8): Clean, Film (disposable camera), Scrapbook (polaroids).
// Pure geometry here (tested); the canvas drawing lives in the render worker.

export type Look = 'clean' | 'film' | 'scrapbook';

export const LOOKS = {
  /** Hard cut "punch": extra zoom that settles over `punchSec`. */
  punch: 0.045,
  punchSec: 0.28,
  /** White flash on the chorus hit. */
  flash: 0.6,
  flashSec: 0.3,
  /** Sparkles burst on the chorus hit. */
  sparkleSec: 0.9,
  /** Scrapbook: a polaroid lands on the beat after falling in for this long. */
  dropSec: 0.38,
  /** Film: light leak brightness between cuts and at its peak on a cut. */
  leakBase: 0.12,
  leakPeak: 0.55,
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Extra zoom right after a hard cut (1 = none). */
export function punchAt(sinceCut: number): number {
  if (sinceCut < 0 || sinceCut >= LOOKS.punchSec) return 1;
  const u = 1 - sinceCut / LOOKS.punchSec;
  return 1 + LOOKS.punch * u * u;
}

/** Flash opacity at time since the accent. */
export function flashAt(since: number): number {
  if (since < 0 || since >= LOOKS.flashSec) return 0;
  return LOOKS.flash * (1 - since / LOOKS.flashSec) ** 2;
}

/** Light leak strength: soft glow always, flaring up around each cut. */
export function leakAt(t: number, cuts: number[]): number {
  let near = Infinity;
  for (const c of cuts) near = Math.min(near, Math.abs(t - c));
  return LOOKS.leakBase + LOOKS.leakPeak * Math.exp(-((near / 0.16) ** 2));
}

/** Overshoots a little, then settles (things landing). */
export function easeOutBack(u: number): number {
  const x = clamp01(u);
  const c = 1.4;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

/** Deterministic "random" in [-1, 1) from an integer. */
export function jitter(i: number, salt = 0): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

export interface Polaroid {
  /** Card size. */
  w: number;
  h: number;
  /** Photo window inside the card (relative to the card's top-left). */
  inner: { x: number; y: number; w: number; h: number };
}

/** Polaroid card for the frame: 4:5 photo in vertical reels, 4:3 in horizontal; thick bottom border. */
export function polaroid(W: number, H: number): Polaroid {
  const vertical = H >= W;
  const iw = vertical ? 0.74 * W : 0.62 * H * (4 / 3);
  const ih = vertical ? iw * (5 / 4) : 0.62 * H;
  const side = iw * 0.055;
  const bottom = iw * 0.2;
  return { w: iw + 2 * side, h: ih + side + bottom, inner: { x: side, y: side, w: iw, h: ih } };
}

export interface Pose {
  /** Card centre. */
  cx: number;
  cy: number;
  /** Radians. */
  rot: number;
  scale: number;
}

/** Where polaroid i rests: slightly off-centre, tilted a few degrees, alternating. */
export function restingPose(i: number, W: number, H: number): Pose {
  const deg = (i % 2 ? 1 : -1) * (1.5 + 2.5 * Math.abs(jitter(i, 1)));
  return {
    cx: W / 2 + jitter(i, 2) * 0.035 * W,
    cy: H * (H >= W ? 0.45 : 0.49) + jitter(i, 3) * 0.015 * H,
    rot: (deg * Math.PI) / 180,
    scale: 1,
  };
}

/** Falling in from below with a spin, landing (u = 1) on the resting pose. */
export function dropPose(i: number, u: number, W: number, H: number): Pose {
  const rest = restingPose(i, W, H);
  const e = easeOutBack(u);
  const k = 1 - e;
  return {
    cx: rest.cx + k * jitter(i, 4) * 0.15 * W,
    cy: rest.cy + k * 1.05 * H,
    rot: rest.rot + k * (i % 2 ? -0.35 : 0.35),
    scale: 1 + k * 0.08,
  };
}

/** Sparkle positions for an accent (normalized), away from the middle where faces usually are. */
export function sparkles(seed: number, n = 7): { x: number; y: number; size: number; delay: number }[] {
  return Array.from({ length: n }, (_, k) => {
    const side = k % 2 ? 1 : -1;
    return {
      x: 0.5 + side * (0.25 + 0.18 * Math.abs(jitter(seed * 31 + k, 5))),
      y: 0.12 + 0.7 * Math.abs(jitter(seed * 31 + k, 6)),
      size: 0.025 + 0.03 * Math.abs(jitter(seed * 31 + k, 7)),
      delay: 0.12 * Math.abs(jitter(seed * 31 + k, 8)),
    };
  });
}

/** Disposable-camera date stamp: 6 01 '26. */
export function stampText(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1} ${String(d.getDate()).padStart(2, '0')} '${String(d.getFullYear()).slice(2)}`;
}

/** Handwritten polaroid note: 3 June. */
export function noteText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}
