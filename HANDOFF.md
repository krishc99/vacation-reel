# HANDOFF → Milestone 3 · vacation-reel · updated 2026-11-08
Audience: AI agent. Terse by design. Original plan = final; don't reopen decisions unless user asks.

## 0. Project
Vacation photos → 15–30s IG Reel MP4. 100% client-side TS, Web Workers, free static host. App later = Capacitor wrap.
User: Krish (GH krishc99). Wants: working result after each milestone, confirm before next. Ask Qs only if blocking.

## 1. Hard constraints
- No paid APIs, no backend. Free local models OK.
- Photos + face data never leave device.
- MP4 H.264 30fps, 15–30s, ~15–25 photos. Shape: vertical 1080×1920 (default) | horizontal 1920×1080.
- Keep fun shots (funny faces, laughs, jumps, backs-to-camera). Quality gate is SOFT (set aside, user can restore).
- Preview/edit screen proper = M9 (M2 has basic tap toggles).
- Pin deps exact, ≥2 weeks old (`npm i -E`). Verify APIs before use. Verify licenses. NO InsightFace weights. No bundled copyrighted music.

## 2. Repo / delivery
- github.com/krishc99/vacation-reel (public), GH Pages via `.github/workflows/pages.yml` (npm ci → npm run build → deploy dist). Live: krishc99.github.io/vacation-reel.
- Agent sessions CANNOT push (git proxy: repo not in session allowlist; GH MCP write 403; read works). Delivery = zip of changed files → user uploads via GH web "Add file → Upload files" (same paths overwrite). Never include `.git` in zip. Hidden `.github/` must be uploaded deliberately if changed.
- `npm ci` works w/o flags; adding vitest needed `--legacy-peer-deps` once (npm arborist bug), lockfile fine.

## 3. Stack
| pkg | ver | license | note |
|---|---|---|---|
| mediabunny | 1.61.6 | MPL-2.0 | replaces deprecated `mp4-muxer` (user informed) |
| exifr | 7.1.3 | MIT | + own HEIC fallback (see §6) |
| libheif-js | 1.23.5 | LGPL-3.0 | replaces plan's `heic2any` (unmaintained, DOM-only, bundles old libheif = LGPL anyway). Lazy chunk, unmodified. README has notice. |
| vite 8.3.4 · typescript 5.9.3 · vitest 4.1.12 | | MIT/Apache | dev |
Scripts: `dev`, `test` (vitest run), `build` (= tsc + vitest + vite build), `preview`.

## 4. Code map
```
index.html                  Add photos / Order (shape toggle, summary, burst grid) / Make reel
src/types.ts                Photo{…, detail:Blob(640 JPEG), stats:QualityStats, dhash}, ReelSettings, Shape, Clip, worker protocols
src/main.ts                 state: photos, analysis, overrides. currentPlan() = candidateIds → selectPhotos → buildTimeline. Tile tap: alt→keeper, keeper→exclude, rejected→include, excluded→restore
src/import/decode.ts        decodeImage(file): createImageBitmap → HEIF brand sniff → libheif (primary image, orientation applied). Used by BOTH workers
src/import/exif.ts          readExif(file,isHeif): exifr; if HEIF & no date → regex "Exif\0\0(MM|II)" → exifr on TIFF slice
src/import/importer.ts      worker pool (1 on phones, ≤2 desktop), PULL model: worker posts 'ready', then 1 file/msg. Crash mid-photo → respawn, retry once, then skip w/ error text. Worker can't start (error before 'ready') → main-thread fallback (status line says so)
src/import/process.ts       processPhoto(id,file): shared pipeline for worker + main-thread fallback
src/workers/import.worker.ts  thin wrapper around processPhoto: decode → 640 canvas (gray: sharpness, noise; JPEG blob kept) → close full → 256 canvas (gray: exposure, dHash; thumb). NO willReadFrequently (forces CPU canvas w/ full-res readback)
src/analysis/pixels.ts      toGray, resizeBox, median
src/analysis/quality.ts     subjectSharpness(gray, regions?) = mean of top-3 of 8×8 tile Laplacian variances (bokeh-safe); regions = M4 face boxes (normalized). noiseSigma = MAD of 3×3 residual on flattest 25% tiles. exposure = mean, clip<10, clip>245
src/analysis/dhash.ts       9×8 dHash as [hi,lo] u32; hamming
src/analysis/bursts.ts      groupBursts: chain (lookback 3); link if (Δt≤3s & d≤20) | (Δt≤30s & d≤12); no-EXIF → d≤8. groupMoments(gap)
src/analysis/gate.ts        percentileRanks; Q = .6·pct(sharp)+.25·pct(exposureScore)+.15·(1−pct(noise)); keeper = max Q per burst; gate on keepers: pct(Q)<0.2 → rejected unless no passing keeper in its moment (5-min chain) → onlyOfMoment. Reasons: blurry/dark/bright/grainy(needs σ>3)/weaker. Gate off if <6 photos
src/analysis/index.ts       Overrides{keeper,include,exclude}, tileState, candidateIds
src/analysis/analysis.test.ts  12 unit tests (dhash, sharpness incl bokeh+regions, noise, percentiles, bursts, gate)
src/selection/index.ts      M1 placeholder: even spread to fit maxSeconds (20 photos @1.5s)
src/render/{timeline,crop,encoder,renderer}.ts, workers/render.worker.ts  unchanged from M1 except decodeImage
```
Q here = plan's Q term (subject sharpness, exposure, noise), already percentile-normalized per album → reuse in M7 score.

## 5. Verified (headless Chromium, synthetic album)
- 18 photos → 14 moments: 4-frame burst → 1 keeper + 3 alts (blurred frame never keeper); 20s re-shot dupe grouped; blurry shot w/ good neighbor in same moment → "blurry", set aside; lone blurry → kept (onlyOfMoment, tooltip); dark+good pair → dark set aside; HEIC decoded + EXIF date correct.
- Export after taps: 540 frames, 18.000s, 1080×1920 h264.
- 108 photos import 16s (2 workers, headless SW), main JS heap 2.3MB after.
- 390px: no h-scroll. Unit tests 12/12.
NOT verified: real iPhone HEIC (exifr fallback tested only on pillow-heif files), real-photo threshold tuning, Safari/iOS perf, 48MP decodes.

## 6. Known limits / tuning notes
- OPEN BUG (M2 on real Android Chrome): "Import worker failed" (empty error = worker load failure or crash) even for 1 photo; laptop Chrome + Pixel emulation fine. Hardened build adds: exact error text, crash retry, main-thread fallback, footer build stamp (`__BUILD__` = UTC time · GITHUB_SHA). Root cause not yet confirmed — check what the status line / skipped list says on device. Suspects: willReadFrequently CPU canvas on huge (50–200MP) Android photos; stale cached index.html after deploy (GH Pages max-age 600) pointing to removed worker hash.
- Sharpness at 640px misses mild blur of 12MP originals (needs ~blur r≥15 at full res to register). If real albums show misses: measure top tile at full-res crop.
- Burst thresholds untuned on real photos (BURST_DEFAULTS, GATE_DEFAULTS are exported constants).
- Keeper overrides cleared when photos are added (burst ids positional).
- libheif chunk duplicated per worker bundle (2×2MB), downloaded only if a HEIC appears.
- Synthetic test images have zero-noise flats → noise ranks odd; real photos fine.

## 7. Milestone 3 scope — "Music, beat cuts, silent export"
- User picks a local audio file (mp3/m4a/wav). Decode via Web Audio `decodeAudioData` (main thread OK) → mono Float32 → worker.
- Beats: `essentia.js` (verify version + license: AGPL? → if AGPL, DON'T; use custom onset detector) or custom: spectral-flux onset envelope → tempo via autocorrelation (60–180 BPM) → beat grid (DP beat tracking à la Ellis) → downbeats (every 4th, phase by onset strength).
- Cuts: 0.5–1.5s per photo, snap to beats/downbeats; opener + finale longer; total 15–30s; pick audio window w/ strongest energy (or from start). Timeline replaces `buildTimeline` fixed 1.5s → `buildBeatTimeline(photos, beats, settings)`.
- Export: (a) with music: add AAC audio track via mediabunny (AudioBufferSource / AudioSampleSource, codec 'aac'; check `canEncodeAudio('aac')` — Firefox may lack AAC encode → fallback opus? MP4+opus IG compat uncertain → if no AAC, offer silent only). (b) Silent at same timing (default path; user adds IG library music). No bundled copyrighted music.
- Transitions: hard cuts on strong beats; crossfades optional (Ken Burns = M8).
- UI: audio picker, waveform/beat markers optional, toggle "Include music in file".
- Done when: cuts land on beats (verify: cut frame times vs beat times ±1 frame), audio in sync, ffprobe shows h264+aac, silent export same cut times.

## 8. Test recipe
- Synthetic photos: PIL random ellipses/lines scenes (`scene(seed,label)`), EXIF via `Image.Exif()[0x8769]={0x9003:'YYYY:MM:DD HH:MM:SS'}`; HEIC via `pillow_heif` (pip, `--break-system-packages`); blur = GaussianBlur(25–30).
- Synthetic music: ffmpeg `sine`/`aevalsrc` click track at known BPM → assert detected tempo.
- `npx vite preview --port 4173 &` → Playwright (preinstalled `require('playwright')`). Files: `setInputFiles('#file-input', paths)`; wait `#order-section:not([hidden])`; tiles are `button.tile[aria-label^="<name>"]`; `#make`; wait `#result:not([hidden])`; `download` event from `#download`. Radio: `page.check('#shape-horizontal')`.
- ffprobe streams/frames/duration. Sandbox blocks fonts.googleapis.com (fallback fonts in screenshots; fine).

## 9. Later (unchanged)
4 CLIP (transformers.js, lazy) + face identity (permissive / face-api.js; tune in Python) → feed face boxes into subjectSharpness regions · 5 classic best-photo · 6 fun modes · 7 score `0.20Q+0.25F+0.20C+0.35M`, MMR, friend coverage, beam-search order · 8 smart crop, Ken Burns, captions (offline reverse geocode) · 9 preview/edit · 10 Capacitor.
Rejected: Python/FastAPI backend, InsightFace weights, BRISQUE, DBSCAN on CLIP alone, server FFmpeg.
