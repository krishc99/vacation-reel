import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import type { ReelAudio } from '../audio/song';
import type { ReelSettings } from '../types';

/**
 * Thin wrapper over the MP4 encoder so the rest of the renderer only knows
 * "draw to this canvas, then addFrame". Swapping in ffmpeg.wasm or a native
 * encoder (Capacitor) later only touches this file.
 */
export interface FrameEncoder {
  canvas: OffscreenCanvas;
  /** 'aac' when a soundtrack was added, else null. */
  audioCodec: string | null;
  addFrame(timestampSec: number, durationSec: number, keyFrame: boolean): Promise<void>;
  finish(): Promise<ArrayBuffer>;
  cancel(): Promise<void>;
}

export class EncoderUnsupportedError extends Error {}

/**
 * Instagram wants AAC. Native WebCodecs AAC is missing in some browsers
 * (Firefox, Chromium builds without proprietary codecs); then lazy-load
 * Mediabunny's wasm AAC encoder (~1 MB, only downloaded in that case).
 */
async function ensureAac(): Promise<boolean> {
  if (await getFirstEncodableAudioCodec(['aac'])) return true;
  const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
  registerAacEncoder();
  return (await getFirstEncodableAudioCodec(['aac'])) !== null;
}

export async function createEncoder(s: ReelSettings, audio?: ReelAudio): Promise<FrameEncoder> {
  if (typeof VideoEncoder === 'undefined') {
    throw new EncoderUnsupportedError(
      'This browser cannot encode video (WebCodecs is missing). Use Chrome, Edge, or Safari 16.4 or newer.',
    );
  }
  // Instagram expects H.264 in MP4.
  const codec = await getFirstEncodableVideoCodec(['avc'], {
    width: s.width,
    height: s.height,
    bitrate: s.bitrate,
  });
  if (!codec) {
    throw new EncoderUnsupportedError(
      `This browser cannot encode H.264 video at ${s.width}×${s.height}. Try Chrome, Edge, or Safari 16.4 or newer.`,
    );
  }

  const canvas = new OffscreenCanvas(s.width, s.height);
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const source = new CanvasSource(canvas, {
    codec,
    bitrate: s.bitrate,
    keyFrameInterval: 2,
    latencyMode: 'quality',
  });
  output.addVideoTrack(source, { frameRate: s.fps });

  let audioSource: AudioSampleSource | null = null;
  if (audio) {
    if (!(await ensureAac())) throw new EncoderUnsupportedError('This browser cannot encode AAC audio. Untick "Put the song in the video file" to export silent.');
    audioSource = new AudioSampleSource({ codec: 'aac', bitrate: 192_000 });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  // Not awaited here: the muxer interleaves tracks, so the audio write may wait
  // for video packets. It is awaited in finish().
  let audioDone: Promise<void> = Promise.resolve();
  if (audio && audioSource) {
    const src = audioSource;
    const n = audio.left.length;
    const planar = new Float32Array(n * 2);
    planar.set(audio.left, 0);
    planar.set(audio.right, n);
    const sample = new AudioSample({
      data: planar,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate: audio.sampleRate,
      timestamp: 0,
    });
    audioDone = src.add(sample).then(() => {
      sample.close();
      src.close();
    });
  }

  return {
    canvas,
    audioCodec: audio ? 'aac' : null,
    addFrame: (t, d, keyFrame) => source.add(t, d, keyFrame ? { keyFrame: true } : undefined),
    async finish() {
      await audioDone;
      await output.finalize();
      return target.buffer!;
    },
    async cancel() {
      await output.cancel();
    },
  };
}
