import type { Photo } from '../types';

export interface Selection {
  picks: Photo[];
  /** Photos left out only because the reel would run past its maximum length. */
  droppedForLength: number;
}

/**
 * How much a photo deserves a slot (until M7 scoring). People first: any photo
 * with people beats any without; more people, bigger faces and open eyes help.
 * `quality` (0..1) breaks ties.
 */
export function slotScore(p: Photo, quality: number): number {
  const ppl = p.people;
  if (!ppl || ppl.count === 0) return quality;
  const open = ppl.faces.length ? ppl.eyesOpen / ppl.faces.length : 0.5;
  return 2 + 0.5 * Math.min(ppl.count, 4) / 4 + 0.5 * Math.min(1, ppl.largestFace * 3) + 0.3 * open + 0.2 * quality;
}

/**
 * Keep chronological order. If there are more photos than slots, split the trip
 * into `max` equal runs of consecutive photos and take the best of each run, so
 * every part of the trip is covered and people win over food and scenery.
 * Milestone 7 replaces this with chapter slots + MMR + friend coverage.
 */
export function selectPhotos(photos: Photo[], max: number, score: (p: Photo) => number = () => 0): Selection {
  if (photos.length <= max) return { picks: photos, droppedForLength: 0 };
  if (max <= 0) return { picks: [], droppedForLength: photos.length };
  const picks: Photo[] = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * photos.length) / max);
    const to = Math.floor(((i + 1) * photos.length) / max);
    let best = photos[from];
    for (let j = from + 1; j < to; j++) if (score(photos[j]) > score(best)) best = photos[j];
    picks.push(best);
  }
  return { picks, droppedForLength: photos.length - max };
}
