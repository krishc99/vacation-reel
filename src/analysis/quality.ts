import { median, type Gray } from './pixels';

/** Raw per-photo measurements. Album-relative scoring happens in gate.ts. */
export interface QualityStats {
  /**
   * Content-independent sharpness: fine-scale ÷ coarse-scale detail energy in
   * the subject area, noise-corrected. ~0.4–1.5 for sharp photos of anything
   * (faces, food, landscapes); < ~0.2 when blurred.
   */
  sharpness: number;
  /** Mean luma 0..1. */
  meanLuma: number;
  /** Fraction of pixels near black / near white. */
  shadowClip: number;
  highlightClip: number;
  /** Estimated noise sigma (luma levels, 640px plane). */
  noise: number;
}

/** Normalized rect (0..1). Face boxes from Milestone 4 plug in here. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 8;
/** Above this, "noise" is really fine texture (gravel, foliage): don't subtract it. */
const MAX_NOISE_CORRECTION = 5;

/** 4-neighbour Laplacian; output is (w-2)×(h-2). */
function laplacian(g: Gray): Gray {
  const { data, width: w, height: h } = g;
  const ow = w - 2;
  const oh = h - 2;
  const out = new Float32Array(Math.max(0, ow * oh));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[(y - 1) * ow + (x - 1)] = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
    }
  }
  return { data: out, width: ow, height: oh };
}

/** 2×2 box downsample. */
function half(g: Gray): Gray {
  const w = g.width >> 1;
  const h = g.height >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * g.width + 2 * x;
      out[y * w + x] = (g.data[i] + g.data[i + 1] + g.data[i + g.width] + g.data[i + g.width + 1]) / 4;
    }
  }
  return { data: out, width: w, height: h };
}

/** Variance of each cell of a GRID×GRID split. */
function tileVariances(g: Gray): number[] {
  const out: number[] = [];
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const x0 = Math.floor((tx * g.width) / GRID);
      const x1 = Math.floor(((tx + 1) * g.width) / GRID);
      const y0 = Math.floor((ty * g.height) / GRID);
      const y1 = Math.floor(((ty + 1) * g.height) / GRID);
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = g.data[y * g.width + x];
          s += v;
          s2 += v * v;
          n++;
        }
      }
      const m = n ? s / n : 0;
      out.push(n ? s2 / n - m * m : 0);
    }
  }
  return out;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Subject sharpness that doesn't depend on how much detail the scene has.
 * Natural images keep roughly the same fine/coarse detail ratio at any content;
 * blur removes fine detail first, so the ratio collapses. Laplacian noise
 * variance (20σ² fine, 5σ² after 2× box) is subtracted so grain can't fake
 * sharpness. Measured on the most structured quarter of tiles (75th pct), or
 * on tiles inside `regions` (face boxes, M4+).
 */
export function subjectSharpness(g: Gray, regions?: Region[], noiseSigma = 0): number {
  const s = noiseSigma > MAX_NOISE_CORRECTION ? 0 : noiseSigma;
  const fine = tileVariances(laplacian(g));
  const coarse = tileVariances(laplacian(half(g)));
  let tiles = fine.map((vf, i) => {
    const vc = Math.max(1e-6, coarse[i] - 5 * s * s);
    return { i, structure: vc, ratio: Math.max(0, vf - 20 * s * s) / vc };
  });
  if (regions?.length) {
    // Tiles overlapping any region (small faces can sit inside a single tile).
    const inside = tiles.filter(({ i }) => {
      const x0 = (i % GRID) / GRID;
      const y0 = Math.floor(i / GRID) / GRID;
      return regions.some((r) => r.x < x0 + 1 / GRID && r.x + r.w > x0 && r.y < y0 + 1 / GRID && r.y + r.h > y0);
    });
    if (inside.length) tiles = inside;
  } else {
    tiles.sort((a, b) => b.structure - a.structure);
    tiles = tiles.slice(0, Math.max(3, Math.floor(tiles.length / 4)));
  }
  return quantile(
    tiles.map((t) => t.ratio),
    0.75,
  );
}

export function exposure(g: Gray): Pick<QualityStats, 'meanLuma' | 'shadowClip' | 'highlightClip'> {
  let sum = 0;
  let lo = 0;
  let hi = 0;
  for (const v of g.data) {
    sum += v;
    if (v < 10) lo++;
    else if (v > 245) hi++;
  }
  const n = g.data.length || 1;
  return { meanLuma: sum / n / 255, shadowClip: lo / n, highlightClip: hi / n };
}

/**
 * Noise sigma: residual after a 3×3 box blur, measured only in the flattest
 * quarter of tiles (sky, walls) so texture isn't mistaken for noise.
 * Box residual of white noise has std σ·√(8/9); corrected back to σ.
 */
export function noiseSigma(g: Gray): number {
  const { data, width: w, height: h } = g;
  const resid = new Float32Array(w * h);
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += data[i + dy * w + dx];
      resid[i] = data[i] - s / 9;
      grad[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + w] - data[i - w]);
    }
  }
  const tw = w / GRID;
  const th = h / GRID;
  const tiles: { grad: number; sigma: number }[] = [];
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const absRes: number[] = [];
      let gsum = 0;
      for (let y = Math.max(1, Math.floor(ty * th)); y < Math.min(h - 1, Math.floor((ty + 1) * th)); y++) {
        for (let x = Math.max(1, Math.floor(tx * tw)); x < Math.min(w - 1, Math.floor((tx + 1) * tw)); x++) {
          const i = y * w + x;
          absRes.push(Math.abs(resid[i]));
          gsum += grad[i];
        }
      }
      if (absRes.length) tiles.push({ grad: gsum / absRes.length, sigma: (median(absRes) * 1.4826) / Math.sqrt(8 / 9) });
    }
  }
  tiles.sort((a, b) => a.grad - b.grad);
  const flat = tiles.slice(0, Math.max(1, Math.floor(tiles.length / 4)));
  return median(flat.map((t) => t.sigma));
}

/** Sharpness + noise on the 640px plane (detail survives); exposure on 256px. */
export function measureQuality(detail: Gray, small: Gray): QualityStats {
  const noise = noiseSigma(detail);
  return {
    sharpness: subjectSharpness(detail, undefined, noise),
    noise,
    ...exposure(small),
  };
}
