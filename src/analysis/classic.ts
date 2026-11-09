// Milestone 5: classic best-photo picking within a burst.
// A face "passes" when eyes are open, it faces the camera, isn't looking down,
// is sharp and isn't cut off by the frame edge. The winning frame has the most
// passing faces, then the best worst face, then the most smiling, then the
// sharpest. Frames missing someone who appears elsewhere in the burst fail
// that person.
import type { Face, People } from './people';

export const CLASSIC = {
  /** Plan: both eyeBlink < 0.4. */
  maxBlink: 0.4,
  /** Plan: yaw < 25°. */
  maxYaw: 25,
  /** eyeLookDown average above this = looking down (at a phone, the floor). */
  maxLookDown: 0.5,
  /** Face crop sharpness below this = soft face (photo-level "blurry" is 0.15). */
  minFaceSharpness: 0.15,
  /** Face box within this share of the frame edge = cut off. */
  edge: 0.005,
};

export interface FaceCheck {
  eyesOpen: boolean;
  facing: boolean;
  notDown: boolean;
  sharp: boolean;
  inFrame: boolean;
  uncovered: boolean;
  pass: boolean;
  /** Continuous 0..1 quality used for "best worst face". */
  quality: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function checkFace(f: Face, o = CLASSIC): FaceCheck {
  const blink = Math.max(f.blinkL, f.blinkR);
  const eyesOpen = blink < o.maxBlink;
  const facing = Math.abs(f.yaw) < o.maxYaw;
  const notDown = (f.lookDown ?? 0) <= o.maxLookDown;
  const sharp = (f.sharpness ?? 1) >= o.minFaceSharpness;
  const b = f.box;
  const uncovered = !f.covered;
  const inFrame = b.x > o.edge && b.y > o.edge && b.x + b.w < 1 - o.edge && b.y + b.h < 1 - o.edge;
  // Eyes weigh most (plan: "heaviest weight"); the rest scale it down.
  const quality =
    clamp01(1 - blink) ** 2 *
    clamp01(1 - Math.abs(f.yaw) / 60) *
    clamp01(1 - Math.max(0, (f.lookDown ?? 0) - 0.3)) *
    (0.5 + 0.5 * clamp01(((f.sharpness ?? 0.5) - 0.1) / 0.4)) *
    (inFrame ? 1 : 0.6) *
    (uncovered ? 1 : 0.25);
  return { eyesOpen, facing, notDown, sharp, inFrame, uncovered, pass: eyesOpen && facing && notDown && sharp && inFrame && uncovered, quality };
}

export interface FrameRank {
  /** Faces passing every check. */
  passing: number;
  /** Faces the burst says should be there (max over frames). */
  expected: number;
  /** Lowest face quality; a missing face counts as 0. */
  worst: number;
  smile: number;
  sharpness: number;
  /** Plain-language problems, e.g. "1 blinking", "1 missing". */
  issues: string[];
}

export function rankFrame(p: People | undefined, expected: number, photoSharpness: number): FrameRank {
  const faces = p?.faces ?? [];
  const checks = faces.map((f) => checkFace(f));
  const missing = Math.max(0, expected - faces.length);
  const count = (k: keyof FaceCheck) => checks.filter((c) => !c[k]).length;
  const issues: string[] = [];
  const add = (n: number, what: string) => n > 0 && issues.push(`${n} ${what}`);
  add(count('eyesOpen'), 'eyes closed');
  add(count('facing'), 'turned away');
  add(count('notDown'), 'looking down');
  add(count('sharp'), 'soft face');
  add(count('inFrame'), 'cut off');
  add(count('uncovered'), 'face covered');
  add(missing, 'missing');
  return {
    passing: checks.filter((c) => c.pass).length,
    expected,
    worst: missing > 0 || !checks.length ? 0 : Math.min(...checks.map((c) => c.quality)),
    smile: faces.length ? faces.reduce((s, f) => s + f.smile, 0) / faces.length : 0,
    sharpness: photoSharpness,
    issues,
  };
}

/** Plan's order: most passing faces → best worst face → avg smile → sharpness. Small gaps count as ties. */
export function compareFrames(a: FrameRank, b: FrameRank): number {
  if (a.passing !== b.passing) return a.passing - b.passing;
  if (Math.abs(a.worst - b.worst) > 0.05) return a.worst - b.worst;
  if (Math.abs(a.smile - b.smile) > 0.05) return a.smile - b.smile;
  return a.sharpness - b.sharpness;
}

/** Index of the best frame, or -1 if no frame has faces (then quality decides as before). */
export function bestFrame(frames: { people?: People; sharpness: number }[]): { index: number; ranks: FrameRank[] } {
  const expected = Math.max(0, ...frames.map((f) => f.people?.faces.length ?? 0));
  const ranks = frames.map((f) => rankFrame(f.people, expected, f.sharpness));
  if (expected === 0) return { index: -1, ranks };
  let best = 0;
  for (let i = 1; i < ranks.length; i++) if (compareFrames(ranks[i], ranks[best]) > 0) best = i;
  return { index: best, ranks };
}
