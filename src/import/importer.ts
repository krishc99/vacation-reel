import type { ImportRequest, ImportResponse, Photo } from '../types';
import ImportWorker from '../workers/import.worker?worker';
import { sortByTime } from './sort';

export interface ImportResult {
  photos: Photo[];
  skipped: { name: string; reason: string }[];
}

let nextId = 0;

/** Runs EXIF + decode + thumbnail in a worker, returns photos sorted by capture time. */
export function importPhotos(
  files: File[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const worker = new ImportWorker();
    const byId = new Map<string, File>();
    const items = files.map((file) => {
      const id = `p${nextId++}`;
      byId.set(id, file);
      return { id, file };
    });
    const photos: Photo[] = [];
    const skipped: ImportResult['skipped'] = [];
    let done = 0;

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
        });
        onProgress(++done, files.length);
      } else if (msg.type === 'skipped') {
        skipped.push({ name: msg.name, reason: msg.reason });
        onProgress(++done, files.length);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({ photos: sortByTime(photos), skipped });
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Import worker failed'));
    };
    const req: ImportRequest = { type: 'import', files: items };
    worker.postMessage(req);
  });
}
