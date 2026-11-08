import { subjectBoxes } from '../analysis/people';
import type { ReelAudio } from '../audio/song';
import type { Subject } from './crop';
import type { Clip, Photo, ReelSettings, ReelStyle, RenderRequest, RenderResponse } from '../types';
import RenderWorker from '../workers/render.worker?worker';

export interface RenderJob {
  promise: Promise<{ blob: Blob; durationSec: number; audioCodec: string | null }>;
  cancel(): void;
}

/** Encodes the timeline to MP4 in a worker. */
export function renderReel(
  clips: Clip[],
  photos: Photo[],
  settings: ReelSettings,
  style: ReelStyle,
  onProgress: (done: number, total: number, stage: string) => void,
  audio?: ReelAudio,
): RenderJob {
  const worker = new RenderWorker();
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<{ blob: Blob; durationSec: number; audioCodec: string | null }>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (e: MessageEvent<RenderResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.done, msg.total, msg.stage);
      else if (msg.type === 'result') {
        worker.terminate();
        resolve({ blob: new Blob([msg.buffer], { type: msg.mimeType }), durationSec: msg.durationSec, audioCodec: msg.audioCodec });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
      reject(new Error(`Video encoder stopped: ${e.message || 'no message'}${where}`));
    };
  });

  const images: Record<string, Blob> = {};
  const subjects: Record<string, Subject[]> = {};
  for (const c of clips) {
    const p = photos.find((x) => x.id === c.photoId)!;
    images[c.photoId] = p.master;
    subjects[c.photoId] = subjectBoxes(p.people);
  }
  const req: RenderRequest = { type: 'render', clips, images, subjects, settings, style, audio };
  worker.postMessage(req, audio ? [audio.left.buffer, audio.right.buffer] : []);

  return {
    promise,
    cancel() {
      worker.terminate();
      rejectFn(new DOMException('Cancelled', 'AbortError'));
    },
  };
}
