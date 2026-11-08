/// <reference lib="webworker" />
// Faces + bodies for each photo (Milestone 4a). MediaPipe runs on CPU (wasm) so
// it behaves the same on every device. Models are served from our own site.
import { FaceLandmarker, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { dedupe, headAngles, summarize, type Body, type Box, type Face } from '../analysis/people';
import { toGray } from '../analysis/pixels';
import { subjectSharpness } from '../analysis/quality';
import type { VisionRequest, VisionResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

let face: FaceLandmarker | null = null;
let pose: PoseLandmarker | null = null;

function post(msg: VisionResponse) {
  self.postMessage(msg);
}

async function init(base: string) {
  // Explicit module-build paths (FilesetResolver may pick a non-existent "nosimd"
  // variant), and load the loader ourselves: it registers globalThis.ModuleFactory.
  const files = {
    wasmLoaderPath: new URL('mediapipe/vision_wasm_module_internal.js', base).href,
    wasmBinaryPath: new URL('mediapipe/vision_wasm_module_internal.wasm', base).href,
  };
  // MediaPipe deletes globalThis.ModuleFactory after creating a task, and an ES
  // module only evaluates once, so put the factory back before each task.
  const loader = (await import(/* @vite-ignore */ files.wasmLoaderPath)) as { default: unknown };
  const g = self as unknown as { ModuleFactory?: unknown };
  g.ModuleFactory = loader.default;
  face = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', base).href, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 12,
    minFaceDetectionConfidence: 0.6,
    minFacePresenceConfidence: 0.6,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  g.ModuleFactory = loader.default;
  pose = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL('models/pose_landmarker_lite.task', base).href, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 6,
    minPoseDetectionConfidence: 0.6,
    minPosePresenceConfidence: 0.6,
  });
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

function detectFaces(img: ImageBitmap | OffscreenCanvas, tile: Tile): Face[] {
  const r = face!.detect(img);
  return r.faceLandmarks.flatMap((lms, i) => {
    const b = boxOf(lms);
    if (!b) return [];
    const bs = r.faceBlendshapes?.[i]?.categories ?? [];
    const score = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
    const m = r.facialTransformationMatrixes?.[i]?.data;
    const { yaw, pitch } = m ? headAngles(m) : { yaw: 0, pitch: 0 };
    return [
      {
        box: mapBox(b, tile),
        blinkL: score('eyeBlinkLeft'),
        blinkR: score('eyeBlinkRight'),
        smile: (score('mouthSmileLeft') + score('mouthSmileRight')) / 2,
        jawOpen: score('jawOpen'),
        yaw,
        pitch,
      },
    ];
  });
}

function detectBodies(img: ImageBitmap): Body[] {
  const r = pose!.detect(img);
  return r.landmarks.flatMap((lms) => {
    const b = boxOf(lms, 0.5);
    if (!b) return [];
    const vis = (i: number) => (lms[i]?.visibility ?? 0) > 0.65;
    // Count a body only with a believable torso: both shoulders, plus both hips or a
    // visible head (nose, eyes or ears). Objects (bikes, chairs) can trigger the detector without these.
    const head = vis(0) || vis(2) || vis(5) || vis(7) || vis(8); // nose, eyes or ears
    if (!(vis(11) && vis(12) && ((vis(23) && vis(24)) || head))) return [];
    // Upright: shoulders above hips.
    if (vis(23) && vis(24) && (lms[11].y + lms[12].y) / 2 >= (lms[23].y + lms[24].y) / 2) return [];
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

async function analyze(req: Extract<VisionRequest, { type: 'photo' }>) {
  const detail = await createImageBitmap(req.detail);
  const whole: Tile = { x: 0, y: 0, w: 1, h: 1 };
  let faces = detectFaces(detail, whole);
  const bodies = detectBodies(detail);

  // Small faces: look again on tiles of the big copy when people are likely
  // (anyone found) or the photo is wide enough to hold a distant group.
  if (faces.length > 0 || bodies.length > 0 || detail.width / detail.height > 1.2) {
    const master = await createImageBitmap(req.master);
    try {
      for (const t of tiles(master.width, master.height)) faces.push(...detectFaces(crop(master, t), t));
    } finally {
      master.close();
    }
    faces = dedupe(faces);
  }

  let faceSharpness: number | null = null;
  if (faces.length) {
    const c = new OffscreenCanvas(detail.width, detail.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(detail, 0, 0);
    const gray = toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    faceSharpness = subjectSharpness(gray, faces.map((f) => f.box), req.noise);
  }
  detail.close();
  return summarize(faces, dedupe(bodies, 0.5), faceSharpness);
}

let ready: Promise<void> | null = null;

self.onmessage = async (e: MessageEvent<VisionRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = init(msg.base);
    try {
      await ready;
      post({ type: 'ready' });
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
