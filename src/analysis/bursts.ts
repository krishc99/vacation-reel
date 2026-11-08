import { hamming, type DHash } from './dhash';

export interface BurstInput {
  id: string;
  takenAt: number; // ms
  timeSource: 'exif' | 'file';
  dhash: DHash;
}

export const BURST_DEFAULTS = {
  /** Rapid-fire: within this many seconds, allow more visual change (people moving). */
  fastWindowSec: 3,
  fastMaxDist: 20,
  /** Same moment re-shot: wider window, stricter visual match. */
  windowSec: 30,
  maxDist: 12,
  /** No EXIF time: only adjacent photos that look near-identical. */
  noTimeMaxDist: 8,
  /** Compare against this many most recent burst members (chain linking). */
  lookback: 3,
};

/**
 * Groups time-sorted photos into bursts: consecutive shots close in time AND
 * close in dHash. Never groups on visuals alone across a time gap.
 */
export function groupBursts(sorted: BurstInput[], opts = BURST_DEFAULTS): string[][] {
  const bursts: BurstInput[][] = [];
  for (const p of sorted) {
    const cur = bursts[bursts.length - 1];
    const linked =
      cur?.slice(-opts.lookback).some((q) => {
        const d = hamming(p.dhash, q.dhash);
        if (p.timeSource === 'file' || q.timeSource === 'file') return d <= opts.noTimeMaxDist;
        const dt = Math.abs(p.takenAt - q.takenAt) / 1000;
        return (dt <= opts.fastWindowSec && d <= opts.fastMaxDist) || (dt <= opts.windowSec && d <= opts.maxDist);
      }) ?? false;
    if (linked) cur!.push(p);
    else bursts.push([p]);
  }
  return bursts.map((b) => b.map((p) => p.id));
}

/** Chains items whose gap to the previous is ≤ gapSec into one "moment". */
export function groupMoments(sorted: { id: string; takenAt: number }[], gapSec: number): string[][] {
  const out: string[][] = [];
  let prev: number | null = null;
  for (const p of sorted) {
    if (prev === null || (p.takenAt - prev) / 1000 > gapSec) out.push([]);
    out[out.length - 1].push(p.id);
    prev = p.takenAt;
  }
  return out;
}
