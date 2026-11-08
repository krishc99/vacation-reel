import './style.css';
import { importPhotos } from './import/importer';
import { sortByTime } from './import/sort';
import { renderReel, type RenderJob } from './render/renderer';
import { buildTimeline, timelineDuration } from './render/timeline';
import { selectPhotos } from './selection';
import { DEFAULT_SETTINGS, SHAPE_SIZE, type Photo, type ReelSettings, type Shape } from './types';
import { megabytes, shotTime, timecode } from './ui/format';

let settings: ReelSettings = { ...DEFAULT_SETTINGS };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  unsupported: $('unsupported'),
  spec: $('spec'),
  drop: $<HTMLLabelElement>('drop'),
  fileInput: $<HTMLInputElement>('file-input'),
  importStatus: $('import-status'),
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
};

let photos: Photo[] = [];
let job: RenderJob | null = null;
let resultUrl: string | null = null;
let resultFile: File | null = null;

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
  try {
    const { photos: added, skipped } = await importPhotos(files, (done, total) => {
      el.importStatus.textContent = `Reading ${done} of ${total}…`;
    });
    photos = sortByTime([...photos, ...added]);
    el.importStatus.textContent = `${added.length} photo${added.length === 1 ? '' : 's'} added.`;
    showSkipped(skipped);
    clearResult();
    renderGrid();
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
['dragleave', 'drop'].forEach((t) =>
  el.drop.addEventListener(t, () => el.drop.classList.remove('is-over')),
);
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});

el.clear.addEventListener('click', () => {
  photos.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
  photos = [];
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
}
document.querySelectorAll<HTMLInputElement>('input[name="shape"]').forEach((r) =>
  r.addEventListener('change', () => r.checked && setShape(r.value as Shape)),
);
setShape((document.querySelector<HTMLInputElement>('input[name="shape"]:checked')?.value as Shape) ?? 'vertical');

// ---- Order grid ----------------------------------------------------------------

function renderGrid() {
  const has = photos.length > 0;
  el.orderSection.hidden = !has;
  el.makeSection.hidden = !has;
  if (!has) return el.grid.replaceChildren();

  const { picks, droppedForLength } = selectPhotos(photos, settings);
  const clips = buildTimeline(picks.map((p) => p.id), settings);
  const startById = new Map(clips.map((c) => [c.photoId, c.start]));
  const duration = timelineDuration(clips);

  let summary = `${picks.length} photos · ${timecode(duration)} at ${settings.secondsPerPhoto}s each, in the order they were taken.`;
  if (droppedForLength > 0) {
    summary += ` ${droppedForLength} faded photos are left out to keep the reel under ${settings.maxSeconds}s; the rest are spread evenly across the trip.`;
  } else if (duration < settings.minSeconds) {
    const need = Math.ceil(settings.minSeconds / settings.secondsPerPhoto) - picks.length;
    summary += ` Add ${need} more for a ${settings.minSeconds}s reel.`;
  }
  const noExif = photos.filter((p) => p.timeSource === 'file').length;
  if (noExif) summary += ` ${noExif} had no capture date, so their file date was used.`;
  el.orderSummary.textContent = summary;

  el.grid.replaceChildren(
    ...photos.map((p) => {
      const li = document.createElement('li');
      const start = startById.get(p.id);
      li.className = start === undefined ? 'tile is-out' : 'tile';
      const img = document.createElement('img');
      img.src = p.thumbUrl;
      img.alt = p.name;
      img.loading = 'lazy';
      const tc = document.createElement('span');
      tc.className = 'tile__tc';
      tc.textContent = start === undefined ? 'not used' : timecode(start);
      const cap = document.createElement('span');
      cap.className = 'tile__cap';
      cap.textContent = shotTime(p.takenAt) + (p.timeSource === 'file' ? ' *' : '');
      cap.title = p.timeSource === 'file' ? 'No capture date; using file date' : p.name;
      li.append(img, tc, cap);
      return li;
    }),
  );
}

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
  const { picks } = selectPhotos(photos, settings);
  if (!picks.length) return;
  clearResult();
  const clips = buildTimeline(picks.map((p) => p.id), settings);

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
  });

  try {
    const { blob, durationSec } = await job.promise;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    resultFile = new File([blob], `vacation-reel-${new Date().toISOString().slice(0, 10)}.mp4`, {
      type: 'video/mp4',
    });
    resultUrl = URL.createObjectURL(resultFile);
    el.video.src = resultUrl;
    el.download.href = resultUrl;
    el.download.download = resultFile.name;
    el.resultMeta.textContent = `${timecode(durationSec)} · ${picks.length} photos · ${megabytes(blob.size)} · made in ${secs}s`;
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
