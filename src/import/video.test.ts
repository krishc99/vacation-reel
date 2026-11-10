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
    const slots = videoSlots(['a', 'v', 'b'], (id) => (id === 'v' ? 2 : 1));
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

describe('loudest moment', () => {
  it('cuts around the cheer, with the ends in pauses', async () => {
    const { soundMoment, SOUND } = await import('./video');
    // 20 s video at 10 bins/s: chatter 0.02, a pause at 10.3–10.4 s, a cheer 12–13.5 s.
    const env = new Float32Array(200).fill(0.02);
    for (let i = 120; i < 135; i++) env[i] = 0.2;
    env[103] = env[104] = 0.002;
    const m = soundMoment(env, 20, 3.5)!;
    expect(m.peak).toBeGreaterThan(12);
    expect(m.peak).toBeLessThan(13.5);
    expect(m.start).toBeGreaterThanOrEqual(10.3 - 1e-9); // moved into the pause before the action
    expect(m.start).toBeLessThanOrEqual(10.4 + 1e-9);
    // Ends 0.5–1 s after the loudest point; most of the moment is the build-up.
    expect(m.end - m.peak).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(m.end - m.peak).toBeLessThanOrEqual(1 + 1e-9);
    expect(m.end - m.start).toBeGreaterThan(3.5 - SOUND.snap - 1e-6);
  });
  it('ignores flat sound (wind, constant chatter)', async () => {
    const { soundMoment } = await import('./video');
    expect(soundMoment(new Float32Array(200).fill(0.05), 20)).toBeNull();
  });
});

describe('choosing the moment', () => {
  it('uses short videos whole, and measures people moving rather than the camera', async () => {
    const { chooseMoment, subjectMotion } = await import('./video');
    const samples = [0.5, 1.5, 2.5, 3.5].map((t) => ({ t, sharp: t === 2.5 ? 1 : 0.5, motion: 0, luma: 0.5 }));
    expect(chooseMoment(samples, null, 5)).toMatchObject({ start: 0, end: 5, poster: 2.5, by: 'whole' });
    // A pan: the same picture shifted 6 px → almost no subject motion. A change in the middle → motion.
    const w = 80;
    const h = 45;
    const img = Float32Array.from({ length: w * h }, (_, i) => ((i % w) * 37 + Math.floor(i / w) * 91) % 255);
    const panned = Float32Array.from({ length: w * h }, (_, i) => img[Math.min(w * h - 1, i + 6)]);
    const moved = img.slice();
    for (let y = 15; y < 30; y++) for (let x = 30; x < 50; x++) moved[y * w + x] = 255 - moved[y * w + x];
    expect(subjectMotion(img, panned, w, h)).toBeLessThan(subjectMotion(img, moved, w, h) / 3);
  });
});
