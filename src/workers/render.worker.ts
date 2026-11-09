/// <reference lib="webworker" />
import { centerCoverCrop, frameFor, type CropRect, type Framing, type Subject } from '../render/crop';
import { createEncoder, type FrameEncoder } from '../render/encoder';
import {
  booth,
  boothGroups,
  easeOutBack,
  easeOutCubic,
  filmStrip,
  COVER_LOSS,
  FLASH,
  flashAt,
  leakAt,
  lerpRect,
  LOOKS,
  MAG_PALETTE,
  magazine,
  OVERLAY_CAPTIONS,
  punchAt,
  sparkles,
  SPARKLES,
  splitLayout,
  splitPages,
  stripPosition,
  type Rect,
} from '../render/looks';
import { MOTION, safeZoom, salientCentre, zoomAt, zoomed, zoomFor, type Box } from '../render/motion';
import { timelineDuration } from '../render/timeline';
import type { Caption, RenderRequest, RenderResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;
type Ctx = OffscreenCanvasRenderingContext2D;

function post(msg: RenderResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ---- One photo, drawable into any rectangle -------------------------------------------

interface View {
  framing: Framing;
  ax: number;
  ay: number;
  z: number;
}

/** Everything needed to draw one clip at any size and moment. */
interface Shot {
  full: ImageBitmap;
  subjects: Subject[];
  keep: Box | null;
  /** Whole photo at ~48 px: scaled up, it is the blurred fill. */
  tiny: OffscreenCanvas;
  /** Edge energy per column / row (on a 96 px copy) for the no-people crop. */
  cols: Float32Array;
  rows: Float32Array;
  /** Seconds on screen: sets how far it zooms. */
  seconds: number;
  views: Map<string, View>;
}

async function prepare(image: Blob, subjects: Subject[], seconds: number): Promise<Shot> {
  const full = await createImageBitmap(image);
  const long = Math.max(full.width, full.height);
  const tiny = new OffscreenCanvas(Math.max(1, Math.round((48 * full.width) / long)), Math.max(1, Math.round((48 * full.height) / long)));
  const tctx = tiny.getContext('2d')!;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(full, 0, 0, tiny.width, tiny.height);

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

  const keep: Box | null = subjects.length
    ? {
        x0: Math.min(...subjects.map((b) => b.x)) * full.width,
        y0: Math.min(...subjects.map((b) => b.y)) * full.height,
        x1: Math.max(...subjects.map((b) => b.x + b.w)) * full.width,
        y1: Math.max(...subjects.map((b) => b.y + b.h)) * full.height,
      }
    : null;
  return { full, subjects, keep, tiny, cols, rows, seconds, views: new Map() };
}

/** Framing + zoom anchor for a w×h window (cached per size). */
let coverLoss: number | undefined;

function viewOf(s: Shot, w: number, h: number, motion: boolean): View {
  const key = `${Math.round(w)}x${Math.round(h)}`;
  const hit = s.views.get(key);
  if (hit) return hit;
  const fw = s.full.width;
  const fh = s.full.height;
  let framing = frameFor(fw, fh, w, h, s.subjects, null, coverLoss);
  if (!s.subjects.length && framing.mode === 'cover') {
    const sx = framing.crop.sw / fw;
    const sy = framing.crop.sh / fh;
    if (sx < 0.97 || sy < 0.97)
      framing = frameFor(fw, fh, w, h, [], { x: sx < 0.97 ? salientCentre(s.cols, sx) : 0.5, y: sy < 0.97 ? salientCentre(s.rows, sy) : 0.5 }, coverLoss);
  }
  const win = framing.crop;
  const k = s.keep;
  const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const ax = clampTo(k ? (k.x0 + k.x1) / 2 : win.sx + win.sw / 2, win.sx, win.sx + win.sw);
  const ay = clampTo(k ? (k.y0 + k.y1) / 2 : win.sy + win.sh / 2, win.sy, win.sy + win.sh);
  const v = { framing, ax, ay, z: motion ? safeZoom(win, ax, ay, k, zoomFor(s.seconds)) : 1 };
  if (s.views.size > 12) s.views.clear(); // animated rects: don't pile up
  s.views.set(key, v);
  return v;
}

/** Draws photo `index` into rect r at motion progress u; `extra` multiplies the zoom (beat punch). */
function drawInto(ctx: Ctx, s: Shot, index: number, u: number, r: Rect, motion: boolean, extra = 1) {
  if (r.w < 2 || r.h < 2) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const v = viewOf(s, r.w, r.h, motion);
  const f = v.framing;
  const z = (v.z > 1.0005 ? zoomAt(index, v.z, clamp01(u)) : 1) * extra;
  const src: CropRect = z > 1.0005 ? zoomed(f.crop, v.ax, v.ay, z) : f.crop;
  if (f.mode === 'cover') {
    ctx.drawImage(s.full, src.sx, src.sy, src.sw, src.sh, r.x, r.y, r.w, r.h);
    return;
  }
  drawBlur(ctx, s, r, 0.28);
  const d = f.dest;
  ctx.drawImage(s.full, src.sx, src.sy, src.sw, src.sh, r.x + d.x, r.y + d.y, d.w, d.h);
}

/** Blurred, darkened copy of the photo filling r. */
function drawBlur(ctx: Ctx, s: Shot, r: Rect, dark: number) {
  const c = centerCoverCrop(s.tiny.width, s.tiny.height, r.w, r.h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(s.tiny, c.sx, c.sy, c.sw, c.sh, r.x, r.y, r.w, r.h);
  if (dark > 0) {
    ctx.fillStyle = `rgba(0,0,0,${dark})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
}

// ---- Film: warm faded grade, light leaks, grain, vignette, date stamp -----------------

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


// ---- Accents (flash + sparkles on the chorus hit) ----------------------------------

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

function drawAccents(ctx: OffscreenCanvasRenderingContext2D, accents: number[], t: number, w: number, h: number, flash: boolean, sparkle: boolean) {
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
    if (!sparkle) return;
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


/** Light grain + vignette only (film strip). */
function grainOver(ctx: Ctx, kit: FilmKit, frame: number, alpha: number, w: number, h: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  ctx.drawImage(kit.grain[frame % kit.grain.length], 0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(kit.vignette, 0, 0);
  ctx.restore();
}


// ---- Shared text helpers ---------------------------------------------------------------

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF = '"Didot", "Bodoni 72", "Bodoni MT", "Playfair Display", "Noto Serif Display", "Noto Serif", Georgia, serif';
const MONO = '"Courier New", ui-monospace, monospace';

function spacing(ctx: Ctx, px: number) {
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${Math.round(px)}px`;
}

/** Largest font size (≤ max) at which `text` fits `width`. */
function fitFont(ctx: Ctx, text: string, font: (px: number) => string, width: number, max: number): number {
  let px = Math.round(max);
  ctx.font = font(px);
  const m = ctx.measureText(text).width;
  if (m > width) px = Math.max(10, Math.floor((px * width) / m));
  ctx.font = font(px);
  return px;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

// ---- The render loop ---------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  if (e.data.type !== 'render') return;
  const { clips, images, subjects, settings: s, style, audio } = e.data;
  const W = s.width;
  const H = s.height;
  const look = style.look ?? 'clean';
  const motion = style.motion;
  const vertical = H >= W;
  coverLoss = COVER_LOSS[look];
  let enc: FrameEncoder | null = null;
  const shots = new Map<number, Shot>();
  try {
    enc = await createEncoder(s, audio);
    const ctx = enc.canvas.getContext('2d', { alpha: false })!;
    const layer = new OffscreenCanvas(W, H);
    const lctx = layer.getContext('2d', { alpha: false })!;
    const frameDur = 1 / s.fps;
    const totalFrames = Math.round(timelineDuration(clips) * s.fps);
    const half = MOTION.fade / 2;
    const starts = clips.map((c) => c.start);
    const ends = clips.map((c) => c.start + c.duration);
    const FULL: Rect = { x: 0, y: 0, w: W, h: H };
    const accents = style.accents ?? [];

    const grainKit: FilmKit | null =
      look === 'film' || look === 'filmstrip'
        ? { grain: [1, 2, 3, 4].map((k) => makeGrain(W, H, k)), vignette: makeVignette(W, H, look === 'film' ? 0.5 : 0.35), cuts: starts.slice(1) }
        : null;
    const strip = look === 'filmstrip' ? filmStrip(W, H) : null;
    const boothBox = look === 'booth' ? booth(W, H) : null;
    const groups = look === 'booth' ? boothGroups(clips.length) : [];
    const mag = look === 'magazine' ? magazine(W, H) : null;
    const pages = look === 'split' ? splitPages(clips.map((c) => c.duration), starts, accents) : [];
    const pageOf = new Map<number, number[]>();
    for (const p of pages) for (const k of p) pageOf.set(k, p);
    // Magazine: a new colour each time the cover title (place/day) changes.
    const palette: number[] = [];
    clips.forEach((c, k) => {
      const prev = k ? palette[k - 1] : -1;
      const changed = k === 0 || style.titles[c.photoId] !== style.titles[clips[k - 1].photoId];
      palette.push(changed ? (prev + 1) % MAG_PALETTE.length : prev);
    });

    const fadeIn = (k: number) => (look === 'clean' || look === 'film') && k > 0 && clips[k].transition === 'fade';
    // When each photo starts and stops being on screen (drives the zoom).
    const span = (k: number): [number, number] => {
      if (look === 'filmstrip') return [starts[k] - LOOKS.slideSec, ends[k]];
      if (look === 'booth' && groups[k]) {
        const members = groups.map((g, j) => (g && g.strip === groups[k]!.strip ? j : -1)).filter((j) => j >= 0);
        return [starts[k], ends[members[members.length - 1]]];
      }
      if (look === 'split' && pageOf.has(k)) {
        const p = pageOf.get(k)!;
        return [starts[k], ends[p[p.length - 1]]];
      }
      return [starts[k] - (fadeIn(k) ? half : 0), ends[k] + (k + 1 < clips.length && fadeIn(k + 1) ? half : 0)];
    };
    const progress = (k: number, t: number) => {
      const [a, b] = span(k);
      return (t - a) / Math.max(1e-3, b - a);
    };
    const shot = async (k: number) => {
      let v = shots.get(k);
      if (!v) {
        const c = clips[k];
        const [a, b] = span(k);
        v = await prepare(images[c.photoId], subjects[c.photoId] ?? [], b - a);
        shots.set(k, v);
      }
      return v;
    };
    const punch = (k: number, t: number) => (motion && k > 0 && clips[k].transition !== 'fade' ? punchAt(t - starts[k]) : 1);

    // -- clean / film: full frame, crossfades between beats --
    const drawFull = async (t: number, i: number) => {
      const c = clips[i];
      let a = i;
      let b = -1;
      let alpha = 0;
      if (fadeIn(i) && t < c.start + half) {
        a = i - 1;
        b = i;
        alpha = 0.5 + (t - c.start) / MOTION.fade;
      } else if (i + 1 < clips.length && fadeIn(i + 1) && t >= ends[i] - half) {
        b = i + 1;
        alpha = (t - (ends[i] - half)) / MOTION.fade;
      }
      drawInto(ctx, await shot(a), a, progress(a, t), FULL, motion, punch(a, t));
      if (b >= 0 && alpha > 0) {
        drawInto(lctx, await shot(b), b, progress(b, t), FULL, motion);
        ctx.save();
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
      }
    };

    // -- film strip --
    const drawStrip = async (t: number, frame: number) => {
      const fs = strip!;
      const pos = stripPosition(starts, t);
      const cur = Math.min(clips.length - 1, Math.round(pos));
      drawBlur(ctx, await shot(cur), FULL, 0.55);
      const along = (k: number) => fs.centre + (k - pos) * fs.pitch;
      // The strip band, running past both ends of the screen.
      ctx.fillStyle = '#16110d';
      if (fs.vertical) ctx.fillRect(fs.cross0, 0, fs.cross, H);
      else ctx.fillRect(0, fs.cross0, W, fs.cross);
      const len = fs.vertical ? H : W;
      for (let k = Math.max(0, Math.floor(pos) - 3); k <= Math.min(clips.length - 1, Math.ceil(pos) + 3); k++) {
        const c = along(k);
        const r: Rect = fs.vertical
          ? { x: fs.cross0 + fs.margin, y: c - fs.frame.h / 2, w: fs.frame.w, h: fs.frame.h }
          : { x: c - fs.frame.w / 2, y: fs.cross0 + fs.margin, w: fs.frame.w, h: fs.frame.h };
        if ((fs.vertical ? r.y + r.h : r.x + r.w) < 0 || (fs.vertical ? r.y : r.x) > len) continue;
        drawInto(ctx, await shot(k), k, progress(k, t), r, motion);
        // Edge printing: frame numbers in the margins, like real film.
        ctx.save();
        ctx.fillStyle = '#e39b3a';
        const px = Math.round(fs.margin * 0.26);
        ctx.font = `700 ${px}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = `▸ ${k + 1}A`;
        if (fs.vertical) {
          ctx.translate(fs.cross0 + fs.margin * 0.16, c);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(label, 0, 0);
          ctx.setTransform(1, 0, 0, 1, fs.cross0 + fs.cross - fs.margin * 0.16, c + fs.frame.h * 0.3);
          ctx.rotate(Math.PI / 2);
          ctx.fillText(`VR 400   ${k + 1}`, 0, 0);
        } else {
          ctx.fillText(label, c, fs.cross0 + fs.margin * 0.16);
          ctx.fillText(`VR 400   ${k + 1}`, c + fs.frame.w * 0.3, fs.cross0 + fs.cross - fs.margin * 0.16);
        }
        ctx.restore();
      }
      // Sprocket holes, moving with the strip.
      const hp = fs.pitch / 6;
      const off = ((((fs.centre - pos * fs.pitch) % hp) + hp) % hp) - hp;
      const across = fs.margin * 0.36;
      const alongSize = hp * 0.52;
      ctx.fillStyle = 'rgba(236,228,212,0.92)';
      for (let a = off; a < len + hp; a += hp) {
        for (const side of [fs.cross0 + fs.margin * 0.56 - across / 2, fs.cross0 + fs.cross - fs.margin * 0.56 - across / 2]) {
          if (fs.vertical) roundRect(ctx, side, a, across, alongSize, across * 0.22);
          else roundRect(ctx, a, side, alongSize, across, across * 0.22);
        }
      }
      grainOver(ctx, grainKit!, frame, 0.22, W, H);
    };

    // -- photo-booth strips --
    const drawBoothStrip = async (t: number, stripNo: number, offX: number, rot: number) => {
      const b = boothBox!;
      const members = groups.map((g, j) => (g && g.strip === stripNo ? j : -1)).filter((j) => j >= 0);
      ctx.save();
      ctx.translate(W / 2 + offX, H / 2);
      ctx.rotate(rot);
      ctx.translate(-b.w / 2, -b.h / 2);
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = b.w * 0.05;
      ctx.shadowOffsetY = b.w * 0.015;
      ctx.fillStyle = '#fbfaf6';
      ctx.fillRect(0, 0, b.w, b.h);
      ctx.shadowColor = 'transparent';
      for (const k of members) {
        const cell = b.cells[groups[k]!.cell];
        if (t < starts[k]) {
          ctx.fillStyle = '#e4e0d8';
          ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
          continue;
        }
        drawInto(ctx, await shot(k), k, progress(k, t), cell, motion);
        const f = flashAt(t - starts[k], 0.9, LOOKS.boothFlashSec);
        if (f > 0) {
          ctx.fillStyle = `rgba(255,255,255,${f})`;
          ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
        }
      }
      const label = style.notes[clips[members[0]].photoId] ?? '';
      if (label) {
        ctx.fillStyle = '#2a2622';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        fitFont(ctx, label, (px) => `700 ${px}px ${MONO}`, b.label.w * 0.92, b.label.h * 0.34);
        ctx.fillText(label, b.label.x + b.label.w / 2, b.label.y + b.label.h * 0.52);
      }
      ctx.restore();
    };
    const drawBooth = async (t: number, i: number) => {
      const g = groups[i];
      const next = i + 1 < clips.length ? groups[i + 1] : null;
      const entering = next && next.cell === 0 && t >= starts[i + 1] - LOOKS.slideSec ? next.strip : null;
      const u = entering !== null ? (t - (starts[i + 1] - LOOKS.slideSec)) / LOOKS.slideSec : 0;
      const restRot = (n: number) => ((n % 2 ? 1 : -1) * 1.6 * Math.PI) / 180;
      if (!g) {
        drawInto(ctx, await shot(i), i, progress(i, t), FULL, motion, punch(i, t));
      } else {
        drawBlur(ctx, await shot(i), FULL, 0.4);
        const out = entering !== null ? easeOutCubic(u) : 0;
        await drawBoothStrip(t, g.strip, -out * W * 1.2, restRot(g.strip) - out * 0.15);
      }
      if (entering !== null) {
        const e = easeOutBack(u, 1);
        await drawBoothStrip(t, entering, (1 - e) * W * 1.2, restRot(entering) + (1 - e) * 0.2);
      }
    };

    // -- magazine cover --
    const drawMagazine = async (t: number, i: number) => {
      const m = mag!;
      const [bg, ink] = MAG_PALETTE[palette[i]];
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      const title = (style.titles[clips[i].photoId] ?? '').toUpperCase();
      const changed = i === 0 || style.titles[clips[i - 1].photoId] !== style.titles[clips[i].photoId];
      const since = t - starts[i];
      ctx.save();
      ctx.fillStyle = ink;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      spacing(ctx, -m.title.w * 0.004);
      const px = fitFont(ctx, title, (p) => `700 ${p}px ${SERIF}`, m.title.w, m.title.h * 1.2);
      const rise = changed && motion ? (1 - easeOutCubic(since / 0.45)) * px * 0.25 : 0;
      ctx.globalAlpha = changed && motion ? clamp01(since / 0.3) : 1;
      // Vertical: letters sit on the photo's top edge, their feet tucked under it.
      const base = m.vertical ? m.photo.y + px * 0.1 : m.title.y + px * 0.86;
      ctx.fillText(title, m.title.x, base + rise);
      ctx.restore();
      // Photo with a soft shadow, over the bottom of the title.
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = W * 0.03;
      ctx.shadowOffsetY = W * 0.01;
      ctx.fillStyle = bg;
      ctx.fillRect(m.photo.x, m.photo.y, m.photo.w, m.photo.h);
      ctx.restore();
      drawInto(ctx, await shot(i), i, progress(i, t), m.photo, motion, punch(i, t));
      // Issue line.
      ctx.save();
      ctx.fillStyle = ink;
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1, W * 0.0015);
      const fx = m.vertical ? m.photo.x : m.title.x;
      const fw = m.vertical ? m.photo.w : m.title.w;
      ctx.beginPath();
      ctx.moveTo(fx, m.footerY - W * 0.022);
      ctx.lineTo(fx + fw, m.footerY - W * 0.022);
      ctx.stroke();
      const small = Math.round(Math.min(W, H) * 0.026);
      ctx.font = `600 ${small}px ${SANS}`;
      spacing(ctx, small * 0.18);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(style.kickers[clips[i].photoId] ?? '', fx, m.footerY);
      ctx.textAlign = 'right';
      ctx.font = `italic 500 ${Math.round(small * 1.15)}px ${SERIF}`;
      spacing(ctx, 0);
      ctx.fillText('the travel issue', fx + fw, m.footerY);
      ctx.restore();
    };

    // -- split-screen photo dump --
    const drawSplit = async (t: number, i: number) => {
      const page = pageOf.get(i) ?? [i];
      if (page.length === 1) return drawInto(ctx, await shot(i), i, progress(i, t), FULL, motion, punch(i, t));
      const step = page.indexOf(i);
      const now = splitLayout(page.length, step, vertical);
      const before = step > 0 ? splitLayout(page.length, step - 1, vertical) : now;
      const u = step > 0 && motion ? easeOutCubic((t - starts[i]) / LOOKS.splitSec) : 1;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      const g = Math.min(W, H) * 0.008;
      for (let j = 0; j <= step; j++) {
        const to = now[j];
        const from = j < step ? before[j] : vertical ? { ...to, y: to.y + 1 } : { ...to, x: to.x + 1 };
        const r = lerpRect(from, to, u);
        // Pixel rect with white gutters between cells (not at the screen edge).
        const x0 = r.x * W + (r.x > 0.001 ? g / 2 : 0);
        const y0 = r.y * H + (r.y > 0.001 ? g / 2 : 0);
        const x1 = (r.x + r.w) * W - (r.x + r.w < 0.999 ? g / 2 : 0);
        const y1 = (r.y + r.h) * H - (r.y + r.h < 0.999 ? g / 2 : 0);
        const k = page[j];
        drawInto(ctx, await shot(k), k, progress(k, t), { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, motion);
      }
    };

    let i = 0;
    let keyAt = -1;
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = (frame + 0.5) * frameDur;
      while (i + 1 < clips.length && t >= starts[i + 1]) i++;
      for (const k of [...shots.keys()]) if (k < i - 3) (shots.get(k)!.full.close(), shots.delete(k));
      const c = clips[i];

      if (look === 'filmstrip') await drawStrip(t, frame);
      else if (look === 'booth') await drawBooth(t, i);
      else if (look === 'magazine') await drawMagazine(t, i);
      else if (look === 'split') await drawSplit(t, i);
      else {
        await drawFull(t, i);
        if (look === 'film') drawFilm(ctx, grainKit!, t, frame, i, style.stamps[c.photoId], W, H);
      }
      drawAccents(ctx, accents, t, W, H, FLASH.has(look), SPARKLES.has(look));
      if (OVERLAY_CAPTIONS.has(look)) for (const cap of style.captions) if (t >= cap.start && t < cap.end) drawCaption(ctx, cap, t, W, H);

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
