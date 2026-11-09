// Shared types used across import / selection / render modules and the workers.
import type { DHash } from './analysis/dhash';
import type { People } from './analysis/people';
import type { QualityStats } from './analysis/quality';
import type { Scene } from './analysis/scenes';
import type { BeatAnalysis } from './audio/beats';
import type { ReelAudio } from './audio/song';

/** One imported photo, after EXIF read and thumbnail generation. */
/** A video in the album: the best few seconds are used like a photo (poster = detail/master). */
export interface VideoInfo {
  /** The video file itself (kept in memory; decoded again at export). */
  file: Blob;
  /** Whole video length, seconds. */
  duration: number;
  /** The chosen moment, seconds into the video. */
  start: number;
  end: number;
  hasAudio: boolean;
}

export interface Photo {
  id: string;
  /** Present for videos. */
  video?: VideoInfo;
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
  /** "All the best": every photo that survives the checks, as long as that takes (up to maxSeconds). */
  takeAll?: boolean;
}

export type ReelLength = '30' | '60' | '90' | 'all';

/** Instagram allows reels up to 3 minutes. Longer reels get a lower bitrate so the file stays phone-sized. */
export const LENGTHS: Record<ReelLength, { maxSeconds: number; bitrate: number; takeAll: boolean }> = {
  '30': { maxSeconds: 30, bitrate: 10_000_000, takeAll: false },
  '60': { maxSeconds: 60, bitrate: 8_000_000, takeAll: false },
  '90': { maxSeconds: 90, bitrate: 6_000_000, takeAll: false },
  all: { maxSeconds: 180, bitrate: 5_000_000, takeAll: true },
};

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
  /** Per photo id: film date stamp ("6 01 '26"); booth strip label ("Day 2 · Sintra" / "3 June"). */
  stamps: Record<string, string>;
  notes: Record<string, string>;
  /** Per photo id: magazine cover title (place, or Day N, or month) and issue line ("NO. 02 — JUNE 2026"). */
  titles: Record<string, string>;
  kickers: Record<string, string>;
  /** Per photo id: width / height, so frames can match each photo's shape. */
  aspects?: Record<string, number>;
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
      video?: VideoInfo;
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
  /** Song excerpt aligned to t = 0; absent = silent video (or the videos' own sound, see videoSound). */
  audio?: ReelAudio;
  /** Video clips, keyed by photo id. */
  videos?: Record<string, RenderVideo>;
  /** No song: use the videos' own sound. */
  videoSound?: boolean;
};

export interface RenderVideo {
  file: Blob;
  start: number;
  end: number;
  hasAudio: boolean;
}

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
