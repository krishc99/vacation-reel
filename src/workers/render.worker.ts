/// <reference lib="webworker" />
import { centerCoverCrop } from '../render/crop';
import { createEncoder, type FrameEncoder } from '../render/encoder';
import { timelineDuration } from '../render/timeline';
import type { RenderRequest, RenderResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

function post(msg: RenderResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/**
 * Decodes one photo and returns it already cropped to the target aspect and
 * scaled to output size, so only one output-sized bitmap is alive at a time.
 */
async function loadFramed(file: File, w: number, h: number): Promise<ImageBitmap> {
  const full = await createImageBitmap(file);
  try {
    const c = centerCoverCrop(full.width, full.height, w, h);
    return await createImageBitmap(full, c.sx, c.sy, c.sw, c.sh, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
  } finally {
    full.close();
  }
}

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  if (e.data.type !== 'render') return;
  const { clips, files, settings: s } = e.data;
  let enc: FrameEncoder | null = null;
  try {
    enc = await createEncoder(s);
    const ctx = enc.canvas.getContext('2d', { alpha: false })!;
    const frameDur = 1 / s.fps;
    const totalFrames = Math.round(timelineDuration(clips) * s.fps);
    let frame = 0;

    for (const clip of clips) {
      const bmp = await loadFramed(files[clip.photoId], s.width, s.height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, s.width, s.height);
      ctx.drawImage(bmp, 0, 0);
      bmp.close();

      // Static frame repeated at constant frame rate (Ken Burns arrives in Milestone 8).
      const endFrame = Math.round((clip.start + clip.duration) * s.fps);
      let first = true;
      while (frame < endFrame) {
        await enc.addFrame(frame * frameDur, frameDur, first);
        first = false;
        frame++;
        if (frame % 15 === 0) post({ type: 'progress', done: frame, total: totalFrames, stage: 'Encoding' });
      }
    }

    post({ type: 'progress', done: totalFrames, total: totalFrames, stage: 'Finishing' });
    const buffer = await enc.finish();
    post({ type: 'result', buffer, mimeType: 'video/mp4', durationSec: totalFrames / s.fps }, [buffer]);
  } catch (err) {
    await enc?.cancel().catch(() => {});
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
