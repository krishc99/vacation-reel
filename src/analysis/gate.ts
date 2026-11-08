import { groupBursts, groupMoments, type BurstInput } from './bursts';
import type { QualityStats } from './quality';

export type Reason = 'blurry' | 'dark' | 'bright';
export type Status = 'keeper' | 'alternate' | 'rejected';

export interface AnalysisInput extends BurstInput {
  stats: QualityStats;
}

export interface Verdict {
  id: string;
  burstId: string;
  status: Status;
  /** Absolute quality 0..1 (sharpness, exposure, noise). Album percentile is applied in the gate. */
  q: number;
  reasons: Reason[];
  /** Low quality but kept because nothing else covers its moment. */
  onlyOfMoment: boolean;
}

export interface Burst {
  id: string;
  photoIds: string[];
  keeperId: string;
}

export interface AlbumAnalysis {
  bursts: Burst[];
  verdicts: Map<string, Verdict>;
}

export const GATE_DEFAULTS = {
  /** Photos within this gap of each other form one moment for the "only photo" rule. */
  momentGapSec: 5 * 60,
  weights: { sharp: 0.6, exposure: 0.25, noise: 0.15 },
  /**
   * Absolute defect thresholds. Sharpness is content-independent (see quality.ts):
   * sample sharp photos of faces/food/landscapes measured 0.4–1.4, blurred ≤ 0.2.
   */
  blurryBelow: 0.25,
  darkMeanBelow: 0.12,
  darkClipAbove: 0.6,
  brightMeanAbove: 0.88,
  brightClipAbove: 0.45,
};

/** 0 = worst in album, 1 = best; ties share the average rank. */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0.5);
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    const r = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) ranks[order[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

/** 1 = well exposed; drops for very dark/bright means and heavy clipping. */
export function exposureScore(s: QualityStats): number {
  const dev = Math.max(0, Math.abs(s.meanLuma - 0.47) - 0.15) / 0.3;
  return 1 - Math.min(1, dev) - 2 * Math.max(0, s.shadowClip - 0.3) - 2 * Math.max(0, s.highlightClip - 0.15);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0..1, saturates for any sharp photo so content type doesn't rank photos. */
export const sharpScore = (s: QualityStats) => clamp01((s.sharpness - 0.2) / 0.25);
/**
 * Mild penalty only, capped: in full-texture frames (foliage, gravel) the noise
 * estimate is really texture, so noise is never a defect on its own.
 */
export const noiseScore = (s: QualityStats) => clamp01(1 - (Math.min(s.noise, 5) - 2) / 6);

/** Real, absolute problems. Ranking low in the album alone is not a defect. */
export function defects(s: QualityStats, o = GATE_DEFAULTS): Reason[] {
  const r: Reason[] = [];
  if (s.sharpness < o.blurryBelow) r.push('blurry');
  if (s.meanLuma < o.darkMeanBelow || s.shadowClip > o.darkClipAbove) r.push('dark');
  else if (s.meanLuma > o.brightMeanAbove || s.highlightClip > o.brightClipAbove) r.push('bright');
  return r;
}

export function analyzeAlbum(sortedItems: AnalysisInput[], opts = GATE_DEFAULTS): AlbumAnalysis {
  const w = opts.weights;
  const q = sortedItems.map(
    ({ stats: s }) => w.sharp * sharpScore(s) + w.exposure * clamp01(exposureScore(s)) + w.noise * noiseScore(s),
  );

  const idx = new Map(sortedItems.map((p, i) => [p.id, i]));
  // Within a burst the scene is the same, so raw sharpness breaks ties fairly.
  const better = (a: string, b: string) => {
    const ia = idx.get(a)!;
    const ib = idx.get(b)!;
    return q[ia] !== q[ib] ? q[ia] > q[ib] : sortedItems[ia].stats.sharpness > sortedItems[ib].stats.sharpness;
  };
  const verdicts = new Map<string, Verdict>();
  const bursts: Burst[] = groupBursts(sortedItems).map((ids, b) => {
    const keeperId = ids.reduce((best, id) => (better(id, best) ? id : best));
    for (const id of ids) {
      verdicts.set(id, {
        id,
        burstId: `b${b}`,
        status: id === keeperId ? 'keeper' : 'alternate',
        q: q[idx.get(id)!],
        reasons: defects(sortedItems[idx.get(id)!].stats, opts),
        onlyOfMoment: false,
      });
    }
    return { id: `b${b}`, photoIds: ids, keeperId };
  });

  // Gate applies to burst keepers; alternates are already out.
  // Set aside = has a real defect AND the same moment has a clean shot.
  // (The plan's "bottom 20th percentile" rule ranked sharp portraits below sharp
  // food/landscapes, because detail amount ≠ quality. Percentiles return in M7 scoring.)
  const keepers = bursts.map((b) => sortedItems[idx.get(b.keeperId)!]);
  const fails = new Set(keepers.filter((p) => verdicts.get(p.id)!.reasons.length > 0).map((p) => p.id));
  for (const moment of groupMoments(keepers, opts.momentGapSec)) {
    const hasGood = moment.some((id) => !fails.has(id));
    for (const id of moment) {
      if (!fails.has(id)) continue;
      const v = verdicts.get(id)!;
      if (hasGood) v.status = 'rejected';
      else v.onlyOfMoment = true;
    }
  }
  return { bursts, verdicts };
}
