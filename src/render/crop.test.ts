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

describe('frameFor with people', () => {
  it('crops around a couple standing off-centre instead of the centre', () => {
    // Landscape, two faces on the right third.
    const f = frameFor(4032, 3024, 1080, 1920, [{ x: 0.7, y: 0.3, w: 0.12, h: 0.2 }]);
    expect(f.mode).toBe('cover');
    if (f.mode !== 'cover') return;
    const left = f.crop.sx / 4032;
    const right = (f.crop.sx + f.crop.sw) / 4032;
    expect(left).toBeLessThanOrEqual(0.7);
    expect(right).toBeGreaterThanOrEqual(0.82);
  });
  it('fits a wide group whole, without trimming anyone at the edges', () => {
    const f = frameFor(4032, 3024, 1080, 1920, [{ x: 0.01, y: 0.3, w: 0.97, h: 0.2 }]);
    expect(f.mode).toBe('fit');
    if (f.mode !== 'fit') return;
    expect(f.crop.sx).toBeLessThanOrEqual(0.01 * 4032 + 1e-6);
    expect(f.crop.sx + f.crop.sw).toBeGreaterThanOrEqual(0.98 * 4032 - 1e-6);
  });
  it('a portrait group that fits keeps faces in the upper part of the frame', () => {
    const f = frameFor(3024, 4032, 1080, 1920, [{ x: 0.3, y: 0.15, w: 0.4, h: 0.15 }]);
    expect(f.mode).toBe('cover');
    if (f.mode !== 'cover') return;
    const faceTop = 0.15 * 4032 - f.crop.sy;
    expect(faceTop).toBeGreaterThanOrEqual(0);
  });
});
