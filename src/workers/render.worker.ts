/// <reference lib="webworker" />
import { centerCoverCrop, frameFor, type Subject } from '../render/crop';
import { createEncoder, type FrameEncoder } from '../render/encoder';
import { timelineDuration } from '../render/timeline';
import type { RenderRequest, RenderResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

function post(msg: RenderResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/** Cheap, portable blur (canvas `filter` isn't in every browser): shrink 24×, then scale back up smoothly. */
function blurredCover(full: ImageBitmap, w: number, h: number): OffscreenCanvas {
  const c = centerCoverCrop(full.width, full.height, w, h);
  const tw = Math.max(1, Math.round(w / 24));
  const th = Math.max(1, Math.round(h / 24));
  const tiny = new OffscreenCanvas(tw, th);
  const tctx = tiny.getContext('2d')!;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(full, c.sx, c.sy, c.sw, c.sh, 0, 0, tw, th);
  return tiny;
}

/**
 * Draws one photo into the frame: cropped to fill, or (for photos far from the
 * reel's shape, e.g. landscape group shots in a vertical reel) shown whole over
 * a blurred, darkened copy of itself so nobody at the edges is cut off.
 */
async function drawPhoto(ctx: OffscreenCanvasRenderingContext2D, image: Blob, w: number, h: number, subjects: Subject[]) {
  const full = await createImageBitmap(image);
  try {
    const f = frameFor(full.width, full.height, w, h, subjects);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (f.mode === 'cover') {
      ctx.drawImage(full, f.crop.sx, f.crop.sy, f.crop.sw, f.crop.sh, 0, 0, w, h);
      return;
    }
    ctx.drawImage(blurredCover(full, w, h), 0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, w, h);
    const { crop: c, dest: d } = f;
    ctx.drawImage(full, c.sx, c.sy, c.sw, c.sh, d.x, d.y, d.w, d.h);
  } finally {
    full.close();
  }
}

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  if (e.data.type !== 'render') return;
  const { clips, images, subjects, settings: s, audio } = e.data;
  let enc: FrameEncoder | null = null;
  try {
    enc = await createEncoder(s, audio);
    const ctx = enc.canvas.getContext('2d', { alpha: false })!;
    const frameDur = 1 / s.fps;
    const totalFrames = Math.round(timelineDuration(clips) * s.fps);
    let frame = 0;

    for (const clip of clips) {
      await drawPhoto(ctx, images[clip.photoId], s.width, s.height, subjects[clip.photoId] ?? []);

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
    post({ type: 'result', buffer, mimeType: 'video/mp4', durationSec: totalFrames / s.fps, audioCodec: enc.audioCodec }, [buffer]);
  } catch (err) {
    await enc?.cancel().catch(() => {});
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
