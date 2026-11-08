# HANDOFF → Milestone 4 · vacation-reel · updated 2026-11-08
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
Scripts: `dev`, `test` (vitest run), `build` (= tsc + vitest + vite build), `preview`. +dep @mediabunny/aac-encoder 1.61.6 (MPL-2.0, wasm FFmpeg AAC = LGPL; lazy).

## 4. Code map
```
index.html                  Add photos / Order (shape toggle, summary, burst grid) / Make reel
src/types.ts                Photo{…, detail:Blob(640 JPEG), stats:QualityStats, dhash}, ReelSettings, Shape, Clip, worker protocols
src/main.ts                 state: photos, analysis, overrides. currentPlan() = candidateIds → selectPhotos → buildTimeline. Tile tap: alt→keeper, keeper→exclude, rejected→include, excluded→restore
src/import/decode.ts        decodeImage(file): createImageBitmap → HEIF brand sniff → libheif (primary image, orientation applied). Used by BOTH workers
src/import/exif.ts          readExif(file,isHeif): exifr; if HEIF & no date → regex "Exif\0\0(MM|II)" → exifr on TIFF slice
src/import/importer.ts      worker pool (1 on phones, ≤2 desktop), PULL model: worker posts 'ready', then 1 file/msg. Crash mid-photo → respawn, retry once, then skip w/ error text. Worker can't start (error before 'ready') → main-thread fallback (status line says so)
src/import/process.ts       processPhoto(id,file): shared pipeline for worker + main-thread fallback. Produces MASTER (≤2560px JPEG q0.9) → detail 640 → small 256. Render uses Photo.master ONLY: Android revokes picked-file access later (NotReadableError at export, user-reported). Never re-read Photo.file after import. Cost: import ~1.7× slower (108 photos 16→28 s headless), ~1 MB blob/photo
src/workers/import.worker.ts  thin wrapper around processPhoto: decode → 640 canvas (gray: sharpness, noise; JPEG blob kept) → close full → 256 canvas (gray: exposure, dHash; thumb). NO willReadFrequently (forces CPU canvas w/ full-res readback)
src/analysis/pixels.ts      toGray, resizeBox, median
src/analysis/quality.ts     subjectSharpness(gray, regions?, σ) = CONTENT-INDEPENDENT ratio: per 8×8 tile var(Lap fine) / var(Lap after 2× box), noise-corrected (−20σ² / −5σ²; no correction if σ>5 = texture), p75 over top-25% structured tiles (or tiles in regions = M4 face boxes). Sharp photos of faces/food/landscapes 0.4–1.4, blurred ≤0.2 (validated on scikit-image samples: astronaut, camera, coffee, chelsea, rocket, grass, gravel, motorcycle, horse; σ1.0–1.5 blur ± noise). noiseSigma = MAD of 3×3 residual on flattest 25% tiles /√(8/9). exposure = mean, clip<10, clip>245
src/analysis/dhash.ts       9×8 dHash as [hi,lo] u32; hamming
src/analysis/bursts.ts      groupBursts: chain (lookback 3); link if (Δt≤3s & d≤20) | (Δt≤30s & d≤12); no-EXIF → d≤8. groupMoments(gap)
src/analysis/gate.ts        Q (absolute 0..1) = .6·sharpScore(sat. (r−.2)/.25) + .25·exposureScore + .15·noiseScore(σ capped at 5). Keeper = max Q per burst, tie → raw sharpness. Gate: keeper with a real DEFECT (blurry r<.25 | dark mean<.12 or clip>.6 | bright mean>.88 or clip>.45) is set aside if its moment (5-min chain) has a clean keeper; else kept w/ onlyOfMoment. Percentile gate REMOVED (user reported people photos dropped for food/landscapes: old metric = detail amount). 'grainy' not a defect (texture fools noise estimate). percentileRanks kept for M7
src/analysis/index.ts       Overrides{keeper,include,exclude}, tileState, candidateIds
src/analysis/analysis.test.ts  15 unit tests (dhash, sharpness incl bokeh+regions, noise, percentiles, bursts, gate)
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
- Sharpness at 640px misses mild blur of 12MP originals (only blur ≳1px at 640 scale registers). If real albums show misses: measure top tile at full-res crop.
- User feedback after M2: blur filtering OK; selection 'still not great' (expected until M4–M7).
- Burst thresholds untuned on real photos (BURST_DEFAULTS, GATE_DEFAULTS are exported constants).
- Keeper overrides cleared when photos are added (burst ids positional).
- libheif chunk duplicated per worker bundle (2×2MB), downloaded only if a HEIC appears.
- Synthetic test images have zero-noise flats → noise ranks odd; real photos fine.

## 7. Milestone 3 — DONE (music, beat cuts, silent export)
```
src/audio/fft.ts            radix-2 FFT
src/audio/beats.ts          analyzeBeats(mono 24k): log-mag STFT (1024/256) spectral flux → detrend/normalize → tempo = autocorr × log-gauss prior @120 BPM (0.9 oct) → Ellis DP (tightness 100) → trim quiet ends → downbeat phase = max kick-band (<150 Hz) flux of 4 phases. ONSET_LAG 11 ms calibrated. bpm = whole-track mean interval. beatEnergy per beat (RMS)
src/audio/song.ts           loadSong: OfflineAudioContext(48k) decode → stereo kept; mono 24k → audio.worker. excerpt(): +AAC_PRIMING (1024/48k) shift (Mediabunny writes no elst; measured fix), 20 ms fade-in, 1 s fade-out
src/audio/structure.ts      'best part' (user: loudest-window picks were bad; masters are flat-loud). Per beat: chroma (STFT 4096/1024, 80–5000 Hz), 7 log bands → intensity z-blend (level .35, brightness .25, low .15, onset density .25), Foote novelty (kernel 8 beats) on [chroma, timbre]. rankSongParts: candidates = downbeats; score = z(window intensity) + z(chorus repetition: max mean chroma cos vs any other position ≥ max(8,W/2) away, W ≤32 beats) + .6·z(boundary novelty) − intro(<8%)/outro(>97%) penalty; top 6, ≥16 beats apart. Verified on synthetic pop song (verse/chorus×3/LOUDER non-repeating bridge, sections equal-RMS): top 3 = the 3 chorus starts exact; loudest-window method picks bridge
src/render/musicTimeline.ts songParts(a,n,s) list; planMusicTimeline(…, mode, partIndex). k beats/photo from multiples with cut 0.5–1.5 s; pick to fit ≤30 s, prefer ≥15 s, then closest to 0.9 s. Opener/finale = 2k. Start = downbeat; 'best' = max mean beatEnergy window, 'start' = first downbeat. maxPhotosForMusic caps selection (≤25). Beats extrapolated if song too short
src/render/encoder.ts       optional AAC track (AudioSampleSource, 192 kbps, one f32-planar AudioSample, add() not awaited until finish → no interleave deadlock). Native AAC else lazy @mediabunny/aac-encoder
src/selection/index.ts      selectPhotos(photos, maxCount) — cap now from timeline (fixed: 20; music: per tempo)
UI: Music step (choose song, Best part / From the start, suggestion stepper ‹ › 'Suggestion i of N · starts m:ss', Play/Stop preview of the exact excerpt via AudioContext, "Put the song in the video file", remove). Silent export note tells user where to start the song in IG.
```
Verified: tempo ±0.5% & >90% beats within 35 ms on synthetic drums 87/100/124/140 BPM; planner: all cuts on detected beats, start on downbeat, 15–30 s for 70–174 BPM. E2E (headless Chromium = wasm AAC path; Pixel emu): MP4 h264 + aac 48k, A/V: audio onset − cut median ~10 ms, max 17 ms (frame quantization) for MP3 & WAV; "best part" lands in loud section. Not verified: native AAC on real phones (priming may be 2112 samples on Apple → ~23 ms late, acceptable), real songs w/ tempo changes/swing, half/double-tempo errors.

Also in this session (post-M2 user feedback "fewer people, more food/landscapes"): gate now only sets aside CLEARLY unusable photos (sharp <0.15, mean <0.07 or clip >0.75, bright >0.93 or clip >0.6) and only if a clean keeper of the SAME SCENE (dHash ≤22) exists in the moment. Bursts tightened: fast 2 s/≤14, window 15 s/≤10. Real fix for people = M4 faces (people-aware gate/selection).

## 7b. Milestone 4 scope — CLIP + face identity
- Plan: CLIP labels+embeddings (transformers.js, small quantized, lazy, cache), face/blendshapes/pose (MediaPipe Face/Pose Landmarker), identity embeddings (permissive model or face-api.js; NOT InsightFace) → cluster into people (recurring = friends, one-off small = strangers). Tune in Python, port.
- PRIORITY from user: reel must favour people. Use face count/size immediately: gate never replaces a face photo with a no-face photo; subjectSharpness(regions=face boxes); selection cap prefers photos with friends until M7 scoring.
- Check MediaPipe tasks-vision in MODULE workers (uses importScripts? may need classic worker or main thread). Model files: self-host in /public (license Apache-2.0) to avoid third-party fetch; verify size.

## 8. Test recipe
- Synthetic photos: PIL random ellipses/lines scenes (`scene(seed,label)`), EXIF via `Image.Exif()[0x8769]={0x9003:'YYYY:MM:DD HH:MM:SS'}`; HEIC via `pillow_heif` (pip, `--break-system-packages`); blur = GaussianBlur(25–30).
- Synthetic music: numpy drum loop (kick 1&3, snare 2&4, hats 8ths; quiet intro, loud 40–70 s) → WAV + MP3 (ffmpeg libmp3lame). Sync check: ffmpeg scene-detect cut pts vs transient onsets in exported audio. Audio input: `setInputFiles('#audio-input', path)`; wait `#music-status` contains 'BPM'; `#song-start`, `#music-in-file`.
- `npx vite preview --port 4173 &` → Playwright (preinstalled `require('playwright')`). Files: `setInputFiles('#file-input', paths)`; wait `#order-section:not([hidden])`; tiles are `button.tile[aria-label^="<name>"]`; `#make`; wait `#result:not([hidden])`; `download` event from `#download`. Radio: `page.check('#shape-horizontal')`.
- ffprobe streams/frames/duration. Sandbox blocks fonts.googleapis.com (fallback fonts in screenshots; fine).

## 9. Later (unchanged)
4 CLIP (transformers.js, lazy) + face identity (permissive / face-api.js; tune in Python) → feed face boxes into subjectSharpness regions · 5 classic best-photo · 6 fun modes · 7 score `0.20Q+0.25F+0.20C+0.35M`, MMR, friend coverage, beam-search order · 8 smart crop, Ken Burns, captions (offline reverse geocode) · 9 preview/edit · 10 Capacitor.
Rejected: Python/FastAPI backend, InsightFace weights, BRISQUE, DBSCAN on CLIP alone, server FFmpeg.
