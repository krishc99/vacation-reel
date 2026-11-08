import { median, type Gray } from './pixels';

/** Raw per-photo measurements. Album-relative scoring happens in gate.ts. */
export interface QualityStats {
  /** Laplacian variance of the sharpest subject region (higher = sharper). */
  sharpness: number;
  /** Mean luma 0..1. */
  meanLuma: number;
  /** Fraction of pixels near black / near white. */
  shadowClip: number;
  highlightClip: number;
  /** Robust noise sigma (luma levels) measured on flat areas. */
  noise: number;
}

/** Normalized rect (0..1) — face boxes from Milestone 4 plug in here. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 8;

/** 4-neighbour Laplacian response; borders left at 0. */
function laplacian(g: Gray): Float32Array {
  const { data, width: w, height: h } = g;
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
    }
  }
  return out;
}

interface TileStat {
  x: number;
  y: number;
  lapVar: number;
}

function tileLaplacianVariance(g: Gray, lap: Float32Array): TileStat[] {
  const tiles: TileStat[] = [];
  const tw = g.width / GRID;
  const th = g.height / GRID;
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const x0 = Math.max(1, Math.floor(tx * tw));
      const x1 = Math.min(g.width - 1, Math.floor((tx + 1) * tw));
      const y0 = Math.max(1, Math.floor(ty * th));
      const y1 = Math.min(g.height - 1, Math.floor((ty + 1) * th));
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = lap[y * g.width + x];
          s += v;
          s2 += v * v;
          n++;
        }
      }
      const mean = n ? s / n : 0;
      tiles.push({ x: (tx + 0.5) / GRID, y: (ty + 0.5) / GRID, lapVar: n ? s2 / n - mean * mean : 0 });
    }
  }
  return tiles;
}

/**
 * Subject-area sharpness. With regions (faces, M4+) we use the tiles under them.
 * Without, we take the mean of the 3 sharpest tiles: an in-focus subject on a
 * blurred background (bokeh) scores as sharp; a fully blurred photo does not.
 */
export function subjectSharpness(g: Gray, regions?: Region[]): number {
  const tiles = tileLaplacianVariance(g, laplacian(g));
  let pool = tiles;
  if (regions?.length) {
    const inside = tiles.filter((t) =>
      regions.some((r) => t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h),
    );
    if (inside.length) pool = inside;
  }
  const top = pool.map((t) => t.lapVar).sort((a, b) => b - a).slice(0, 3);
  return top.reduce((a, b) => a + b, 0) / Math.max(1, top.length);
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
      if (absRes.length) tiles.push({ grad: gsum / absRes.length, sigma: median(absRes) * 1.4826 });
    }
  }
  tiles.sort((a, b) => a.grad - b.grad);
  const flat = tiles.slice(0, Math.max(1, Math.floor(tiles.length / 4)));
  return median(flat.map((t) => t.sigma));
}

/** Sharpness + noise on the 640px plane (detail survives); exposure on 256px. */
export function measureQuality(detail: Gray, small: Gray): QualityStats {
  return {
    sharpness: subjectSharpness(detail),
    noise: noiseSigma(detail),
    ...exposure(small),
  };
}
