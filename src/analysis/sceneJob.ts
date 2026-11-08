import type { Photo, SceneRequest, SceneResponse } from '../types';
import SceneWorker from '../workers/scene.worker?worker';
import type { Scene } from './scenes';

export interface SceneJob {
  done: Promise<{ failed: number; error: string | null }>;
  cancel(): void;
}

/** CLIP scene type for each photo without one; one worker, results stream back. */
export function findScenes(photos: Photo[], onScene: (id: string, s: Scene) => void, onProgress: (done: number, total: number) => void): SceneJob {
  const todo = photos.filter((p) => !p.scene);
  const worker = new SceneWorker();
  type Done = { failed: number; error: string | null };
  let finish: (r: Done) => void = () => {};
  const done = new Promise<Done>((r) => (finish = r));
  let i = 0;
  let failed = 0;
  let cancelled = false;
  const next = () => {
    if (cancelled) return;
    if (i >= todo.length) {
      worker.terminate();
      return finish({ failed, error: null });
    }
    const req: SceneRequest = { type: 'photo', id: todo[i].id, detail: todo[i].detail };
    worker.postMessage(req);
  };
  worker.onmessage = (e: MessageEvent<SceneResponse>) => {
    const m = e.data;
    if (m.type === 'ready') return next();
    if (m.type === 'fatal') {
      worker.terminate();
      return finish({ failed: todo.length, error: m.message });
    }
    if (m.type === 'scene') onScene(m.id, m.scene);
    else failed++;
    onProgress(++i, todo.length);
    next();
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    finish({ failed: todo.length - i, error: e.message || 'scene finder stopped' });
  };
  if (!todo.length) {
    worker.terminate();
    finish({ failed: 0, error: null });
  } else {
    const init: SceneRequest = { type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href };
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
