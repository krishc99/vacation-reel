import { describe, expect, it } from 'vitest';
import { chapters } from '../analysis/chapters';
import type { PhotoScore } from '../analysis/scoring';
import type { Photo } from '../types';
import { chooseReel, sequence } from './reel';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 22, 8);
let n = 0;
function mk(o: { t: number; people?: number; label?: string; emb?: number[]; lat?: number; lon?: number }): Photo {
  const id = `p${n++}`;
  const count = o.people ?? 0;
  return {
    id,
    name: id,
    takenAt: T0 + o.t * H,
    timeSource: 'exif',
    lat: o.lat ?? null,
    lon: o.lon ?? null,
    people: { faces: [], bodies: [], count, eyesOpen: count, largestFace: count ? 0.2 : 0, faceSharpness: null },
    scene: o.label ? { label: o.label, probs: {}, embedding: o.emb ?? [] } : undefined,
  } as unknown as Photo;
}
const sc = (m: Record<string, number>) => new Map(Object.entries(m).map(([k, v]) => [k, { score: v, M: v } as PhotoScore]));
const who = { friends: () => [] as string[], known: false };

describe('chapters', () => {
  it('splits on long gaps and on moving > 1.5 km', () => {
    const ps = [mk({ t: 0, lat: 25.08, lon: 55.14 }), mk({ t: 0.5, lat: 25.081, lon: 55.141 }), mk({ t: 1, lat: 25.2, lon: 55.27 }), mk({ t: 5 })];
    expect(chapters(ps).map((c) => c.length)).toEqual([2, 1, 1]);
  });
});

describe('chooseReel', () => {
  it('gives every chapter a slot and more to the stronger chapter', () => {
    n = 0;
    const day1 = Array.from({ length: 10 }, (_, i) => mk({ t: i * 0.1, people: 2 }));
    const day2 = Array.from({ length: 10 }, (_, i) => mk({ t: 24 + i * 0.1, people: 2 }));
    const scores = sc(Object.fromEntries([...day1.map((p) => [p.id, 0.9]), ...day2.map((p) => [p.id, 0.3])]));
    const r = chooseReel([...day1, ...day2], 6, scores, who);
    const d1 = r.picks.filter((p) => day1.includes(p)).length;
    expect(r.chapters).toBe(2);
    expect(d1).toBeGreaterThan(3);
    expect(6 - d1).toBeGreaterThanOrEqual(1);
  });

  it('avoids near-identical shots (MMR) and keeps food to its share', () => {
    n = 0;
    const same = [1, 0];
    const other = [0, 1];
    const ps = [
      mk({ t: 0, people: 1, label: 'people', emb: same }),
      mk({ t: 0.1, people: 1, label: 'people', emb: same }),
      mk({ t: 0.2, people: 1, label: 'people', emb: other }),
      ...Array.from({ length: 6 }, (_, i) => mk({ t: 0.3 + i * 0.01, label: 'food', emb: [Math.SQRT1_2, Math.SQRT1_2] })),
    ];
    const scores = sc({ p0: 0.9, p1: 0.89, p2: 0.6, p3: 0.95, p4: 0.95, p5: 0.95, p6: 0.95, p7: 0.95, p8: 0.95 });
    const r = chooseReel(ps, 3, scores, who);
    const ids = r.picks.map((p) => p.id);
    expect(ids).toContain('p2'); // the different-looking people photo beats a near-repeat
    expect(ids.filter((i) => ['p0', 'p1'].includes(i))).toHaveLength(1);
    // The third slot goes to food rather than a near-repeat of p0, but only one food.
    expect(r.picks.filter((p) => p.scene?.label === 'food')).toHaveLength(1);
  });
});

describe('sequence keeps the story in order', () => {
  it('does not move an early photo to the end of a long chapter', () => {
    n = 0;
    const ps = Array.from({ length: 12 }, (_, i) => mk({ t: i * 0.1, people: i % 3 ? 1 : 0, label: i % 2 ? 'people' : 'vehicle' }));
    const scores = new Map(ps.map((p, i) => [p.id, { score: 0.5, M: i === 5 ? 0.9 : 0.2 } as PhotoScore]));
    const order = sequence(ps, [ps], scores, who).map((p) => Number(p.id.slice(1)));
    // Ignoring the hook (first) and finale (last), positions stay within 2 of chronological.
    const mid = order.slice(1, -1);
    const sorted = [...mid].sort((a, b) => a - b);
    mid.forEach((v, i) => expect(Math.abs(sorted.indexOf(v) - i)).toBeLessThanOrEqual(2));
  });
});

describe('sequence', () => {
  it('opens on the best group photo, ends on the biggest moment, and leads chapters with a scenic shot', () => {
    n = 0;
    const a = mk({ t: 0, people: 2, label: 'people' });
    const b = mk({ t: 0.2, label: 'landmark' });
    const c = mk({ t: 0.4, people: 1, label: 'people' });
    const d = mk({ t: 0.6, people: 3, label: 'nightlife' });
    const e = mk({ t: 0.8, people: 2, label: 'people' });
    const scores = new Map([
      [a.id, { score: 0.5, M: 0.4 }],
      [b.id, { score: 0.4, M: 0.2 }],
      [c.id, { score: 0.9, M: 0.3 }],
      [d.id, { score: 0.6, M: 0.95 }],
      [e.id, { score: 0.3, M: 0.1 }],
    ] as [string, PhotoScore][]);
    const order = sequence([a, b, c, d, e], [[a, b, c, d, e]], scores, who).map((p) => p.id);
    expect(order[0]).toBe(d.id); // cover: the group photo (3 people), not the higher-scoring solo
    expect(order[order.length - 1]).toBe(a.id); // finale: biggest moment of the rest
    expect(order[1]).toBe(b.id); // establishing landmark leads the chapter
  });
});
