import { groupBursts, groupMoments, type BurstInput } from './bursts';
import type { QualityStats } from './quality';

export type Reason = 'blurry' | 'dark' | 'bright' | 'grainy' | 'weaker';
export type Status = 'keeper' | 'alternate' | 'rejected';

export interface AnalysisInput extends BurstInput {
  stats: QualityStats;
}

export interface Verdict {
  id: string;
  burstId: string;
  status: Status;
  /** Album-relative quality 0..1 (percentile-blended). */
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
  /** Keepers whose Q percentile is below this are set aside (plan: 20th percentile). */
  rejectBelowPct: 0.2,
  /** Photos within this gap of each other form one moment for the "only photo" rule. */
  momentGapSec: 5 * 60,
  /** Too few photos for percentiles to mean anything: no gate. */
  minPhotosForGate: 6,
  weights: { sharp: 0.6, exposure: 0.25, noise: 0.15 },
  /** Noise sigma (luma levels, 640px) below which a photo is never labelled grainy. */
  grainyMinSigma: 3,
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

export function analyzeAlbum(sortedItems: AnalysisInput[], opts = GATE_DEFAULTS): AlbumAnalysis {
  const n = sortedItems.length;
  const sharpPct = percentileRanks(sortedItems.map((p) => p.stats.sharpness));
  const expoPct = percentileRanks(sortedItems.map((p) => exposureScore(p.stats)));
  const noisePct = percentileRanks(sortedItems.map((p) => p.stats.noise));
  const w = opts.weights;
  const qRaw = sortedItems.map((_, i) => w.sharp * sharpPct[i] + w.exposure * expoPct[i] + w.noise * (1 - noisePct[i]));
  const qPct = percentileRanks(qRaw);

  const idx = new Map(sortedItems.map((p, i) => [p.id, i]));
  const verdicts = new Map<string, Verdict>();
  const bursts: Burst[] = groupBursts(sortedItems).map((ids, b) => {
    const keeperId = ids.reduce((best, id) => (qRaw[idx.get(id)!] > qRaw[idx.get(best)!] ? id : best));
    for (const id of ids) {
      verdicts.set(id, {
        id,
        burstId: `b${b}`,
        status: id === keeperId ? 'keeper' : 'alternate',
        q: qRaw[idx.get(id)!],
        reasons: [],
        onlyOfMoment: false,
      });
    }
    return { id: `b${b}`, photoIds: ids, keeperId };
  });

  if (n < opts.minPhotosForGate) return { bursts, verdicts };

  const reasonsFor = (i: number): Reason[] => {
    const r: Reason[] = [];
    if (sharpPct[i] < 0.25) r.push('blurry');
    if (expoPct[i] < 0.25) r.push(sortedItems[i].stats.meanLuma < 0.47 ? 'dark' : 'bright');
    // Relative rank alone would call the least-clean of a clean album "grainy".
    if (noisePct[i] > 0.75 && sortedItems[i].stats.noise > opts.grainyMinSigma) r.push('grainy');
    return r.length ? r : ['weaker'];
  };

  // Gate applies to burst keepers; alternates are already out.
  const keepers = bursts.map((b) => sortedItems[idx.get(b.keeperId)!]);
  const fails = new Set(keepers.filter((p) => qPct[idx.get(p.id)!] < opts.rejectBelowPct).map((p) => p.id));
  for (const moment of groupMoments(keepers, opts.momentGapSec)) {
    const hasGood = moment.some((id) => !fails.has(id));
    for (const id of moment) {
      if (!fails.has(id)) continue;
      const v = verdicts.get(id)!;
      v.reasons = reasonsFor(idx.get(id)!);
      if (hasGood) v.status = 'rejected';
      else v.onlyOfMoment = true;
    }
  }
  return { bursts, verdicts };
}
