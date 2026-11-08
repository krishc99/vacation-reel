import type { AudioAnalysisRequest, AudioAnalysisResponse } from '../types';
import AudioWorker from '../workers/audio.worker?worker';
import type { BeatAnalysis } from './beats';

export const SONG_RATE = 48000;
const ANALYSIS_RATE = SONG_RATE / 2;

export interface Song {
  name: string;
  /** Stereo PCM at SONG_RATE. */
  left: Float32Array;
  right: Float32Array;
  duration: number;
  beats: BeatAnalysis;
}

/** Decode (resampled to 48 kHz stereo by the browser), then beat-track in a worker. */
export async function loadSong(file: File): Promise<Song> {
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctx(2, SONG_RATE, SONG_RATE);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('This file could not be read as audio. Try an MP3, M4A or WAV.');
  }
  const left = buf.getChannelData(0).slice();
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : left;

  // Mono at 24 kHz for analysis (2:1 average; plenty for onset detection).
  const mono = new Float32Array(Math.floor(left.length / 2));
  for (let i = 0; i < mono.length; i++) mono[i] = (left[2 * i] + left[2 * i + 1] + right[2 * i] + right[2 * i + 1]) / 4;

  const beats = await new Promise<BeatAnalysis>((resolve, reject) => {
    const w = new AudioWorker();
    w.onmessage = (e: MessageEvent<AudioAnalysisResponse>) => {
      w.terminate();
      if (e.data.type === 'result') resolve(e.data.analysis);
      else reject(new Error(e.data.message));
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      reject(new Error(`Beat detection stopped: ${e.message || 'no message'}`));
    };
    const req: AudioAnalysisRequest = { mono, sampleRate: ANALYSIS_RATE };
    w.postMessage(req, [mono.buffer]);
  });
  if (beats.beats.length < 8) throw new Error('No steady beat found in this song. Try another track.');
  return { name: file.name, left, right, duration: buf.duration, beats };
}

/**
 * AAC encoders prepend ~1024 samples of silence ("priming") and Mediabunny
 * writes no edit list to hide it, so players would hear the music ~21 ms late
 * against the cuts. Measured on exports: +24–31 ms before this fix. Starting
 * the excerpt this much later puts beats back on the cuts.
 */
export const AAC_PRIMING_SEC = 1024 / SONG_RATE;

/** Song excerpt for the reel: [start, start+duration), short fade-in, 1 s fade-out. */
export function excerpt(song: Song, start: number, duration: number): ReelAudio {
  const n = Math.round(duration * SONG_RATE);
  const s0 = Math.round((start + AAC_PRIMING_SEC) * SONG_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const fadeIn = Math.round(0.02 * SONG_RATE);
  const fadeOut = Math.min(n, Math.round(1.0 * SONG_RATE));
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j < 0 || j >= song.left.length) continue;
    let g = 1;
    if (i < fadeIn) g = i / fadeIn;
    if (i > n - fadeOut) g *= Math.max(0, (n - i) / fadeOut);
    left[i] = song.left[j] * g;
    right[i] = song.right[j] * g;
  }
  return { left, right, sampleRate: SONG_RATE };
}

export interface ReelAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}
