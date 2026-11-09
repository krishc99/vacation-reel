import type { Photo, VisionRequest, VisionResponse } from '../types';
import VisionWorker from '../workers/vision.worker?worker';
import type { People } from './people';
import { modelWorkers, runPool } from './pool';

export interface VisionJob {
  done: Promise<{ failed: number; error: string | null; warnings: string[] }>;
  cancel(): void;
}

/**
 * Finds faces and bodies for photos that don't have them yet. Phones run one
 * worker; computers with memory to spare run up to 3 copies side by side.
 * Results stream back through onPeople so the grid can update as it goes.
 */
export function findPeople(
  photos: Photo[],
  onPeople: (id: string, people: People) => void,
  onProgress: (done: number, total: number) => void,
  onReady: () => void = () => {},
): VisionJob {
  const todo = photos.filter((p) => !p.people);
  let warnings: string[] = [];
  if (!todo.length) onReady();
  const pool = runPool<VisionRequest, VisionResponse>(
    () => new VisionWorker(),
    modelWorkers('people'),
    todo.length,
    {
      init: { type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href },
      request: (i) => {
        const p = todo[i];
        return { type: 'photo', id: p.id, detail: p.detail, master: p.master, noise: p.stats.noise };
      },
      kind: (m) => (m.type === 'ready' ? 'ready' : m.type === 'fatal' ? 'fatal' : m.type === 'people' ? 'ok' : 'failed'),
      fatalText: (m) => (m.type === 'fatal' ? m.message : 'people finder stopped'),
    },
    (m) => m.type === 'people' && onPeople(m.id, m.people),
    onProgress,
    (m) => {
      if (m.type === 'ready') warnings = m.warnings;
      onReady();
    },
  );
  return {
    done: pool.done.then((r) => ({ ...r, warnings })),
    cancel: pool.cancel,
  };
}
