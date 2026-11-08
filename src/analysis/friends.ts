import { cosine } from './align';

/**
 * Groups faces across the album into people, then decides who's a friend.
 * Average-linkage agglomerative clustering on SFace embeddings (cosine), with a
 * cannot-link rule: two faces in the same photo are never the same person.
 */

export interface FaceRef {
  photoId: string;
  /** Burst (moment) the photo belongs to: a burst counts once toward "recurring". */
  burstId: string;
  faceIndex: number;
  embedding: number[];
  /** Face height as a share of the photo height. */
  size: number;
}

export interface Person {
  id: string;
  faces: FaceRef[];
  photoIds: string[];
  /** Distinct moments (bursts) this person appears in. */
  moments: number;
  largest: number;
  friend: boolean;
}

export const FRIEND_DEFAULTS = {
  /** SFace's published same-person cosine threshold (OpenCV FaceRecognizerSF). */
  sameCosine: 0.363,
  /**
   * One-off faces at least this big (share of photo height) are the subject of
   * the photo (selfie, portrait, a group shot), so they count as friends.
   * Strangers in the background are usually well under 5%.
   */
  bigFace: 0.07,
};

export function clusterPeople(faces: FaceRef[], o = FRIEND_DEFAULTS): Person[] {
  type C = { members: number[]; photos: Set<string> };
  const clusters: C[] = faces.map((f, i) => ({ members: [i], photos: new Set([f.photoId]) }));
  const sim = faces.map((a) => faces.map((b) => cosine(a.embedding, b.embedding)));
  const link = (x: C, y: C) => {
    for (const p of x.photos) if (y.photos.has(p)) return -Infinity; // cannot-link
    let s = 0;
    for (const i of x.members) for (const j of y.members) s += sim[i][j];
    return s / (x.members.length * y.members.length);
  };
  for (;;) {
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const v = link(clusters[i], clusters[j]);
        if (v > best) {
          best = v;
          bi = i;
          bj = j;
        }
      }
    if (bi < 0 || best < o.sameCosine) break;
    const a = clusters[bi];
    const b = clusters[bj];
    a.members.push(...b.members);
    b.photos.forEach((p) => a.photos.add(p));
    clusters.splice(bj, 1);
  }
  const people = clusters.map((c, k) => {
    const fs = c.members.map((i) => faces[i]);
    const moments = new Set(fs.map((f) => f.burstId)).size;
    const largest = Math.max(...fs.map((f) => f.size));
    return {
      id: `person${k}`,
      faces: fs,
      photoIds: [...c.photos],
      moments,
      largest,
      friend: moments >= 2 || largest >= o.bigFace,
    };
  });
  // Most-seen first; stable ids by rank so the UI order is meaningful.
  people.sort((a, b) => b.moments - a.moments || b.largest - a.largest);
  people.forEach((p, i) => (p.id = `person${i}`));
  return people;
}
