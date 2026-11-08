// Prepares static assets for face/pose detection (Milestone 4a). Runs before dev/build.
// - Copies MediaPipe's wasm runtime into public/mediapipe/ and ONNX Runtime's into public/ort/.
// - Downloads the official MediaPipe models into public/models/ (skipped if present).
// Both folders are git-ignored; everything is served from our own site, so photos
// and the app never talk to a third party at runtime.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const WASM = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];
// ONNX Runtime (MIT) runs the face-identity model. Single-threaded SIMD build:
// GitHub Pages can't send the headers threads need.
const ORT = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const MODELS = {
  // Apache-2.0, https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // Apache-2.0, https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  // Apache-2.0, OpenCV Zoo SFace (MobileFaceNet, LFW 99.40%). Full precision: in
  // the browser's wasm engine it runs ~5× faster than the int8 file (45 vs 240 ms/face).
  // https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface
  'face_recognition_sface_2021dec.onnx':
    'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
  // MIT (OpenAI CLIP ViT-B/32, ONNX export by Xenova), 8-bit (89 MB): ~2.5× faster in
  // the browser than the 4-bit file (180 vs 450 ms/photo), same labels on samples.
  // Image encoder only; label embeddings are precomputed in src/analysis/sceneLabels.json.
  'clip-vit-b32-vision-int8.onnx':
    'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
};

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

await mkdir(join(pub, 'mediapipe'), { recursive: true });
await mkdir(join(pub, 'models'), { recursive: true });
await mkdir(join(pub, 'ort'), { recursive: true });

for (const f of ORT) {
  await copyFile(join(root, 'node_modules/onnxruntime-web/dist', f), join(pub, 'ort', f));
}

for (const f of WASM) {
  await copyFile(join(root, 'node_modules/@mediapipe/tasks-vision/wasm', f), join(pub, 'mediapipe', f));
}

for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(pub, 'models', name);
  if (await exists(dest)) continue;
  console.log(`Downloading ${name}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${name}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
console.log('Vision assets ready.');
