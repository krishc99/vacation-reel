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
  it('with you marked: photos with you rise, solo photos of others drop, groups stay', () => {
    const verdicts = new Map<string, Verdict>(['me', 'solo', 'group'].map((id) => [id, { q: 0.8 } as Verdict]));
    const friends = (x: Photo) => ({ me: ['me', 'a'], solo: ['b'], group: ['a', 'b'] })[x.id as 'me' | 'solo' | 'group'];
    const base = { verdicts, burstSize: () => 1, firstOfChapter: () => false };
    const ps = [p('me', 2), p('solo', 1), p('group', 2)];
    const without = scorePhotos(ps, { ...base, who: { friends, known: true } });
    const withMe = scorePhotos(ps, { ...base, who: { friends, known: true, me: 'me' } });
    expect(withMe.get('me')!.score).toBeGreaterThan(without.get('me')!.score);
    expect(withMe.get('solo')!.score).toBeLessThan(without.get('solo')!.score);
    // Groups without you get no penalty: they now outrank the solo photo of someone else.
    expect(withMe.get('group')!.score).toBeGreaterThan(withMe.get('solo')!.score);
  });

  it('aesthetic needs a 512-d embedding', () => {
    expect(aestheticScore(undefined)).toBeNull();
    expect(typeof aestheticScore(new Array(512).fill(1 / Math.sqrt(512)))).toBe('number');
  });
});
