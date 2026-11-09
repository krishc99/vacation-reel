// People in a photo (Milestone 4a): faces from MediaPipe Face Landmarker, bodies
// from Pose Landmarker. Pure helpers here; detection runs in vision.worker.ts.

/** Normalized box, 0..1 of the photo's width/height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Face {
  box: Box;
  /** Blendshape scores 0..1. */
  blinkL: number;
  blinkR: number;
  smile: number;
  jawOpen: number;
  /** Degrees from the face transformation matrix (sign convention unverified; use magnitudes). */
  yaw: number;
  pitch: number;
  /** 128-d SFace identity embedding (L2-normalised); absent for tiny or side-on faces. */
  embedding?: number[];
  /** Eyes looking down (blendshape eyeLookDown L/R average, 0..1): checking a phone, not the camera. */
  lookDown?: number;
  /** Sharpness of this face alone (content-independent ratio on a 96 px crop of the big copy). */
  sharpness?: number;
  /** Hidden: a hand over it (body landmarks), or a big face the expression model can't read. */
  covered?: boolean;
}

export interface Body {
  box: Box;
  /** Nose visible → facing the camera; shoulders without a nose → back to camera. */
  noseVisible: boolean;
  shouldersVisible: boolean;
  /** Both wrists above the nose (arms up / jump). */
  armsUp: boolean;
}

export interface People {
  faces: Face[];
  bodies: Body[];
  /** Distinct people: faces + bodies without a face inside them. */
  count: number;
  /** Faces with both eyes open (blink < 0.4). */
  eyesOpen: number;
  /** Largest face height as a share of the photo height (how "about people" the photo is). */
  largestFace: number;
  /** Content-independent sharpness measured on the faces (see quality.ts); null without faces. */
  faceSharpness: number | null;
}

export const EYES_OPEN_MAX_BLINK = 0.4;

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Overlap-based de-duplication (detections from overlapping tiles). Keeps the larger box. */
export function dedupe<T extends { box: Box }>(items: T[], maxIou = 0.3): T[] {
  const sorted = [...items].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const out: T[] = [];
  for (const it of sorted) if (out.every((o) => iou(o.box, it.box) <= maxIou && !contains(o.box, center(it.box)))) out.push(it);
  return out;
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
function contains(b: Box, p: { x: number; y: number }) {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function summarize(faces: Face[], bodies: Body[], faceSharpness: number | null): People {
  const faceless = bodies.filter((b) => !faces.some((f) => contains(b.box, center(f.box))));
  return {
    faces,
    bodies,
    count: faces.length + faceless.length,
    eyesOpen: faces.filter((f) => f.blinkL < EYES_OPEN_MAX_BLINK && f.blinkR < EYES_OPEN_MAX_BLINK).length,
    largestFace: faces.reduce((m, f) => Math.max(m, f.box.h), 0),
    faceSharpness,
  };
}

/** Boxes that must stay in frame: faces (with room for hair/chin) and faceless bodies' upper half. */
export function subjectBoxes(p: People | undefined): Box[] {
  if (!p) return [];
  const boxes = p.faces.map((f) => ({
    x: f.box.x - f.box.w * 0.25,
    y: f.box.y - f.box.h * 0.35,
    w: f.box.w * 1.5,
    h: f.box.h * 1.6,
  }));
  for (const b of p.bodies) {
    if (p.faces.some((f) => contains(b.box, center(f.box)))) continue;
    boxes.push({ x: b.box.x, y: b.box.y, w: b.box.w, h: b.box.h * 0.6 });
  }
  return boxes.map(clampBox);
}

function clampBox(b: Box): Box {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.min(1, b.x + b.w) - x, h: Math.min(1, b.y + b.h) - y };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Yaw/pitch (degrees) from a column-major 4×4 face transformation matrix. */
export function headAngles(m: ArrayLike<number>): { yaw: number; pitch: number } {
  // Forward axis = third column of the rotation.
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  return {
    yaw: (Math.atan2(fx, fz) * 180) / Math.PI,
    pitch: (Math.atan2(-fy, Math.hypot(fx, fz)) * 180) / Math.PI,
  };
}

/**
 * The face detector occasionally sees a face in an object (a soup bowl, a wheel).
 * When CLIP is confident the photo is an object/food/animal/vehicle shot, CLIP's
 * own "people" score is low, and no body was found, those few faces are dropped.
 * A friend holding a dish still has shoulders (a body) and a real people score.
 */
export function dropObjectFaces(p: People, scene: { label: string; probs: Partial<Record<string, number>> }): People {
  const objecty = ['food', 'animal', 'vehicle', 'room'].includes(scene.label) && (scene.probs[scene.label] ?? 0) >= 0.5;
  if (!objecty || p.bodies.length > 0 || p.faces.length > 2 || (scene.probs.people ?? 0) >= 0.1) return p;
  return summarize([], p.bodies, null);
}
