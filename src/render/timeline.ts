import type { Clip, ReelSettings } from '../types';

/** Milestone 1: fixed duration per photo. With a song, musicTimeline cuts on the beat instead. */
export function buildTimeline(photoIds: string[], s: ReelSettings): Clip[] {
  return photoIds.map((photoId, i) => ({
    photoId,
    start: i * s.secondsPerPhoto,
    duration: s.secondsPerPhoto,
    // No beat to land on: every change is a soft crossfade.
    transition: i === 0 ? 'cut' : 'fade',
  }));
}

export function timelineDuration(clips: Clip[]): number {
  const last = clips[clips.length - 1];
  return last ? last.start + last.duration : 0;
}
