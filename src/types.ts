// Shared types used across import / selection / render modules and the workers.
import type { DHash } from './analysis/dhash';
import type { People } from './analysis/people';
import type { QualityStats } from './analysis/quality';
import type { Scene } from './analysis/scenes';
import type { BeatAnalysis } from './audio/beats';
import type { ReelAudio } from './audio/song';

/** One imported photo, after EXIF read and thumbnail generation. */
export interface Photo {
  id: string;
  /** The picked file is not kept: the copies below are all the app needs after import (saves memory). */
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
  /** Faces and bodies (filled in after import by the vision worker; absent until then). */
  people?: People;
  /** Scene type from CLIP (filled in after import by the scene worker). */
  scene?: Scene;
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
  /** How this photo arrives (M8): hard cut on a downbeat, short crossfade otherwise. Default cut. */
  transition?: 'cut' | 'fade';
}

/** On-screen text (M8), e.g. "DAY 2" over "Lisbon". */
export interface Caption {
  /** Small line above (may be empty). */
  top: string;
  main: string;
  start: number;
  end: number;
}

/** Look of the reel (M8). */
export interface ReelStyle {
  /** Slow zoom toward the people (Ken Burns). */
  motion: boolean;
  captions: Caption[];
  look: import('./render/looks').Look;
  /** Reel times of the big musical moment (chorus hit): flash + sparkles. */
  accents: number[];
  /** Per photo id: film date stamp ("6 01 '26") and scrapbook note ("3 June" / caption). */
  stamps: Record<string, string>;
  notes: Record<string, string>;
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
  /** People to keep in frame (normalized boxes), keyed by photo id. */
  subjects: Record<string, import('./render/crop').Subject[]>;
  settings: ReelSettings;
  style: ReelStyle;
  /** Song excerpt aligned to t = 0; absent = silent video. */
  audio?: ReelAudio;
};

export type AudioAnalysisRequest = { mono: Float32Array; sampleRate: number };
export type AudioAnalysisResponse = { type: 'result'; analysis: BeatAnalysis } | { type: 'error'; message: string };

export type RenderResponse =
  | { type: 'progress'; done: number; total: number; stage: string }
  | { type: 'result'; buffer: ArrayBuffer; mimeType: string; durationSec: number; audioCodec: string | null }
  | { type: 'error'; message: string };

export type VisionRequest =
  | { type: 'init'; base: string }
  | { type: 'photo'; id: string; detail: Blob; master: Blob; noise: number };

export type VisionResponse =
  | { type: 'ready'; warnings: string[] }
  | { type: 'fatal'; message: string }
  | { type: 'people'; id: string; people: People }
  | { type: 'failed'; id: string; message: string };

export type SceneRequest = { type: 'init'; base: string } | { type: 'photo'; id: string; detail: Blob };

export type SceneResponse =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'scene'; id: string; scene: Scene }
  | { type: 'failed'; id: string; message: string };
