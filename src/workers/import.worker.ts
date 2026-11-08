/// <reference lib="webworker" />
import { dhash } from '../analysis/dhash';
import { toGray } from '../analysis/pixels';
import { measureQuality } from '../analysis/quality';
import { decodeImage, looksLikeHeif } from '../import/decode';
import { readExif } from '../import/exif';
import type { ImportRequest, ImportResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

const DETAIL_EDGE = 640; // detection + sharpness/noise
const SMALL_EDGE = 256; // exposure, dHash, thumbnail

function post(msg: ImportResponse) {
  self.postMessage(msg);
}

function scaled(src: { width: number; height: number }, edge: number) {
  const s = Math.min(1, edge / Math.max(src.width, src.height));
  return { w: Math.max(1, Math.round(src.width * s)), h: Math.max(1, Math.round(src.height * s)) };
}

function drawScaled(src: CanvasImageSource & { width: number; height: number }, edge: number) {
  const { w, h } = scaled(src, edge);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  return { canvas, gray };
}

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  if (e.data.type !== 'import') return;
  for (const { id, file } of e.data.files) {
    let full: ImageBitmap;
    try {
      full = await decodeImage(file);
    } catch (err) {
      post({ type: 'skipped', id, name: file.name, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const width = full.width;
      const height = full.height;
      // Downscale in two steps; full-res bitmap is released right after the first.
      const detail = drawScaled(full, DETAIL_EDGE);
      full.close();
      const small = drawScaled(detail.canvas, SMALL_EDGE);
      const [exif, thumb, detailBlob] = await Promise.all([
        readExif(file, await looksLikeHeif(file)),
        small.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }),
        detail.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }),
      ]);
      post({
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
      });
    } catch (err) {
      full.close();
      post({ type: 'skipped', id, name: file.name, reason: String(err) });
    }
  }
  post({ type: 'done' });
};
