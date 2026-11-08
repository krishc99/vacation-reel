// Per-photo import pipeline. Runs inside the import worker normally, and on the
// main thread as a fallback when workers can't start on a device.
import { dhash } from '../analysis/dhash';
import { toGray } from '../analysis/pixels';
import { measureQuality } from '../analysis/quality';
import type { ImportResponse } from '../types';
import { decodeImage, looksLikeHeif } from './decode';
import { readExif } from './exif';

const DETAIL_EDGE = 640; // detection + sharpness/noise
const SMALL_EDGE = 256; // exposure, dHash, thumbnail

type PhotoMsg = Extract<ImportResponse, { type: 'photo' }>;
type SkippedMsg = Extract<ImportResponse, { type: 'skipped' }>;

function scaled(src: { width: number; height: number }, edge: number) {
  const s = Math.min(1, edge / Math.max(src.width, src.height));
  return { w: Math.max(1, Math.round(src.width * s)), h: Math.max(1, Math.round(src.height * s)) };
}

function drawScaled(src: CanvasImageSource & { width: number; height: number }, edge: number) {
  const { w, h } = scaled(src, edge);
  const canvas = new OffscreenCanvas(w, h);
  // No willReadFrequently: that forces a CPU canvas, which has to pull the full-res
  // bitmap into memory just to scale it down. One readback of 640px is cheap.
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable (device may be low on memory)');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  return { canvas, gray };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export async function processPhoto(id: string, file: File): Promise<PhotoMsg | SkippedMsg> {
  let full: ImageBitmap;
  try {
    full = await decodeImage(file);
  } catch (err) {
    return { type: 'skipped', id, name: file.name, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const width = full.width;
    const height = full.height;
    // Downscale in two steps; full-res bitmap is released right after the first.
    const detail = drawScaled(full, DETAIL_EDGE);
    full.close();
    const small = drawScaled(detail.canvas, SMALL_EDGE);
    const isHeif = await looksLikeHeif(file);
    const [exif, thumb, detailBlob] = await Promise.all([
      readExif(file, isHeif),
      small.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }),
      detail.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }),
    ]);
    return {
      type: 'photo',
      id,
      takenAt: exif.takenAt ?? file.lastModified,
      timeSource: exif.takenAt != null ? 'exif' : 'file',
      lat: exif.lat,
      lon: exif.lon,
      width,
      height,
      thumb,
      detail: detailBlob,
      stats: measureQuality(detail.gray, small.gray),
      dhash: dhash(small.gray),
    };
  } catch (err) {
    full.close();
    return { type: 'skipped', id, name: file.name, reason: `Could not analyse this photo (${errorText(err)})` };
  }
}
