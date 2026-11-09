// Milestone 7: choose the photos (chapters → per-chapter MMR → global coverage)
// and put them in order (beam search, hook first, best moment last).
import { chapters } from '../analysis/chapters';
import type { PhotoScore } from '../analysis/scoring';
import type { Photo } from '../types';
import { clipSim, coverFriends, dedupeReel, ensureMe, isFood, isPeoplePhoto, limitSoloOthers, SIMILAR, type Who } from './index';

/** Scene types that make a good chapter opener ("establishing shot"). */
const ESTABLISHING = new Set(['scenery', 'landmark', 'city', 'sunset']);

export const REEL = {
  /** MMR: penalty per unit of CLIP similarity above `simFloor` (scaled to 0..1 at 1.0). */
  lambda: 0.6,
  simFloor: 0.6,
  /** Bonus for a friend not yet in the reel. */
  newFriend: 0.15,
  /** Food: at most this share of the reel (min 1) unless nothing else is left. */
  foodShare: 0.1,
  beamWidth: 12,
};

export interface ReelPlan {
  picks: Photo[];
  droppedForLength: number;
  chapters: number;
  friendSwaps: number;
}

/** Slots ∝ chapter importance (sum of its 3 best scores), min 1, largest remainder. */
function allocate(groups: Photo[][], max: number, score: (p: Photo) => number): number[] {
  const imp = groups.map((g) => g.map(score).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0));
  const slots = groups.map(() => 0);
  // More chapters than slots: the most important chapters get one each.
  const order = imp.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order.slice(0, Math.min(max, groups.length))) slots[i] = 1;
  let left = max - slots.reduce((s, x) => s + x, 0);
  const total = imp.reduce((s, x, i) => s + (slots[i] ? x : 0), 0) || 1;
  const want = imp.map((v, i) => (slots[i] ? (v / total) * max : 0));
  while (left > 0) {
    let best = -1;
    let gap = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      if (!slots[i] || slots[i] >= groups[i].length) continue;
      const g = want[i] - slots[i];
      if (g > gap) {
        gap = g;
        best = i;
      }
    }
    if (best < 0) break; // every chapter is full
    slots[best]++;
    left--;
  }
  return slots;
}

/**
 * Per chapter, maximal marginal relevance: score − λ·(similarity to what's
 * already picked) + bonus for friends not yet shown. Keeps Krish's rules:
 * people photos first (one scenic "establishing" shot allowed per chapter of 3+
 * slots), food capped across the reel.
 */
function pickChapter(
  group: Photo[],
  slots: number,
  chosen: Photo[],
  score: (p: Photo) => number,
  who: Who,
  food: { used: number; cap: number },
): Photo[] {
  const out: Photo[] = [];
  const pool = [...group];
  const shownFriends = new Set(chosen.flatMap((p) => who.friends(p)));
  let establishing = false;
  const simTo = (p: Photo) => Math.max(0, ...[...chosen, ...out].map((q) => clipSim(p, q)));
  while (out.length < slots && pool.length) {
    // A near-repeat of something already picked doesn't count as "people still to show".
    const peopleLeft = pool.some((p) => isPeoplePhoto(p, who) && simTo(p) < SIMILAR);
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      const people = isPeoplePhoto(p, who);
      const scenic = ESTABLISHING.has(p.scene?.label ?? '');
      if (!people && peopleLeft && !(scenic && slots >= 3 && !establishing)) continue;
      if (isFood(p) && food.used >= food.cap && pool.some((q) => !isFood(q))) continue;
      const sim = simTo(p);
      const fresh = who.friends(p).filter((f) => !shownFriends.has(f)).length;
      const v = score(p) - REEL.lambda * Math.max(0, (sim - REEL.simFloor) / (1 - REEL.simFloor)) + REEL.newFriend * Math.min(fresh, 2);
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    if (best < 0) break;
    const [p] = pool.splice(best, 1);
    if (!isPeoplePhoto(p, who)) establishing = true;
    if (isFood(p)) food.used++;
    who.friends(p).forEach((f) => shownFriends.add(f));
    out.push(p);
  }
  return out;
}

export function chooseReel(candidates: Photo[], max: number, scores: Map<string, PhotoScore>, who: Who): ReelPlan {
  const score = (p: Photo) => scores.get(p.id)?.score ?? 0;
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const groups = chapters(candidates).map((ids) => ids.map((id) => byId.get(id)!));
  if (candidates.length <= max) {
    // Everything fits, but still at most one solo photo of someone else.
    const all = new Set(candidates);
    const trimmed = limitSoloOthers(candidates, all, score, who) + dedupeReel(candidates, all, score, (p) => scores.get(p.id)?.Q ?? 0.5, who);
    if (trimmed) {
      const kept = candidates.filter((p) => all.has(p));
      return { picks: sequence(kept, groups, scores, who), droppedForLength: 0, chapters: groups.length, friendSwaps: trimmed };
    }
    return { picks: sequence(candidates, groups, scores, who), droppedForLength: 0, chapters: groups.length, friendSwaps: 0 };
  }
  const slots = allocate(groups, max, score);
  const food = { used: 0, cap: Math.max(1, Math.floor(max * REEL.foodShare)) };
  const chosen: Photo[] = [];
  groups.forEach((g, i) => chosen.push(...pickChapter(g, slots[i], chosen, score, who, food)));
  const set = new Set(chosen);
  const friendSwaps =
    coverFriends(candidates, set, score, who) +
    ensureMe(candidates, set, score, who) +
    limitSoloOthers(candidates, set, score, who) +
    dedupeReel(candidates, set, score, (p) => scores.get(p.id)?.Q ?? 0.5, who);
  const picked = candidates.filter((p) => set.has(p));
  return {
    picks: sequence(picked, groups, scores, who),
    droppedForLength: candidates.length - picked.length,
    chapters: groups.length,
    friendSwaps,
  };
}

// ---- Sequencing ---------------------------------------------------------------

const kind = (p: Photo, who: Who) => {
  const n = who.known ? who.friends(p).length : (p.people?.count ?? 0);
  return n === 0 ? 'none' : n === 1 ? 'solo' : 'group';
};

/**
 * Beam search over one chapter's order (soft penalties, plan step 5):
 * establishing shot first, ≤ 2 of the same scene type in a row, loose
 * group/solo alternation, and stay roughly chronological.
 */
function orderChapter(items: Photo[], who: Who): Photo[] {
  if (items.length <= 2) return items;
  const hasEstablishing = items.some((p) => ESTABLISHING.has(p.scene?.label ?? ''));
  type State = { seq: Photo[]; cost: number };
  let beam: State[] = [{ seq: [], cost: 0 }];
  for (let step = 0; step < items.length; step++) {
    const next: State[] = [];
    for (const st of beam) {
      for (const p of items) {
        if (st.seq.includes(p)) continue;
        let c = st.cost;
        const seq = [...st.seq, p];
        const n = seq.length;
        if (n === 1 && hasEstablishing && !ESTABLISHING.has(p.scene?.label ?? '')) c += 0.6;
        if (n >= 3 && p.scene && seq[n - 2].scene?.label === p.scene.label && seq[n - 3].scene?.label === p.scene.label) c += 1;
        if (n >= 3 && kind(p, who) === kind(seq[n - 2], who) && kind(p, who) === kind(seq[n - 3], who)) c += 0.3;
        // Stay roughly chronological: every earlier photo jumped over costs a little,
        // so small swaps (to break up runs) are fine but big time jumps aren't.
        c += 0.35 * items.filter((q) => !seq.includes(q) && q.takenAt < p.takenAt).length;
        next.push({ seq, cost: c });
      }
    }
    next.sort((a, b) => a.cost - b.cost);
    beam = next.slice(0, REEL.beamWidth);
  }
  return beam[0].seq;
}

/**
 * Chapters in time order, each ordered by beam search; then plan step 6:
 * open with the strongest hook (best score among people/highlight photos) and
 * close on the photo with the highest moment score.
 */
export function sequence(picks: Photo[], groups: Photo[][], scores: Map<string, PhotoScore>, who: Who): Photo[] {
  const inReel = new Set(picks);
  let out = groups.flatMap((g) => orderChapter(g.filter((p) => inReel.has(p)), who));
  if (out.length < 3) return out;
  const s = (p: Photo) => scores.get(p.id);
  const hook = [...out].sort((a, b) => (s(b)?.score ?? 0) - (s(a)?.score ?? 0))[0];
  out = [hook, ...out.filter((p) => p !== hook)];
  const rest = out.slice(1);
  const finale = [...rest].sort((a, b) => (s(b)?.M ?? 0) - (s(a)?.M ?? 0))[0];
  return [hook, ...rest.filter((p) => p !== finale), finale];
}
