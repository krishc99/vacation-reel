# Vacation Reel

Turns vacation photos into a 15–30 s Instagram Reel (MP4, H.264, 30 fps), entirely in the browser.
Photos never leave the device: no backend, no paid APIs.

## Status

**Milestone 1 of 10 — done.** Upload → EXIF time sort → 1.5 s per photo → center crop → WebCodecs MP4 → download / share.

- Shape: vertical 1080×1920 (Reels) or horizontal 1920×1080.
- More than 20 photos: an even spread across the trip is kept so the reel stays ≤ 30 s (placeholder until smart selection in M7).
- Photos without EXIF dates fall back to the file's modified date.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/pages.yml`.

## Layout

```
src/
  import/      EXIF read (exifr), chronological sort, import worker client
  analysis/    quality gate, bursts, CLIP, faces (empty until M2)
  selection/   which photos make the reel (M1: even spread under the length cap)
  render/      timeline, crop, encoder wrapper (Mediabunny), render worker client
  workers/     import.worker.ts (decode + EXIF + thumbnails), render.worker.ts (crop + encode)
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
| vite | 8.3.4 | MIT | build (dev) |
| typescript | 5.9.3 | Apache-2.0 | types (dev) |

**Note:** the plan named `mp4-muxer`; its npm page now marks it deprecated in favour of Mediabunny, its successor by the same author. The encoder is isolated in `src/render/encoder.ts`, so it can be swapped. MPL-2.0 is file-level copyleft: fine for commercial use as long as changes to Mediabunny's own files are published.

## Roadmap

1. ✅ Upload, EXIF sort, 1.5 s each, center crop, MP4 export, download
2. Quality gate, dHash grouping, HEIC, downscaling
3. Music, beat cuts, silent export
4. CLIP + face identity
5. Classic best-photo picking
6. Fun modes
7. Scoring + sequencing
8. Smart crop, Ken Burns, captions
9. Preview/edit screen
10. Capacitor app
