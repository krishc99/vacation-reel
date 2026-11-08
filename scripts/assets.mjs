// Prepares static assets for face/pose detection (Milestone 4a). Runs before dev/build.
// - Copies MediaPipe's wasm runtime from node_modules into public/mediapipe/.
// - Downloads the official MediaPipe models into public/models/ (skipped if present).
// Both folders are git-ignored; everything is served from our own site, so photos
// and the app never talk to a third party at runtime.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const WASM = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];
const MODELS = {
  // Apache-2.0, https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // Apache-2.0, https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

await mkdir(join(pub, 'mediapipe'), { recursive: true });
await mkdir(join(pub, 'models'), { recursive: true });

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
