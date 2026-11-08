/// <reference lib="webworker" />
import { readExif } from '../import/exif';
import type { ImportRequest, ImportResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

const THUMB_EDGE = 256;

function post(msg: ImportResponse) {
  self.postMessage(msg);
}

async function makeThumb(bitmap: ImageBitmap): Promise<Blob> {
  const scale = THUMB_EDGE / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * Math.min(1, scale)));
  const h = Math.max(1, Math.round(bitmap.height * Math.min(1, scale)));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  if (e.data.type !== 'import') return;
  for (const { id, file } of e.data.files) {
    let bitmap: ImageBitmap | null = null;
    try {
      // createImageBitmap applies EXIF orientation by default ("from-image").
      bitmap = await createImageBitmap(file);
    } catch {
      const isHeic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
      post({
        type: 'skipped',
        id,
        name: file.name,
        reason: isHeic
          ? 'HEIC is not supported in this browser yet (coming in the next milestone). Export as JPEG or use Safari.'
          : 'This file could not be opened as an image.',
      });
      continue;
    }
    try {
      const exif = await readExif(file);
      const thumb = await makeThumb(bitmap);
      post({
        type: 'photo',
        id,
        takenAt: exif.takenAt ?? file.lastModified,
        timeSource: exif.takenAt != null ? 'exif' : 'file',
        lat: exif.lat,
        lon: exif.lon,
        width: bitmap.width,
        height: bitmap.height,
        thumb,
      });
    } catch (err) {
      post({ type: 'skipped', id, name: file.name, reason: String(err) });
    } finally {
      bitmap.close();
    }
  }
  post({ type: 'done' });
};
