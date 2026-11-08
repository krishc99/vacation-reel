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
