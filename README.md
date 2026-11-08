# Vacation Reel

Turns vacation photos into a 15–30 s Instagram Reel (MP4, H.264, 30 fps), entirely in the browser.
Photos never leave the device: no backend, no paid APIs.

## Status

**Milestone 4b part 1 (friends) — done.** Scene types (CLIP) pending model access.

- M1: upload → EXIF time sort → 1.5 s per photo → center crop → WebCodecs MP4 → download / share.
- M2: HEIC (libheif wasm, lazy-loaded) · 640px + 256px downscales · content-independent subject sharpness, exposure, noise · dHash bursts (best frame kept, others shown as alternates) · quality gate (photos with a real defect, i.e. blurry / very dark / blown out, are set aside when the same moment has a clean shot) · tap a tile to swap / remove / bring back.
- M3: pick a song from your device → own beat tracker (tempo, beats, bar starts) in a worker → every cut lands on a beat, reel starts on a bar, opener/finale hold 2× · "Best part" (chorus detection: repetition + intensity + section boundaries; step through up to 6 suggestions and preview them) or "From the start" · AAC soundtrack in the MP4 (native encoder, or wasm fallback) with 1 s fade-out · or silent export with the same cuts for Instagram's music library.

- Shape: vertical 1080×1920 (Reels) or horizontal 1920×1080.
- More than 20 photos: an even spread across the trip is kept so the reel stays ≤ 30 s (placeholder until smart selection in M7).
- Photos without EXIF dates fall back to the file's modified date.

## Run

```bash
npm install                 # then: npm run dev / build fetch the models into public/models/ (needs internet once)
# npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (analysis)
npm run build    # typecheck + tests + static site in dist/
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/pages.yml`.

## Layout

```
src/
  import/      decode (native, HEIC fallback), EXIF (exifr + HEIC fallback), sort, worker pool
  analysis/    quality stats, dHash, bursts, gate (+ CLIP, faces from M4)
  audio/       FFT, beat tracker, song decode + excerpt
  selection/   which photos make the reel (M1: even spread under the length cap)
  render/      timeline (fixed + beat-cut planner), crop, encoder wrapper (Mediabunny, video + AAC), render worker client
  workers/     import.worker.ts (decode, downscale, stats, dHash, thumbs), render.worker.ts (crop + encode)
  ui/          formatting helpers
  main.ts      page wiring
```

All decoding and encoding runs in Web Workers (OffscreenCanvas + WebCodecs).

## Browser support

Needs WebCodecs `VideoEncoder` with H.264 and OffscreenCanvas 2D: Chrome / Edge 94+, Safari 16.4+ (iOS and macOS).
Firefox desktop 130+ has WebCodecs; Firefox Android does not. Unsupported browsers see a message. An `ffmpeg.wasm` fallback is planned.

## Dependencies (pinned)

| Package | Version | License | Use |
|---|---|---|---|
| mediabunny | 1.61.6 | MPL-2.0 | MP4 muxing over WebCodecs |
| exifr | 7.1.3 | MIT | EXIF date / GPS |
| libheif-js | 1.23.5 | LGPL-3.0 | HEIC decode (wasm, separate lazy chunk) |
| vite | 8.3.4 | MIT | build (dev) |
| typescript | 5.9.3 | Apache-2.0 | types (dev) |
| @mediabunny/aac-encoder | 1.61.6 | MPL-2.0 (bundles FFmpeg's AAC encoder, LGPL) | AAC when the browser has none; lazy chunk |
| @mediapipe/tasks-vision | 1.1.1 | Apache-2.0 | face + pose landmarks; wasm runtime copied to `public/mediapipe/` |
| onnxruntime-web | 1.30.0 | MIT | runs SFace (single-threaded wasm, copied to `public/ort/`) |
| vitest | 4.1.12 | MIT | unit tests (dev) |

**Note:** the plan named `mp4-muxer`; its npm page now marks it deprecated in favour of Mediabunny, its successor by the same author. The encoder is isolated in `src/render/encoder.ts`, so it can be swapped. MPL-2.0 is file-level copyleft: fine for commercial use as long as changes to Mediabunny's own files are published.

**Note:** the plan named `heic2any`. It hasn't been updated in years, needs the DOM (can't run in a worker), and bundles an old libheif, so it is effectively LGPL anyway. We use `libheif-js` directly: same license class, current libheif, runs in workers. LGPL compliance: ship it unmodified as its own file (it is a separate lazy chunk) and keep this notice + link to its source.

## Roadmap

1. ✅ Upload, EXIF sort, 1.5 s each, center crop, MP4 export, download
2. ✅ Quality gate, dHash grouping, HEIC, downscaling
3. ✅ Music, beat cuts, silent export
4. CLIP + face identity
5. Classic best-photo picking
6. Fun modes
7. Scoring + sequencing
8. Smart crop, Ken Burns, captions
9. Preview/edit screen
10. Capacitor app

**Beat detection:** `essentia.js` (named in the plan as an option) is AGPL-3.0, so it is not used. The tracker in `src/audio/beats.ts` is original code: spectral-flux onsets → autocorrelation tempo → Ellis-style dynamic-programming beat tracking.

**Models:** `scripts/assets.mjs` (runs before dev/build) copies MediaPipe's wasm into `public/mediapipe/` and downloads the official Face Landmarker and Pose Landmarker (lite) models (Apache-2.0) plus OpenCV Zoo's SFace int8 (Apache-2.0) into `public/models/`; ONNX Runtime's wasm goes to `public/ort/`. Both folders are git-ignored and served from this site, so nothing is fetched from third parties at runtime. First visit downloads ~28 MB wasm (compressed in transit) + ~19.5 MB models, then the browser caches them.
