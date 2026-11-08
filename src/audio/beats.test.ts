import { describe, expect, it } from 'vitest';
import { analyzeBeats } from './beats';

const SR = 24000;

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * Drum pattern: kick on beats 1 & 3, snare on 2 & 4, hi-hat on 8ths, quiet pad.
 * `offset` delays the first beat; `introSec` of near-silence before it.
 */
export function drumLoop(bpm: number, seconds: number, offset = 0.3, seed = 1): { audio: Float32Array; beats: number[] } {
  const r = rng(seed);
  const n = Math.floor(seconds * SR);
  const audio = new Float32Array(n);
  const P = 60 / bpm;
  const beats: number[] = [];
  for (let t = offset; t < seconds - 0.2; t += P) beats.push(t);
  const add = (start: number, len: number, f: (i: number) => number) => {
    const s = Math.floor(start * SR);
    for (let i = 0; i < len && s + i < n; i++) audio[s + i] += f(i);
  };
  beats.forEach((t, i) => {
    if (i % 2 === 0) add(t, SR * 0.15, (k) => 0.9 * Math.sin((2 * Math.PI * 55 * k) / SR) * Math.exp(-k / (SR * 0.05))); // kick
    else add(t, SR * 0.12, (k) => 0.5 * r() * Math.exp(-k / (SR * 0.03))); // snare
    add(t, SR * 0.03, (k) => 0.15 * r() * Math.exp(-k / (SR * 0.006))); // hat on beat
    add(t + P / 2, SR * 0.03, (k) => 0.1 * r() * Math.exp(-k / (SR * 0.006))); // hat off-beat
  });
  for (let i = 0; i < n; i++) audio[i] += 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.01 * r();
  return { audio, beats };
}

function matchRate(found: number[], truth: number[], tol: number) {
  let hit = 0;
  for (const t of truth) if (found.some((f) => Math.abs(f - t) <= tol)) hit++;
  return hit / truth.length;
}

describe('analyzeBeats', () => {
  for (const bpm of [124, 87, 100, 140]) {
    it(`finds tempo and beats at ${bpm} BPM`, () => {
      const { audio, beats } = drumLoop(bpm, 30);
      const a = analyzeBeats(audio, SR);
      expect(Math.abs(a.bpm - bpm) / bpm).toBeLessThan(0.005);
      // Ignore the first 2 s while the tracker settles.
      const truth = beats.filter((t) => t > 2 && t < 28);
      expect(matchRate(a.beats, truth, 0.035)).toBeGreaterThan(0.9);
    });
  }

  it('puts downbeats on the kick', () => {
    const { audio, beats } = drumLoop(124, 30, 0.3);
    const a = analyzeBeats(audio, SR);
    const downs = a.beats.filter((_, i) => i % 4 === a.downbeatPhase).filter((t) => t > 2 && t < 28);
    // Kicks are on even beat indices of the ground truth; every downbeat must land on one.
    const kicks = beats.filter((_, i) => i % 2 === 0);
    expect(downs.length).toBeGreaterThan(5);
    expect(matchRate(kicks, downs, 0.035)).toBeGreaterThan(0.9);
  });

  it('returns no beats for silence', () => {
    expect(analyzeBeats(new Float32Array(SR * 10), SR).beats.length).toBeLessThan(3);
  });
});
