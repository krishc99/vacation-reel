import type { Clip, ReelSettings } from '../types';

/** Milestone 1: fixed duration per photo. Milestone 3 replaces this with beat-aligned cuts. */
export function buildTimeline(photoIds: string[], s: ReelSettings): Clip[] {
  return photoIds.map((photoId, i) => ({
    photoId,
    start: i * s.secondsPerPhoto,
    duration: s.secondsPerPhoto,
  }));
}

export function timelineDuration(clips: Clip[]): number {
  const last = clips[clips.length - 1];
  return last ? last.start + last.duration : 0;
}
