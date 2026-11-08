// Face alignment for SFace: a 2-D similarity transform (scale + rotation +
// translation) from 5 face points to the standard 112×112 ArcFace template.

export type Pt = [number, number];

/** Template points in 112×112 output pixels: image-left eye, image-right eye, nose, mouth left, mouth right. */
export const TEMPLATE_112: Pt[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Least-squares similarity transform src → dst (Umeyama, no reflection).
 * Returns canvas matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export function similarity(src: Pt[], dst: Pt[]): [number, number, number, number, number, number] {
  const n = src.length;
  const mean = (p: Pt[]) => p.reduce((m, q) => [m[0] + q[0] / n, m[1] + q[1] / n] as Pt, [0, 0] as Pt);
  const ms = mean(src);
  const md = mean(dst);
  let sxx = 0;
  let sxy = 0; // Σ (s·d) and Σ (s × d) for the rotation angle
  let var_ = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - ms[0];
    const sy = src[i][1] - ms[1];
    const dx = dst[i][0] - md[0];
    const dy = dst[i][1] - md[1];
    sxx += sx * dx + sy * dy;
    sxy += sx * dy - sy * dx;
    var_ += sx * sx + sy * sy;
  }
  const norm = Math.hypot(sxx, sxy);
  const scale = var_ > 0 ? norm / var_ : 1;
  const cos = norm > 0 ? sxx / norm : 1;
  const sin = norm > 0 ? sxy / norm : 0;
  const a = scale * cos;
  const b = scale * sin;
  // x' = a x − b y + e ; y' = b x + a y + f
  const e = md[0] - (a * ms[0] - b * ms[1]);
  const f = md[1] - (b * ms[0] + a * ms[1]);
  return [a, b, -b, a, e, f];
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // embeddings are stored L2-normalised
}

export function l2normalize(v: Float32Array): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Array.from(v, (x) => x / n);
}
