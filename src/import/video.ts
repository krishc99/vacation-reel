// Videos: find the best few seconds, and keep a still of it (the "poster") so the
// rest of the app (faces, scenes, scoring, framing) treats the moment like a photo.
// Decoding uses the browser's own video decoder through Mediabunny.
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input, type InputAudioTrack } from 'mediabunny';
import { toGray } from '../analysis/pixels';
import { subjectSharpness } from '../analysis/quality';
import { readVideoMeta, utcToWallClock } from './videoMeta';
import { copiesOf, errorText, unreadable, UNREADABLE_HELP, type PhotoMsg, type SkippedMsg } from './process';

export const VIDEO = {
  /** Length of the moment taken from each longer video, seconds. */
  moment: 3.5,
  /** Videos up to this long are used whole (Krish). */
  wholeUpTo: 6,
  /** Frames looked at per second of video (capped by maxSamples). */
  samplesPerSec: 2,
  maxSamples: 60,
  /** Videos bigger than this are skipped (phones run out of memory). */
  maxBytes: 1.5e9,
};

export interface FrameSample {
  t: number;
  sharp: number;
  motion: number;
  luma: number;
}

/**
 * Best window of `length` seconds: sharp frames, something happening (people
 * moving: camera motion is removed before this), not too dark. Returns its start and the sharpest frame in it (for the poster).
 */
export function bestMoment(samples: FrameSample[], duration: number, length = VIDEO.moment): { start: number; end: number; poster: number } {
  if (duration <= length || samples.length < 2) {
    const best = samples.reduce((a, b) => (b.sharp > a.sharp ? b : a), samples[0] ?? { t: duration / 2, sharp: 0, motion: 0, luma: 0.5 });
    return { start: 0, end: duration, poster: best.t };
  }
  const maxSharp = Math.max(1e-6, ...samples.map((s) => s.sharp));
  const maxMotion = Math.max(1e-6, ...samples.map((s) => s.motion));
  const value = (s: FrameSample) => s.sharp / maxSharp + 0.6 * (s.motion / maxMotion) - (s.luma < 0.15 ? 0.5 : 0);
  let best = { start: 0, score: -Infinity };
  // Windows start on samples; skip the first half second (camera still settling).
  for (const s of samples) {
    const start = Math.min(Math.max(0, s.t), duration - length);
    if (start < 0.5 && duration > length + 1) continue;
    const inside = samples.filter((x) => x.t >= start && x.t <= start + length);
    if (!inside.length) continue;
    // Average quality, plus the single biggest burst of action in the window.
    const score = inside.reduce((a, x) => a + value(x), 0) / inside.length + 0.4 * Math.max(...inside.map((x) => x.motion / maxMotion));
    if (score > best.score) best = { start, score };
  }
  const inside = samples.filter((x) => x.t >= best.start && x.t <= best.start + length);
  const poster = inside.reduce((a, b) => (b.sharp > a.sharp ? b : a), inside[0]).t;
  return { start: best.start, end: best.start + length, poster };
}

// ---- Sound: the loudest moment (cheers, laughter, a splash) -------------------------------

export const SOUND = {
  /** Loudness measured every 0.1 s. */
  step: 0.1,
  /** A peak counts when its loudness is at least this many times the video's usual level… */
  peakOverMedian: 2,
  /** …and at least this loud (RMS, 0..1 ≈ −32 dBFS), so a quiet video's cough doesn't win. */
  minPeak: 0.025,
  /** The cut ends this soon after the loudest point… (Krish: "half a second or one second after the peak") */
  afterMin: 0.5,
  afterMax: 1.0,
  /** …once the burst has died down to this share of its peak, if that's sooner. */
  fallTo: 0.5,
  /** How far the start may move to land in a pause, seconds. */
  snap: 0.6,
};

/** Loudness (RMS of both channels) every SOUND.step seconds over the whole video. */
async function loudness(track: InputAudioTrack, duration: number): Promise<Float32Array> {
  const bins = Math.max(1, Math.ceil(duration / SOUND.step));
  const sum = new Float64Array(bins);
  const count = new Float64Array(bins);
  const sink = new AudioSampleSink(track);
  for await (const smp of sink.samples(0, duration)) {
    const frames = smp.numberOfFrames;
    const chans = Math.min(2, smp.numberOfChannels);
    const sr = smp.sampleRate;
    for (let ch = 0; ch < chans; ch++) {
      const buf = new Float32Array(frames);
      smp.copyTo(buf, { planeIndex: ch, format: 'f32-planar' });
      for (let i = 0; i < frames; i++) {
        const b = Math.floor((smp.timestamp + i / sr) / SOUND.step);
        if (b < 0 || b >= bins) continue;
        sum[b] += buf[i] * buf[i];
        count[b]++;
      }
    }
    smp.close();
  }
  return Float32Array.from(sum, (v, i) => (count[i] ? Math.sqrt(v / count[i]) : 0));
}

/**
 * The moment leading up to the loudest point, if the video has a clear one: it
 * ends 0.5–1 s after the peak (once the cheer dies down), so most of it is the
 * build-up (the jump, the toast). Each end lands in the quietest spot nearby so
 * nobody is cut off mid-word. Null when the sound is flat (wind, chatter, music
 * playing): then the picture decides.
 */
export function soundMoment(env: ArrayLike<number>, duration: number, length = VIDEO.moment): { start: number; end: number; peak: number } | null {
  const n = env.length;
  if (n < 5 || duration <= 0) return null;
  // Smooth over half a second, so one clap or bump doesn't count as the moment.
  const w = Math.max(1, Math.round(0.5 / SOUND.step));
  const smooth = Array.from({ length: n }, (_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) (s += env[j]), c++;
    return s / c;
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  let pk = 0;
  for (let i = 1; i < n; i++) if (smooth[i] > smooth[pk]) pk = i;
  const peakLevel = smooth[pk];
  if (peakLevel < SOUND.minPeak || peakLevel < SOUND.peakOverMedian * Math.max(median, 1e-4)) return null;
  const peak = (pk + 0.5) * SOUND.step;
  if (duration <= length) return { start: 0, end: duration, peak };
  // Quietest bin within ±snap of t (raw loudness: pauses between words are short).
  const quietNear = (t: number, lo: number, hi: number) => {
    const a = Math.max(0, Math.floor(Math.max(lo, t - SOUND.snap) / SOUND.step));
    const b = Math.min(n - 1, Math.ceil(Math.min(hi, t + SOUND.snap) / SOUND.step));
    const at = t / SOUND.step;
    let best = a;
    for (let i = a; i <= b; i++) {
      const quieter = env[i] < env[best] - 1e-6;
      const tie = Math.abs(env[i] - env[best]) <= 1e-6 && Math.abs(i - at) < Math.abs(best - at);
      if (quieter || tie) best = i;
    }
    return Math.min(hi, Math.max(lo, best * SOUND.step));
  };
  // End: shortly after the peak, when the burst dies down (0.5–1 s after it), in the
  // quietest spot there. Most of the moment is the build-up before the peak.
  let fall = pk;
  while (fall + 1 < n && smooth[fall + 1] >= SOUND.fallTo * peakLevel) fall++;
  const lo = Math.min(duration, peak + SOUND.afterMin);
  const hi = Math.min(duration, peak + SOUND.afterMax);
  let end = quietNear(Math.min(hi, Math.max(lo, (fall + 1) * SOUND.step + 0.2)), lo, hi);
  let start = Math.max(0, end - length);
  start = quietNear(start, 0, Math.max(0, peak - 1));
  if (end - start < length - SOUND.snap) end = Math.min(duration, Math.max(end, start + length - SOUND.snap));
  return { start, end, peak };
}

/**
 * Movement of the people/things in the frame, not the camera: the frame
 * difference after the best small shift between the two frames (a pan or a
 * shaky hand mostly lines up again; a jump, a wave or dancing doesn't).
 */
export function subjectMotion(prev: Float32Array, cur: Float32Array, w: number, h: number): number {
  let best = Infinity;
  const r = Math.round(w * 0.08); // up to 8% of the width
  const step = Math.max(1, Math.round(r / 4));
  for (let dy = -r; dy <= r; dy += step)
    for (let dx = -r; dx <= r; dx += step) {
      let sum = 0;
      let cnt = 0;
      for (let y = r; y < h - r; y += 2)
        for (let x = r; x < w - r; x += 2) {
          sum += Math.abs(cur[y * w + x] - prev[(y + dy) * w + (x + dx)]);
          cnt++;
        }
      if (cnt && sum / cnt < best) best = sum / cnt;
    }
  return Number.isFinite(best) ? best : 0;
}

/** Whole video if short; else around the loudest point; else the sharpest, liveliest stretch. */
export function chooseMoment(samples: FrameSample[], env: ArrayLike<number> | null, duration: number): { start: number; end: number; poster: number; by: 'whole' | 'sound' | 'picture' } {
  const sharpestIn = (a: number, b: number) => {
    const inside = samples.filter((x) => x.t >= a && x.t <= b);
    return inside.length ? inside.reduce((p, q) => (q.sharp > p.sharp ? q : p)).t : (a + b) / 2;
  };
  if (duration <= VIDEO.wholeUpTo) return { start: 0, end: duration, poster: sharpestIn(0, duration), by: 'whole' };
  const loud = env ? soundMoment(env, duration) : null;
  if (loud) return { start: loud.start, end: loud.end, poster: sharpestIn(loud.start, loud.end), by: 'sound' };
  return { ...bestMoment(samples, duration), by: 'picture' };
}

export async function processVideo(id: string, file: File): Promise<PhotoMsg | SkippedMsg> {
  if (file.size > VIDEO.maxBytes) return { type: 'skipped', id, name: file.name, reason: 'Video is over 1.5 GB; trim it on your phone first.' };
  let input: Input | null = null;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { type: 'skipped', id, name: file.name, reason: 'No video picture in this file.' };
    if (!(await track.canDecode()))
      return {
        type: 'skipped',
        id,
        name: file.name,
        reason: `This browser can't play this video's format (${track.codec ?? 'unknown'}; iPhone videos are often HEVC). Try Chrome or Safari.`,
      };
    const duration = await input.computeDuration();
    const audio = await input.getPrimaryAudioTrack();
    const tags = await input.getMetadataTags().catch(() => ({}) as { date?: Date });

    // Look at small frames across the video: sharpness, motion, brightness.
    const n = Math.max(4, Math.min(VIDEO.maxSamples, Math.round(duration * VIDEO.samplesPerSec)));
    const times = Array.from({ length: n }, (_, i) => ((i + 0.5) * duration) / n);
    const small = new CanvasSink(track, { width: 160, poolSize: 2 });
    const samples: FrameSample[] = [];
    let prev: Float32Array | null = null;
    for await (const wc of small.canvasesAtTimestamps(times)) {
      if (!wc) continue;
      const c = wc.canvas as OffscreenCanvas;
      const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      const g = toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      let luma = 0;
      for (let i = 0; i < g.data.length; i++) luma += g.data[i];
      // Movement in the scene (camera motion removed): jumps, waves, dancing.
      const motion = prev && prev.length === g.data.length ? subjectMotion(prev, g.data, c.width, c.height) : 0;
      samples.push({ t: wc.timestamp, sharp: subjectSharpness(g), motion, luma: luma / g.data.length / 255 });
      prev = g.data.slice();
    }
    // Short video: all of it. Longer: a clear sound peak (cheer, laughter, splash)
    // picks the moment; otherwise the picture does (sharp, with the most action).
    let env: Float32Array | null = null;
    if (duration > VIDEO.wholeUpTo && audio && (await audio.canDecode())) {
      try {
        env = await loudness(audio, duration);
      } catch {
        env = null; // sound unreadable: the picture decides
      }
    }
    const m = chooseMoment(samples, env, duration);

    // The poster: the sharpest frame of the moment, at render size.
    const long = Math.max(track.displayWidth, track.displayHeight);
    const big = new CanvasSink(track, long > 2560 ? (track.displayWidth >= track.displayHeight ? { width: 2560 } : { height: 2560 }) : {});
    const frame = await big.getCanvas(m.poster);
    if (!frame) throw new Error('could not read a frame');
    // When and where: the container's own dates and location (iPhone local time with
    // zone; Android UTC, corrected to the trip's clock after import), else the tag.
    const meta = await readVideoMeta(file);
    const tagDate = (tags as { date?: Date }).date;
    const takenAt = meta.wallClock ?? (meta.utc !== null ? utcToWallClock(meta.utc, null) : tagDate && !isNaN(tagDate.getTime()) ? tagDate.getTime() : null);
    const msg = await copiesOf(id, frame.canvas as OffscreenCanvas, { takenAt, lat: meta.lat, lon: meta.lon }, file.lastModified);
    const utc = meta.wallClock === null && meta.utc !== null ? meta.utc : undefined;
    return { ...msg, video: { file, duration, start: m.start, end: m.end, hasAudio: !!audio, utc } };
  } catch (err) {
    const reason = unreadable(err) ? UNREADABLE_HELP : `Could not read this video (${errorText(err)})`;
    return { type: 'skipped', id, name: file.name, reason };
  } finally {
    input?.dispose?.();
  }
}
