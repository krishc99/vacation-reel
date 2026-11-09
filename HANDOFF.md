# HANDOFF → Milestone 6 (fun modes); M7 + M8 done first (user's call) · vacation-reel · updated 2026-11-09
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
src/render/musicTimeline.ts LEAD-IN (user: chorus start too abrupt): reel starts leadInBeats = whole bars ≈3 s (≥1 bar) before the chorus; opener photo spans the lead-in so the chorus downbeat = cut to photo 2 (verified exact in export). MusicPlan.highlight = chorus time. songParts(a,n,s) list; planMusicTimeline(…, mode, partIndex). k beats/photo from multiples with cut 0.5–1.5 s; pick to fit ≤30 s, prefer ≥15 s, then closest to 0.9 s. Opener/finale = 2k. Start = downbeat; 'best' = max mean beatEnergy window, 'start' = first downbeat. maxPhotosForMusic caps selection (≤25). Beats extrapolated if song too short
src/render/crop.ts          frameFor(): cover crop if it loses ≤30% of width/height, else FIT (user: group shots lost side people): whole photo (6% edge trim) centred over blurred (24× down/up-scale, portable) + 28% darkened cover copy. Tiles preview the same (CSS blur bg). M8 smart crop can switch to face-anchored cover when all faces fit
src/render/encoder.ts       optional AAC track (AudioSampleSource, 192 kbps, one f32-planar AudioSample, add() not awaited until finish → no interleave deadlock). Native AAC else lazy @mediabunny/aac-encoder
src/selection/index.ts      selectPhotos(photos, maxCount) — cap now from timeline (fixed: 20; music: per tempo)
UI: Music step (choose song, Best part / From the start, suggestion stepper ‹ › 'Suggestion i of N · starts m:ss', Play/Stop preview of the exact excerpt via AudioContext, "Put the song in the video file", remove). Silent export note tells user where to start the song in IG.
```
Verified: tempo ±0.5% & >90% beats within 35 ms on synthetic drums 87/100/124/140 BPM; planner: all cuts on detected beats, start on downbeat, 15–30 s for 70–174 BPM. E2E (headless Chromium = wasm AAC path; Pixel emu): MP4 h264 + aac 48k, A/V: audio onset − cut median ~10 ms, max 17 ms (frame quantization) for MP3 & WAV; "best part" lands in loud section. Not verified: native AAC on real phones (priming may be 2112 samples on Apple → ~23 ms late, acceptable), real songs w/ tempo changes/swing, half/double-tempo errors.

Also in this session (post-M2 user feedback "fewer people, more food/landscapes"): gate now only sets aside CLEARLY unusable photos (sharp <0.15, mean <0.07 or clip >0.75, bright >0.93 or clip >0.6) and only if a clean keeper of the SAME SCENE (dHash ≤22) exists in the moment. Bursts tightened: fast 2 s/≤14, window 15 s/≤10. Real fix for people = M4 faces (people-aware gate/selection).

## 7b. Milestone 4a — DONE (people first)
```
scripts/assets.mjs          predev/prebuild: copy tasks-vision wasm (module build) → public/mediapipe; download face_landmarker.task + pose_landmarker_lite.task (official GCS URLs) → public/models (skip if present). Both git-ignored. CI (Actions) has internet; sandbox doesn't → seed public/models from npm 'ptmaker-vision-models' (third-party mirror, TEST ONLY)
src/workers/vision.worker.ts  MediaPipe in a MODULE worker: build fileset by hand (module_internal js/wasm), import the loader and set self.ModuleFactory before EACH createFromOptions (MediaPipe deletes it; ESM evaluates once). CPU delegate. FaceLandmarker numFaces 12, conf 0.6 (0.45 → false face on a bike wheel; 0.7 → misses 2/6 in group), blendshapes + matrices. PoseLandmarker lite numPoses 6, conf 0.6; body counted only with both shoulders + (both hips or head: nose/eyes/ears) + upright + human proportions when hips visible (hips 0.3–1.3× and torso ≤2.5× shoulder width; samples 0.4–0.7 / 0.7–1.8; a motorbike gave torso 5.4). Pass 1 on 640 detail; pass 2 on 3×2 (2×3) overlapping tiles of master when anyone found or aspect>1.2; dedupe by IoU/centre. faceSharpness = subjectSharpness on face tiles (overlap test)
src/analysis/people.ts      types Face/Body/People, summarize (count = faces + faceless bodies, eyesOpen blink<0.4, largestFace), subjectBoxes (face + headroom, faceless body upper 60%), headAngles (sign convention unverified)
src/analysis/vision.ts      findPeople(): one worker, sequential, streams results; main re-analyses (debounced 400 ms). Status line #people-status
gate.ts                     defects use faceSharpness when faces; replacement must be same scene AND have people if the failing photo has; burst keeper = most eyes-open faces, then Q
selection/index.ts          selectPhotos(photos, max, score): PEOPLE FIRST GLOBALLY (user: food chosen over distinct unused people photos): people photos fill slots via spread() (max equal runs, best slotScore each); others only fill the leftover slots, also spread; chronological output. slotScore: people → 2 + count/size/open-eyes bonuses; else quality
render/crop.ts              frameFor(…, subjects): if union of subjects fits the cover window (≤96%) → cover placed on them (centre at 42% height); else fit with edge trim reduced so nobody is cut; no subjects → old rule. Tiles mirror it via object-position
```
Verified: sample album (8): group photo = 6 people exactly, portraits = 1, food/cat/rocket/bike/grass = 0, 2.3 s. Face sharpness sharp 0.48–1.1 vs blurred 0.10–0.13. 50-photo album (10 people photos interleaved) with 20 slots → all 10 people photos picked, 1 non-people per remaining run; no false positives after tuning; frames: group fitted whole, sub-group/portrait cropped around faces. 43 unit tests. Not verified: real phone albums (night, sunglasses, crowds), speed on phones (~0.13 s/photo headless desktop), big crowds (numFaces 12 cap), person_camera (face hidden behind camera) → 0 people.

## 7c. Milestone 4b part 1 — DONE (friends)
```
model                       OpenCV Zoo SFace int8 (face_recognition_sface_2021dec_int8.onnx, 9.9 MB, Apache-2.0, LFW 99.32% vs fp32 99.40%); downloaded by scripts/assets.mjs from media.githubusercontent.com (reachable from sandbox AND CI). Runtime: onnxruntime-web 1.30.0 'onnxruntime-web/wasm', numThreads 1 (no COOP/COEP on Pages), wasmPaths {wasm: base/ort/ort-wasm-simd-threaded.wasm}, logSeverityLevel 3 (graph-initializer warnings spam)
src/analysis/align.ts       ArcFace 112 template, Umeyama similarity → canvas setTransform; cosine; l2normalize
vision.worker.ts            5 pts from MediaPipe mesh: eyes avg(33,133)/avg(362,263) (image left/right), nose 1, mouth 61/291; embed faces with box.h ≥ 0.035 and |yaw| ≤ 50 from MASTER copy; input RGB 0–255 NCHW (OpenCV FaceRecognizerSF: blobFromImage swapRB, no mean)
src/analysis/friends.ts     clusterPeople: average-linkage agglomerative, stop at cosine 0.363 (SFace published threshold), cannot-link faces in same photo; Person {photoIds, moments (distinct bursts), largest, friend = moments ≥ 2 || largest ≥ 0.07}
selection/index.ts          Who {friends(p), known}. isPeoplePhoto: before recognition any person; after: friends > 0 OR unidentified subject (face w/o embedding ≥ 0.07, or body ≥ 0.45 tall). coverFriends(): after people-first spread, swap each missing friend's best photo in for the weakest pick that isn't any friend's only photo (plan step 3). Selection.friendSwaps
main.ts                     updateFriends() after people finder finishes; friends strip (#friends) with 96 px face crops from detail copy, "in reel / in album", strangers count
```
Verified: mirrored/cropped/zoomed copies of a 6-person group + astronaut → 6 coherent clusters, same-face mirror cosine 0.94–0.97, no cross-person merges; a missing person = face not embedded (too small/side-on). 50-photo albums: all 10 people photos picked; friend coverage unit-tested. 12.7 s for 50 photos (10 with people) headless. 51 unit tests. Not verified: same friend across genuinely different photos (lighting/age/sunglasses) — no such test data here; threshold may need tuning on Krish's album.

## 7d. M4b part 2 — DONE (scene types)
```
model        Xenova/clip-vit-base-patch32 onnx/vision_model_q4.onnx (63.6 MB, MIT) → public/models/clip-vit-b32-vision.onnx (assets.mjs, HF; needs huggingface.co + *.hf.co CDN in sandbox allowlist — Krish added both). q4 vs fp32 embedding cosine 0.95–0.99 on samples (int8 89 MB no better). transformers.js NOT used: ORT already shipped; second runtime = +20 MB
labels       scripts/clip_labels.py (python onnxruntime + tokenizers, text_model_quantized, prompt ensembles per class) → src/analysis/sceneLabels.json (13 classes × 512). SCENES_ENABLED = labels present
scene.worker CLIP preprocess: shortest side 224 (canvas high quality), centre crop, mean/std, NCHW; output image_embeds → l2 → classify (softmax of 100·cos). ~0.5 s/photo headless desktop (phones slower; runs in background, grid updates live)
scenes.ts    classify, SCENE_LABEL, isJunk (top=junk & p ≥ 0.25; browser receipt 0.29), looksLikeScreenshot (timeSource file & ratio ≥ 1.9 & (.png | /screen ?shot/i))
gate.ts      Reason 'screenshot' (junk or screenshot heuristic, no people) → always set aside (soft)
selection    others = fillOthers: non-food spread first; food ≤ floor(0.2·slots) unless nothing else; SCENE_BONUS sunset/landmark .4, scenery/activity .3, city/nightlife .2, vehicle −.1, room −.2
```
Verified (samples): coffee→food .85, moto→vehicle .92, grass→scenery, rocket→landmark, cat→animal, receipt→junk (set aside), chat screenshot→caught by file clues (CLIP said room). People photos' CLIP labels unreliable (astronaut→landmark) — people decisions use faces, not CLIP. 50-photo album: 10 people + 8 scenery + 2 food picked, no vehicles/animals. 54 unit tests.
Also: status line now "People in X of N · F faces, I recognisable → K people you appear with, S one-off" (user reported "only 2 people"; ask which number is low). Different-person SFace cosine max 0.34 on samples → do NOT lower 0.363. NotReadableError (cloud placeholder / moved file) → retry once after 500 ms, then friendly "make it available offline" message.

## 7d+. Phone robustness (after M4b, user's Android run)
- Import SNAPSHOTS all picked files first (file.arrayBuffer → new File) before analysis: Android revoked access mid-import (54 s for 24 photos) → NotReadableError on late files. Photo.file removed (copies only held during import; masters/details kept).
- Model/engine downloads: fetchAsset.ts fetchBytes (3 tries, backoff) → MediaPipe modelAssetBuffer + wasm via blob: URL; ORT env.wasm.wasmBinary + session from bytes. User saw "face_landmarker.task: HTTP 200 … Failed to fetch" (download broke mid-way). Tested by aborting the first request of every big file: all recovered.
- Scene finder starts only after the people finder finishes (one heavy download/compile at a time on phones).
- Phone import pool: 2 if navigator.deviceMemory ≥ 6, else 1. Master JPEG q 0.88.

## 7d++. After Krish's 83-photo run (people 34/83, 44 faces → 11 people; scenes 37 activity, 20 food…)
- Soup bowl detected as a face → people.ts dropObjectFaces: CLIP label food/animal/vehicle/room with p ≥ 0.5, CLIP people < 0.1, no body, ≤ 2 faces → faces dropped (applied when the scene arrives; friends regrouped after scenes finish).
- Similar photos picked → selection diversify(): chronological; pick with CLIP cos ≥ 0.9 to an earlier pick is swapped for best unpicked photo between its neighbours that is < 0.9 to all picks; people↔people only; never drop a friend's last spot. Selection.varietySwaps shown in summary.
- Only 25 photos / 22.9 s → MUSIC_DEFAULTS.maxPhotos 25 → 40 (cap only; count comes from chorus length at preferred pace, ≤ 30 s). Summary says why photos were left out (end with the chorus / fit music in 30 s / stay under 30 s).
- OPEN: "activity" = 37/83 suspicious (labels/prompt tuning on real photos needed).

## 7e. Milestone 5 — DONE (classic best photo per burst)
```
vision.worker  per face: lookDown = avg(eyeLookDownLeft/Right) blendshapes; sharpness = subjectSharpness on 96 px crop (face box ×1.2) from MASTER, noise scaled by 96/side
classic.ts     CLASSIC {maxBlink .4, maxYaw 25, maxLookDown .5, minFaceSharpness .15, edge .005}. checkFace → pass + quality (=(1−blink)²·yaw·lookDown·sharp·edge). rankFrame(people, expected = max faces in burst, sharpness) → {passing, worst (missing → 0), smile, issues[]}. compareFrames: passing → worst (±.05 tie) → smile (±.05) → sharpness. bestFrame → −1 if no faces (old quality comparator then)
gate.ts        burst keeper = bestFrame when ≥ 2 frames with faces; Verdict.faceRank for every face photo
main.ts        slot score += 0.3·faceRank.worst; tile tooltip "Faces: 4 of 6 good; 1 eyes closed, 1 missing"; alternate tiles show first issue
```
Verified: real candid group photo → readings match the picture (2 looking down at cards, laughing man eyes shut, man turned 54°, only centre man passes → "1 of 6 good"). Burst [blurred, full, centre face blocked] → keeps full ("6 soft face", "1 missing" on others). 63 unit tests. Pitch sign unverified → not used (lookDown blendshape instead). Krish's run before M5: 43 of 83 photos really have people, app found 34; 20 food correct; 2 screenshots correct.

## 7e+. Speed + "this is me" (after M5)
- Speed (Krish: import→scenes too slow; 83 photos ≈ 3.3 min). Measured in browser (single-thread wasm): CLIP q4 450 ms/photo vs int8 180 ms (native 82 vs 69) → ship vision_model_quantized (89 MB) as models/clip-vit-b32-vision-int8.onnx. SFace int8 240 ms/face vs fp32 45 ms → ship fp32 (38.7 MB) as models/face_recognition_sface_2021dec.onnx. Scene finder starts when people models are loaded (onReady), runs in parallel (2 cores). Scenes skip burst alternates. 50-photo album pick→done 41 s → 16 s headless.
- "Me": tap a face in the friends strip (button, aria-pressed) → meCentroid = mean embedding; findMe matches centroid ≥ 0.45 after every recluster; optional "Remember me on this device" stores the 128-d centroid in localStorage (vacation-reel.me), untick = delete. Who.me → slotScore +0.4 and ensureMe(): ≥ max(2, ceil(picks/5)) photos of me if available, swapping weakest non-me picks (never a friend's only photo). Me always listed first ("You").

## 7g. Milestone 7 — DONE (before M6)
```
scoring.ts   SCORE_WEIGHTS Q .15 F .25 C .15 M .45 (plan start .20/.25/.20/.35; Krish: people > food/scenery; aesthetic rates coffee 7.1 vs group 5.7; blur already gated). Raw → album percentiles. F: people photo 0.5+0.5·(½ passing/expected + ½ worst face) else 0.5·Σ CLIP probs of scenic classes (food → ~0). C: LAION aesthetic (src/analysis/aesthetic.json from scripts/aesthetic.py, sa_0_4_vit_b_32_linear MIT; .pth zip read w/o torch) − 0.5 if someone cut off. M: .45·friends/4 + .15·you + .15·log burst size + .15·highlight (CLIP vs sceneLabels.json "highlights", cos .22→.30) + .10·first of chapter
chapters.ts  new chapter if gap > 2 h or > 1.5 km from chapter anchor (GPS both). Never CLIP
reel.ts      chooseReel: allocate slots ∝ sum of top-3 scores (min 1, largest remainder, overflow to non-full chapters); pickChapter MMR: v = score − 0.6·max(0,(sim−0.6)/0.4) + 0.15·new friends; people first (near-repeat people photos, CLIP ≥ 0.9, don't block), one ESTABLISHING (scenery/landmark/city/sunset) shot per chapter with ≥ 3 slots, food ≤ max(1, 10 %) unless nothing else; then coverFriends + ensureMe. sequence: chapters chronological, orderChapter beam (width 12): +0.6 non-establishing first when one exists, +1 third same scene in a row, +0.3 third same group/solo/none, +0.35 per earlier photo jumped; then hook = best score first, finale = best M last
main.ts      currentPlan → scorePhotos + chooseReel (selectPhotos kept for tests/fallback logic). Tile tooltip shows score parts + highlight. Summary mentions chapters.
```
Verified: 70 unit tests (chapters split by gap/distance, slots favour stronger chapter, MMR drops near-repeat, food ≤ 1, near-chronological order, hook/finale/establishing). E2E 50-photo album: hook = top-score people photo, finale = highest moment, order chronological with small swaps, near-repeat cam shot dropped. NOT tuned on real albums yet.

## 7g+. After M7 (Krish: "order 90% good"; marked himself → still too many solo photos of others; unreadable files again)
```
importer.ts  snapshot: 3 parallel copy lanes, each file up to 3 tries (400/1600 ms backoff), arrayBuffer → stream fallback; message points at Google Photos ⋮ → Download
scoring.ts   after percentiles, with me marked: +ME_BOOST .12 if me in photo; −SOLO_OTHER_PENALTY .15 if exactly one friend (not me) and ≤ 1 person. Groups without me unchanged
selection    ensureMe target max(2, ceil(picks/4))
exif.ts      BUG FIX (since M2): exifr pick listed 'latitude','longitude' → GPS never read. Now picks GPSLatitude/Ref, GPSLongitude/Ref (exifr derives latitude/longitude). Place-based chapters (1.5 km) only work from now on
```

## 7h. Milestone 8 — DONE (motion, transitions, smart crop, captions)
```
render/motion.ts    MOTION {maxZoom .08, zoomPerSec .05, fade .2 s, captionFade .3}. zoom about anchor (anchor stays still on screen), safeZoom limits z so the subject box stays inside the window; even clips push in, odd pull out; ease = .7 linear + .3 cosine. transitionFor: downbeat (beat−phase ≡ 0 mod 4) or chorus beat → cut, other beats → fade; no music → fade. salientCentre: max edge-energy window share − .15·|c−.5|
musicTimeline.ts    Clip.transition set per cut (clip 0 cut). timeline.ts (no music): all fades
crop.ts             frameFor(..., salient) → no-people cover crop centred on detail
render.worker.ts    per-frame draw. Shot = bitmap + framing + blurred fill + anchor + z; ≤3 bitmaps alive. Fade centred on cut (±0.1 s): incoming drawn to layer canvas, blended with alpha. Motion progress spans whole visible time incl. fades. Fit mode zooms the photo inside its fixed dest box (never spills over the blur). Keyframe at each clip start. Captions lower-left (y .74h vertical / .8h horizontal), small letter-spaced top line + bold main, fade+rise
render/captions.ts  public/geo/places.tsv (scripts/places.mjs from GeoNames cities1000.txt via npm cities-with-1000@1.0.4; pop ≥ 5000; 49k rows, 1.47 MB, ~560 KB gz; CC BY 4.0 → attribution in footer + README). 1° grid; nearest ≤ 25 km, score d/(1+.5·max(0,log10pop−3.7)). buildCaptions: clip 0 = title (month year / most common place, tie → earliest); then "Day N / place" when day|place changes, days non-decreasing only (hook/finale out of order), ≥ 2.1 s between starts, ≥ 1.8 s shown, no overlap; no GPS → "Day N"; single day → place only
UI                  Make section: "Slow zoom…" (on), "Captions" (off). Places file fetched only when captions on and picks have GPS
```
Verified: 80 unit tests. E2E 50-photo GPS album (Lisbon/Sintra/Algés, 3 days) + 120 BPM song: hard cuts every 2 s on downbeats, fades between, zoom visible, captions June 2026/Sintra → Day 1/Lisbon → Day 2/Sintra → Day 3/Algés. Render 20 s reel in ~18 s desktop (static frames before; phones slower).

## 7h+. Looks + solo cap (Krish: "max ~1 solo photo of others"; "more creative, pinteresty overlays")
```
selection    isSoloOther (me marked, exactly 1 friend ≠ me, count ≤ 2); limitSoloOthers keeps ≤ SOLO_OTHER_MAX=1 (best), swaps rest for best unpicked people photo (with me / group) else any non-near-repeat; runs LAST in chooseReel (also when all candidates fit) and selectPhotos → beats coverFriends for solo-only friends. SOLO_OTHER_PENALTY .3
render/looks.ts  Look clean|film|filmstrip|booth|magazine|split (Scrapbook REMOVED: Krish "doesn't look nice"). punchAt (+4.5% on hard cuts, .28 s), flashAt, sparkles; FLASH/SPARKLES/OVERLAY_CAPTIONS sets per look (Film: flash, NO sparkles — Krish); COVER_LOSS split .6 / booth .5 (cells crop harder before falling back to fit). filmStrip geometry + stripPosition (easeOutBack lands on the beat, slideSec .32); booth (3 cells: stacked 4:3 vertical / side by side 4:5 horizontal) + boothGroups (opener, finale, leftovers full screen; strips of 3 between); magazine layout (title fitted to width, photo top = title bottom, letters' feet 10% under photo); splitPages (full: opener, finale, chorus clip, ≥1.6 s; runs → pages of 2/3) + splitLayout (full → halves → half + 2 quarters; new cell slides in from bottom/right over .24 s)
worker       Shot = bitmap + 48 px tiny (blur fill) + edge profiles; viewOf(w,h) caches framing/anchor/zoom per rect size; drawInto(rect) used by every look. film: grade + leaks + grain + vignette + stamp. filmstrip: blurred bg, dark band, frames ±3 around position, orange edge numbers ("▸ 12A", "VR 400 12"), moving sprocket holes, light grain. booth: blurred bg, white strip ±1.6°, empty cells grey until their beat, camera flash per cell, mono label (place · date); next strip slides in from right while old leaves left. magazine: palette colour changes with title (MAG_PALETTE 6 muted pairs), serif title rises in on change, shadowed photo, rule + "NO. 02 — JUNE 2026" + italic "the travel issue". split: white gutters
captions.ts  photoLabels → stamps / notes (place · 3 June) / titles (place | Day N | month) / kickers. Places loaded when captions on OR look magazine/booth
UI           Look radio (default Clean) in Make section; motion checkbox also controls punch/slides
drive.ts     Google Drive link import (Krish asked for Drive/iCloud links). Drive API v3 + free API key VITE_GOOGLE_API_KEY (GitHub secret GOOGLE_API_KEY → pages.yml build env; key restricted to krishc99.github.io referrer + Drive API). parseDriveLink (folders/, file/d/, ?id=); listDrive (folder + 2 levels of subfolders, images incl. HEIC as octet-stream); downloadDrive (3 lanes, 3 tries, alt=media) → in-memory File → importPhotos(copy=false). Friendly 403/404/429 errors. Form hidden when no key. iCloud links NOT possible (no CORS on sharedstreams; would need a server) — iPhone picker already reaches iCloud Photos. Google Photos albums NOT possible (Library API restricted since 2025; Picker API needs OAuth)
```

## 7i. After Krish's 320-photo Drive run (only 184 arrived; 39 faces in 121 people photos; "recognised in 3 photos"; repeats; hands over faces; blurred of a burst kept)
```
drive.ts      DRIVE_DOWNLOAD {lanes 2, tries 6, pauseMs 2000 doubling to 30 s}: Google rate-limits anonymous alt=media → 403 WITHOUT CORS ("Failed to fetch"). Any refusal pauses all lanes; photo re-queued at the back. Re-adding the same link fetches only names not yet added. Status shows total minutes + Google wait
drive sign-in Anonymous (API key) downloads: Google stops after ~50 photos, then 403 for EVERY file for a while (Krish: "reached 53, after refresh all 403"). Fix: Sign in with Google via Google Identity Services token client (script accounts.google.com/gsi/client loaded when the link box is focused; requestAccessToken from the tap), scope drive.readonly, token in memory only; requests use Authorization: Bearer (no key). Secret GOOGLE_CLIENT_ID → VITE_GOOGLE_CLIENT_ID (OAuth client "Web application", JS origin https://krishc99.github.io, consent screen Testing with Krish as test user; drive.readonly is restricted, so it stays in Testing = up to 100 test users, no verification). Without client ID falls back to API key
faces         YuNet (face_detection_yunet_2023mar.onnx, OpenCV Zoo MIT, 232 KB, fixed 1×3×640×640 BGR 0–255) via ORT = main detector (src/analysis/yunet.ts decode: strides 8/16/32, score √(cls·obj) ≥ .72, NMS .3, min side 9 px); same tiles as before on the 2560 copy. MediaPipe FaceLandmarker now only reads expressions on a 256 px crop (2.2× face) per YuNet face; YuNet points kept for SFace alignment. Fallback to MediaPipe detection if YuNet fails to load. Test: synthetic crowd album 1/5 → 4/5 photos with faces (6 → 21 faces); mix 26 → 30 faces. ~2× slower people pass (0.35 s/photo desktop)
covered       Face.covered: ≥ 2 pose hand points (wrists/fingers 15–22, vis > .6) inside the face box (inner 70%), or a face ≥ 8% tall that MediaPipe can't mesh. classic: 'face covered' issue, quality ×.25, fails pass. scoring: −COVERED_PENALTY .25 if ≥ half the faces covered. (CLIP "hands over face" prompt tried: NOT discriminative, group photo scored higher than control → dropped)
friends       sameCosine .363 → .33 (holiday faces split one person into several groups). EMBED_MIN_FACE .035 → .025. photosWithMe: once marked, any face with cosine ≥ ME_FACE_MATCH .36 to my centroid = me in that photo (catches faces clustered elsewhere)
selection     SIMILAR .9 → .88. dedupeReel (last pass in chooseReel, also when everything fits): near-repeat pair → keep higher Q percentile (if gap > .05, else score), never drop someone's only photo; refill with best unpicked non-repeat (same people/non-people kind first, not a solo-other). ensureMe/coverFriends pick "freshest" (non-repeat) incoming. ME_BOOST .12 → .2; ensureMe ≥ max(2, ⅓ of picks)
looks         Cells never cut people: frameFor(…, maxCoverLoss, peopleMaxLoss) with COVER_LOSS {split .5, booth .45} and PEOPLE_LOSS {split .35, booth .35, filmstrip .2, magazine .2}, applied only to cells (full-screen photos keep the normal rules). Film strip: frame length follows each photo's aspect (stripLayout/alongAt; style.aspects from Photo.width/height), strip swings ±4° per beat, push-zoom on landing, gate weave, motion smear while sliding, warm flare on landing, flicker, unexposed next frames dimmer. Magazine: colours from the photo (paletteOf: saturation-weighted hue → pale paper or deep shade; title in the photo's most vivid hue), eased over .35 s; photo box keeps the photo's shape, centred. Split: 4 two-photo + 4 three-photo arrangements, entry from bottom/top/left/right/pop, per page (splitVariant, never same twice in a row), easeOutBack settle
```

## 7j. Duplicates / equal time / debug report (Krish: "still duplicates; everyone equally if no Me; similar pose → more people")
```
import        same picture twice (same size, time within 2 s, dHash ≤ 2) → kept once, reported in skipped
selection     clipSim falls back to dHash (≤ 6 → .95) when a photo has no CLIP embedding (scene check skipped/unfinished) — repeats were invisible before. SIMILAR .88 → .86. dedupeReel: near-repeat pair with different friend counts → keep the one with more people unless Q gap > .25. pickChapter: REEL.balance .07 × average earlier appearances of the photo's people (me exempt) → equal time
debug         Order section → "Download debug report" (src/debug/report.ts): HTML with optional 160 px thumbnails + embedded JSON (#data): per photo name/time/gps/burst/status/q/issues/scene top-3/hasClip/faces (h, yaw, id, covered, blink, smile)/friends/score parts/nearest photo (clip, dhash); reelPairs (clip ≥ .75 or dhash ≤ 12); people (photos, moments, in reel). Parse: re.search(r'id="data">(.*)</script>')
open          group6 test: MediaPipe-on-crop blink .49–.65 on smiling faces → "3 eyes closed" (check against Krish's report before tuning maxBlink)
```

## 7k. iPhone round 2 (Krish: tick dead with many photos; 40 worked; scene finder "Out of memory"; wants no cap)
```
scenes        iPhone OOM (CLIP 89 MB + people models at once). Phones (touch + mobile UA/iPad) now run scenes AFTER people (vision worker terminated); desktops unchanged (parallel). ORT sessions (CLIP, SFace): enableCpuMemArena/enableMemPattern false. Scene error matching /memory|backend/ → one retry after 1.5 s
length        Order section "Length": 30 s (default, ends with chorus) / 60 / 90 / All the best (180 s). LENGTHS in types.ts sets maxSeconds + bitrate (10/8/6/5 Mbps). musicTimeline: > 31 s = keep going past the chorus (no section cap; tries longest phrase-aligned total first); seconds() caps by what's left of the song from the start beat (−0.5 s) so the music never runs out. Short songs: quicker pace instead of running past the end. "All": every candidate that survives dedupe (chooseReel returns all when they fit)
iOS picker    accept = image/heic,image/heif,image/jpeg,image/png,image/webp on iOS (asks for originals; "image/*" makes iOS convert each photo to JPEG first, which silently fails on big selections). Button under the drop zone toggles "compatible mode" (image/*), remembered in localStorage. NOT verified on device
test          mix album + "All the best": 50 → 16 photos (synthetic scenes look alike to CLIP at .86); watch this on real albums via the debug report
```

## 7l. Same face in several circles; scenery over group photos (Krish, after pausing iPhone testing)
```
friends       clusterPeople pass 2: merge groups whose CENTROIDS have cosine ≥ mergeCentroid .42 (cannot-link kept). Manual: "Same person in two circles? Merge them" under the circles → tap both → mergePersons; merges remembered as centroid pairs for the session and re-applied after each regroup (nearestPerson ≥ .6)
selection     isPeoplePhoto also true for a group shot: ≥ 2 uncovered faces ≥ 5% tall, recognised or not (split identities used to make group photos "one-off strangers" = scenery). Reel-wide scenery cap: REEL.sceneryShare .15 (min 1) of slots for no-people photos while people photos are left (was: one establishing shot per chapter with ≥ 3 slots, unbounded across chapters)
ios           picker wait message: after the picker closes (focus/visibility), "Your phone is handing the photos over…" until change/cancel
```
Still waiting on Krish's debug report from a real album to tune SIMILAR / scoring with data.

## 7m. From Krish's debug report (317 photos, 279 keepers, 487 faces/361 ided, 7 main people 31–66 photos each — recognition now fine)
```
findings      Reel had: same-setup pairs at CLIP .74 (cake, same minute) / .80 (lake, 10 s apart) — under SIMILAR .86; a forwarded-WhatsApp landscape (file date) forming its own chapter and taking a guaranteed slot; group shots (#33: 6 friends, score .80) lost to smaller groups because "equal time" averaged everyone's earlier appearances (groups of popular people penalised) and split one-off "friends" (2 moments, tiny faces) earned the new-friend bonus
fixes         clipSim = imageSim + time boost (camera dates only): ≤ 45 s +.2, ≤ 3 min +.12 (TIME_BOOST) — used everywhere repeats are judged. Balance uses the LEAST-shown person in the photo. Friend needs ≥ 3 moments when album has ≥ 100 moments. allocate: guaranteed slot only for chapters with a people photo or importance ≥ .6 × median. NO_DATE_PENALTY .1 (timeSource 'file'). sceneryShare .1; establishing shot only in chapters with ≥ 4 slots
undated       sequence(): photos without a camera date leave the timeline; best-scored alternate between right after the opener and right before the finale. Repeats for them = image similarity only (no time boost). Covered: also front-facing (|yaw| < 30) faces ≥ 5% tall that MediaPipe can't mesh (was ≥ 8%)
check         Krish's carousel set (#7,#12–16, CLIP .84–.95, within 70 s) and pirate set (#42–44, .88–.91, within 10 s) → each becomes one photo with the time boost
tools         scratchpad/rep/lib.py: load(report) → (data, thumbs by "#n"); sheet(thumbs, [(n, label)], path) contact sheet
```

## 7f. Milestone 6 scope — fun modes (plan)
Funny (jawOpen/mouthPucker/cheekPuff/eyeWide*/browInnerUp high; wink OK, half-closed both = blink), Laugh (eyes closed + big smile + open jaw), Scenic from behind (shoulders, no nose/eyes; judge scenery sharpness + framing, people small), Jump/arms up (wrists above head; highest body frame in burst). Intentional vs accidental: shared or held deviations intentional; one person in one frame accidental. A burst can yield several keepers (one per mode). Mix ~1 fun per 4–5 classic, spread out (M7 sequencing).

## 8. Test recipe
- Synthetic photos: PIL random ellipses/lines scenes (`scene(seed,label)`), EXIF via `Image.Exif()[0x8769]={0x9003:'YYYY:MM:DD HH:MM:SS'}`; HEIC via `pillow_heif` (pip, `--break-system-packages`); blur = GaussianBlur(25–30).
- Synthetic music: numpy drum loop (kick 1&3, snare 2&4, hats 8ths; quiet intro, loud 40–70 s) → WAV + MP3 (ffmpeg libmp3lame). Sync check: ffmpeg scene-detect cut pts vs transient onsets in exported audio. Audio input: `setInputFiles('#audio-input', path)`; wait `#music-status` contains 'BPM'; `#song-start`, `#music-in-file`.
- `npx vite preview --port 4173 &` → Playwright (preinstalled `require('playwright')`). Files: `setInputFiles('#file-input', paths)`; wait `#order-section:not([hidden])`; tiles are `button.tile[aria-label^="<name>"]`; `#make`; wait `#result:not([hidden])`; `download` event from `#download`. Radio: `page.check('#shape-horizontal')`.
- ffprobe streams/frames/duration. Sandbox blocks fonts.googleapis.com (fallback fonts in screenshots; fine).

## 9. Later (unchanged)
4 CLIP (transformers.js, lazy) + face identity (permissive / face-api.js; tune in Python) → feed face boxes into subjectSharpness regions · 5 classic best-photo · 6 fun modes · 7 score `0.20Q+0.25F+0.20C+0.35M`, MMR, friend coverage, beam-search order · 8 DONE · 9 preview/edit · 10 Capacitor.
Rejected: Python/FastAPI backend, InsightFace weights, BRISQUE, DBSCAN on CLIP alone, server FFmpeg.
