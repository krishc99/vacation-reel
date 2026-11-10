import type { Clip, ReelSettings } from '../types';

/** Milestone 1: fixed duration per photo. With a song, musicTimeline cuts on the beat instead. */
export function buildTimeline(photoIds: string[], s: ReelSettings, durationOf: (id: string) => number = () => s.secondsPerPhoto): Clip[] {
  let t = 0;
  return photoIds.map((photoId, i) => {
    const duration = durationOf(photoId);
    const clip: Clip = {
      photoId,
      start: t,
      duration,
      // No beat to land on: every change is a soft crossfade.
      transition: i === 0 ? 'cut' : 'fade',
    };
    t += duration;
    return clip;
  });
}

/**
 * A video takes several photo slots in a music plan, about as many as its
 * moment lasts (2–7): expand ids to slots, then merge a video's consecutive
 * clips back into one.
 */
export function videoSlots(ids: string[], slotsOf: (id: string) => number): string[] {
  return ids.flatMap((id) => Array.from({ length: Math.max(1, slotsOf(id)) }, () => id));
}

/** Slots for a video moment of `seconds` at about `perSlot` seconds a photo. */
export const slotsFor = (seconds: number, perSlot: number) => Math.min(7, Math.max(2, Math.round(seconds / perSlot)));
export function mergeSlots(clips: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const last = out[out.length - 1];
    if (last && last.photoId === c.photoId) last.duration = c.start + c.duration - last.start;
    else out.push({ ...c });
  }
  return out;
}

export function timelineDuration(clips: Clip[]): number {
  const last = clips[clips.length - 1];
  return last ? last.start + last.duration : 0;
}
