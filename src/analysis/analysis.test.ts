import { describe, expect, it } from 'vitest';
import { groupBursts, groupMoments } from './bursts';
import { dhash, hamming, type DHash } from './dhash';
import { analyzeAlbum, percentileRanks, type AnalysisInput } from './gate';
import type { Gray } from './pixels';
import { exposure, noiseSigma, subjectSharpness, type QualityStats } from './quality';

// Deterministic PRNG so tests are stable.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function makeGray(w: number, h: number, f: (x: number, y: number) => number): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { data, width: w, height: h };
}

function blur(g: Gray, r: number): Gray {
  return makeGray(g.width, g.height, (x, y) => {
    let s = 0;
    let n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(g.width - 1, Math.max(0, x + dx));
        const yy = Math.min(g.height - 1, Math.max(0, y + dy));
        s += g.data[yy * g.width + xx];
        n++;
      }
    return s / n;
  });
}

const checker = (x: number, y: number) => (((x >> 3) + (y >> 3)) % 2 ? 220 : 40);

describe('dhash', () => {
  it('is stable under blur and brightness shift, different for different scenes', () => {
    const a = makeGray(128, 96, (x, y) => (x * 2 + y) % 256);
    const b = makeGray(128, 96, (x, y) => ((x * 2 + y) % 256) * 0.8 + 20);
    const c = makeGray(128, 96, (x, y) => 255 - ((x * 3 + y * 5) % 256));
    expect(hamming(dhash(a), dhash(a))).toBe(0);
    expect(hamming(dhash(a), dhash(b))).toBeLessThanOrEqual(4);
    expect(hamming(dhash(a), dhash(c))).toBeGreaterThan(20);
  });
  it('popcount over both halves', () => {
    expect(hamming([0xffffffff, 0], [0, 0xffffffff])).toBe(64);
  });
});

describe('quality', () => {
  const sharp = makeGray(160, 120, checker);
  const blurred = blur(sharp, 3);
  it('sharp > blurred', () => {
    expect(subjectSharpness(sharp)).toBeGreaterThan(subjectSharpness(blurred) * 5);
  });
  it('bokeh: sharp subject on blurred background scores close to fully sharp', () => {
    const bokeh = makeGray(160, 120, (x, y) => (x > 50 && x < 110 && y > 30 && y < 90 ? checker(x, y) : blurred.data[y * 160 + x]));
    expect(subjectSharpness(bokeh)).toBeGreaterThan(subjectSharpness(sharp) * 0.6);
  });
  it('regions restrict measurement to faces', () => {
    const half = makeGray(160, 120, (x, y) => (x < 80 ? checker(x, y) : blurred.data[y * 160 + x]));
    const onBlur = subjectSharpness(half, [{ x: 0.55, y: 0, w: 0.45, h: 1 }]);
    expect(onBlur).toBeLessThan(subjectSharpness(half) / 5);
  });
  it('noise sigma tracks added noise, ignores texture', () => {
    const r = rng(1);
    const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
    const clean = makeGray(160, 120, (x) => 100 + x * 0.3);
    const noisy = makeGray(160, 120, (x) => 100 + x * 0.3 + gauss() * 8);
    expect(noiseSigma(clean)).toBeLessThan(1);
    expect(noiseSigma(noisy)).toBeGreaterThan(4);
  });
  it('exposure clip fractions', () => {
    const dark = exposure(makeGray(10, 10, () => 3));
    expect(dark.shadowClip).toBe(1);
    expect(dark.meanLuma).toBeLessThan(0.05);
  });
});

describe('percentileRanks', () => {
  it('handles ties and singletons', () => {
    expect(percentileRanks([5])).toEqual([0.5]);
    expect(percentileRanks([1, 2, 2, 3])).toEqual([0, 0.5, 0.5, 1]);
  });
});

const H = (n: number): DHash => [n >>> 0, 0];
const T0 = Date.UTC(2026, 9, 22, 9);

describe('bursts', () => {
  it('links close-in-time + similar, splits on time gap or visual change', () => {
    const ids = groupBursts([
      { id: 'a', takenAt: T0, timeSource: 'exif', dhash: H(0) },
      { id: 'b', takenAt: T0 + 1000, timeSource: 'exif', dhash: H(0xff) }, // 8 bits, 1s → same
      { id: 'c', takenAt: T0 + 20_000, timeSource: 'exif', dhash: H(0xf) }, // 4 from a, 20s → same
      { id: 'd', takenAt: T0 + 25_000, timeSource: 'exif', dhash: H(0xffffff) }, // 24 bits → new
      { id: 'e', takenAt: T0 + 3_600_000, timeSource: 'exif', dhash: H(0xffffff) }, // 1h later → new
    ]);
    expect(ids).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
  });
  it('moments chain by gap', () => {
    const m = groupMoments(
      [0, 60, 200, 1000].map((s, i) => ({ id: String(i), takenAt: T0 + s * 1000 })),
      300,
    );
    expect(m).toEqual([['0', '1', '2'], ['3']]);
  });
});

describe('analyzeAlbum', () => {
  const good: QualityStats = { sharpness: 500, meanLuma: 0.5, shadowClip: 0.01, highlightClip: 0.01, noise: 2 };
  const blurry: QualityStats = { ...good, sharpness: 5 };
  const item = (id: string, min: number, stats: QualityStats, hash: number): AnalysisInput => ({
    id,
    takenAt: T0 + min * 60_000,
    timeSource: 'exif',
    dhash: H(hash),
    stats,
  });
  // Distinct hashes (≥16 bits apart) so nothing bursts unless intended.
  const hashes = [0x0, 0xffff, 0xffff0000, 0x00ffff00, 0xf0f0f0f0, 0x0f0f0f0f, 0x33333333, 0xcccccccc];

  it('rejects a blurry shot when its moment has a good one; keeps it when it is the only one', () => {
    const items = [
      item('g1', 0, good, hashes[0]),
      item('bad-shared', 2, blurry, hashes[1]), // same moment as g1 → rejected
      item('g2', 60, { ...good, sharpness: 400 }, hashes[2]),
      item('g3', 120, { ...good, sharpness: 450 }, hashes[3]),
      item('g4', 180, { ...good, sharpness: 300 }, hashes[4]),
      item('g5', 240, { ...good, sharpness: 350 }, hashes[5]),
      item('bad-alone', 600, { ...blurry, sharpness: 4 }, hashes[6]), // nothing else near → kept
      item('g6', 700, { ...good, sharpness: 420 }, hashes[7]),
    ];
    const a = analyzeAlbum(items);
    expect(a.verdicts.get('bad-shared')!.status).toBe('rejected');
    expect(a.verdicts.get('bad-shared')!.reasons).toContain('blurry');
    expect(a.verdicts.get('bad-alone')!.status).toBe('keeper');
    expect(a.verdicts.get('bad-alone')!.onlyOfMoment).toBe(true);
  });

  it('picks the sharpest frame of a burst as keeper', () => {
    const items = [
      item('b1', 0, { ...good, sharpness: 100 }, 0),
      item('b2', 0.01, { ...good, sharpness: 900 }, 1),
      item('b3', 0.02, { ...good, sharpness: 50 }, 3),
    ];
    const a = analyzeAlbum(items);
    expect(a.bursts).toHaveLength(1);
    expect(a.bursts[0].keeperId).toBe('b2');
    expect(a.verdicts.get('b1')!.status).toBe('alternate');
  });
});
