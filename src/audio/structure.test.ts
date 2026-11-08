import { describe, expect, it } from 'vitest';
import { analyzeBeats } from './beats';
import { rankSongParts } from './structure';

const SR = 24000;

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

type Section = { name: string; bars: number; chords: number[][]; full: boolean; gain: number; noise?: boolean };

// MIDI chords (one per bar).
const Am = [57, 60, 64];
const Dm = [50, 57, 62, 65];
const Em = [52, 59, 64, 67];
const F = [53, 57, 60, 65];
const G = [55, 59, 62, 67];
const C = [48, 55, 60, 64];

/**
 * Pop-shaped song at 120 BPM (bar = 2 s). Verse: mellow, sparse drums.
 * Chorus: different chords, full drums, brighter. Every section is "mastered"
 * to the same loudness, except the bridge, which is LOUDER (noise wash) and
 * doesn't repeat: the trap that fooled loudest-window picking.
 */
export function popSong() {
  const verse = { bars: 8, chords: [Am, Dm, Em, Am, Am, Dm, Em, Am], full: false, gain: 1 };
  const chorus = { bars: 8, chords: [F, G, C, Am, F, G, C, Am], full: true, gain: 1 };
  const sections: Section[] = [
    { name: 'intro', bars: 4, chords: [Am, Am, Dm, Dm], full: false, gain: 0.5 },
    { name: 'verse', ...verse },
    { name: 'chorus', ...chorus },
    { name: 'verse', ...verse },
    { name: 'chorus', ...chorus },
    { name: 'bridge', bars: 4, chords: [Dm, Dm, Em, Em], full: true, gain: 1.5, noise: true },
    { name: 'chorus', ...chorus },
    { name: 'outro', bars: 4, chords: [Am, Am, Am, Am], full: false, gain: 0.4 },
  ];
  const bar = 2;
  const beat = 0.5;
  const total = sections.reduce((s, x) => s + x.bars, 0) * bar + 1;
  const audio = new Float32Array(Math.floor(total * SR));
  const r = rng(5);
  const starts: { name: string; t: number }[] = [];
  let t0 = 0.25;

  for (const sec of sections) {
    starts.push({ name: sec.name, t: t0 });
    const s0 = Math.floor(t0 * SR);
    const len = Math.floor(sec.bars * bar * SR);
    const buf = new Float32Array(len);
    for (let b = 0; b < sec.bars; b++) {
      const notes = sec.chords[b];
      for (let i = 0; i < bar * SR; i++) {
        const t = i / SR;
        let v = 0;
        for (const m of notes) {
          const f = 440 * 2 ** ((m - 69) / 12);
          v += Math.sin(2 * Math.PI * f * t);
          if (sec.full) v += 0.5 * Math.sin(4 * Math.PI * f * t) + 0.3 * Math.sin(6 * Math.PI * f * t); // brighter
        }
        buf[b * bar * SR + i] += 0.08 * v;
      }
      for (let q = 0; q < 4; q++) {
        const at = Math.floor((b * bar + q * beat) * SR);
        const kickBeat = sec.full ? q % 2 === 0 : q === 0;
        const snareBeat = sec.full ? q % 2 === 1 : q === 2;
        for (let i = 0; i < 0.15 * SR && at + i < len; i++) {
          if (kickBeat) buf[at + i] += 0.8 * Math.sin((2 * Math.PI * 55 * i) / SR) * Math.exp(-i / (0.05 * SR));
          if (snareBeat) buf[at + i] += 0.4 * r() * Math.exp(-i / (0.03 * SR));
          if (sec.full && i < 0.03 * SR) {
            buf[at + i] += 0.12 * r() * Math.exp(-i / (0.006 * SR));
            const off = at + Math.floor(0.25 * SR) + i;
            if (off < len) buf[off] += 0.1 * r() * Math.exp(-i / (0.006 * SR));
          }
        }
      }
    }
    if (sec.noise) for (let i = 0; i < len; i++) buf[i] += 0.5 * r();
    // "Mastering": every section to the same RMS × gain.
    let s2 = 0;
    for (const v of buf) s2 += v * v;
    const g = (0.2 * sec.gain) / Math.sqrt(s2 / len);
    for (let i = 0; i < len && s0 + i < audio.length; i++) audio[s0 + i] += buf[i] * g;
    t0 += sec.bars * bar;
  }
  return { audio, starts, duration: total };
}

describe('song structure', () => {
  const { audio, starts, duration } = popSong();
  const a = analyzeBeats(audio, SR);
  const span = 34; // 15 photos at 2 beats each, opener/finale doubled

  it('tracks the song at 120 BPM', () => {
    expect(Math.abs(a.bpm - 120)).toBeLessThan(1);
  });

  it('top suggestion starts at a chorus, not the louder bridge', () => {
    const parts = rankSongParts(a.features, a.downbeatPhase, span, duration, a.beats);
    const t = a.beats[parts[0].beat];
    const chorusStarts = starts.filter((s) => s.name === 'chorus').map((s) => s.t);
    expect(Math.min(...chorusStarts.map((c) => Math.abs(c - t)))).toBeLessThan(1.1); // within half a bar
  });

  it('loudest-window picking (old method) lands on the bridge, proving the trap works', () => {
    let best = 0;
    let bestE = -1;
    for (let b = a.downbeatPhase; b + span <= a.beatEnergy.length; b += 4) {
      const e = a.beatEnergy.slice(b, b + 8).reduce((x, y) => x + y, 0);
      if (e > bestE) {
        bestE = e;
        best = b;
      }
    }
    const bridge = starts.find((s) => s.name === 'bridge')!.t;
    expect(Math.abs(a.beats[best] - bridge)).toBeLessThan(8);
  });

  it('suggestions are distinct parts of the song', () => {
    const parts = rankSongParts(a.features, a.downbeatPhase, span, duration, a.beats);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < parts.length; i++) for (let j = 0; j < i; j++) expect(Math.abs(parts[i].beat - parts[j].beat)).toBeGreaterThanOrEqual(16);
  });
});
