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
  it('people photos win even when they bunch up in one part of the trip', () => {
    // 40 photos: food everywhere, but 8 distinct people photos all on day 2 (indices 20–27).
    const photos = Array.from({ length: 40 }, (_, i) => photo(`p${i}`, i >= 20 && i < 28 ? 1 : 0));
    const { picks } = selectPhotos(photos, 10, (p) => slotScore(p, 0.9));
    const ppl = picks.filter((p) => (p.people?.count ?? 0) > 0);
    expect(ppl).toHaveLength(8); // every people photo is in
    expect(picks).toHaveLength(10); // the 2 leftover slots go to food/scenery, spread out
    expect(picks.map((p) => Number(p.id.slice(1)))).toEqual([...picks.map((p) => Number(p.id.slice(1)))].sort((a, b) => a - b));
  });

  it('with more people photos than slots, no food/scenery is used', () => {
    const photos = Array.from({ length: 60 }, (_, i) => photo(`p${i}`, i % 2));
    const { picks } = selectPhotos(photos, 20, (p) => slotScore(p, 0.9));
    expect(picks.every((p) => (p.people?.count ?? 0) > 0)).toBe(true);
    // Spread over the trip: first pick early, last pick late.
    expect(Number(picks[0].id.slice(1))).toBeLessThan(5);
    expect(Number(picks[19].id.slice(1))).toBeGreaterThan(54);
  });

  it('every friend gets into the reel', () => {
    // 30 people photos; friend "z" only in photo 29 (a weak photo) — would be dropped by spread.
    const photos = Array.from({ length: 30 }, (_, i) => photo(`p${i}`, 1));
    const friends = (p: Photo) => (p.id === 'p29' ? ['z'] : ['a']);
    const who = { friends, known: true };
    const score = (p: Photo) => (p.id === 'p29' ? 0 : 1) + slotScore(p, 0.5, who) * 0;
    const { picks, friendSwaps } = selectPhotos(photos, 10, score, who);
    expect(picks.some((p) => p.id === 'p29')).toBe(true);
    expect(friendSwaps).toBe(1);
  });

  it('once friends are known, a photo of only background strangers is scenery', () => {
    const who = { friends: () => [], known: true };
    const strangers = photo('s', 3, 0.04); // three small one-off faces
    expect(slotScore(strangers, 0.5, who)).toBe(0.5);
  });

  it('leftover slots go to scenery first; food gets at most one per five slots', () => {
    const withScene = (id: string, label: string) => ({ ...photo(id, 0), scene: { label, probs: {}, embedding: [] } }) as unknown as Photo;
    const photos = Array.from({ length: 40 }, (_, i) => withScene(`p${i}`, i % 2 ? 'food' : 'scenery'));
    const { picks } = selectPhotos(photos, 10, (p) => slotScore(p, 0.5));
    expect(picks.filter((p) => p.scene?.label === 'food')).toHaveLength(2);
    // Only food left? Then food fills the reel rather than leaving it short.
    const foodOnly = Array.from({ length: 20 }, (_, i) => withScene(`f${i}`, 'food'));
    expect(selectPhotos(foodOnly, 10).picks).toHaveLength(10);
  });

  it('swaps a near-repeat shot for a different-looking one from the same stretch', () => {
    const emb = (v: number) => [Math.cos(v), Math.sin(v)];
    const shot = (id: string, angle: number) => ({ ...photo(id, 0), scene: { label: 'scenery', probs: {}, embedding: emb(angle) } }) as unknown as Photo;
    // Stretch 1: two near-identical sunsets (a, b) and a different beach (c); stretch 2: d.
    const photos = [shot('a', 0), shot('c', 1.2), shot('b', 0.05), shot('x', 0.02), shot('d', 2.5), shot('y', 2.52)];
    const score = (p: Photo) => ({ a: 1, b: 0.9, c: 0.1, x: 0.05, d: 1, y: 0.2 })[p.id]!;
    const { picks, varietySwaps } = selectPhotos(photos, 3, score);
    const ids = picks.map((p) => p.id);
    expect(ids).toContain('c'); // the different-looking photo got in
    expect(ids.filter((i) => ['a', 'b', 'x'].includes(i))).toHaveLength(1);
    expect(varietySwaps).toBeGreaterThanOrEqual(1);
  });

  it('a sharp landscape never beats a soft-but-usable people photo', () => {
    expect(slotScore(photo('a', 1, 0.05), 0.2)).toBeGreaterThan(slotScore(photo('b', 0), 1));
  });
  it('keeps everything when there is room', () => {
    const photos = [photo('a', 0), photo('b', 1)];
    expect(selectPhotos(photos, 5).picks).toHaveLength(2);
  });
});
