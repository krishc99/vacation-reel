import type { ImportRequest, ImportResponse, Photo } from '../types';
import ImportWorker from '../workers/import.worker?worker';
import { errorText, processPhoto } from './process';
import { sortByTime } from './sort';

export interface ImportResult {
  photos: Photo[];
  skipped: { name: string; reason: string }[];
  /** Set when workers could not run and photos were read on the main thread. */
  fallbackReason: string | null;
}

type Item = { id: string; file: File; attempts: number };
type Result = Extract<ImportResponse, { type: 'photo' | 'skipped' }>;

let nextId = 0;

/** Phones: one worker (one full-res decode in memory at a time). Desktops: two. */
function poolSize(): number {
  const touch = navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // Phones: one at a time, unless the browser reports ≥ 6 GB RAM (Chrome's deviceMemory).
  if (touch) return ((navigator as { deviceMemory?: number }).deviceMemory ?? 0) >= 6 ? 2 : 1;
  return Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
}

function workerErrorText(e: ErrorEvent): string {
  const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
  return e.message ? `${e.message}${where}` : `worker stopped without a message${where}`;
}

class WorkerStartError extends Error {}

/**
 * Runs files through a pool of import workers, one file per message.
 * - Worker crashes mid-photo: respawn, retry that photo once, then skip it with the reason.
 * - Worker can't start at all: throws WorkerStartError so the caller falls back.
 */
function runInWorkers(queue: Item[], onResult: (r: Result) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let active = 0;
    let finished = false;
    let everReady = false;

    const done = () => {
      if (!finished && active === 0 && queue.length === 0) {
        finished = true;
        resolve();
      }
    };

    const spawn = () => {
      if (finished || queue.length === 0) return done();
      active++;
      const worker = new ImportWorker();
      let ready = false;
      let current: Item | null = null;

      const next = () => {
        current = queue.shift() ?? null;
        if (!current) {
          worker.terminate();
          active--;
          return done();
        }
        current.attempts++;
        const req: ImportRequest = { type: 'photo', id: current.id, file: current.file };
        worker.postMessage(req);
      };

      const die = (reason: string) => {
        worker.terminate();
        active--;
        if (finished) return;
        if (!ready && !everReady) {
          // Never got going on this device: let the caller use the main thread.
          if (current) queue.unshift(current);
          finished = true;
          return reject(new WorkerStartError(reason));
        }
        if (current) {
          if (current.attempts < 2) queue.push(current);
          else onResult({ type: 'skipped', id: current.id, name: current.file.name, reason: `Reader crashed on this photo: ${reason}` });
        }
        spawn();
      };

      worker.onmessage = (e: MessageEvent<ImportResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          ready = everReady = true;
          next();
        } else if (msg.type === 'photo' || msg.type === 'skipped') {
          onResult(msg);
          next();
        } else if (msg.type === 'fatal') {
          die(msg.message);
        }
      };
      worker.onerror = (e) => {
        e.preventDefault();
        die(workerErrorText(e));
      };
      worker.onmessageerror = () => die('message could not be read');
    };

    const n = Math.min(poolSize(), queue.length);
    if (n === 0) return done();
    for (let i = 0; i < n; i++) spawn();
  });
}

async function runOnMainThread(queue: Item[], onResult: (r: Result) => void) {
  for (const item of queue.splice(0)) {
    try {
      onResult(await processPhoto(item.id, item.file));
    } catch (err) {
      onResult({ type: 'skipped', id: item.id, name: item.file.name, reason: errorText(err) });
    }
    // Let the page repaint progress between photos.
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Decode + EXIF + stats + dHash + thumbnails; returns photos sorted by capture time. */
/**
 * Copy every picked file right away. Android (and cloud-backed pickers) only let
 * a page read picked files for a limited time; analysis takes a few seconds per
 * photo, so files at the back of the queue used to become unreadable
 * (NotReadableError). Reading bytes is fast; the copies are ordinary Blobs the
 * browser can keep on disk.
 */
async function snapshot(
  files: File[],
  onProgress: (done: number, total: number) => void,
): Promise<{ copies: File[]; unreadable: string[] }> {
  const copies: File[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    try {
      const bytes = await f.arrayBuffer();
      copies.push(new File([bytes], f.name, { type: f.type, lastModified: f.lastModified }));
    } catch {
      unreadable.push(f.name);
    }
    onProgress(copies.length + unreadable.length, files.length);
  }
  return { copies, unreadable };
}

export async function importPhotos(
  picked: File[],
  onProgress: (done: number, total: number) => void,
  onCopying: (done: number, total: number) => void = () => {},
): Promise<ImportResult> {
  const { copies: files, unreadable } = await snapshot(picked, onCopying);
  const queue: Item[] = files.map((file) => ({ id: `p${nextId++}`, file, attempts: 0 }));
  const byId = new Map(queue.map((i) => [i.id, i.file]));
  const photos: Photo[] = [];
  const skipped: ImportResult['skipped'] = unreadable.map((name) => ({
    name,
    reason: "Couldn't read this file from your device. Try picking it again; if it's an online-only cloud copy, download it first.",
  }));
  const seen = new Set<string>();
  let fallbackReason: string | null = null;

  const onResult = (msg: Result) => {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    if (msg.type === 'photo') {
      const file = byId.get(msg.id)!;
      photos.push({
        id: msg.id,
        name: file.name,
        takenAt: msg.takenAt,
        timeSource: msg.timeSource,
        lat: msg.lat,
        lon: msg.lon,
        width: msg.width,
        height: msg.height,
        thumbUrl: URL.createObjectURL(msg.thumb),
        detail: msg.detail,
        master: msg.master,
        stats: msg.stats,
        dhash: msg.dhash,
      });
    } else {
      skipped.push({ name: msg.name, reason: msg.reason });
    }
    onProgress(seen.size, files.length);
  };

  try {
    await runInWorkers(queue, onResult);
  } catch (err) {
    if (!(err instanceof WorkerStartError)) throw err;
    fallbackReason = err.message;
    console.warn('Import worker could not start, using main thread:', err.message);
    await runOnMainThread(queue, onResult);
  }
  return { photos: sortByTime(photos), skipped, fallbackReason };
}
