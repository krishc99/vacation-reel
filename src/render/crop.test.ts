import { describe, expect, it } from 'vitest';
import { frameFor } from './crop';

describe('frameFor', () => {
  it('crops photos close to the reel shape (portrait 3:4 into 9:16)', () => {
    expect(frameFor(3024, 4032, 1080, 1920).mode).toBe('cover');
    expect(frameFor(4032, 3024, 1920, 1080).mode).toBe('cover');
  });
  it('fits landscape group shots into a vertical reel instead of cutting the sides', () => {
    const f = frameFor(4032, 3024, 1080, 1920);
    expect(f.mode).toBe('fit');
    if (f.mode !== 'fit') return;
    // Keeps 94% of the width, full width of the frame, centred vertically.
    expect(f.crop.sw / 4032).toBeCloseTo(0.94, 5);
    expect(f.dest.w).toBeCloseTo(1080, 5);
    expect(f.dest.y).toBeGreaterThan(0);
    expect(f.dest.y * 2 + f.dest.h).toBeCloseTo(1920, 5);
  });
  it('fits tall photos into a horizontal reel', () => {
    expect(frameFor(3024, 4032, 1920, 1080).mode).toBe('fit');
  });
});
