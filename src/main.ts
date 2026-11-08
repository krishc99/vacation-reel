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
import { importPhotos } from './import/importer';
import { sortByTime } from './import/sort';
import { renderReel, type RenderJob } from './render/renderer';
import { buildTimeline, timelineDuration } from './render/timeline';
import { selectPhotos } from './selection';
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
let analysis: AlbumAnalysis | null = null;
let overrides: Overrides = emptyOverrides();
let job: RenderJob | null = null;
let resultUrl: string | null = null;
let resultFile: File | null = null;

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

el.clear.addEventListener('click', () => {
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
}

function currentPlan(): Plan {
  if (!analysis) return { picks: [], clips: [], droppedForLength: 0 };
  const byId = new Map(photos.map((p) => [p.id, p]));
  const candidates = candidateIds(analysis, overrides).map((id) => byId.get(id)!);
  const { picks, droppedForLength } = selectPhotos(candidates, settings);
  return { picks, clips: buildTimeline(picks.map((p) => p.id), settings), droppedForLength };
}

// ---- Grid ----------------------------------------------------------------------

const REASON_LABEL: Record<Reason, string> = {
  blurry: 'blurry',
  dark: 'too dark',
  bright: 'too bright',
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
  if (!has) return el.grid.replaceChildren();
  const a = analysis!;

  const plan = currentPlan();
  const startById = new Map(plan.clips.map((c) => [c.photoId, c.start]));
  const duration = timelineDuration(plan.clips);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const states = new Map(photos.map((p) => [p.id, tileState(p.id, a, overrides)]));
  const count = (s: string) => [...states.values()].filter((x) => x === s).length;

  const parts = [
    `${photos.length} photos → ${a.bursts.length} moments`,
    count('rejected') ? `${count('rejected')} set aside for quality` : '',
    `${plan.picks.length} in the reel · ${timecode(duration)}`,
  ].filter(Boolean);
  let summary = parts.join(' · ') + '.';
  if (plan.droppedForLength > 0) {
    summary += ` ${plan.droppedForLength} more left out to stay under ${settings.maxSeconds}s, spread evenly across the trip.`;
  } else if (duration < settings.minSeconds && plan.picks.length) {
    const need = Math.ceil(settings.minSeconds / settings.secondsPerPhoto) - plan.picks.length;
    summary += ` Add ${need} more for a ${settings.minSeconds}s reel.`;
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

  const img = document.createElement('img');
  img.src = p.thumbUrl;
  img.alt = p.name;
  img.loading = 'lazy';

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
  btn.title = `${p.name} · ${shotTimeFull(p.takenAt)}.${why} ${action}.${note}`;
  btn.setAttribute('aria-label', `${p.name}, ${label}. ${action}.`);
  btn.append(img, tc, cap);
  return btn;
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
  const { picks, clips } = currentPlan();
  if (!picks.length) return;
  clearResult();

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
