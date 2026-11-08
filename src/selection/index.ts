import type { Photo } from '../types';

export interface Selection {
  picks: Photo[];
  /** Photos left out only because the reel would run past its maximum length. */
  droppedForLength: number;
}

/**
 * Milestone 1 placeholder: keep chronological order and, if there are too many
 * photos for the reel length (`max`, set by the timeline), take an even spread across the trip so no day is lost.
 * Milestone 7 replaces this with chapter slots + MMR + friend coverage.
 */
export function selectPhotos(photos: Photo[], max: number): Selection {
  if (photos.length <= max) return { picks: photos, droppedForLength: 0 };
  if (max <= 1) return { picks: photos.slice(0, Math.max(0, max)), droppedForLength: photos.length - Math.max(0, max) };
  const picks: Photo[] = [];
  for (let i = 0; i < max; i++) {
    // Even spacing that always includes the first and last photo.
    picks.push(photos[Math.round((i * (photos.length - 1)) / (max - 1))]);
  }
  return { picks, droppedForLength: photos.length - max };
}
