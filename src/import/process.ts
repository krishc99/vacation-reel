// Per-photo import pipeline. Runs inside the import worker normally, and on the
// main thread as a fallback when workers can't start on a device.
import { dhash } from '../analysis/dhash';
import { toGray } from '../analysis/pixels';
import { measureQuality } from '../analysis/quality';
import type { ImportResponse } from '../types';
import { decodeImage, looksLikeHeif } from './decode';
import { readExif } from './exif';

/**
 * Long edge of the copy kept for rendering. Enough for a 1080×1920 / 1920×1080
 * cover crop from any 4:3 or 3:2 photo, with headroom for Ken Burns (M8).
 * Kept because Android revokes access to picked files after a while
 * (NotReadableError at export), so we never re-read the original.
 */
const MASTER_EDGE = 2560;
const DETAIL_EDGE = 640; // detection + sharpness/noise
const SMALL_EDGE = 256; // exposure, dHash, thumbnail

export type PhotoMsg = Extract<ImportResponse, { type: 'photo' }>;
export type SkippedMsg = Extract<ImportResponse, { type: 'skipped' }>;

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

/** Scale without reading pixels back (GPU-friendly). */
function scaleOnly(src: CanvasImageSource & { width: number; height: number }, edge: number): OffscreenCanvas {
  const { w, h } = scaled(src, edge);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable (device may be low on memory)');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * The browser lost access to the file (NotReadableError): it was moved or edited
 * after picking, or it's an online-only cloud file (iCloud / OneDrive / Google
 * Drive placeholder) that was never downloaded.
 */
export function unreadable(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'NotReadableError' || /could not be read/i.test(e?.message ?? '');
}
export const UNREADABLE_HELP = "Couldn't read this file from your device. Try picking it again; if it's an online-only cloud copy, download it first.";

/**
 * The copies the app keeps of a picture (render master, detection copy,
 * thumbnail) plus its quality stats and fingerprint. Closes `full` if it's a bitmap.
 */
export async function copiesOf(
  id: string,
  full: CanvasImageSource & { width: number; height: number },
  meta: { takenAt: number | null; lat: number | null; lon: number | null; tzOffset?: number | null },
  fallbackTime: number,
): Promise<PhotoMsg> {
  const width = full.width;
  const height = full.height;
  // Downscale in two steps; full-res bitmap is released right after the first.
  const master = scaleOnly(full, MASTER_EDGE);
  if (full instanceof ImageBitmap) full.close();
  const detail = drawScaled(master, DETAIL_EDGE);
  const small = drawScaled(detail.canvas, SMALL_EDGE);
  const [thumb, detailBlob, masterBlob] = await Promise.all([
    small.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }),
    detail.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }),
    master.convertToBlob({ type: 'image/jpeg', quality: 0.88 }),
  ]);
  return {
    type: 'photo',
    id,
    takenAt: meta.takenAt ?? fallbackTime,
    timeSource: meta.takenAt != null ? 'exif' : 'file',
    lat: meta.lat,
    lon: meta.lon,
    tzOffset: meta.tzOffset ?? null,
    width,
    height,
    thumb,
    detail: detailBlob,
    master: masterBlob,
    stats: measureQuality(detail.gray, small.gray),
    dhash: dhash(small.gray),
  };
}

export const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(f.name);

export async function processPhoto(id: string, file: File): Promise<PhotoMsg | SkippedMsg> {
  if (isVideoFile(file)) return (await import('./video')).processVideo(id, file);
  let full: ImageBitmap;
  try {
    try {
      full = await decodeImage(file);
    } catch (err) {
      if (!unreadable(err)) throw err;
      // Cloud files sometimes become readable a moment later; try once more.
      await new Promise((r) => setTimeout(r, 500));
      full = await decodeImage(file);
    }
  } catch (err) {
    const reason = unreadable(err) ? UNREADABLE_HELP : err instanceof Error ? err.message : String(err);
    return { type: 'skipped', id, name: file.name, reason };
  }
  try {
    const isHeif = await looksLikeHeif(file);
    const exif = await readExif(file, isHeif);
    return await copiesOf(id, full, exif, file.lastModified);
  } catch (err) {
    try {
      full.close();
    } catch {
      /* already closed */
    }
    const reason = unreadable(err) ? UNREADABLE_HELP : `Could not analyse this photo (${errorText(err)})`;
    return { type: 'skipped', id, name: file.name, reason };
  }
}
