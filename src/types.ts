// Shared types used across import / selection / render modules and the workers.
import type { DHash } from './analysis/dhash';
import type { QualityStats } from './analysis/quality';
import type { BeatAnalysis } from './audio/beats';
import type { ReelAudio } from './audio/song';

/** One imported photo, after EXIF read and thumbnail generation. */
export interface Photo {
  id: string;
  file: File;
  name: string;
  /** Capture time in ms since epoch. EXIF DateTimeOriginal if present, else file lastModified. */
  takenAt: number;
  timeSource: 'exif' | 'file';
  lat: number | null;
  lon: number | null;
  /** Decoded pixel size after EXIF orientation is applied. */
  width: number;
  height: number;
  /** Object URL of a small JPEG preview (~256px long edge). */
  thumbUrl: string;
  /** 640px long-edge JPEG kept for detection (faces/pose, Milestone 4+). */
  detail: Blob;
  /** ≤2560px JPEG used for rendering. The original File may become unreadable (Android). */
  master: Blob;
  stats: QualityStats;
  dhash: DHash;
}

export interface ReelSettings {
  width: number;
  height: number;
  fps: number;
  secondsPerPhoto: number;
  /** Upper bound on photos so the reel stays within maxSeconds. */
  maxSeconds: number;
  minSeconds: number;
  bitrate: number;
}

export type Shape = 'vertical' | 'horizontal';

export const SHAPE_SIZE: Record<Shape, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
};

export const DEFAULT_SETTINGS: ReelSettings = {
  width: 1080,
  height: 1920,
  fps: 30,
  secondsPerPhoto: 1.5,
  maxSeconds: 30,
  minSeconds: 15,
  bitrate: 10_000_000,
};

/** One photo's slot on the reel timeline (seconds). */
export interface Clip {
  photoId: string;
  start: number;
  duration: number;
}

// ---- Worker protocols -------------------------------------------------------

export type ImportRequest = { type: 'photo'; id: string; file: File };

export type ImportResponse =
  | {
      type: 'photo';
      id: string;
      takenAt: number;
      timeSource: 'exif' | 'file';
      lat: number | null;
      lon: number | null;
      width: number;
      height: number;
      thumb: Blob;
      detail: Blob;
      master: Blob;
      stats: QualityStats;
      dhash: DHash;
    }
  | { type: 'skipped'; id: string; name: string; reason: string }
  | { type: 'ready' }
  | { type: 'fatal'; message: string };

export type RenderRequest = {
  type: 'render';
  clips: Clip[];
  /** Render copies (Photo.master), keyed by photo id. */
  images: Record<string, Blob>;
  settings: ReelSettings;
  /** Song excerpt aligned to t = 0; absent = silent video. */
  audio?: ReelAudio;
};

export type AudioAnalysisRequest = { mono: Float32Array; sampleRate: number };
export type AudioAnalysisResponse = { type: 'result'; analysis: BeatAnalysis } | { type: 'error'; message: string };

export type RenderResponse =
  | { type: 'progress'; done: number; total: number; stage: string }
  | { type: 'result'; buffer: ArrayBuffer; mimeType: string; durationSec: number; audioCodec: string | null }
  | { type: 'error'; message: string };
