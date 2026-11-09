import { describe, expect, it } from 'vitest';
import { mergeSlots, videoSlots } from '../render/timeline';
import { bestMoment, type FrameSample } from './video';

describe('videos', () => {
  it('picks the sharp, lively stretch and the sharpest frame in it as the poster', () => {
    const samples: FrameSample[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.5,
      sharp: i >= 10 && i <= 16 ? 1 : 0.3,
      motion: i >= 10 && i <= 16 ? 5 : 0.5,
      luma: 0.5,
    }));
    samples[13].sharp = 1.4;
    const m = bestMoment(samples, 10, 3);
    expect(m.start).toBeGreaterThanOrEqual(4.5);
    expect(m.end - m.start).toBeCloseTo(3);
    expect(m.poster).toBeCloseTo(6.5);
    // Short video: all of it.
    expect(bestMoment(samples.slice(0, 4), 2, 3)).toMatchObject({ start: 0, end: 2 });
  });

  it('a video takes two beat slots, merged back into one clip', () => {
    const slots = videoSlots(['a', 'v', 'b'], (id) => id === 'v');
    expect(slots).toEqual(['a', 'v', 'v', 'b']);
    const clips = slots.map((photoId, i) => ({ photoId, start: i, duration: 1, transition: 'cut' as const }));
    const merged = mergeSlots(clips);
    expect(merged.map((c) => [c.photoId, c.start, c.duration])).toEqual([
      ['a', 0, 1],
      ['v', 1, 2],
      ['b', 3, 1],
    ]);
  });
});
