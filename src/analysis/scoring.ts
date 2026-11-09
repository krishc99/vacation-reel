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
 * Later (Krish: "focus on photography skill: angle, lighting"): C .15 → .20, M .45 → .40,
 * and C now includes how well the faces are lit.
 */
export const SCORE_WEIGHTS = { Q: 0.15, F: 0.25, C: 0.2, M: 0.4 };

/**
 * Once you've marked yourself: photos with you get a lift; solo photos of
 * someone else (just them, not you) drop. Groups without you are unchanged.
 */
export const ME_BOOST = 0.2;
export const SOLO_OTHER_PENALTY = 0.3;
/** At least half the faces covered (hands over face). */
export const COVERED_PENALTY = 0.25;
/** Photo without a camera date. */
export const NO_DATE_PENALTY = 0.1;
/** Video moments. */
export const VIDEO_BOOST = 0.06;

export interface PhotoScore {
  Q: number;
  F: number;
  C: number;
  M: number;
  score: number;
  /** Raw aesthetic (LAION, ~1–10) for tooltips. */
  aesthetic: number | null;
  /** Absolute quality 0..1 (sharpness, exposure, noise), for comparing two near-identical shots. */
  q: number;
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

/**
 * Face lighting bonus, about −0.6…+0.6 (the aesthetic score spans ~4–8): faces
 * around mid-bright (0.45–0.65) are well lit; the bigger faces count more.
 */
export function faceLighting(p: Photo): number {
  const faces = (p.people?.faces ?? []).filter((f) => f.light !== undefined && f.box.h >= 0.03);
  if (!faces.length) return 0;
  let w = 0;
  let sum = 0;
  for (const f of faces) {
    const l = f.light!;
    const good = l < 0.45 ? clamp01((l - 0.15) / 0.3) : l > 0.65 ? clamp01((0.92 - l) / 0.27) : 1;
    sum += f.box.h * good;
    w += f.box.h;
  }
  return 1.2 * (sum / w) - 0.6;
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
  // No cap on group size (Krish): every extra person adds. The scale is the size
  // of your group (the friends who keep appearing), not the most faces in any one
  // photo: dividing by the latter (one crowded photo) squashed the difference
  // between a couple and a group, so landmarks and "first photo of a chapter"
  // started outranking group shots.
  const groupSize = ctx.who.known ? Math.max(3, new Set(photos.flatMap((p) => ctx.who.friends(p))).size) : 5;
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
    // C: how good it looks as a photograph: LAION aesthetic on CLIP (composition,
    // colour, light, angle as people rate them), how well the faces are lit (dark =
    // backlit or in shadow, washed out = blown), minus people cut off by the frame.
    const aes = aestheticScore(p.scene?.embedding);
    const cut = v?.faceRank?.issues.some((i) => i.includes('cut off')) ? 0.5 : 0;
    const C = (aes ?? 5) - cut + faceLighting(p);
    // M: the moment. Friends present (you count extra), burst density, highlight, new place.
    const friends = ctx.who.known ? ctx.who.friends(p) : [];
    const nFriends = ctx.who.known ? friends.length : (p.people?.count ?? 0);
    const me = ctx.who.me && friends.includes(ctx.who.me) ? 1 : 0;
    const hl = highlightOf(p.scene?.embedding);
    const M =
      // Bigger groups always count more (Krish: prefer the photos with more of us together, no cap).
      0.45 * (nFriends / groupSize) +
      0.15 * me +
      0.15 * (Math.log(1 + ctx.burstSize(p)) / Math.log(1 + maxBurst)) +
      0.15 * hl.strength +
      0.1 * (ctx.firstOfChapter(p) ? 1 : 0);
    return { Q, F, C, M, aes, hl: hl.name };
  });
  const [, pF, pC, pM] = (['Q', 'F', 'C', 'M'] as const).map((k) => percentiles(raw.map((r) => r[k])));
  // Quality stays absolute: most usable photos score ~0.93–1.0, and ranking those
  // tiny differences (Krish's report: q .93 → bottom 9%) unfairly sank good group shots.
  const pQ = raw.map((r) => r.Q);
  const out = new Map<string, PhotoScore>();
  const me = ctx.who.me;
  photos.forEach((p, i) => {
    let adj = 0;
    if (me) {
      const friends = ctx.who.friends(p);
      if (friends.includes(me)) adj = ME_BOOST;
      else if (friends.length === 1 && (p.people?.count ?? 0) <= 1) adj = -SOLO_OTHER_PENALTY;
    }
    // Faces hidden behind hands etc.: mostly-covered photos drop.
    const faces = p.people?.faces ?? [];
    const hidden = faces.filter((f) => f.covered).length;
    if (faces.length && hidden * 2 >= faces.length) adj -= COVERED_PENALTY;
    // No camera date (forwarded/WhatsApp copies, screenshots of photos): can't be
    // placed in the story, often a lower-quality copy of something else.
    if (p.timeSource !== 'exif') adj -= NO_DATE_PENALTY;
    // A moving moment brings the reel to life.
    if (p.video) adj += VIDEO_BOOST;
    out.set(p.id, {
      Q: pQ[i],
      F: pF[i],
      C: pC[i],
      M: pM[i],
      score: w.Q * pQ[i] + w.F * pF[i] + w.C * pC[i] + w.M * pM[i] + adj,
      aesthetic: raw[i].aes,
      q: raw[i].Q,
      highlight: raw[i].hl,
    });
  });
  return out;
}
