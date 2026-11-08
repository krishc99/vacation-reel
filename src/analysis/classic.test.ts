import { describe, expect, it } from 'vitest';
import { bestFrame, checkFace } from './classic';
import { summarize, type Face } from './people';

const face = (x: number, o: Partial<Face> = {}): Face => ({
  box: { x, y: 0.3, w: 0.1, h: 0.12 },
  blinkL: 0.05,
  blinkR: 0.05,
  smile: 0.3,
  jawOpen: 0.05,
  yaw: 3,
  pitch: 0,
  lookDown: 0.1,
  sharpness: 0.6,
  ...o,
});
const frame = (faces: Face[], sharpness = 0.6) => ({ people: summarize(faces, [], 0.6), sharpness });
const trio = (o: Partial<Face>[] = [{}, {}, {}]) => o.map((x, i) => face(0.1 + i * 0.3, x));

describe('checkFace', () => {
  it('fails on each plan rule', () => {
    expect(checkFace(face(0.3)).pass).toBe(true);
    expect(checkFace(face(0.3, { blinkL: 0.7 })).eyesOpen).toBe(false);
    expect(checkFace(face(0.3, { yaw: -40 })).facing).toBe(false);
    expect(checkFace(face(0.3, { lookDown: 0.8 })).notDown).toBe(false);
    expect(checkFace(face(0.3, { sharpness: 0.08 })).sharp).toBe(false);
    expect(checkFace(face(0)).inFrame).toBe(false);
  });
});

describe('bestFrame', () => {
  it('picks the frame where nobody blinks, even if another frame is sharper', () => {
    const r = bestFrame([frame(trio([{}, { blinkR: 0.8 }, {}]), 0.9), frame(trio(), 0.5)]);
    expect(r.index).toBe(1);
    expect(r.ranks[0].issues).toEqual(['1 eyes closed']);
  });
  it('a frame missing someone loses to one where everyone is there', () => {
    const all = frame(trio([{}, { yaw: 35 }, {}]));
    const missingOne = frame([face(0.1), face(0.4)]);
    const r = bestFrame([missingOne, all]);
    expect(r.index).toBe(1);
    expect(r.ranks[0].issues).toContain('1 missing');
  });
  it('when faces tie, more smiling wins', () => {
    const r = bestFrame([frame(trio([{ smile: 0.1 }, { smile: 0.1 }, { smile: 0.1 }])), frame(trio([{ smile: 0.8 }, { smile: 0.7 }, { smile: 0.6 }]))]);
    expect(r.index).toBe(1);
  });
  it('no faces anywhere → leave it to photo quality', () => {
    expect(bestFrame([frame([]), frame([])]).index).toBe(-1);
  });
});
