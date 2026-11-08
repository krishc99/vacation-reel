export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Largest source rect with the target aspect ratio, centered ("cover").
 * Milestone 8 swaps the center for a face / salient-region anchor.
 */
export function centerCoverCrop(srcW: number, srcH: number, dstW: number, dstH: number): CropRect {
  const dstAspect = dstW / dstH;
  if (srcW / srcH > dstAspect) {
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

export const FRAMING = {
  /** Cover-crop only if it cuts away at most this share of the photo's width (or height). */
  maxCoverLoss: 0.3,
  /** In fit mode, still trim this much off the long sides (edges rarely matter). */
  fitTrim: 0.06,
};

export type Framing =
  | { mode: 'cover'; crop: CropRect }
  /** Photo shown whole (lightly trimmed) at `dest`, over a blurred copy of itself. */
  | { mode: 'fit'; crop: CropRect; dest: { x: number; y: number; w: number; h: number } };

/** Normalized subject box (faces with headroom, bodies seen from behind). */
export interface Subject {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Framing for one photo.
 * - With people: crop to fill the frame if everyone fits in the crop, placed
 *   around them (faces a little above centre). If they don't all fit, show the
 *   whole photo over a blurred fill so nobody is cut off.
 * - Without people: crop if that loses ≤ 30% of the photo, else fit.
 */
export function frameFor(srcW: number, srcH: number, dstW: number, dstH: number, subjects: Subject[] = []): Framing {
  const cover = centerCoverCrop(srcW, srcH, dstW, dstH);
  const loss = 1 - Math.min(cover.sw / srcW, cover.sh / srcH);

  if (subjects.length) {
    const x0 = Math.min(...subjects.map((b) => b.x)) * srcW;
    const y0 = Math.min(...subjects.map((b) => b.y)) * srcH;
    const x1 = Math.max(...subjects.map((b) => b.x + b.w)) * srcW;
    const y1 = Math.max(...subjects.map((b) => b.y + b.h)) * srcH;
    if (x1 - x0 <= cover.sw * 0.96 && y1 - y0 <= cover.sh * 0.96) {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const sx = Math.min(srcW - cover.sw, Math.max(0, cx - cover.sw / 2));
      // People's centre at ~42% from the top leaves headroom and shows more body below.
      const sy = Math.min(srcH - cover.sh, Math.max(0, cy - cover.sh * 0.42));
      return { mode: 'cover', crop: { sx, sy, sw: cover.sw, sh: cover.sh } };
    }
    return fit(srcW, srcH, dstW, dstH, { x0, y0, x1, y1 });
  }

  if (loss <= FRAMING.maxCoverLoss) return { mode: 'cover', crop: cover };
  return fit(srcW, srcH, dstW, dstH, null);
}

/** Whole photo (edges trimmed only where no one stands) centred on the frame. */
function fit(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  keep: { x0: number; y0: number; x1: number; y1: number } | null,
): Framing {
  const wide = srcW / srcH > dstW / dstH; // too wide → trim left/right
  let t = FRAMING.fitTrim;
  if (keep) {
    // Shrink the trim until the subjects stay inside it.
    const room = wide ? Math.min(keep.x0 / srcW, 1 - keep.x1 / srcW) : Math.min(keep.y0 / srcH, 1 - keep.y1 / srcH);
    t = Math.max(0, Math.min(t, 2 * room));
  }
  const crop: CropRect = wide
    ? { sx: (srcW * t) / 2, sy: 0, sw: srcW * (1 - t), sh: srcH }
    : { sx: 0, sy: (srcH * t) / 2, sw: srcW, sh: srcH * (1 - t) };
  const scale = Math.min(dstW / crop.sw, dstH / crop.sh);
  const w = crop.sw * scale;
  const h = crop.sh * scale;
  return { mode: 'fit', crop, dest: { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h } };
}
