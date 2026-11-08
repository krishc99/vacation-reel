import { describe, expect, it } from 'vitest';
import type { Photo } from '../types';
import { aestheticScore, scorePhotos } from './scoring';
import type { Verdict } from './gate';

const p = (id: string, people: number): Photo =>
  ({ id, people: { faces: [], bodies: [], count: people, eyesOpen: people, largestFace: 0.2, faceSharpness: null } }) as unknown as Photo;

describe('scorePhotos', () => {
  it('ranks a photo with friends above an equally good one without', () => {
    const verdicts = new Map<string, Verdict>([
      ['a', { q: 0.8 } as Verdict],
      ['b', { q: 0.8 } as Verdict],
    ]);
    const s = scorePhotos([p('a', 3), p('b', 0)], { verdicts, who: { friends: () => [], known: false }, burstSize: () => 1, firstOfChapter: () => false });
    expect(s.get('a')!.score).toBeGreaterThan(s.get('b')!.score);
  });
  it('aesthetic needs a 512-d embedding', () => {
    expect(aestheticScore(undefined)).toBeNull();
    expect(typeof aestheticScore(new Array(512).fill(1 / Math.sqrt(512)))).toBe('number');
  });
});
