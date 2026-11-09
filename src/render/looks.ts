// Creative looks. Pure geometry and timing here (unit-tested); canvas drawing is in the render worker.
//   clean     full-frame photos, crossfades, zoom punch, flash + sparkles on the chorus
//   film      disposable camera: warm grade, light leaks, grain, orange date stamp
//   filmstrip 35 mm strip that slides one frame per beat
//   booth     photo-booth strips: 3 photos fill in one per beat, each with a flash
//   magazine  editorial cover: huge serif place name, photo over it, issue line
//   split     photo dump: frame splits into 2–3 photos on fast beats, big moments full screen

export type Look = 'clean' | 'film' | 'filmstrip' | 'booth' | 'magazine' | 'split';

export const LOOKS = {
  /** Hard cut "punch": extra zoom that settles over `punchSec`. */
  punch: 0.045,
  punchSec: 0.28,
  /** White flash on the chorus hit. */
  flash: 0.6,
  flashSec: 0.3,
  /** Sparkles burst on the chorus hit. */
  sparkleSec: 0.9,
  /** Film: light leak brightness between cuts and at its peak on a cut. */
  leakBase: 0.12,
  leakPeak: 0.55,
  /** Film strip / booth strip / split cells: movement that lands exactly on the beat. */
  slideSec: 0.32,
  /** Split: cells rearrange over this long after the beat. */
  splitSec: 0.24,
  /** Booth: camera flash on each new cell. */
  boothFlashSec: 0.2,
  /** Split: photos on screen at least this long get the full frame. */
  fullHold: 1.6,
};

/** Which looks draw the overlay captions / flash / sparkles. Others show place and date their own way. */
export const OVERLAY_CAPTIONS: ReadonlySet<Look> = new Set(['clean', 'film', 'split']);
export const FLASH: ReadonlySet<Look> = new Set(['clean', 'film', 'split', 'magazine']);
export const SPARKLES: ReadonlySet<Look> = new Set(['clean', 'split', 'magazine']);
/** How much of a photo (width or height) may be cropped away before it is shown whole over a blur. */
export const COVER_LOSS: Partial<Record<Look, number>> = { split: 0.6, booth: 0.5 };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Extra zoom right after a hard cut (1 = none). */
export function punchAt(sinceCut: number): number {
  if (sinceCut < 0 || sinceCut >= LOOKS.punchSec) return 1;
  const u = 1 - sinceCut / LOOKS.punchSec;
  return 1 + LOOKS.punch * u * u;
}

/** Flash opacity at time since the accent. */
export function flashAt(since: number, peak = LOOKS.flash, len = LOOKS.flashSec): number {
  if (since < 0 || since >= len) return 0;
  return peak * (1 - since / len) ** 2;
}

/** Light leak strength: soft glow always, flaring up around each cut. */
export function leakAt(t: number, cuts: number[]): number {
  let near = Infinity;
  for (const c of cuts) near = Math.min(near, Math.abs(t - c));
  return LOOKS.leakBase + LOOKS.leakPeak * Math.exp(-((near / 0.16) ** 2));
}

/** Overshoots a little, then settles (things landing). */
export function easeOutBack(u: number, c = 1.2): number {
  const x = clamp01(u);
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

export const easeOutCubic = (u: number) => 1 - (1 - clamp01(u)) ** 3;

/** Deterministic "random" in [-1, 1) from an integer. */
export function jitter(i: number, salt = 0): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
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

/** Short date note: 3 June. */
export function noteText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

// ---- Film strip ----------------------------------------------------------------------

export interface FilmStrip {
  vertical: boolean;
  /** Strip band across the frame: offset and thickness on the cross axis. */
  cross0: number;
  cross: number;
  /** Sprocket margin on each side of the picture. */
  margin: number;
  /** Picture size and distance between pictures along the strip. */
  frame: { w: number; h: number };
  pitch: number;
  /** Centre of the current picture along the strip axis. */
  centre: number;
}

/** Vertical reels: a vertical strip of 4:5 frames. Horizontal: a horizontal strip of 7:5 frames. */
export function filmStrip(W: number, H: number): FilmStrip {
  const vertical = H >= W;
  const cross = vertical ? 0.9 * W : 0.86 * H;
  const margin = 0.1 * cross;
  const inner = cross - 2 * margin;
  const frame = vertical ? { w: inner, h: inner * 1.25 } : { w: inner * 1.4, h: inner };
  const along = vertical ? frame.h : frame.w;
  return {
    vertical,
    cross0: ((vertical ? W : H) - cross) / 2,
    cross,
    margin,
    frame,
    pitch: along * 1.06,
    centre: vertical ? 0.47 * H : 0.5 * W,
  };
}

/**
 * Strip position (in frames) at time t: frame k slides into place during the
 * `slideSec` before its cut and lands exactly on it.
 */
export function stripPosition(starts: number[], t: number, slide = LOOKS.slideSec): number {
  let k = 0;
  while (k + 1 < starts.length && t >= starts[k + 1] - slide) k++;
  if (k === 0) return 0;
  const u = (t - (starts[k] - slide)) / slide;
  return k - 1 + easeOutBack(u, 0.9);
}

// ---- Photo-booth strips --------------------------------------------------------------

export interface Booth {
  vertical: boolean;
  /** Strip size; cells are laid out inside it. */
  w: number;
  h: number;
  cells: Rect[];
  /** Area for the handwritten/typed label. */
  label: Rect;
}

export const BOOTH_CELLS = 3;

/** A white strip with 3 cells: stacked 4:3 in vertical reels, side by side 4:5 in horizontal. */
export function booth(W: number, H: number): Booth {
  const vertical = H >= W;
  if (vertical) {
    const w = 0.66 * W;
    const pad = 0.045 * w;
    const gap = 0.6 * pad;
    const cw = w - 2 * pad;
    const ch = (cw * 3) / 4;
    const labelH = 0.17 * w;
    const cells = Array.from({ length: BOOTH_CELLS }, (_, k) => ({ x: pad, y: pad + k * (ch + gap), w: cw, h: ch }));
    const h = pad + BOOTH_CELLS * ch + (BOOTH_CELLS - 1) * gap + labelH;
    return { vertical, w, h, cells, label: { x: pad, y: h - labelH, w: cw, h: labelH } };
  }
  const ch = 0.62 * H;
  const cw = 0.8 * ch;
  const pad = 0.055 * ch;
  const gap = 0.6 * pad;
  const labelH = 0.16 * ch;
  const w = 2 * pad + BOOTH_CELLS * cw + (BOOTH_CELLS - 1) * gap;
  const cells = Array.from({ length: BOOTH_CELLS }, (_, k) => ({ x: pad + k * (cw + gap), y: pad, w: cw, h: ch }));
  const h = pad + ch + labelH;
  return { vertical, w, h, cells, label: { x: pad, y: h - labelH, w: w - 2 * pad, h: labelH } };
}

/**
 * Which clips share a strip. The opener and the finale (and any leftover 1–2
 * at the end) stay full screen; everything between fills strips of 3.
 * Returns, per clip, its strip number and cell (or null = full screen).
 */
export function boothGroups(n: number): ({ strip: number; cell: number } | null)[] {
  const out: ({ strip: number; cell: number } | null)[] = new Array(n).fill(null);
  if (n < 2 + BOOTH_CELLS) return out;
  const middle = n - 2;
  const strips = Math.floor(middle / BOOTH_CELLS);
  for (let k = 0; k < strips * BOOTH_CELLS; k++) out[1 + k] = { strip: Math.floor(k / BOOTH_CELLS), cell: k % BOOTH_CELLS };
  return out;
}

// ---- Magazine ------------------------------------------------------------------------

/** Muted editorial colours; [background, ink]. */
export const MAG_PALETTE: [string, string][] = [
  ['#ece5d8', '#1d1b18'],
  ['#b4583a', '#f6ecdf'],
  ['#d9c6a5', '#24201a'],
  ['#2f3e46', '#efe6d6'],
  ['#8d9a6b', '#f7f2e6'],
  ['#e7cfc4', '#2a1f1c'],
];

export interface MagazineLayout {
  vertical: boolean;
  margin: number;
  /** Title box: font is fitted to its width (and height for horizontal). */
  title: Rect;
  photo: Rect;
  /** Small issue line under the photo (vertical) or title (horizontal). */
  footerY: number;
}

export function magazine(W: number, H: number): MagazineLayout {
  const vertical = H >= W;
  if (vertical) {
    const m = 0.06 * W;
    const title = { x: m, y: 0.04 * H, w: W - 2 * m, h: 0.13 * H };
    // The photo tucks over the foot of the title, like a cover where the subject sits over the masthead.
    const py = title.y + title.h;
    const pw = W - 2 * m;
    const photo = { x: m, y: py, w: pw, h: 0.6 * H };
    return { vertical, margin: m, title, photo, footerY: py + photo.h + 0.03 * H };
  }
  const m = 0.05 * H;
  const photo = { x: 0.42 * W, y: 0.08 * H, w: 0.54 * W, h: 0.84 * H };
  const title = { x: 0.05 * W, y: 0.2 * H, w: 0.4 * W, h: 0.45 * H };
  return { vertical, margin: m, title, photo, footerY: 0.8 * H };
}

// ---- Split-screen photo dump -----------------------------------------------------------

/**
 * Pages of consecutive clips. Opener, finale, the clip on the chorus hit and
 * long holds get the full screen; runs of quick cuts are grouped 2 or 3 to a page.
 */
export function splitPages(durations: number[], starts: number[], accents: number[]): number[][] {
  const n = durations.length;
  const full = (i: number) =>
    i === 0 || i === n - 1 || durations[i] >= LOOKS.fullHold || accents.some((a) => Math.abs(a - starts[i]) < 0.05);
  const pages: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    let r = run.length;
    let k = 0;
    while (r > 0) {
      const size = r === 1 ? 1 : r === 2 || r === 4 ? 2 : 3;
      pages.push(run.slice(k, k + size));
      k += size;
      r -= size;
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (full(i)) {
      flush();
      pages.push([i]);
    } else run.push(i);
  }
  flush();
  return pages;
}

/**
 * Cell rects (normalized 0..1) for a page of `n` photos after `step + 1` of them
 * have appeared: first full screen, then halves, then one half + two quarters.
 */
export function splitLayout(n: number, step: number, vertical: boolean): Rect[] {
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const a: Rect = vertical ? { x: 0, y: 0, w: 1, h: 0.5 } : { x: 0, y: 0, w: 0.5, h: 1 };
  const b: Rect = vertical ? { x: 0, y: 0.5, w: 1, h: 0.5 } : { x: 0.5, y: 0, w: 0.5, h: 1 };
  if (n === 1 || step === 0) return [full];
  if (step === 1) return [a, b];
  const b1: Rect = vertical ? { x: 0, y: 0.5, w: 0.5, h: 0.5 } : { x: 0.5, y: 0, w: 0.5, h: 0.5 };
  const b2: Rect = vertical ? { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } : { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
  return [a, b1, b2];
}

export const lerpRect = (p: Rect, q: Rect, u: number): Rect => ({
  x: p.x + (q.x - p.x) * u,
  y: p.y + (q.y - p.y) * u,
  w: p.w + (q.w - p.w) * u,
  h: p.h + (q.h - p.h) * u,
});
