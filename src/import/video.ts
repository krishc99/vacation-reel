// Videos: find the best few seconds, and keep a still of it (the "poster") so the
// rest of the app (faces, scenes, scoring, framing) treats the moment like a photo.
// Decoding uses the browser's own video decoder through Mediabunny.
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { toGray } from '../analysis/pixels';
import { subjectSharpness } from '../analysis/quality';
import { copiesOf, errorText, unreadable, UNREADABLE_HELP, type PhotoMsg, type SkippedMsg } from './process';

export const VIDEO = {
  /** Length of the moment taken from each video, seconds (shorter videos: all of it). */
  moment: 3.5,
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
 * Best window of `length` seconds: sharp frames, something happening (motion),
 * not too dark. Returns its start and the sharpest frame in it (for the poster).
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
    const score = inside.reduce((a, x) => a + value(x), 0) / inside.length;
    if (score > best.score) best = { start, score };
  }
  const inside = samples.filter((x) => x.t >= best.start && x.t <= best.start + length);
  const poster = inside.reduce((a, b) => (b.sharp > a.sharp ? b : a), inside[0]).t;
  return { start: best.start, end: best.start + length, poster };
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
      let motion = 0;
      let luma = 0;
      for (let i = 0; i < g.data.length; i++) {
        luma += g.data[i];
        if (prev && prev.length === g.data.length) motion += Math.abs(g.data[i] - prev[i]);
      }
      samples.push({ t: wc.timestamp, sharp: subjectSharpness(g), motion: prev ? motion / g.data.length : 0, luma: luma / g.data.length / 255 });
      prev = g.data.slice();
    }
    const m = bestMoment(samples, duration);

    // The poster: the sharpest frame of the moment, at render size.
    const long = Math.max(track.displayWidth, track.displayHeight);
    const big = new CanvasSink(track, long > 2560 ? (track.displayWidth >= track.displayHeight ? { width: 2560 } : { height: 2560 }) : {});
    const frame = await big.getCanvas(m.poster);
    if (!frame) throw new Error('could not read a frame');
    const date = (tags as { date?: Date }).date;
    const msg = await copiesOf(id, frame.canvas as OffscreenCanvas, { takenAt: date && !isNaN(date.getTime()) ? date.getTime() : null, lat: null, lon: null }, file.lastModified);
    return { ...msg, video: { file, duration, start: m.start, end: m.end, hasAudio: !!audio } };
  } catch (err) {
    const reason = unreadable(err) ? UNREADABLE_HELP : `Could not read this video (${errorText(err)})`;
    return { type: 'skipped', id, name: file.name, reason };
  } finally {
    input?.dispose?.();
  }
}
