import type { Photo, VisionRequest, VisionResponse } from '../types';
import VisionWorker from '../workers/vision.worker?worker';
import type { People } from './people';

export interface VisionJob {
  done: Promise<{ failed: number; error: string | null }>;
  cancel(): void;
}

/**
 * Finds faces and bodies for photos that don't have them yet, one at a time in
 * a single worker (the models are ~10 MB; one copy in memory). Results stream
 * back through onPeople so the grid can update as it goes.
 */
export function findPeople(
  photos: Photo[],
  onPeople: (id: string, people: People) => void,
  onProgress: (done: number, total: number) => void,
): VisionJob {
  const todo = photos.filter((p) => !p.people);
  const worker = new VisionWorker();
  let cancelled = false;
  let finish: (r: { failed: number; error: string | null }) => void = () => {};
  const done = new Promise<{ failed: number; error: string | null }>((r) => (finish = r));
  let i = 0;
  let failed = 0;

  const next = () => {
    if (cancelled) return;
    if (i >= todo.length) {
      worker.terminate();
      return finish({ failed, error: null });
    }
    const p = todo[i];
    const req: VisionRequest = { type: 'photo', id: p.id, detail: p.detail, master: p.master, noise: p.stats.noise };
    worker.postMessage(req);
  };

  worker.onmessage = (e: MessageEvent<VisionResponse>) => {
    const m = e.data;
    if (m.type === 'ready') return next();
    if (m.type === 'fatal') {
      worker.terminate();
      return finish({ failed: todo.length, error: m.message });
    }
    if (m.type === 'people') onPeople(m.id, m.people);
    else failed++;
    onProgress(++i, todo.length);
    next();
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    finish({ failed: todo.length - i, error: e.message || 'people finder stopped' });
  };

  if (todo.length === 0) {
    worker.terminate();
    finish({ failed: 0, error: null });
  } else {
    const init: VisionRequest = { type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href };
    worker.postMessage(init);
  }
  return {
    done,
    cancel() {
      cancelled = true;
      worker.terminate();
      finish({ failed: 0, error: null });
    },
  };
}
