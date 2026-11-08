import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import type { ReelSettings } from '../types';

/**
 * Thin wrapper over the MP4 encoder so the rest of the renderer only knows
 * "draw to this canvas, then addFrame". Swapping in ffmpeg.wasm or a native
 * encoder (Capacitor) later only touches this file.
 */
export interface FrameEncoder {
  canvas: OffscreenCanvas;
  addFrame(timestampSec: number, durationSec: number, keyFrame: boolean): Promise<void>;
  finish(): Promise<ArrayBuffer>;
  cancel(): Promise<void>;
}

export class EncoderUnsupportedError extends Error {}

export async function createEncoder(s: ReelSettings): Promise<FrameEncoder> {
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
  await output.start();

  return {
    canvas,
    addFrame: (t, d, keyFrame) => source.add(t, d, keyFrame ? { keyFrame: true } : undefined),
    async finish() {
      await output.finalize();
      return target.buffer!;
    },
    async cancel() {
      await output.cancel();
    },
  };
}
