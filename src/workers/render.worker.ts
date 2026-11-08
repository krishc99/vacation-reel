/// <reference lib="webworker" />
import { centerCoverCrop, frameFor, type CropRect, type Framing, type Subject } from '../render/crop';
import { createEncoder, type FrameEncoder } from '../render/encoder';
import { MOTION, safeZoom, salientCentre, zoomAt, zoomed, zoomFor, type Box } from '../render/motion';
import { timelineDuration } from '../render/timeline';
import type { Caption, Clip, RenderRequest, RenderResponse } from '../types';

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

/** Where the detail is in a photo without people (normalized centre), from edge energy on a small copy. */
function salientPoint(full: ImageBitmap, f: Framing & { mode: 'cover' }): { x: number; y: number } | null {
  const shareX = f.crop.sw / full.width;
  const shareY = f.crop.sh / full.height;
  if (shareX > 0.97 && shareY > 0.97) return null;
  const W = 96;
  const H = Math.max(8, Math.round((W * full.height) / full.width));
  const c = new OffscreenCanvas(W, H);
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(full, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  const cols = new Float32Array(W);
  const rows = new Float32Array(H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const e = Math.abs(g[y * W + x + 1] - g[y * W + x - 1]) + Math.abs(g[(y + 1) * W + x] - g[(y - 1) * W + x]);
      cols[x] += e;
      rows[y] += e;
    }
  return { x: shareX < 0.97 ? salientCentre(cols, shareX) : 0.5, y: shareY < 0.97 ? salientCentre(rows, shareY) : 0.5 };
}

/** Everything needed to draw one clip at any moment. */
interface Shot {
  full: ImageBitmap;
  framing: Framing;
  /** Fit mode: blurred fill behind the photo. */
  fill: OffscreenCanvas | null;
  ax: number;
  ay: number;
  /** Zoom reached at the end of the motion (1 = still). */
  z: number;
}

async function prepare(clip: Clip, image: Blob, subjects: Subject[], w: number, h: number, motion: boolean): Promise<Shot> {
  const full = await createImageBitmap(image);
  let framing = frameFor(full.width, full.height, w, h, subjects);
  if (!subjects.length && framing.mode === 'cover') framing = frameFor(full.width, full.height, w, h, [], salientPoint(full, framing));
  const win = framing.crop;
  let keep: Box | null = null;
  if (subjects.length) {
    keep = {
      x0: Math.min(...subjects.map((b) => b.x)) * full.width,
      y0: Math.min(...subjects.map((b) => b.y)) * full.height,
      x1: Math.max(...subjects.map((b) => b.x + b.w)) * full.width,
      y1: Math.max(...subjects.map((b) => b.y + b.h)) * full.height,
    };
  }
  // Anchor: the people's centre (or the window's), kept inside the window.
  const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const ax = clampTo(keep ? (keep.x0 + keep.x1) / 2 : win.sx + win.sw / 2, win.sx, win.sx + win.sw);
  const ay = clampTo(keep ? (keep.y0 + keep.y1) / 2 : win.sy + win.sh / 2, win.sy, win.sy + win.sh);
  const onScreen = clip.duration + (clip.transition === 'fade' ? MOTION.fade / 2 : 0) + MOTION.fade / 2;
  const z = motion ? safeZoom(win, ax, ay, keep, zoomFor(onScreen)) : 1;
  return { full, framing, fill: framing.mode === 'fit' ? blurredCover(full, w, h) : null, ax, ay, z };
}

function drawShot(ctx: OffscreenCanvasRenderingContext2D, s: Shot, index: number, u: number, w: number, h: number) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const f = s.framing;
  const src: CropRect = s.z > 1.0005 ? zoomed(f.crop, s.ax, s.ay, zoomAt(index, s.z, u)) : f.crop;
  if (f.mode === 'cover') {
    ctx.drawImage(s.full, src.sx, src.sy, src.sw, src.sh, 0, 0, w, h);
    return;
  }
  ctx.drawImage(s.fill!, 0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, 0, w, h);
  const d = f.dest;
  ctx.drawImage(s.full, src.sx, src.sy, src.sw, src.sh, d.x, d.y, d.w, d.h);
}

/** Lower-left, above where Instagram puts its buttons and caption. */
function drawCaption(ctx: OffscreenCanvasRenderingContext2D, c: Caption, t: number, w: number, h: number) {
  const a = Math.min(1, (t - c.start) / MOTION.captionFade, (c.end - t) / MOTION.captionFade);
  if (a <= 0) return;
  const unit = Math.min(w, h);
  const x = Math.round(0.07 * w);
  const baseY = Math.round(h > w ? 0.74 * h : 0.8 * h);
  const mainPx = Math.round(unit * 0.085);
  const topPx = Math.round(unit * 0.034);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = unit * 0.02;
  ctx.fillStyle = '#fff';
  // Slight rise as it appears.
  const rise = (1 - Math.min(1, (t - c.start) / MOTION.captionFade)) * unit * 0.015;
  ctx.font = `700 ${mainPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  let main = c.main;
  while (main.length > 4 && ctx.measureText(main).width > w - 2 * x) main = main.slice(0, -2) + '…';
  ctx.fillText(main, x, baseY + rise);
  if (c.top) {
    ctx.font = `600 ${topPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${Math.round(topPx * 0.15)}px`;
    ctx.fillText(c.top.toUpperCase(), x, baseY - mainPx * 1.05 + rise);
  }
  ctx.restore();
}

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  if (e.data.type !== 'render') return;
  const { clips, images, subjects, settings: s, style, audio } = e.data;
  const W = s.width;
  const H = s.height;
  let enc: FrameEncoder | null = null;
  const shots = new Map<number, Shot>();
  try {
    enc = await createEncoder(s, audio);
    const ctx = enc.canvas.getContext('2d', { alpha: false })!;
    // Incoming photo during a crossfade is drawn here, then blended in one step.
    const layer = new OffscreenCanvas(W, H);
    const lctx = layer.getContext('2d', { alpha: false })!;
    const frameDur = 1 / s.fps;
    const totalFrames = Math.round(timelineDuration(clips) * s.fps);
    const half = MOTION.fade / 2;
    const fadeIn = (i: number) => i > 0 && clips[i].transition === 'fade';

    const shot = async (i: number) => {
      let v = shots.get(i);
      if (!v) {
        const c = clips[i];
        v = await prepare(c, images[c.photoId], subjects[c.photoId] ?? [], W, H, style.motion);
        shots.set(i, v);
      }
      return v;
    };
    // Motion runs over the whole time a photo is visible, crossfades included.
    const progress = (i: number, t: number) => {
      const c = clips[i];
      const from = c.start - (fadeIn(i) ? half : 0);
      const to = c.start + c.duration + (i + 1 < clips.length && fadeIn(i + 1) ? half : 0);
      return (t - from) / Math.max(1e-3, to - from);
    };

    let i = 0;
    let keyAt = -1;
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = (frame + 0.5) * frameDur;
      while (i + 1 < clips.length && t >= clips[i + 1].start) i++;
      // Free photos that are done.
      for (const k of [...shots.keys()]) if (k < i - 1) (shots.get(k)!.full.close(), shots.delete(k));

      const c = clips[i];
      const end = c.start + c.duration;
      let a = i; // drawn underneath
      let b = -1; // blended on top
      let alpha = 0;
      if (fadeIn(i) && t < c.start + half) {
        a = i - 1;
        b = i;
        alpha = 0.5 + (t - c.start) / MOTION.fade;
      } else if (i + 1 < clips.length && fadeIn(i + 1) && t >= end - half) {
        b = i + 1;
        alpha = (t - (end - half)) / MOTION.fade;
      }
      drawShot(ctx, await shot(a), a, progress(a, t), W, H);
      if (b >= 0 && alpha > 0) {
        drawShot(lctx, await shot(b), b, progress(b, t), W, H);
        ctx.save();
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
      }
      for (const cap of style.captions) if (t >= cap.start && t < cap.end) drawCaption(ctx, cap, t, W, H);

      // Keyframe where each photo starts (cheap seeking, clean cuts).
      const key = keyAt !== i;
      keyAt = i;
      await enc.addFrame(frame * frameDur, frameDur, key);
      if (frame % 15 === 0) post({ type: 'progress', done: frame, total: totalFrames, stage: 'Encoding' });
    }

    post({ type: 'progress', done: totalFrames, total: totalFrames, stage: 'Finishing' });
    const buffer = await enc.finish();
    post({ type: 'result', buffer, mimeType: 'video/mp4', durationSec: totalFrames / s.fps, audioCodec: enc.audioCodec }, [buffer]);
  } catch (err) {
    await enc?.cancel().catch(() => {});
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    for (const v of shots.values()) v.full.close();
  }
};
