import { resizeBox, type Gray } from './pixels';

/** 64-bit difference hash as two 32-bit halves [hi, lo]. */
export type DHash = [number, number];

/** Classic dHash: 9×8 grayscale, bit = left pixel brighter than right. */
export function dhash(g: Gray): DHash {
  const px = resizeBox(g, 9, 8);
  let hi = 0;
  let lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0;
      const idx = y * 8 + x;
      if (idx < 32) hi = (hi | (bit << (31 - idx))) >>> 0;
      else lo = (lo | (bit << (63 - idx))) >>> 0;
    }
  }
  return [hi, lo];
}

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a: DHash, b: DHash): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}
