/// <reference lib="webworker" />
// Scene types (Milestone 4b): CLIP ViT-B/32 image encoder on ONNX Runtime (wasm).
import * as ort from 'onnxruntime-web/wasm';
import { l2normalize } from '../analysis/align';
import { classify } from '../analysis/scenes';
import { fetchBytes } from './fetchAsset';
import type { SceneRequest, SceneResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

export const CLIP_MODEL = 'models/clip-vit-b32-vision-int8.onnx';
const SIZE = 224;
// openai/clip-vit-base-patch32 preprocessor_config.json
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

let session: ort.InferenceSession | null = null;

function post(msg: SceneResponse) {
  self.postMessage(msg);
}

/** Shortest side → 224, centre crop 224×224, scale to 0..1, normalise, NCHW. */
function preprocess(bmp: ImageBitmap): Float32Array {
  const s = SIZE / Math.min(bmp.width, bmp.height);
  const w = Math.round(bmp.width * s);
  const h = Math.round(bmp.height * s);
  const c = new OffscreenCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    for (let ch = 0; ch < 3; ch++) out[ch * plane + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  }
  return out;
}

self.onmessage = async (e: MessageEvent<SceneRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    const model = new URL(CLIP_MODEL, msg.base).href;
    try {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmBinary = await fetchBytes(new URL('ort/ort-wasm-simd-threaded.wasm', msg.base).href);
      session = await ort.InferenceSession.create(await fetchBytes(model), { executionProviders: ['wasm'], logSeverityLevel: 3 });
      post({ type: 'ready' });
    } catch (err) {
      let why = 'blocked or offline (no response)';
      try {
        const r = await fetch(model, { method: 'HEAD', cache: 'no-store' });
        why = r.ok ? `HTTP ${r.status}; ${err instanceof Error ? err.message : String(err)}` : `HTTP ${r.status}`;
      } catch {
        /* keep */
      }
      post({ type: 'fatal', message: `${CLIP_MODEL}: ${why}` });
    }
    return;
  }
  if (msg.type === 'photo') {
    try {
      const bmp = await createImageBitmap(msg.detail);
      const input = preprocess(bmp);
      bmp.close();
      const out = await session!.run({ [session!.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
      const name = session!.outputNames.includes('image_embeds') ? 'image_embeds' : session!.outputNames[0];
      post({ type: 'scene', id: msg.id, scene: classify(l2normalize(out[name].data as Float32Array)) });
    } catch (err) {
      post({ type: 'failed', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
