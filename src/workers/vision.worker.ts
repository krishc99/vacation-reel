/// <reference lib="webworker" />
// Faces + bodies for each photo (Milestone 4a). MediaPipe runs on CPU (wasm) so
// it behaves the same on every device. Models are served from our own site.
import { FaceLandmarker, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import * as ort from 'onnxruntime-web/wasm';
import { l2normalize, similarity, TEMPLATE_112, type Pt } from '../analysis/align';
import { fetchAsBlobUrl, fetchBytes } from './fetchAsset';
import { dedupe, headAngles, summarize, type Body, type Box, type Face } from '../analysis/people';
import { toGray } from '../analysis/pixels';
import { decodeYunet, yawFromPoints, YUNET, yunetTensor } from '../analysis/yunet';
import { subjectSharpness } from '../analysis/quality';
import type { VisionRequest, VisionResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

let face: FaceLandmarker | null = null;
let pose: PoseLandmarker | null = null;
let sface: ort.InferenceSession | null = null;
/** Main face finder when it loads; MediaPipe then only reads expressions on face crops. */
let yunet: ort.InferenceSession | null = null;

/** Face points used for alignment (MediaPipe mesh indices), in image order left → right. */
const EYE_L = [33, 133]; // subject's right eye = image left
const EYE_R = [362, 263];
const NOSE = 1;
const MOUTH_L = 61;
const MOUTH_R = 291;

/** Internal: face plus its 5 alignment points (normalized to the whole photo). */
type FaceWithPts = Face & { pts: Pt[] };

const EMBED_MIN_FACE = 0.025; // face height share (on the 2560 px copy ≈ 48 px); smaller faces give unreliable identities
const EMBED_MAX_YAW = 50;

function post(msg: VisionResponse) {
  self.postMessage(msg);
}

/**
 * Why a file didn't load: HTTP status if the server answered, otherwise a network
 * block (offline, ad/privacy blocker, firewall). Shown to the user verbatim.
 */
async function whyFailed(url: string, err: unknown): Promise<string> {
  const name = url.split('/').slice(-2).join('/');
  let status = 'blocked or offline (no response)';
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    status = r.ok ? `HTTP ${r.status}, so the file exists; ${err instanceof Error ? err.message : String(err)}` : `HTTP ${r.status}`;
  } catch {
    /* keep "blocked" */
  }
  return `${name}: ${status}`;
}

async function stage<T>(url: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(await whyFailed(url, err));
  }
}

/** Loads the detectors. Faces are required; bodies and identities degrade gracefully. */
async function init(base: string): Promise<string[]> {
  const warnings: string[] = [];
  // Explicit module-build paths (FilesetResolver may pick a non-existent "nosimd"
  // variant), and load the loader ourselves: it registers globalThis.ModuleFactory.
  // The 13.5 MB engine is downloaded by us (with retries) and handed over as a
  // local blob: URL, so a dropped connection doesn't kill the people finder.
  const wasmUrl = new URL('mediapipe/vision_wasm_module_internal.wasm', base).href;
  const files = {
    wasmLoaderPath: new URL('mediapipe/vision_wasm_module_internal.js', base).href,
    wasmBinaryPath: await stage(wasmUrl, () => fetchAsBlobUrl(wasmUrl, 'application/wasm')),
  };
  // MediaPipe deletes globalThis.ModuleFactory after creating a task, and an ES
  // module only evaluates once, so put the factory back before each task.
  const loader = await stage(files.wasmLoaderPath, () => import(/* @vite-ignore */ files.wasmLoaderPath) as Promise<{ default: unknown }>);
  const g = self as unknown as { ModuleFactory?: unknown };
  g.ModuleFactory = loader.default;
  const faceModel = new URL('models/face_landmarker.task', base).href;
  const faceBytes = await stage(faceModel, () => fetchBytes(faceModel));
  face = await stage(faceModel, () =>
    FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetBuffer: faceBytes, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 12,
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    }),
  );

  const poseModel = new URL('models/pose_landmarker_lite.task', base).href;
  try {
    g.ModuleFactory = loader.default;
    const poseBytes = await stage(poseModel, () => fetchBytes(poseModel));
    pose = await stage(poseModel, () =>
      PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: poseBytes, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numPoses: 6,
        minPoseDetectionConfidence: 0.6,
        minPosePresenceConfidence: 0.6,
      }),
    );
  } catch (err) {
    warnings.push(`Bodies off (${(err as Error).message})`);
  }

  const ortWasm = new URL('ort/ort-wasm-simd-threaded.wasm', base).href;
  const sfaceModel = new URL('models/face_recognition_sface_2021dec.onnx', base).href;
  try {
    ort.env.wasm.numThreads = 1; // no cross-origin isolation on GitHub Pages
    ort.env.wasm.wasmBinary = await stage(ortWasm, () => fetchBytes(ortWasm));
    const sfaceBytes = await stage(sfaceModel, () => fetchBytes(sfaceModel));
    sface = await stage(sfaceModel, () =>
      ort.InferenceSession.create(sfaceBytes, {
        executionProviders: ['wasm'],
        logSeverityLevel: 3, // the model's graph triggers harmless optimiser warnings
      }),
    );
    const yunetModel = new URL('models/face_detection_yunet_2023mar.onnx', base).href;
    try {
      const bytes = await stage(yunetModel, () => fetchBytes(yunetModel));
      yunet = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], logSeverityLevel: 3 });
    } catch (err) {
      warnings.push(`Small-face finder off (${(err as Error).message})`);
    }
  } catch (err) {
    // The runtime wasm may be the culprit rather than the model.
    const rt = await whyFailed(ortWasm, err);
    warnings.push(`Friend recognition off (${(err as Error).message}; runtime ${rt})`);
  }
  return warnings;
}

function boxOf(lms: NormalizedLandmark[], minVis = -1): Box | null {
  const pts = lms.filter((l) => (l.visibility ?? 1) >= minVis);
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** Tile rect (normalized) → map tile-normalized box back to the whole photo. */
type Tile = { x: number; y: number; w: number; h: number };
const mapBox = (b: Box, t: Tile): Box => ({ x: t.x + b.x * t.w, y: t.y + b.y * t.h, w: b.w * t.w, h: b.h * t.h });

function detectFaces(img: ImageBitmap | OffscreenCanvas, tile: Tile): FaceWithPts[] {
  const r = face!.detect(img);
  return r.faceLandmarks.flatMap((lms, i) => {
    const b = boxOf(lms);
    if (!b) return [];
    const bs = r.faceBlendshapes?.[i]?.categories ?? [];
    const score = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
    const m = r.facialTransformationMatrixes?.[i]?.data;
    const { yaw, pitch } = m ? headAngles(m) : { yaw: 0, pitch: 0 };
    const at = (k: number): Pt => [tile.x + lms[k].x * tile.w, tile.y + lms[k].y * tile.h];
    const avg = (ks: number[]): Pt => {
      const ps = ks.map(at);
      return [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
    };
    return [
      {
        pts: [avg(EYE_L), avg(EYE_R), at(NOSE), at(MOUTH_L), at(MOUTH_R)],
        box: mapBox(b, tile),
        blinkL: score('eyeBlinkLeft'),
        blinkR: score('eyeBlinkRight'),
        smile: (score('mouthSmileLeft') + score('mouthSmileRight')) / 2,
        jawOpen: score('jawOpen'),
        lookDown: (score('eyeLookDownLeft') + score('eyeLookDownRight')) / 2,
        yaw,
        pitch,
      },
    ];
  });
}

/** YuNet on a region of the image (tile, normalized), letterboxed into 640×640. */
async function detectYunet(src: ImageBitmap, t: Tile): Promise<FaceWithPts[]> {
  const sw = t.w * src.width;
  const sh = t.h * src.height;
  const sc = YUNET.size / Math.max(sw, sh);
  const c = new OffscreenCanvas(YUNET.size, YUNET.size);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, YUNET.size, YUNET.size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, t.x * src.width, t.y * src.height, sw, sh, 0, 0, sw * sc, sh * sc);
  const data = yunetTensor(ctx.getImageData(0, 0, YUNET.size, YUNET.size).data);
  const out = await yunet!.run({ [yunet!.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, YUNET.size, YUNET.size]) });
  // Input pixels → normalized whole-photo coordinates.
  const nx = (x: number) => t.x + (x / sc / sw) * t.w;
  const ny = (y: number) => t.y + (y / sc / sh) * t.h;
  return decodeYunet(out as Record<string, { data: ArrayLike<number> }>).map((d) => {
    const pts = d.pts.map(([x, y]) => [nx(x), ny(y)] as Pt);
    return {
      pts,
      box: { x: nx(d.x), y: ny(d.y), w: (d.w / sc / sw) * t.w, h: (d.h / sc / sh) * t.h },
      blinkL: 0,
      blinkR: 0,
      smile: 0,
      jawOpen: 0,
      lookDown: 0,
      yaw: yawFromPoints(pts),
      pitch: 0,
    };
  });
}

/**
 * Expressions (eyes, smile, head angle) for a YuNet face: MediaPipe on a crop
 * around it, where the face is big enough for MediaPipe's close-range detector.
 * Keeps YuNet's box and points (they're what SFace aligns on).
 */
function readExpression(master: ImageBitmap, f: FaceWithPts): boolean {
  const side = Math.max(f.box.w * master.width, f.box.h * master.height) * 2.2;
  const cx = (f.box.x + f.box.w / 2) * master.width;
  const cy = (f.box.y + f.box.h / 2) * master.height;
  const c = new OffscreenCanvas(256, 256);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 256);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(master, cx - side / 2, cy - side / 2, side, side, 0, 0, 256, 256);
  const tile: Tile = { x: 0, y: 0, w: 1, h: 1 };
  const found = detectFaces(c, tile);
  // The face nearest the crop's centre is ours.
  const mine = found.sort((a, b) => Math.hypot(a.box.x + a.box.w / 2 - 0.5, a.box.y + a.box.h / 2 - 0.5) - Math.hypot(b.box.x + b.box.w / 2 - 0.5, b.box.y + b.box.h / 2 - 0.5))[0];
  if (!mine || Math.hypot(mine.box.x + mine.box.w / 2 - 0.5, mine.box.y + mine.box.h / 2 - 0.5) > 0.2) return false;
  f.blinkL = mine.blinkL;
  f.blinkR = mine.blinkR;
  f.smile = mine.smile;
  f.jawOpen = mine.jawOpen;
  f.lookDown = mine.lookDown;
  f.yaw = mine.yaw;
  f.pitch = mine.pitch;
  return true;
}

/** Pose hand points (wrists, pinkies, index fingers, thumbs). */
const HAND = [15, 16, 17, 18, 19, 20, 21, 22];

/** Body proportions in real units (x scaled by aspect): [hip width, torso length, leg length] relative to shoulders/torso. */
function geometry(l: NormalizedLandmark[], aspect: number): number[] {
  const d = (a: number, b: number) => Math.hypot((l[a].x - l[b].x) * aspect, l[a].y - l[b].y);
  const mid = (a: number, b: number) => ({ x: ((l[a].x + l[b].x) / 2) * aspect, y: (l[a].y + l[b].y) / 2 });
  const sh = d(11, 12) || 1e-6;
  const ms = mid(11, 12);
  const mh = mid(23, 24);
  const torso = Math.hypot(ms.x - mh.x, ms.y - mh.y);
  const legs = (d(23, 25) + d(24, 26)) / 2;
  return [d(23, 24) / sh, torso / sh, legs / (torso || 1e-6)];
}

let lastHands: Pt[] = [];

function detectBodies(img: ImageBitmap): Body[] {
  const r = pose!.detect(img);
  lastHands = r.landmarks.flatMap((lms) => HAND.filter((k) => (lms[k]?.visibility ?? 0) > 0.6).map((k) => [lms[k].x, lms[k].y] as Pt));
  return r.landmarks.flatMap((lms) => {
    const b = boxOf(lms, 0.5);
    if (!b) return [];
    const vis = (i: number) => (lms[i]?.visibility ?? 0) > 0.65;
    // Count a body only with a believable torso: both shoulders, plus both hips or a
    // visible head (nose, eyes or ears). Objects (bikes, chairs) can trigger the detector without these.
    const head = vis(0) || vis(2) || vis(5) || vis(7) || vis(8); // nose, eyes or ears
    if (!(vis(11) && vis(12) && ((vis(23) && vis(24)) || head))) return [];
    if (vis(23) && vis(24)) {
      // Upright: shoulders above hips.
      if ((lms[11].y + lms[12].y) / 2 >= (lms[23].y + lms[24].y) / 2) return [];
      // Human proportions (sample people: hips 0.4–0.7× and torso 0.7–1.8× shoulder
      // width; a motorbike read as a "body" had a torso 5.4× its shoulders).
      const [hips, torso] = geometry(lms, img.width / img.height);
      if (hips < 0.3 || hips > 1.3 || torso > 2.5) return [];
    }
    const noseY = lms[0]?.y ?? 0;
    return [
      {
        box: b,
        noseVisible: vis(0),
        shouldersVisible: vis(11) && vis(12),
        armsUp: vis(15) && vis(16) && lms[15].y < noseY && lms[16].y < noseY,
      },
    ];
  });
}

/**
 * Overlapping tiles of the large copy, so small faces in group shots and wide
 * scenes are still big enough for the detector (it works on a 128 px input).
 */
function tiles(w: number, h: number): Tile[] {
  const cols = w >= h ? 3 : 2;
  const rows = w >= h ? 2 : 3;
  const tw = 1.6 / cols; // 60% overlap budget across the row
  const th = 1.6 / rows;
  const out: Tile[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ x: ((1 - tw) * c) / (cols - 1), y: ((1 - th) * r) / (rows - 1), w: tw, h: th });
  return out;
}

function crop(src: ImageBitmap, t: Tile): OffscreenCanvas {
  const sw = Math.round(t.w * src.width);
  const sh = Math.round(t.h * src.height);
  const scale = Math.min(1, 960 / Math.max(sw, sh));
  const c = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  c.getContext('2d')!.drawImage(src, Math.round(t.x * src.width), Math.round(t.y * src.height), sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** Align a face to 112×112 from the big copy and run SFace. */
async function embed(master: ImageBitmap, f: FaceWithPts): Promise<number[]> {
  const src = f.pts.map(([x, y]) => [x * master.width, y * master.height] as Pt);
  const [a, b, c, d, e, g] = similarity(src, TEMPLATE_112);
  const canvas = new OffscreenCanvas(112, 112);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(a, b, c, d, e, g);
  ctx.drawImage(master, 0, 0);
  const px = ctx.getImageData(0, 0, 112, 112).data;
  // OpenCV FaceRecognizerSF: RGB, 0–255, no mean/scale, NCHW.
  const input = new Float32Array(3 * 112 * 112);
  for (let i = 0; i < 112 * 112; i++) {
    input[i] = px[i * 4];
    input[i + 112 * 112] = px[i * 4 + 1];
    input[i + 2 * 112 * 112] = px[i * 4 + 2];
  }
  const feeds = { [sface!.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) };
  const out = await sface!.run(feeds);
  return l2normalize(out[sface!.outputNames[0]].data as Float32Array);
}

/** Per-face sharpness: 96 px crop (face + 20%) from the big copy, same ratio metric as the photo. */
function faceSharpnessOf(master: ImageBitmap, f: Face, noise: number): number {
  const side = Math.max(f.box.w * master.width, f.box.h * master.height) * 1.2;
  const cx = (f.box.x + f.box.w / 2) * master.width;
  const cy = (f.box.y + f.box.h / 2) * master.height;
  const c = new OffscreenCanvas(96, 96);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(master, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
  const gray = toGray(ctx.getImageData(0, 0, 96, 96).data, 96, 96);
  // Noise shrinks with the downscale; only correct when the crop isn't upsampled.
  return subjectSharpness(gray, undefined, side >= 96 ? noise * (96 / side) : noise);
}

async function analyze(req: Extract<VisionRequest, { type: 'photo' }>) {
  const detail = await createImageBitmap(req.detail);
  const whole: Tile = { x: 0, y: 0, w: 1, h: 1 };
  let faces = yunet ? await detectYunet(detail, whole) : detectFaces(detail, whole);
  const bodies = pose ? detectBodies(detail) : [];

  // Small faces: look again on tiles of the big copy when people are likely
  // (anyone found) or the photo is wide enough to hold a distant group.
  const needTiles = faces.length > 0 || bodies.length > 0 || detail.width / detail.height > 1.2;
  if (needTiles || faces.length) {
    const master = await createImageBitmap(req.master);
    try {
      if (needTiles) {
        for (const t of tiles(master.width, master.height)) faces.push(...(yunet ? await detectYunet(master, t) : detectFaces(crop(master, t), t)));
        faces = dedupe(faces);
      }
      // A big face the expression model can't make out is usually hidden (hands, a cup, hair).
      if (yunet) for (const f of faces) if (!readExpression(master, f) && f.box.h >= 0.08) f.covered = true;
      for (const f of faces) f.sharpness = faceSharpnessOf(master, f, req.noise);
      // Identity for faces big and frontal enough to recognise.
      for (const f of faces) {
        if (sface && f.box.h >= EMBED_MIN_FACE && Math.abs(f.yaw) <= EMBED_MAX_YAW) f.embedding = await embed(master, f);
      }
    } finally {
      master.close();
    }
  }

  // A hand inside a face box (shrunk a little, so a hand on the chin doesn't count).
  for (const f of faces) {
    const b = f.box;
    const inside = lastHands.filter(([x, y]) => x > b.x + 0.15 * b.w && x < b.x + 0.85 * b.w && y > b.y + 0.1 * b.h && y < b.y + 0.8 * b.h);
    if (inside.length >= 2) f.covered = true;
  }
  lastHands = [];

  let faceSharpness: number | null = null;
  if (faces.length) {
    const c = new OffscreenCanvas(detail.width, detail.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(detail, 0, 0);
    const gray = toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    faceSharpness = subjectSharpness(gray, faces.map((f) => f.box), req.noise);
  }
  detail.close();
  // Alignment points are only needed here; don't ship them back.
  const clean: Face[] = faces.map(({ pts: _pts, ...f }) => f);
  return summarize(clean, dedupe(bodies, 0.5), faceSharpness);
}

let ready: Promise<void> | null = null;

self.onmessage = async (e: MessageEvent<VisionRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    const loading = init(msg.base);
    ready = loading.then(() => undefined);
    try {
      post({ type: 'ready', warnings: await loading });
    } catch (err) {
      post({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === 'photo') {
    try {
      await ready;
      post({ type: 'people', id: msg.id, people: await analyze(msg) });
    } catch (err) {
      post({ type: 'failed', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
