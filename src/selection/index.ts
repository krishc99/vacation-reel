import type { Photo } from '../types';

export interface Selection {
  picks: Photo[];
  /** Photos left out only because the reel would run past its maximum length. */
  droppedForLength: number;
  /** Friends swapped in so everyone appears at least once. */
  friendSwaps: number;
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
export function slotScore(p: Photo, quality: number, who: Who = NO_WHO): number {
  const ppl = p.people;
  if (!ppl || !isPeoplePhoto(p, who)) return quality;
  const n = who.known ? Math.max(1, who.friends(p).length) : ppl.count;
  const open = ppl.faces.length ? ppl.eyesOpen / ppl.faces.length : 0.5;
  return 2 + (0.5 * Math.min(n, 4)) / 4 + 0.5 * Math.min(1, ppl.largestFace * 3) + 0.3 * open + 0.2 * quality;
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
function coverFriends(all: Photo[], picks: Set<Photo>, score: (p: Photo) => number, who: Who): number {
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
  if (photos.length <= max) return { picks: photos, droppedForLength: 0, friendSwaps: 0 };
  if (max <= 0) return { picks: [], droppedForLength: photos.length, friendSwaps: 0 };
  const people = photos.filter((p) => isPeoplePhoto(p, who));
  const others = photos.filter((p) => !isPeoplePhoto(p, who));
  const chosen = new Set([...spread(people, max, score), ...spread(others, max - Math.min(max, people.length), score)]);
  const friendSwaps = coverFriends(photos, chosen, score, who);
  const picks = photos.filter((p) => chosen.has(p));
  return { picks, droppedForLength: photos.length - picks.length, friendSwaps };
}
