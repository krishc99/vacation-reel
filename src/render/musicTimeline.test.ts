import { describe, expect, it } from 'vitest';
import type { BeatAnalysis } from '../audio/beats';
import { DEFAULT_SETTINGS } from '../types';
import { maxPhotosForMusic, planMusicTimeline } from './musicTimeline';

function grid(bpm: number, seconds: number, phase = 1, loudFrom = 60, loudTo = 90): BeatAnalysis {
  const P = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0.2; t < seconds; t += P) beats.push(t);
  const beatEnergy = beats.slice(1).map((t) => (t >= loudFrom && t < loudTo ? 1 : 0.2));
  const intensity = beats.slice(1).map((t) => (t >= loudFrom && t < loudTo ? 1 : -1));
  const chroma = intensity.map(() => [1, ...new Array(11).fill(0)]);
  const novelty = beats.map(() => 0);
  return { bpm, beats, downbeatPhase: phase, beatEnergy, duration: seconds, features: { chroma, intensity, novelty } };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

describe('planMusicTimeline', () => {
  it('cuts only on detected beats, starts on a downbeat, stays within 15–30 s', () => {
    for (const bpm of [70, 87, 100, 124, 140, 174]) {
      const a = grid(bpm, 180);
      const n = Math.min(18, maxPhotosForMusic(a, DEFAULT_SETTINGS, 'best'));
      const plan = planMusicTimeline(ids(n), a, DEFAULT_SETTINGS, 'best');
      const startIdx = a.beats.indexOf(plan.audioStart);
      expect(startIdx % 4).toBe(a.downbeatPhase);
      for (const c of plan.clips) {
        const abs = plan.audioStart + c.start;
        expect(a.beats.some((b) => Math.abs(b - abs) < 1e-9)).toBe(true);
        expect(c.duration).toBeGreaterThanOrEqual(0.5 - 1e-6);
      }
      // Middle photos 0.5–1.5 s; opener/finale hold longer.
      for (const c of plan.clips.slice(1, -1)) expect(c.duration).toBeLessThanOrEqual(1.5 + 1e-6);
      expect(plan.clips[0].duration).toBeGreaterThan(plan.clips[1].duration);
      // The highlight (chorus) lands exactly on the cut to photo 2, after a 1+ bar lead-in.
      if (plan.highlight !== null && plan.highlight > plan.audioStart) {
        expect(Math.abs(plan.audioStart + plan.clips[1].start - plan.highlight)).toBeLessThan(1e-9);
        expect(plan.highlight - plan.audioStart).toBeGreaterThanOrEqual(4 * (60 / bpm) - 1e-6);
      }
      expect(plan.duration).toBeLessThanOrEqual(30 + 1e-6);
      expect(plan.duration).toBeGreaterThanOrEqual(15 - 1e-6);
    }
  });

  it('"best" starts in the most intense section; "start" at the first downbeat', () => {
    const a = grid(120, 180, 1, 60, 100);
    const best = planMusicTimeline(ids(15), a, DEFAULT_SETTINGS, 'best');
    expect(best.highlight!).toBeGreaterThanOrEqual(59);
    expect(best.highlight!).toBeLessThan(75);
    // Lead-in: ~3 s → 2 bars at 120 BPM = 4 s before the highlight.
    expect(best.highlight! - best.audioStart).toBeCloseTo(4, 6);
    const start = planMusicTimeline(ids(15), a, DEFAULT_SETTINGS, 'start');
    expect(start.audioStart).toBe(a.beats[1]);
  });

  it('caps photos so the reel fits 30 s', () => {
    const a = grid(124, 180);
    const max = maxPhotosForMusic(a, DEFAULT_SETTINGS, 'best');
    expect(planMusicTimeline(ids(max), a, DEFAULT_SETTINGS, 'best').duration).toBeLessThanOrEqual(30);
  });

  it('extends past the last beat when the song is short', () => {
    const a = grid(120, 8);
    const plan = planMusicTimeline(ids(12), a, DEFAULT_SETTINGS, 'start');
    expect(plan.clips).toHaveLength(12);
    expect(plan.duration).toBeGreaterThan(8);
  });
});
