import type { Photo, ReelSettings } from '../types';

export interface Selection {
  picks: Photo[];
  /** Photos left out only because the reel would run past maxSeconds. */
  droppedForLength: number;
}

/**
 * Milestone 1 placeholder: keep chronological order and, if there are too many
 * photos for maxSeconds, take an even spread across the trip so no day is lost.
 * Milestone 7 replaces this with chapter slots + MMR + friend coverage.
 */
export function selectPhotos(photos: Photo[], s: ReelSettings): Selection {
  const max = Math.floor(s.maxSeconds / s.secondsPerPhoto);
  if (photos.length <= max) return { picks: photos, droppedForLength: 0 };
  const picks: Photo[] = [];
  for (let i = 0; i < max; i++) {
    // Even spacing that always includes the first and last photo.
    picks.push(photos[Math.round((i * (photos.length - 1)) / (max - 1))]);
  }
  return { picks, droppedForLength: photos.length - max };
}
