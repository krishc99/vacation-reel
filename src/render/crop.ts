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

/**
 * Landscape photos in a vertical reel (or the reverse) lose ~58% to a cover crop:
 * the people at the sides of a group shot. Those are fitted instead, with a
 * blurred fill around them. Photos close to the target shape are still cropped.
 */
export function frameFor(srcW: number, srcH: number, dstW: number, dstH: number): Framing {
  const cover = centerCoverCrop(srcW, srcH, dstW, dstH);
  const loss = 1 - Math.min(cover.sw / srcW, cover.sh / srcH);
  if (loss <= FRAMING.maxCoverLoss) return { mode: 'cover', crop: cover };

  const wide = srcW / srcH > dstW / dstH; // too wide → trim left/right
  const t = FRAMING.fitTrim;
  const crop: CropRect = wide
    ? { sx: (srcW * t) / 2, sy: 0, sw: srcW * (1 - t), sh: srcH }
    : { sx: 0, sy: (srcH * t) / 2, sw: srcW, sh: srcH * (1 - t) };
  const scale = Math.min(dstW / crop.sw, dstH / crop.sh);
  const w = crop.sw * scale;
  const h = crop.sh * scale;
  return { mode: 'fit', crop, dest: { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h } };
}
