/** Grayscale plane, values 0..255. */
export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** Rec.601 luma from RGBA bytes. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return { data, width, height };
}

/** Box-average downsample to an exact size (used for dHash). */
export function resizeBox(g: Gray, outW: number, outH: number): Float32Array {
  const out = new Float32Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * g.height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * g.height) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * g.width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * g.width) / outW));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * g.width;
        for (let x = x0; x < x1; x++) sum += g.data[row + x];
      }
      out[oy * outW + ox] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
