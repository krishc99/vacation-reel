// Analysis module. M2: quality stats, dHash bursts, quality gate.
// M4+ adds CLIP, faces, pose; they feed Region[] into subjectSharpness.
import type { AlbumAnalysis } from './gate';

export { analyzeAlbum, type AlbumAnalysis, type Burst, type Reason, type Verdict } from './gate';

/** User decisions that override the automatic ones. */
export interface Overrides {
  /** burstId → photo the user picked instead of the automatic keeper. */
  keeper: Map<string, string>;
  /** Set-aside photos the user wants back. */
  include: Set<string>;
  /** Photos the user removed. */
  exclude: Set<string>;
}

export const emptyOverrides = (): Overrides => ({ keeper: new Map(), include: new Set(), exclude: new Set() });

export type TileState = 'keeper' | 'alternate' | 'rejected' | 'excluded';

/** State of one photo after overrides; drives both UI and candidate list. */
export function tileState(id: string, a: AlbumAnalysis, ov: Overrides): TileState {
  const v = a.verdicts.get(id)!;
  const burst = a.bursts.find((b) => b.id === v.burstId)!;
  const keeperId = ov.keeper.get(burst.id) ?? burst.keeperId;
  if (id !== keeperId) return 'alternate';
  if (ov.exclude.has(id)) return 'excluded';
  // A keeper the user chose by hand is never auto-rejected.
  if (v.status === 'rejected' && !ov.include.has(id) && !ov.keeper.has(burst.id)) return 'rejected';
  return 'keeper';
}

/** One photo per burst that survives the gate and overrides, in burst (chronological) order. */
export function candidateIds(a: AlbumAnalysis, ov: Overrides): string[] {
  const out: string[] = [];
  for (const b of a.bursts) {
    const id = ov.keeper.get(b.id) ?? b.keeperId;
    if (tileState(id, a, ov) === 'keeper') out.push(id);
  }
  return out;
}
