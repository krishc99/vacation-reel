import type { Photo } from '../types';

export interface Selection {
  picks: Photo[];
  /** Photos left out only because the reel would run past its maximum length. */
  droppedForLength: number;
  /** Friends swapped in so everyone appears at least once. */
  friendSwaps: number;
  /** Near-repeat shots swapped for different-looking ones. */
  varietySwaps: number;
}

/**
 * Who is in a photo, as far as selection cares. Before friend recognition has
 * run, every detected person counts. After it, only friends count: a photo
 * whose only faces are one-off strangers in the background is a scenery photo.
 */
export interface Who {
  /** Friend ids in this photo (empty if identity unknown or no friends). */
  friends(p: Photo): string[];
  /** True once friend recognition has run for the album. */
  known: boolean;
  /** The person the user marked as themselves. */
  me?: string | null;
}

export const NO_WHO: Who = { friends: () => [], known: false };

/**
 * A person in the photo we can't identify but who is clearly the subject: a
 * face too side-on or covered to recognise (behind a camera), or a body seen
 * from behind that fills much of the frame.
 */
const unidentifiedSubject = (p: Photo) =>
  (p.people?.faces ?? []).some((f) => !f.embedding && f.box.h >= 0.07) || (p.people?.bodies ?? []).some((b) => b.box.h >= 0.45);

export function isPeoplePhoto(p: Photo, who: Who = NO_WHO): boolean {
  if (!p.people || p.people.count === 0) return false;
  if (!who.known) return true;
  return who.friends(p).length > 0 || unidentifiedSubject(p);
}

/**
 * How much a photo deserves a slot (until M7 scoring). People first: any photo
 * with people beats any without; more friends, bigger faces and open eyes help.
 * `quality` (0..1) breaks ties.
 */
/** Scenes that make good establishing / highlight shots get a small boost among non-people photos. */
const SCENE_BONUS: Record<string, number> = { sunset: 0.4, landmark: 0.4, scenery: 0.3, city: 0.2, activity: 0.3, nightlife: 0.2, vehicle: -0.1, room: -0.2 };

export function slotScore(p: Photo, quality: number, who: Who = NO_WHO): number {
  const ppl = p.people;
  if (!ppl || !isPeoplePhoto(p, who)) return quality + (p.scene ? (SCENE_BONUS[p.scene.label] ?? 0) : 0);
  const n = who.known ? Math.max(1, who.friends(p).length) : ppl.count;
  const withMe = who.me && who.friends(p).includes(who.me) ? 0.4 : 0;
  const open = ppl.faces.length ? ppl.eyesOpen / ppl.faces.length : 0.5;
  return 2 + withMe + (0.5 * Math.min(n, 4)) / 4 + 0.5 * Math.min(1, ppl.largestFace * 3) + 0.3 * open + 0.2 * quality;
}

/**
 * You're usually behind the camera, so you'd barely appear. With "me" chosen,
 * the reel keeps at least max(2, 1 in 5 photos) of you, if the album has them,
 * swapping out the weakest picks without you (never a friend's only photo).
 */
export function ensureMe(all: Photo[], picks: Set<Photo>, score: (p: Photo) => number, who: Who): number {
  const me = who.me;
  if (!me) return 0;
  const mine = (p: Photo) => who.friends(p).includes(me);
  const target = Math.min(all.filter(mine).length, Math.max(2, Math.ceil(picks.size / 5)));
  let swaps = 0;
  while ([...picks].filter(mine).length < target) {
    const incoming = all.filter((p) => mine(p) && !picks.has(p)).sort((a, b) => score(b) - score(a))[0];
    const count = new Map<string, number>();
    for (const q of picks) for (const f of who.friends(q)) count.set(f, (count.get(f) ?? 0) + 1);
    const victim = [...picks]
      .filter((p) => !mine(p) && who.friends(p).every((f) => (count.get(f) ?? 0) > 1))
      .sort((a, b) => score(a) - score(b))[0];
    if (!incoming || !victim) break;
    picks.delete(victim);
    picks.add(incoming);
    swaps++;
  }
  return swaps;
}

/** Best-scoring photo from each of `slots` equal runs of consecutive photos (keeps time spread). */
function spread(photos: Photo[], slots: number, score: (p: Photo) => number): Photo[] {
  if (slots <= 0) return [];
  if (photos.length <= slots) return photos;
  const picks: Photo[] = [];
  for (let i = 0; i < slots; i++) {
    const from = Math.floor((i * photos.length) / slots);
    const to = Math.floor(((i + 1) * photos.length) / slots);
    let best = photos[from];
    for (let j = from + 1; j < to; j++) if (score(photos[j]) > score(best)) best = photos[j];
    picks.push(best);
  }
  return picks;
}

/**
 * Plan step 3 (global pass): every friend appears at least once. For each
 * missing friend (most-photographed first), swap in their best photo for the
 * weakest pick whose removal doesn't drop another friend.
 */
export function coverFriends(all: Photo[], picks: Set<Photo>, score: (p: Photo) => number, who: Who): number {
  if (!who.known) return 0;
  const count = new Map<string, number>();
  const covered = () => {
    count.clear();
    for (const p of picks) for (const f of who.friends(p)) count.set(f, (count.get(f) ?? 0) + 1);
  };
  covered();
  const photosOf = new Map<string, Photo[]>();
  for (const p of all) for (const f of who.friends(p)) photosOf.set(f, [...(photosOf.get(f) ?? []), p]);
  const missing = [...photosOf.keys()].filter((f) => !count.has(f)).sort((a, b) => photosOf.get(b)!.length - photosOf.get(a)!.length);

  let swaps = 0;
  for (const f of missing) {
    if (count.has(f)) continue; // covered by an earlier swap
    const incoming = photosOf.get(f)!.filter((p) => !picks.has(p)).sort((a, b) => score(b) - score(a))[0];
    if (!incoming) continue;
    // Victim: weakest pick that isn't the only photo of any friend.
    const victims = [...picks]
      .filter((p) => who.friends(p).every((g) => (count.get(g) ?? 0) > 1))
      .sort((a, b) => score(a) - score(b));
    if (!victims.length) break;
    picks.delete(victims[0]);
    picks.add(incoming);
    swaps++;
    covered();
  }
  return swaps;
}

/**
 * At most one food photo per 5 leftover (non-people) slots, as a taste of the
 * trip; more only if there's nothing else to fill with.
 */
export const FOOD_SHARE = 0.2;

export const isFood = (p: Photo) => p.scene?.label === 'food';

/** Non-people slots: scenery-type photos first, food capped, all spread over the trip. */
function fillOthers(others: Photo[], slots: number, score: (p: Photo) => number): Photo[] {
  if (slots <= 0) return [];
  const food = others.filter(isFood);
  const rest = others.filter((p) => !isFood(p));
  const foodSlots = Math.min(food.length, Math.max(slots - rest.length, Math.floor(slots * FOOD_SHARE)));
  const restSlots = Math.min(rest.length, slots - foodSlots);
  return [...spread(rest, restSlots, score), ...spread(food, slots - restSlots, score)];
}

/** CLIP image similarity at or above which two photos count as "the same shot again". */
export const SIMILAR = 0.9;

export function clipSim(a: Photo, b: Photo): number {
  const x = a.scene?.embedding;
  const y = b.scene?.embedding;
  if (!x || !y || x.length !== y.length) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * y[i];
  return s;
}

/**
 * Variety pass: walking the picks in time order, a pick that looks like an
 * earlier pick (CLIP ≥ SIMILAR) is swapped for the best unpicked photo from the
 * same stretch of the trip (between its neighbours) that looks different from
 * every pick. People photos are only swapped for people photos, and only if no
 * friend loses their last spot.
 */
function diversify(all: Photo[], picks: Set<Photo>, score: (p: Photo) => number, who: Who): number {
  const order = all.filter((p) => picks.has(p));
  const pos = new Map(all.map((p, i) => [p, i]));
  let swaps = 0;
  for (let k = 1; k < order.length; k++) {
    const cur = order[k];
    if (!order.slice(0, k).some((q) => clipSim(q, cur) >= SIMILAR)) continue;
    const from = pos.get(order[k - 1])! + 1;
    const to = k + 1 < order.length ? pos.get(order[k + 1])! : all.length;
    const friendCount = new Map<string, number>();
    for (const q of picks) for (const f of who.friends(q)) friendCount.set(f, (friendCount.get(f) ?? 0) + 1);
    const losesFriend = (p: Photo) => who.friends(p).some((f) => (friendCount.get(f) ?? 0) <= 1);
    const needPeople = isPeoplePhoto(cur, who);
    let best: Photo | null = null;
    for (let i = from; i < to; i++) {
      const c = all[i];
      if (picks.has(c) || isPeoplePhoto(c, who) !== needPeople) continue;
      if ([...picks].some((q) => q !== cur && clipSim(q, c) >= SIMILAR)) continue;
      if (!best || score(c) > score(best)) best = c;
    }
    if (!best || losesFriend(cur) && !who.friends(cur).every((f) => who.friends(best!).includes(f))) continue;
    picks.delete(cur);
    picks.add(best);
    order[k] = best;
    swaps++;
  }
  return swaps;
}

/**
 * People first, across the whole trip: photos with people (friends, once known)
 * fill the slots, spread over time, best per stretch; food/scenery only fills
 * slots left over. Then every friend is guaranteed a spot. Chronological
 * output. Milestone 7 replaces this with chapter slots + MMR scoring.
 */
export function selectPhotos(
  photos: Photo[],
  max: number,
  score: (p: Photo) => number = () => 0,
  who: Who = NO_WHO,
): Selection {
  if (photos.length <= max) return { picks: photos, droppedForLength: 0, friendSwaps: 0, varietySwaps: 0 };
  if (max <= 0) return { picks: [], droppedForLength: photos.length, friendSwaps: 0, varietySwaps: 0 };
  const people = photos.filter((p) => isPeoplePhoto(p, who));
  const others = photos.filter((p) => !isPeoplePhoto(p, who));
  const chosen = new Set([...spread(people, max, score), ...fillOthers(others, max - Math.min(max, people.length), score)]);
  const friendSwaps = coverFriends(photos, chosen, score, who) + ensureMe(photos, chosen, score, who);
  const varietySwaps = diversify(photos, chosen, score, who);
  const picks = photos.filter((p) => chosen.has(p));
  return { picks, droppedForLength: photos.length - picks.length, friendSwaps, varietySwaps };
}
