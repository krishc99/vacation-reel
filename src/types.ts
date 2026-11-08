// Shared types used across import / selection / render modules and the workers.

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

export type ImportRequest = { type: 'import'; files: { id: string; file: File }[] };

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
    }
  | { type: 'skipped'; id: string; name: string; reason: string }
  | { type: 'done' };

export type RenderRequest = {
  type: 'render';
  clips: Clip[];
  files: Record<string, File>;
  settings: ReelSettings;
};

export type RenderResponse =
  | { type: 'progress'; done: number; total: number; stage: string }
  | { type: 'result'; buffer: ArrayBuffer; mimeType: string; durationSec: number }
  | { type: 'error'; message: string };
