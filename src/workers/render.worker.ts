/// <reference lib="webworker" />
import { centerCoverCrop, frameFor, type CropRect, type Framing, type Subject } from '../render/crop';
import { createEncoder, type FrameEncoder } from '../render/encoder';
import { MOTION, safeZoom, salientCentre, zoomAt, zoomed, zoomFor, type Box } from '../render/motion';
import { timelineDuration } from '../render/timeline';
import { dropPose, flashAt, leakAt, LOOKS, polaroid, punchAt, restingPose, sparkles, jitter, type Polaroid, type Pose } from '../render/looks';
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
  const onScreen = clip.duration + MOTION.fade + LOOKS.dropSec / 2;
  const z = motion ? safeZoom(win, ax, ay, keep, zoomFor(onScreen)) : 1;
  return { full, framing, fill: framing.mode === 'fit' ? blurredCover(full, w, h) : null, ax, ay, z };
}

/** Draws a shot into the rect (x, y, w, h); `extra` multiplies the zoom (beat punch). */
function drawShot(ctx: OffscreenCanvasRenderingContext2D, s: Shot, index: number, u: number, w: number, h: number, extra = 1, x = 0, y = 0) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const f = s.framing;
  const z = (s.z > 1.0005 ? zoomAt(index, s.z, u) : 1) * extra;
  const src: CropRect = z > 1.0005 ? zoomed(f.crop, s.ax, s.ay, z) : f.crop;
  if (f.mode === 'cover') {
    ctx.drawImage(s.full, src.sx, src.sy, src.sw, src.sh, x, y, w, h);
    return;
  }
  ctx.drawImage(s.fill!, x, y, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(x, y, w, h);
  const d = f.dest;
  ctx.drawImage(s.full, src.sx, src.sy, src.sw, src.sh, x + d.x, y + d.y, d.w, d.h);
}

// ---- Film look: warm faded grade, light leaks, grain, vignette, date stamp ----------

function makeGrain(w: number, h: number, seed: number): OffscreenCanvas {
  const gw = Math.ceil(w / 2);
  const gh = Math.ceil(h / 2);
  const c = new OffscreenCanvas(gw, gh);
  const g = c.getContext('2d')!;
  const img = g.createImageData(gw, gh);
  let r = seed * 2654435761;
  for (let i = 0; i < gw * gh; i++) {
    r = (r * 1103515245 + 12345) >>> 0;
    const v = 128 + ((r >>> 16) % 90) - 45;
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v;
    img.data[4 * i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeVignette(w: number, h: number, strength: number): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${strength})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return c;
}

interface FilmKit {
  grain: OffscreenCanvas[];
  vignette: OffscreenCanvas;
  cuts: number[];
}

function drawFilm(ctx: OffscreenCanvasRenderingContext2D, kit: FilmKit, t: number, frame: number, clipIndex: number, stamp: string | undefined, w: number, h: number) {
  ctx.save();
  // Warm, slightly faded colour.
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = 'rgba(255,176,102,0.55)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgb(24,16,20)';
  ctx.fillRect(0, 0, w, h);
  // Light leaks drifting in from a corner, flaring on each cut.
  const leak = leakAt(t, kit.cuts);
  const side = clipIndex % 2 ? 0 : 1;
  const big = Math.max(w, h);
  const leaks: [number, number, string][] = [
    [w * (side ? 1.02 : -0.02) + Math.sin(t * 0.9) * 0.06 * w, h * (0.18 + 0.08 * Math.sin(t * 0.6)), '255,120,40'],
    [w * (side ? -0.05 : 1.05), h * (0.86 + 0.05 * Math.cos(t * 0.7)), '255,70,110'],
  ];
  for (const [x, y, rgb] of leaks) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, big * 0.55);
    g.addColorStop(0, `rgba(${rgb},${leak})`);
    g.addColorStop(0.45, `rgba(${rgb},${leak * 0.35})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // Grain (changes every frame) and vignette.
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.32;
  ctx.drawImage(kit.grain[frame % kit.grain.length], 0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(kit.vignette, 0, 0);
  // Orange date stamp, bottom right (left of Instagram's buttons).
  if (stamp) {
    const unit = Math.min(w, h);
    ctx.font = `700 ${Math.round(unit * 0.045)}px "Courier New", ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.shadowColor = 'rgba(255,90,0,0.9)';
    ctx.shadowBlur = unit * 0.012;
    ctx.fillStyle = '#ffa23a';
    ctx.fillText(stamp, w * (h > w ? 0.8 : 0.9), h * (h > w ? 0.8 : 0.88));
  }
  ctx.restore();
}

// ---- Scrapbook look: polaroids dropping onto paper, washi tape, handwritten notes -----

function makePaper(w: number, h: number): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#efe6d8';
  g.fillRect(0, 0, w, h);
  // Paper fibres.
  for (let i = 0; i < 2600; i++) {
    const x = ((jitter(i, 11) + 1) / 2) * w;
    const y = ((jitter(i, 12) + 1) / 2) * h;
    g.fillStyle = `rgba(${jitter(i, 13) > 0 ? '120,100,80' : '255,255,255'},${0.05 + 0.06 * Math.abs(jitter(i, 14))})`;
    g.fillRect(x, y, 1 + 2 * Math.abs(jitter(i, 15)), 1);
  }
  // Journal dot grid.
  const step = Math.min(w, h) / 18;
  g.fillStyle = 'rgba(110,90,70,0.16)';
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) g.fillRect(x, y, 3, 3);
  const v = makeVignette(w, h, 0.22);
  g.drawImage(v, 0, 0);
  return c;
}

const TAPE = ['rgba(240,206,206,0.82)', 'rgba(198,222,238,0.82)', 'rgba(236,222,176,0.85)', 'rgba(206,232,204,0.82)'];
const HAND = '"Segoe Print", "Bradley Hand", "Dancing Script", "Comic Sans MS", cursive';

function drawCard(ctx: OffscreenCanvasRenderingContext2D, p: Polaroid, pose: Pose, i: number, drawPhoto: (x: number, y: number, w: number, h: number) => void, note: string | undefined) {
  ctx.save();
  ctx.translate(pose.cx, pose.cy);
  ctx.rotate(pose.rot);
  ctx.scale(pose.scale, pose.scale);
  const x0 = -p.w / 2;
  const y0 = -p.h / 2;
  ctx.shadowColor = 'rgba(40,25,10,0.35)';
  ctx.shadowBlur = p.w * 0.04;
  ctx.shadowOffsetY = p.w * 0.015;
  ctx.fillStyle = '#fbfaf6';
  ctx.fillRect(x0, y0, p.w, p.h);
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0 + p.inner.x, y0 + p.inner.y, p.inner.w, p.inner.h);
  ctx.clip();
  drawPhoto(x0 + p.inner.x, y0 + p.inner.y, p.inner.w, p.inner.h);
  ctx.restore();
  if (note) {
    ctx.fillStyle = '#3a332c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let px = Math.round(p.w * 0.07);
    ctx.font = `600 ${px}px ${HAND}`;
    while (px > 12 && ctx.measureText(note).width > p.inner.w) ctx.font = `600 ${(px -= 2)}px ${HAND}`;
    ctx.fillText(note, 0, y0 + p.inner.y + p.inner.h + (p.h - p.inner.y - p.inner.h) / 2);
  }
  // Washi tape across the top edge, with torn ends.
  ctx.rotate((jitter(i, 9) * 6 * Math.PI) / 180);
  const tw = p.w * 0.32;
  const th = p.w * 0.075;
  ctx.fillStyle = TAPE[i % TAPE.length];
  ctx.beginPath();
  const ty = y0 - th * 0.45;
  ctx.moveTo(-tw / 2, ty);
  for (let k = 0; k <= 6; k++) ctx.lineTo(-tw / 2 + (k % 2 ? 4 : 0), ty + (th * k) / 6);
  ctx.lineTo(tw / 2, ty + th);
  for (let k = 6; k >= 0; k--) ctx.lineTo(tw / 2 - (k % 2 ? 4 : 0), ty + (th * k) / 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---- Accents (all looks): flash + sparkles on the chorus hit ------------------------

function drawSparkle(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.quadraticCurveTo(Math.cos(a + Math.PI / 4) * r * 0.12, Math.sin(a + Math.PI / 4) * r * 0.12, Math.cos(a + Math.PI / 2) * r, Math.sin(a + Math.PI / 2) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawAccents(ctx: OffscreenCanvasRenderingContext2D, accents: number[], t: number, w: number, h: number, flash: boolean) {
  accents.forEach((a, n) => {
    const since = t - a;
    if (since < 0 || since > LOOKS.sparkleSec + 0.2) return;
    if (flash) {
      const f = flashAt(since);
      if (f > 0) {
        ctx.fillStyle = `rgba(255,255,255,${f})`;
        ctx.fillRect(0, 0, w, h);
      }
    }
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(255,240,200,0.9)';
    ctx.shadowBlur = Math.min(w, h) * 0.02;
    for (const sp of sparkles(n)) {
      const u = (since - sp.delay) / LOOKS.sparkleSec;
      if (u <= 0 || u >= 1) continue;
      const grow = u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75;
      ctx.globalAlpha = Math.min(1, grow * 1.4);
      drawSparkle(ctx, sp.x * w, sp.y * h, sp.size * Math.min(w, h) * 2 * grow, u * 1.2);
    }
    ctx.restore();
  });
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
  const look = style.look ?? 'clean';
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
    const card = look === 'scrapbook' ? polaroid(W, H) : null;
    const paper = card ? makePaper(W, H) : null;
    const film: FilmKit | null =
      look === 'film' ? { grain: [1, 2, 3, 4].map((k) => makeGrain(W, H, k)), vignette: makeVignette(W, H, 0.5), cuts: clips.slice(1).map((c) => c.start) } : null;
    // Scrapbook photos fill the polaroid window; other looks fill the frame.
    const TW = card ? Math.round(card.inner.w) : W;
    const TH = card ? Math.round(card.inner.h) : H;
    const D = LOOKS.dropSec;
    const fadeIn = (i: number) => !card && i > 0 && clips[i].transition === 'fade';

    const shot = async (i: number) => {
      let v = shots.get(i);
      if (!v) {
        const c = clips[i];
        v = await prepare(c, images[c.photoId], subjects[c.photoId] ?? [], TW, TH, style.motion);
        shots.set(i, v);
      }
      return v;
    };
    // Scrapbook: polaroid k lands on its beat after falling for D seconds (the first one lands at D).
    const visibleFrom = (k: number) => (card ? (k === 0 ? 0 : clips[k].start - D) : clips[k].start - (fadeIn(k) ? half : 0));
    // Motion runs over the whole time a photo is visible, crossfades and drop-ins included.
    const progress = (k: number, t: number) => {
      const c = clips[k];
      const to = c.start + c.duration + (!card && k + 1 < clips.length && fadeIn(k + 1) ? half : 0);
      const from = visibleFrom(k);
      return (t - from) / Math.max(1e-3, to - from);
    };
    const punch = (k: number, t: number) => (style.motion && k > 0 && clips[k].transition !== 'fade' ? punchAt(t - clips[k].start) : 1);

    let i = 0;
    let keyAt = -1;
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = (frame + 0.5) * frameDur;
      while (i + 1 < clips.length && t >= clips[i + 1].start) i++;
      // Free photos that are done (scrapbook keeps two under the top card).
      for (const k of [...shots.keys()]) if (k < i - 2) (shots.get(k)!.full.close(), shots.delete(k));
      const c = clips[i];

      if (card && paper) {
        ctx.drawImage(paper, 0, 0);
        for (let k = Math.max(0, i - 2); k <= Math.min(clips.length - 1, i + 1); k++) {
          if (t < visibleFrom(k)) continue;
          const u = (t - visibleFrom(k)) / D;
          const pose = u >= 1 ? restingPose(k, W, H) : dropPose(k, u, W, H);
          const sh = await shot(k);
          const p = progress(k, t);
          drawCard(ctx, card, pose, k, (x, y, w, h) => drawShot(ctx, sh, k, p, w, h, 1, x, y), style.notes[clips[k].photoId]);
        }
      } else {
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
        drawShot(ctx, await shot(a), a, progress(a, t), W, H, punch(a, t));
        if (b >= 0 && alpha > 0) {
          drawShot(lctx, await shot(b), b, progress(b, t), W, H);
          ctx.save();
          ctx.globalAlpha = Math.min(1, alpha);
          ctx.drawImage(layer, 0, 0);
          ctx.restore();
        }
        if (film) drawFilm(ctx, film, t, frame, i, style.stamps[c.photoId], W, H);
      }
      drawAccents(ctx, style.accents ?? [], t, W, H, !card);
      if (!card) for (const cap of style.captions) if (t >= cap.start && t < cap.end) drawCaption(ctx, cap, t, W, H);

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
