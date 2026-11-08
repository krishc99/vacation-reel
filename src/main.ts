import './style.css';
import {
  analyzeAlbum,
  candidateIds,
  emptyOverrides,
  tileState,
  type AlbumAnalysis,
  type Overrides,
  type Reason,
} from './analysis';
import { subjectBoxes } from './analysis/people';
import { findPeople, type VisionJob } from './analysis/vision';
import { findScenes, type SceneJob } from './analysis/sceneJob';
import { SCENE_LABEL, SCENES_ENABLED } from './analysis/scenes';
import { importPhotos } from './import/importer';
import { sortByTime } from './import/sort';
import { excerpt, loadSong, type Song } from './audio/song';
import { maxPhotosForMusic, planMusicTimeline, songParts, type SongStart } from './render/musicTimeline';
import { renderReel, type RenderJob } from './render/renderer';
import { frameFor } from './render/crop';
import { buildTimeline, timelineDuration } from './render/timeline';
import { NO_WHO, selectPhotos, slotScore, type Who } from './selection';
import { clusterPeople, type FaceRef, type Person } from './analysis/friends';
import { DEFAULT_SETTINGS, SHAPE_SIZE, type Clip, type Photo, type ReelSettings, type Shape } from './types';
import { megabytes, shotTime, shotTimeFull, timecode } from './ui/format';

let settings: ReelSettings = { ...DEFAULT_SETTINGS };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  unsupported: $('unsupported'),
  spec: $('spec'),
  build: $('build'),
  drop: $<HTMLLabelElement>('drop'),
  fileInput: $<HTMLInputElement>('file-input'),
  importStatus: $('import-status'),
  peopleStatus: $('people-status'),
  sceneStatus: $('scene-status'),
  friends: $('friends'),
  friendList: $<HTMLUListElement>('friend-list'),
  friendsNote: $('friends-note'),
  skipped: $<HTMLUListElement>('skipped'),
  orderSection: $('order-section'),
  orderSummary: $('order-summary'),
  grid: $<HTMLOListElement>('grid'),
  clear: $<HTMLButtonElement>('clear'),
  makeSection: $('make-section'),
  make: $<HTMLButtonElement>('make'),
  cancel: $<HTMLButtonElement>('cancel'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressLabel: $('progress-label'),
  renderError: $('render-error'),
  result: $('result'),
  video: $<HTMLVideoElement>('video'),
  resultMeta: $('result-meta'),
  download: $<HTMLAnchorElement>('download'),
  share: $<HTMLButtonElement>('share'),
  musicSection: $('music-section'),
  audioInput: $<HTMLInputElement>('audio-input'),
  musicPick: $<HTMLLabelElement>('music-pick'),
  musicStatus: $('music-status'),
  musicControls: $('music-controls'),
  musicInFile: $<HTMLInputElement>('music-in-file'),
  musicRemove: $<HTMLButtonElement>('music-remove'),
  resultNote: $('result-note'),
  partPrev: $<HTMLButtonElement>('part-prev'),
  partNext: $<HTMLButtonElement>('part-next'),
  partLabel: $('part-label'),
  partPlay: $<HTMLButtonElement>('part-play'),
};

let photos: Photo[] = [];
let analysis: AlbumAnalysis | null = null;
let overrides: Overrides = emptyOverrides();
let job: RenderJob | null = null;
let resultUrl: string | null = null;
let resultFile: File | null = null;
let song: Song | null = null;
let songStart: SongStart = 'best';
let songPart = 0;

// ---- Build stamp (confirms which version is live) ------------------------------

el.build.textContent = `Build ${__BUILD__}`;

// ---- Capability check --------------------------------------------------------

if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') {
  el.unsupported.textContent =
    'This browser cannot make videos yet. Open this page in Chrome, Edge, or Safari 16.4 or newer.';
  el.unsupported.hidden = false;
}

// ---- Import ------------------------------------------------------------------

async function addFiles(list: FileList | File[]) {
  const files = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!files.length) return;
  el.drop.classList.add('is-busy');
  el.importStatus.textContent = `Reading 0 of ${files.length}…`;
  const t0 = performance.now();
  try {
    const { photos: added, skipped, fallbackReason } = await importPhotos(files, (done, total) => {
      el.importStatus.textContent = `Reading ${done} of ${total}…`;
    });
    photos = sortByTime([...photos, ...added]);
    analysis = analyzeAlbum(photos);
    // Burst ids are positional, so keeper picks don't survive a re-analysis.
    overrides.keeper.clear();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    el.importStatus.textContent =
      `${added.length} photo${added.length === 1 ? '' : 's'} added in ${secs}s.` +
      (fallbackReason ? ` Background reader unavailable on this device (${fallbackReason}), so photos were read directly; the page may pause briefly.` : '');
    showSkipped(skipped);
    clearResult();
    renderGrid();
    startPeople();
    startScenes();
  } catch (err) {
    el.importStatus.textContent = `Could not read photos: ${(err as Error).message}`;
  } finally {
    el.drop.classList.remove('is-busy');
  }
}

function showSkipped(skipped: { name: string; reason: string }[]) {
  el.skipped.replaceChildren(
    ...skipped.map((s) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = s.name;
      li.append(b, ` skipped. ${s.reason}`);
      return li;
    }),
  );
  el.skipped.hidden = skipped.length === 0;
}

el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files) addFiles(el.fileInput.files);
  el.fileInput.value = '';
});
['dragenter', 'dragover'].forEach((t) =>
  el.drop.addEventListener(t, (e) => {
    e.preventDefault();
    el.drop.classList.add('is-over');
  }),
);
['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, () => el.drop.classList.remove('is-over')));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});

// ---- People (faces + bodies, M4a) --------------------------------------------

let visionJob: VisionJob | null = null;
let refreshTimer = 0;
let persons: Person[] = [];
let who: Who = NO_WHO;
const faceThumbs = new Map<string, string>();

/** Re-run analysis as people results stream in (batched so the grid doesn't thrash). */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    if (!photos.length) return;
    analysis = analyzeAlbum(photos);
    renderGrid();
  }, 400);
}

function startPeople() {
  visionJob?.cancel();
  const byId = new Map(photos.map((p) => [p.id, p]));
  const t0 = performance.now();
  el.peopleStatus.textContent = 'Getting the people finder ready…';
  const job = findPeople(
    photos,
    (id, people) => {
      const p = byId.get(id);
      if (p) p.people = people;
      scheduleRefresh();
    },
    (done, total) => (el.peopleStatus.textContent = `Finding people… ${done} of ${total}`),
  );
  visionJob = job;
  void job.done.then(({ failed, error, warnings }) => {
    if (visionJob !== job) return;
    visionJob = null;
    const withPeople = photos.filter((p) => (p.people?.count ?? 0) > 0).length;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    el.peopleStatus.textContent = error
      ? `People finder unavailable (${error}). Photos are picked without it.`
      : `People in ${withPeople} of ${photos.length} photos (${secs}s).` +
        (failed ? ` ${failed} could not be checked.` : '') +
        (warnings.length ? ` ${warnings.join('. ')}.` : '');
    if (!error) {
      analysis = analyzeAlbum(photos);
      updateFriends();
      const faces = photos.reduce((n, p) => n + (p.people?.faces.length ?? 0), 0);
      const ided = photos.reduce((n, p) => n + (p.people?.faces.filter((f) => f.embedding).length ?? 0), 0);
      const friends = persons.filter((x) => x.friend).length;
      const oneOffs = persons.length - friends;
      el.peopleStatus.textContent +=
        ` ${faces} faces, ${ided} clear enough to recognise → ${friends} ${friends === 1 ? 'person' : 'people'} you appear with` +
        (oneOffs ? `, ${oneOffs} one-off face${oneOffs === 1 ? '' : 's'} (treated as strangers).` : '.');
    }
    scheduleRefresh();
  });
}

// ---- Scenes (M4b): food / scenery / landmark / … via CLIP ----------------------

let sceneJob: SceneJob | null = null;

function startScenes() {
  if (!SCENES_ENABLED) return;
  sceneJob?.cancel();
  const byId = new Map(photos.map((p) => [p.id, p]));
  const t0 = performance.now();
  el.sceneStatus.textContent = 'Getting the scene finder ready…';
  const job = findScenes(
    photos,
    (id, scene) => {
      const p = byId.get(id);
      if (p) p.scene = scene;
      scheduleRefresh();
    },
    (done, total) => (el.sceneStatus.textContent = `Sorting scenes… ${done} of ${total}`),
  );
  sceneJob = job;
  void job.done.then(({ failed, error }) => {
    if (sceneJob !== job) return;
    sceneJob = null;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const counts = new Map<string, number>();
    for (const p of photos) if (p.scene) counts.set(SCENE_LABEL[p.scene.label], (counts.get(SCENE_LABEL[p.scene.label]) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ');
    el.sceneStatus.textContent = error
      ? `Scene finder unavailable (${error}). Food and scenery are not told apart.`
      : `Scenes: ${top} (${secs}s).` + (failed ? ` ${failed} could not be checked.` : '');
    scheduleRefresh();
  });
}

// ---- Friends (M4b): who recurs across the album ---------------------------------

function updateFriends() {
  const faces: FaceRef[] = [];
  for (const p of photos) {
    p.people?.faces.forEach((f, i) => {
      if (f.embedding)
        faces.push({ photoId: p.id, burstId: analysis?.verdicts.get(p.id)?.burstId ?? p.id, faceIndex: i, embedding: f.embedding, size: f.box.h });
    });
  }
  persons = clusterPeople(faces);
  const byPhoto = new Map<string, string[]>();
  for (const person of persons) {
    if (!person.friend) continue;
    for (const id of person.photoIds) byPhoto.set(id, [...(byPhoto.get(id) ?? []), person.id]);
  }
  who = { friends: (p) => byPhoto.get(p.id) ?? [], known: true };
  faceThumbs.forEach((u) => URL.revokeObjectURL(u));
  faceThumbs.clear();
  void makeFaceThumbs().then(() => renderGrid());
}

/** Small square crop of each friend's biggest face (from the 640 px copy). */
async function makeFaceThumbs() {
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const person of persons.filter((x) => x.friend)) {
    const ref = person.faces.reduce((a, b) => (b.size > a.size ? b : a));
    const photo = byId.get(ref.photoId);
    const box = photo?.people?.faces[ref.faceIndex]?.box;
    if (!photo || !box) continue;
    const bmp = await createImageBitmap(photo.detail);
    const side = Math.max(box.w * bmp.width, box.h * bmp.height) * 1.4;
    const cx = (box.x + box.w / 2) * bmp.width;
    const cy = (box.y + box.h / 2) * bmp.height;
    const c = new OffscreenCanvas(96, 96);
    c.getContext('2d')!.drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
    bmp.close();
    faceThumbs.set(person.id, URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })));
  }
}

function renderFriends(picks: Photo[]) {
  const friends = persons.filter((p) => p.friend);
  el.friends.hidden = !who.known || friends.length === 0;
  if (el.friends.hidden) return;
  const inReel = new Set(picks.map((p) => p.id));
  const strangers = persons.filter((p) => !p.friend).length;
  el.friendList.replaceChildren(
    ...friends.map((f) => {
      const li = document.createElement('li');
      const shown = f.photoIds.filter((id) => inReel.has(id)).length;
      li.className = shown ? 'friend' : 'friend is-missing';
      const img = document.createElement('img');
      img.alt = '';
      if (faceThumbs.has(f.id)) img.src = faceThumbs.get(f.id)!;
      const n = document.createElement('span');
      n.textContent = `${shown}/${f.photoIds.length}`;
      li.title = `In ${f.photoIds.length} photo${f.photoIds.length === 1 ? '' : 's'}; ${shown} in the reel.`;
      li.append(img, n);
      return li;
    }),
  );
  el.friendsNote.textContent =
    `${friends.length} ${friends.length === 1 ? 'person' : 'people'} recognised across your photos (in reel / in album). ` +
    (strangers ? `${strangers} one-off face${strangers === 1 ? '' : 's'} treated as strangers.` : '');
}

el.clear.addEventListener('click', () => {
  sceneJob?.cancel();
  sceneJob = null;
  el.sceneStatus.textContent = '';
  visionJob?.cancel();
  visionJob = null;
  persons = [];
  who = NO_WHO;
  el.peopleStatus.textContent = '';
  photos.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
  photos = [];
  analysis = null;
  overrides = emptyOverrides();
  el.importStatus.textContent = '';
  el.skipped.hidden = true;
  clearResult();
  renderGrid();
});

// ---- Shape -------------------------------------------------------------------

function setShape(shape: Shape) {
  settings = { ...settings, ...SHAPE_SIZE[shape] };
  document.documentElement.dataset.shape = shape;
  el.spec.textContent = `${settings.width}×${settings.height} · ${settings.fps} fps · H.264 MP4 · ${settings.minSeconds}–${settings.maxSeconds} s`;
  clearResult();
  if (analysis) renderGrid();
}
document.querySelectorAll<HTMLInputElement>('input[name="shape"]').forEach((r) =>
  r.addEventListener('change', () => r.checked && setShape(r.value as Shape)),
);
setShape((document.querySelector<HTMLInputElement>('input[name="shape"]:checked')?.value as Shape) ?? 'vertical');

// ---- Plan: analysis + overrides → selection → timeline --------------------------

interface Plan {
  picks: Photo[];
  clips: Clip[];
  droppedForLength: number;
  /** Song time at reel t = 0 when cutting to music. */
  audioStart: number | null;
  /** Song time of the chorus the reel builds up to. */
  highlight: number | null;
  /** Reel ends exactly where the chorus ends. */
  coversSection: boolean;
}

function currentPlan(): Plan {
  if (!analysis) return { picks: [], clips: [], droppedForLength: 0, audioStart: null, highlight: null, coversSection: false };
  const byId = new Map(photos.map((p) => [p.id, p]));
  const candidates = candidateIds(analysis, overrides).map((id) => byId.get(id)!);
  const max = song
    ? maxPhotosForMusic(song.beats, settings, songStart, songPart)
    : Math.floor(settings.maxSeconds / settings.secondsPerPhoto);
  const a = analysis;
  const score = (p: Photo) => slotScore(p, a.verdicts.get(p.id)?.q ?? 0, who);
  const { picks, droppedForLength } = selectPhotos(candidates, max, score, who);
  const ids = picks.map((p) => p.id);
  if (song && ids.length) {
    const m = planMusicTimeline(ids, song.beats, settings, songStart, songPart);
    return { picks, clips: m.clips, droppedForLength, audioStart: m.audioStart, highlight: m.highlight, coversSection: m.coversSection };
  }
  return { picks, clips: buildTimeline(ids, settings), droppedForLength, audioStart: null, highlight: null, coversSection: false };
}

// ---- Grid ----------------------------------------------------------------------

const REASON_LABEL: Record<Reason, string> = {
  blurry: 'blurry',
  dark: 'too dark',
  bright: 'too bright',
  screenshot: 'screenshot/doc',
};

function onTileTap(id: string) {
  if (!analysis) return;
  const v = analysis.verdicts.get(id)!;
  switch (tileState(id, analysis, overrides)) {
    case 'alternate':
      overrides.keeper.set(v.burstId, id);
      break;
    case 'rejected':
      overrides.include.add(id);
      break;
    case 'excluded':
      overrides.exclude.delete(id);
      break;
    case 'keeper':
      overrides.exclude.add(id);
      overrides.include.delete(id);
      break;
  }
  clearResult();
  renderGrid();
}

function renderGrid() {
  const has = photos.length > 0 && analysis !== null;
  el.orderSection.hidden = !has;
  el.makeSection.hidden = !has;
  el.musicSection.hidden = !has;
  if (!has) return el.grid.replaceChildren();
  const a = analysis!;

  const plan = currentPlan();
  updateSongParts(plan);
  renderFriends(plan.picks);
  const startById = new Map(plan.clips.map((c) => [c.photoId, c.start]));
  const duration = timelineDuration(plan.clips);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const states = new Map(photos.map((p) => [p.id, tileState(p.id, a, overrides)]));
  const count = (s: string) => [...states.values()].filter((x) => x === s).length;

  const parts = [
    `${photos.length} photos → ${a.bursts.length} moments`,
    count('rejected') ? `${count('rejected')} set aside for quality` : '',
    `${plan.picks.length} in the reel · ${timecode(duration)}${song ? ` cut to ${Math.round(song.beats.bpm)} BPM` : ''}`,
  ].filter(Boolean);
  let summary = parts.join(' · ') + '.';
  if (plan.droppedForLength > 0) {
    summary += ` ${plan.droppedForLength} more left out to stay under ${settings.maxSeconds}s, spread evenly across the trip.`;
  } else if (duration < settings.minSeconds - 0.05 && plan.picks.length) {
    summary += ` Add a few more photos for a ${settings.minSeconds}s reel.`;
  }
  const noExif = photos.filter((p) => p.timeSource === 'file').length;
  if (noExif) summary += ` ${noExif} had no capture date, so their file date was used.`;
  summary += ' Tap a photo to swap, remove or bring it back.';
  el.orderSummary.textContent = summary;

  el.grid.replaceChildren(
    ...a.bursts.map((b) => {
      const group = document.createElement('li');
      group.className = b.photoIds.length > 1 ? 'burst is-multi' : 'burst';
      if (b.photoIds.length > 1) {
        const tag = document.createElement('span');
        tag.className = 'burst__tag';
        tag.textContent = `burst · ${b.photoIds.length}`;
        group.append(tag);
      }
      const row = document.createElement('div');
      row.className = 'burst__row';
      for (const id of b.photoIds) row.append(tile(byId.get(id)!, states.get(id)!, startById.get(id)));
      group.append(row);
      return group;
    }),
  );
}

function tile(p: Photo, state: ReturnType<typeof tileState>, start: number | undefined): HTMLElement {
  const v = analysis!.verdicts.get(p.id)!;
  const btn = document.createElement('button');
  btn.type = 'button';
  const used = start !== undefined;
  const cls = state === 'keeper' ? (used ? 'is-used' : 'is-capped') : `is-${state}`;
  btn.className = `tile ${cls}`;
  btn.addEventListener('click', () => onTileTap(p.id));
  if (p.people) {
    btn.dataset.people = String(p.people.count);
    btn.dataset.eyesOpen = String(p.people.eyesOpen);
    btn.dataset.faces = String(p.people.faces.length);
    btn.dataset.bodies = String(p.people.bodies.length);
    if (p.people.faceSharpness !== null) btn.dataset.faceSharp = p.people.faceSharpness.toFixed(3);
  }
  btn.dataset.sharp = p.stats.sharpness.toFixed(3);
  if (p.scene) btn.dataset.scene = `${p.scene.label}${(p.scene.probs[p.scene.label] ?? 0).toFixed(2)}`;

  // Preview the framing the export will use (cover crop, or whole photo on a blurred fill).
  const framing = frameFor(p.width, p.height, settings.width, settings.height, subjectBoxes(p.people));
  const fit = framing.mode === 'fit';
  const frame = document.createElement('span');
  frame.className = fit ? 'tile__frame is-fit' : 'tile__frame';
  if (fit) {
    const bg = document.createElement('img');
    bg.className = 'tile__bg';
    bg.src = p.thumbUrl;
    bg.alt = '';
    frame.append(bg);
  }
  const img = document.createElement('img');
  img.className = 'tile__img';
  if (framing.mode === 'cover') {
    // Same crop position as the export (shifted toward the people).
    const c = framing.crop;
    const px = p.width > c.sw + 0.5 ? (c.sx / (p.width - c.sw)) * 100 : 50;
    const py = p.height > c.sh + 0.5 ? (c.sy / (p.height - c.sh)) * 100 : 50;
    img.style.objectPosition = `${px.toFixed(1)}% ${py.toFixed(1)}%`;
  }
  img.src = p.thumbUrl;
  img.alt = p.name;
  img.loading = 'lazy';
  frame.append(img);

  const tc = document.createElement('span');
  tc.className = 'tile__tc';
  const reasons = v.reasons.map((r) => REASON_LABEL[r]).join(', ');
  const labels: Record<string, [string, string]> = {
    'is-used': [timecode(start ?? 0), 'Remove from reel'],
    'is-capped': ['not used', 'Left out for length. Tap to remove entirely'],
    'is-alternate': ['alt', 'Use this one instead'],
    'is-rejected': [v.reasons.length ? REASON_LABEL[v.reasons[0]] : 'set aside', 'Bring back'],
    'is-excluded': ['removed', 'Bring back'],
  };
  const [label, action] = labels[cls];
  tc.textContent = label;

  const cap = document.createElement('span');
  cap.className = 'tile__cap';
  cap.textContent = shotTime(p.takenAt) + (p.timeSource === 'file' ? ' *' : '');

  const note = v.onlyOfMoment && state === 'keeper' ? ` Kept although ${reasons}: only shot of this moment.` : '';
  const why = cls === 'is-rejected' ? ` Set aside: ${reasons}.` : '';
  const sceneTxt = p.scene ? ` ${SCENE_LABEL[p.scene.label]}.` : '';
  btn.title = `${p.name} · ${shotTimeFull(p.takenAt)}.${sceneTxt}${why} ${action}.${note}`;
  btn.setAttribute('aria-label', `${p.name}, ${label}. ${action}.`);
  btn.append(frame, tc, cap);
  return btn;
}

// ---- Music -------------------------------------------------------------------

function updateSongParts(plan: Plan) {
  if (!song || !plan.picks.length || plan.audioStart === null) return;
  const total = songStart === 'best' ? songParts(song.beats, plan.picks.length, settings).length : 0;
  const at =
    plan.highlight !== null && plan.highlight > plan.audioStart
      ? `chorus ${timecode(plan.highlight)} · lead-in from ${timecode(plan.audioStart)} · ${plan.coversSection ? 'ends with the chorus' : 'ends on a phrase'}`
      : `starts ${timecode(plan.audioStart)}`;
  el.partLabel.textContent = songStart === 'best' && total ? `Suggestion ${Math.min(songPart, total - 1) + 1} of ${total} · ${at}` : `From the top · ${at}`;
  el.partPrev.hidden = el.partNext.hidden = songStart !== 'best';
  el.partPrev.disabled = songPart <= 0;
  el.partNext.disabled = songPart >= total - 1;
}

function stepPart(d: number) {
  songPart = Math.max(0, songPart + d);
  stopPreview();
  clearResult();
  renderGrid();
}
el.partPrev.addEventListener('click', () => stepPart(-1));
el.partNext.addEventListener('click', () => stepPart(1));

// Preview the exact excerpt the reel will use (same start, length and fade).
let previewCtx: AudioContext | null = null;
let previewSrc: AudioBufferSourceNode | null = null;
function stopPreview() {
  previewSrc?.stop();
  previewSrc = null;
  el.partPlay.textContent = 'Play';
}
el.partPlay.addEventListener('click', () => {
  if (previewSrc) return stopPreview();
  const plan = currentPlan();
  if (!song || plan.audioStart === null) return;
  previewCtx ??= new AudioContext();
  const clip = excerpt(song, plan.audioStart, timelineDuration(plan.clips));
  const buf = previewCtx.createBuffer(2, clip.left.length, clip.sampleRate);
  buf.copyToChannel(clip.left as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(clip.right as Float32Array<ArrayBuffer>, 1);
  const src = previewCtx.createBufferSource();
  src.buffer = buf;
  src.connect(previewCtx.destination);
  src.onended = () => {
    if (previewSrc === src) stopPreview();
  };
  void previewCtx.resume();
  src.start();
  previewSrc = src;
  el.partPlay.textContent = 'Stop';
});

el.audioInput.addEventListener('change', async () => {
  const file = el.audioInput.files?.[0];
  el.audioInput.value = '';
  if (!file) return;
  el.musicPick.classList.add('is-busy');
  el.musicStatus.textContent = `Finding the beat in ${file.name}…`;
  const t0 = performance.now();
  try {
    stopPreview();
    song = await loadSong(file);
    songPart = 0;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    el.musicStatus.textContent = `${song.name} · ${Math.round(song.beats.bpm)} BPM · ${timecode(song.duration)} · analysed in ${secs}s. Cuts land on the beat.`;
    el.musicControls.hidden = false;
    el.musicPick.querySelector('span')!.textContent = 'Change song';
  } catch (err) {
    song = null;
    el.musicStatus.textContent = (err as Error).message;
    el.musicControls.hidden = true;
  } finally {
    el.musicPick.classList.remove('is-busy');
  }
  clearResult();
  renderGrid();
});

document.querySelectorAll<HTMLInputElement>('input[name="song-start"]').forEach((r) =>
  r.addEventListener('change', () => {
    if (!r.checked) return;
    songStart = r.value as SongStart;
    stopPreview();
    clearResult();
    renderGrid();
  }),
);
el.musicInFile.addEventListener('change', clearResult);
el.musicRemove.addEventListener('click', () => {
  stopPreview();
  song = null;
  el.musicControls.hidden = true;
  el.musicStatus.textContent = 'Optional. Cuts land on the beat. The song never leaves this device.';
  el.musicPick.querySelector('span')!.textContent = 'Choose a song';
  clearResult();
  renderGrid();
});

// ---- Render ------------------------------------------------------------------

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultFile = null;
  el.result.hidden = true;
  el.renderError.hidden = true;
  el.video.removeAttribute('src');
}

el.make.addEventListener('click', async () => {
  const { picks, clips, audioStart } = currentPlan();
  if (!picks.length) return;
  clearResult();
  const withAudio = song !== null && audioStart !== null && el.musicInFile.checked;
  const audio = withAudio ? excerpt(song!, audioStart!, timelineDuration(clips)) : undefined;

  el.make.disabled = true;
  el.cancel.hidden = false;
  el.progress.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressLabel.textContent = 'Starting…';
  const t0 = performance.now();

  job = renderReel(clips, picks, settings, (done, total, stage) => {
    const pct = total ? (done / total) * 100 : 0;
    el.progressFill.style.width = `${pct.toFixed(1)}%`;
    el.progressLabel.textContent = `${stage} · frame ${done} of ${total}`;
  }, audio);

  try {
    const { blob, durationSec, audioCodec } = await job.promise;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    resultFile = new File([blob], `vacation-reel-${new Date().toISOString().slice(0, 10)}.mp4`, {
      type: 'video/mp4',
    });
    resultUrl = URL.createObjectURL(resultFile);
    el.video.src = resultUrl;
    el.download.href = resultUrl;
    el.download.download = resultFile.name;
    el.resultMeta.textContent = `${timecode(durationSec)} · ${picks.length} photos · ${audioCodec ? 'with music' : 'silent'} · ${megabytes(blob.size)} · made in ${secs}s`;
    el.video.muted = !audioCodec;
    el.resultNote.textContent = audioCodec
      ? 'The song is in the file. If Instagram mutes it for copyright, re-export silent and pick the song in Instagram instead.'
      : song
        ? `Silent, cut to the beat of ${song.name}. When posting, pick the same song in Instagram's music library and start it at ${timecode(audioStart ?? 0)}.`
        : "No music. Add a track from Instagram's library when you post.";
    el.share.hidden = !(navigator.canShare && navigator.canShare({ files: [resultFile] }));
    el.result.hidden = false;
    el.progress.hidden = true;
  } catch (err) {
    el.progress.hidden = true;
    if ((err as Error).name !== 'AbortError') {
      el.renderError.textContent = `The reel could not be made. ${(err as Error).message}`;
      el.renderError.hidden = false;
    }
  } finally {
    job = null;
    el.make.disabled = false;
    el.cancel.hidden = true;
  }
});

el.cancel.addEventListener('click', () => job?.cancel());

el.share.addEventListener('click', async () => {
  if (!resultFile) return;
  try {
    await navigator.share({ files: [resultFile], title: 'Vacation reel' });
  } catch {
    /* user closed the share sheet */
  }
});
