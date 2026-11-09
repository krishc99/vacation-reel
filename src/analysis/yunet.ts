// YuNet face detector (OpenCV Zoo, MIT): finds small, distant and turned faces
// that MediaPipe's selfie-range detector misses, with the 5 points SFace is
// trained to align on. Input: 640×640 BGR 0–255 NCHW. Pure decoding here.
import type { Pt } from './align';

export const YUNET = {
  size: 640,
  strides: [8, 16, 32] as const,
  /** OpenCV's sample uses 0.9; lower finds more real faces, CLIP/size checks catch the odd poster. */
  minScore: 0.72,
  nmsIou: 0.3,
  /** Faces smaller than this (px in the 640 input) are noise. */
  minSide: 9,
};

export interface YuFace {
  score: number;
  /** In input pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Image-left eye, image-right eye, nose, mouth left, mouth right (input pixels). */
  pts: Pt[];
}

type Outputs = Record<string, { data: ArrayLike<number> }>;

export function decodeYunet(out: Outputs, o = YUNET): YuFace[] {
  const dets: YuFace[] = [];
  for (const s of o.strides) {
    const cols = o.size / s;
    const cls = out[`cls_${s}`].data;
    const obj = out[`obj_${s}`].data;
    const bb = out[`bbox_${s}`].data;
    const kp = out[`kps_${s}`].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < o.minScore) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = (c + bb[4 * i]) * s;
      const cy = (r + bb[4 * i + 1]) * s;
      const w = Math.exp(bb[4 * i + 2]) * s;
      const h = Math.exp(bb[4 * i + 3]) * s;
      if (Math.min(w, h) < o.minSide) continue;
      const pts: Pt[] = [];
      for (let n = 0; n < 5; n++) pts.push([(kp[10 * i + 2 * n] + c) * s, (kp[10 * i + 2 * n + 1] + r) * s]);
      dets.push({ score, x: cx - w / 2, y: cy - h / 2, w, h, pts });
    }
  }
  dets.sort((a, b) => b.score - a.score);
  const keep: YuFace[] = [];
  const iou = (a: YuFace, b: YuFace) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const i = ix * iy;
    return i / (a.w * a.h + b.w * b.h - i);
  };
  for (const d of dets) if (keep.every((k) => iou(d, k) < o.nmsIou)) keep.push(d);
  return keep;
}

/** Rough head turn from the 5 points (degrees, magnitude meaningful): nose offset from the eyes' midpoint. */
export function yawFromPoints(p: Pt[]): number {
  const mid = (p[0][0] + p[1][0]) / 2;
  const half = Math.abs(p[1][0] - p[0][0]) / 2 || 1;
  return Math.max(-90, Math.min(90, ((p[2][0] - mid) / half) * 45));
}

/** Pixels (RGBA, w×h placed top-left) → YuNet input tensor data. */
export function yunetTensor(rgba: Uint8ClampedArray, size = YUNET.size): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[4 * i + 2]; // B
    out[n + i] = rgba[4 * i + 1]; // G
    out[2 * n + i] = rgba[4 * i]; // R
  }
  return out;
}
