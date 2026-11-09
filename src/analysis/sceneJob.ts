import type { Photo, SceneRequest, SceneResponse } from '../types';
import SceneWorker from '../workers/scene.worker?worker';
import type { Scene } from './scenes';
import { runPool, modelWorkers } from './pool';

export interface SceneJob {
  done: Promise<{ failed: number; error: string | null }>;
  cancel(): void;
}

/** CLIP scene type for each photo without one; 1–2 workers, results stream back. */
export function findScenes(photos: Photo[], onScene: (id: string, s: Scene) => void, onProgress: (done: number, total: number) => void): SceneJob {
  const todo = photos.filter((p) => !p.scene);
  const pool = runPool<SceneRequest, SceneResponse>(
    () => new SceneWorker(),
    modelWorkers('scenes'),
    todo.length,
    {
      init: { type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href },
      request: (i) => ({ type: 'photo', id: todo[i].id, detail: todo[i].detail }),
      kind: (m) => (m.type === 'ready' ? 'ready' : m.type === 'fatal' ? 'fatal' : m.type === 'scene' ? 'ok' : 'failed'),
      fatalText: (m) => (m.type === 'fatal' ? m.message : 'scene finder stopped'),
    },
    (m) => m.type === 'scene' && onScene(m.id, m.scene),
    onProgress,
  );
  return pool;
}
