import type { Clip, Photo, ReelSettings, RenderRequest, RenderResponse } from '../types';
import RenderWorker from '../workers/render.worker?worker';

export interface RenderJob {
  promise: Promise<{ blob: Blob; durationSec: number }>;
  cancel(): void;
}

/** Encodes the timeline to MP4 in a worker. */
export function renderReel(
  clips: Clip[],
  photos: Photo[],
  settings: ReelSettings,
  onProgress: (done: number, total: number, stage: string) => void,
): RenderJob {
  const worker = new RenderWorker();
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<{ blob: Blob; durationSec: number }>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (e: MessageEvent<RenderResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.done, msg.total, msg.stage);
      else if (msg.type === 'result') {
        worker.terminate();
        resolve({ blob: new Blob([msg.buffer], { type: msg.mimeType }), durationSec: msg.durationSec });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Render worker failed'));
    };
  });

  const files: Record<string, File> = {};
  for (const c of clips) files[c.photoId] = photos.find((p) => p.id === c.photoId)!.file;
  const req: RenderRequest = { type: 'render', clips, files, settings };
  worker.postMessage(req);

  return {
    promise,
    cancel() {
      worker.terminate();
      rejectFn(new DOMException('Cancelled', 'AbortError'));
    },
  };
}
