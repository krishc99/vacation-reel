import { describe, expect, it } from 'vitest';
import { similarity, TEMPLATE_112, type Pt } from './align';
import { clusterPeople, type FaceRef } from './friends';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const r = rng(9);
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
/** Identity centre + per-photo noise, like real embeddings (same person ~0.5–0.8 cosine). */
const centres = Array.from({ length: 6 }, () => unit(Array.from({ length: 128 }, r)));
const face = (person: number, photoId: string, burstId = photoId, size = 0.04): FaceRef => ({
  photoId,
  burstId,
  faceIndex: 0,
  size,
  embedding: unit(centres[person].map((x) => x + 0.09 * r())),
});

describe('similarity transform', () => {
  it('recovers scale, rotation and shift exactly', () => {
    const ang = 0.3;
    const sc = 2.5;
    const src: Pt[] = TEMPLATE_112.map(([x, y]) => [(x * Math.cos(ang) - y * Math.sin(ang)) / sc + 400, (x * Math.sin(ang) + y * Math.cos(ang)) / sc + 120]);
    const [a, b, c, d, e, f] = similarity(src, TEMPLATE_112);
    src.forEach(([x, y], i) => {
      expect(a * x + c * y + e).toBeCloseTo(TEMPLATE_112[i][0], 6);
      expect(b * x + d * y + f).toBeCloseTo(TEMPLATE_112[i][1], 6);
    });
  });
});

describe('clusterPeople', () => {
  it('groups the same person across photos and keeps different people apart', () => {
    const faces = [face(0, 'a'), face(0, 'b'), face(0, 'c'), face(1, 'a'), face(1, 'd'), face(2, 'e')];
    const people = clusterPeople(faces);
    expect(people).toHaveLength(3);
    expect(people[0].photoIds.sort()).toEqual(['a', 'b', 'c']);
    expect(people[0].friend).toBe(true);
    expect(people.find((p) => p.photoIds.includes('e'))!.friend).toBe(false); // one-off small face = stranger
  });

  it('never merges two faces from the same photo', () => {
    // Make person 3 and 4 nearly identical but standing in the same photo.
    const twin = face(3, 'g');
    const other = { ...face(3, 'g'), faceIndex: 1 };
    expect(clusterPeople([twin, other])).toHaveLength(2);
  });

  it('a big one-off face (selfie) still counts as a friend; a burst counts once', () => {
    const people = clusterPeople([face(4, 'x', 'x', 0.3), face(5, 'y1', 'burst'), face(5, 'y2', 'burst')]);
    expect(people.find((p) => p.photoIds.includes('x'))!.friend).toBe(true);
    expect(people.find((p) => p.photoIds.includes('y1'))!.friend).toBe(false);
  });
});
