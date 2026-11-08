import type { ImportRequest, ImportResponse, Photo } from '../types';
import ImportWorker from '../workers/import.worker?worker';
import { sortByTime } from './sort';

export interface ImportResult {
  photos: Photo[];
  skipped: { name: string; reason: string }[];
}

let nextId = 0;

/** Two workers: faster on multi-core, while capping full-res decodes in memory at two. */
const POOL_SIZE = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));

/** Decode + EXIF + stats + dHash + thumbnails in workers; returns photos sorted by time. */
export async function importPhotos(
  files: File[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const items = files.map((file) => ({ id: `p${nextId++}`, file }));
  const byId = new Map(items.map((i) => [i.id, i.file]));
  const photos: Photo[] = [];
  const skipped: ImportResult['skipped'] = [];
  let done = 0;

  const chunks: (typeof items)[] = Array.from({ length: POOL_SIZE }, () => []);
  items.forEach((it, i) => chunks[i % POOL_SIZE].push(it));

  await Promise.all(
    chunks
      .filter((c) => c.length)
      .map(
        (chunk) =>
          new Promise<void>((resolve, reject) => {
            const worker = new ImportWorker();
            worker.onmessage = (e: MessageEvent<ImportResponse>) => {
              const msg = e.data;
              if (msg.type === 'photo') {
                const file = byId.get(msg.id)!;
                photos.push({
                  id: msg.id,
                  file,
                  name: file.name,
                  takenAt: msg.takenAt,
                  timeSource: msg.timeSource,
                  lat: msg.lat,
                  lon: msg.lon,
                  width: msg.width,
                  height: msg.height,
                  thumbUrl: URL.createObjectURL(msg.thumb),
                  detail: msg.detail,
                  stats: msg.stats,
                  dhash: msg.dhash,
                });
                onProgress(++done, files.length);
              } else if (msg.type === 'skipped') {
                skipped.push({ name: msg.name, reason: msg.reason });
                onProgress(++done, files.length);
              } else if (msg.type === 'done') {
                worker.terminate();
                resolve();
              }
            };
            worker.onerror = (e) => {
              worker.terminate();
              reject(new Error(e.message || 'Import worker failed'));
            };
            const req: ImportRequest = { type: 'import', files: chunk };
            worker.postMessage(req);
          }),
      ),
  );
  return { photos: sortByTime(photos), skipped };
}
