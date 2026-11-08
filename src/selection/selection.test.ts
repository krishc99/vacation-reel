import { describe, expect, it } from 'vitest';
import type { Photo } from '../types';
import { selectPhotos, slotScore } from './index';

const photo = (id: string, people: number, face = 0.2): Photo =>
  ({
    id,
    people: people
      ? { faces: Array.from({ length: people }, () => ({ box: { x: 0, y: 0, w: face, h: face } })), bodies: [], count: people, eyesOpen: people, largestFace: face, faceSharpness: 0.6 }
      : { faces: [], bodies: [], count: 0, eyesOpen: 0, largestFace: 0, faceSharpness: null },
  }) as unknown as Photo;

describe('selectPhotos (people first)', () => {
  it('takes the people photo from each stretch of the trip over food/scenery', () => {
    // 30 photos, every third has people; 10 slots → one per stretch of 3.
    const photos = Array.from({ length: 30 }, (_, i) => photo(`p${i}`, i % 3 === 1 ? 2 : 0));
    const { picks } = selectPhotos(photos, 10, (p) => slotScore(p, 0.9));
    expect(picks.every((p) => (p.people?.count ?? 0) > 0)).toBe(true);
    // Still spread across the whole trip, in order.
    expect(picks.map((p) => Number(p.id.slice(1)))).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);
  });
  it('a sharp landscape never beats a soft-but-usable people photo', () => {
    expect(slotScore(photo('a', 1, 0.05), 0.2)).toBeGreaterThan(slotScore(photo('b', 0), 1));
  });
  it('keeps everything when there is room', () => {
    const photos = [photo('a', 0), photo('b', 1)];
    expect(selectPhotos(photos, 5).picks).toHaveLength(2);
  });
});
