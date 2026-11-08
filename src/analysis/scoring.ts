// Milestone 7: one score per photo. Plan: Score = wQ·Q + wF·F + wC·C + wM·M,
// every term percentile-normalised within the album.
import type { Photo } from '../types';
import type { Who } from '../selection';
import { isPeoplePhoto } from '../selection';
import aesthetic from './aesthetic.json';
import type { Verdict } from './gate';
import labels from './sceneLabels.json';

/**
 * Plan's starting weights were Q .20, F .25, C .20, M .35. Tuned from Krish's
 * feedback (people over food/scenery; blurry shots are already gated out; the
 * aesthetic model rates food photos very highly — coffee 7.1 vs group 5.7):
 * more weight on the moment (who is in it, highlights), less on looks/quality.
 */
export const SCORE_WEIGHTS = { Q: 0.15, F: 0.25, C: 0.15, M: 0.45 };

export interface PhotoScore {
  Q: number;
  F: number;
  C: number;
  M: number;
  score: number;
  /** Raw aesthetic (LAION, ~1–10) for tooltips. */
  aesthetic: number | null;
  /** Which highlight prompt matched best, if strongly. */
  highlight: string | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const HIGHLIGHTS = (labels as { highlights?: Record<string, number[]> }).highlights ?? {};
const W = aesthetic.w as number[];

export function aestheticScore(embedding: number[] | undefined): number | null {
  return embedding && embedding.length === W.length ? dot(embedding, W) + aesthetic.b : null;
}

/** Best highlight prompt: CLIP image–text cosine, ~0.20 unrelated → ~0.30 strong match. */
function highlightOf(embedding: number[] | undefined): { name: string | null; strength: number } {
  if (!embedding) return { name: null, strength: 0 };
  let best: string | null = null;
  let bestSim = -1;
  for (const [name, v] of Object.entries(HIGHLIGHTS)) {
    if (v.length !== embedding.length) continue;
    const s = dot(embedding, v);
    if (s > bestSim) {
      bestSim = s;
      best = name;
    }
  }
  const strength = clamp01((bestSim - 0.22) / 0.08);
  return { name: strength >= 0.5 ? best : null, strength };
}

/** 0 = lowest in album, 1 = highest; ties share the average rank. */
function percentiles(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0.5);
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 / (n - 1);
    i = j + 1;
  }
  return out;
}

const SCENIC = ['scenery', 'sunset', 'landmark', 'city', 'activity', 'nightlife'] as const;

export interface ScoreContext {
  verdicts: Map<string, Verdict>;
  who: Who;
  /** Number of frames in each photo's burst (plan: burst density = importance). */
  burstSize: (p: Photo) => number;
  /** First photo of its chapter (plan: first photo at a new location). */
  firstOfChapter: (p: Photo) => boolean;
}

export function scorePhotos(photos: Photo[], ctx: ScoreContext, w = SCORE_WEIGHTS): Map<string, PhotoScore> {
  const maxBurst = Math.max(1, ...photos.map(ctx.burstSize));
  const raw = photos.map((p) => {
    const v = ctx.verdicts.get(p.id);
    const people = isPeoplePhoto(p, ctx.who);
    // Q: quality (sharpness, exposure, noise), already 0..1.
    const Q = v?.q ?? 0.5;
    // F by mode. Classic people photo: how good the faces are. Otherwise: how scenic.
    let F: number;
    if (people) {
      const fr = v?.faceRank;
      F = 0.5 + 0.5 * (fr && fr.expected ? 0.5 * (fr.passing / fr.expected) + 0.5 * fr.worst : 0.5);
    } else if (p.scene) {
      F = 0.5 * clamp01(SCENIC.reduce((s, k) => s + (p.scene!.probs[k] ?? 0), 0));
    } else F = 0.25;
    // C: how good it looks (LAION aesthetic on CLIP), minus people cut off by the frame.
    const aes = aestheticScore(p.scene?.embedding);
    const cut = v?.faceRank?.issues.some((i) => i.includes('cut off')) ? 0.5 : 0;
    const C = (aes ?? 5) - cut;
    // M: the moment. Friends present (you count extra), burst density, highlight, new place.
    const friends = ctx.who.known ? ctx.who.friends(p) : [];
    const nFriends = ctx.who.known ? friends.length : (p.people?.count ?? 0);
    const me = ctx.who.me && friends.includes(ctx.who.me) ? 1 : 0;
    const hl = highlightOf(p.scene?.embedding);
    const M =
      0.45 * clamp01(nFriends / 4) +
      0.15 * me +
      0.15 * (Math.log(1 + ctx.burstSize(p)) / Math.log(1 + maxBurst)) +
      0.15 * hl.strength +
      0.1 * (ctx.firstOfChapter(p) ? 1 : 0);
    return { Q, F, C, M, aes, hl: hl.name };
  });
  const [pQ, pF, pC, pM] = (['Q', 'F', 'C', 'M'] as const).map((k) => percentiles(raw.map((r) => r[k])));
  const out = new Map<string, PhotoScore>();
  photos.forEach((p, i) => {
    out.set(p.id, {
      Q: pQ[i],
      F: pF[i],
      C: pC[i],
      M: pM[i],
      score: w.Q * pQ[i] + w.F * pF[i] + w.C * pC[i] + w.M * pM[i],
      aesthetic: raw[i].aes,
      highlight: raw[i].hl,
    });
  });
  return out;
}
