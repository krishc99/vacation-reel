import { describe, expect, it } from 'vitest';
import { booth, boothGroups, filmStrip, flashAt, leakAt, LOOKS, magazine, punchAt, splitLayout, splitPages, stampText, stripPosition } from './looks';

describe('looks', () => {
  it('punch and flash fade out after the beat', () => {
    expect(punchAt(0)).toBeCloseTo(1 + LOOKS.punch);
    expect(punchAt(LOOKS.punchSec)).toBe(1);
    expect(flashAt(0)).toBeCloseTo(LOOKS.flash);
    expect(flashAt(1)).toBe(0);
  });
  it('light leaks flare on cuts', () => {
    expect(leakAt(2, [2])).toBeCloseTo(LOOKS.leakBase + LOOKS.leakPeak);
    expect(leakAt(3, [2])).toBeCloseTo(LOOKS.leakBase, 2);
  });
  it('film strip lands each frame exactly on its beat', () => {
    const starts = [0, 3, 4, 5];
    expect(stripPosition(starts, 1)).toBe(0);
    expect(stripPosition(starts, 3)).toBeCloseTo(1);
    expect(stripPosition(starts, 3.5)).toBeCloseTo(1);
    expect(stripPosition(starts, 4 - LOOKS.slideSec / 2)).toBeGreaterThan(1);
    for (const [W, H] of [[1080, 1920], [1920, 1080]]) {
      const f = filmStrip(W, H);
      expect(f.cross).toBeLessThan(f.vertical ? W : H);
      expect(f.pitch).toBeGreaterThan(f.vertical ? f.frame.h : f.frame.w);
    }
  });
  it('booth: opener and finale full screen, strips of 3 between, strip fits the frame', () => {
    const g = boothGroups(9);
    expect(g[0]).toBeNull();
    expect(g[8]).toBeNull();
    expect(g.slice(1, 7).map((x) => x && `${x.strip}.${x.cell}`)).toEqual(['0.0', '0.1', '0.2', '1.0', '1.1', '1.2']);
    expect(g[7]).toBeNull(); // leftover → full screen
    for (const [W, H] of [[1080, 1920], [1920, 1080]]) {
      const b = booth(W, H);
      expect(b.w).toBeLessThan(W);
      expect(b.h).toBeLessThan(H);
    }
  });
  it('magazine photo overlaps the title and stays on screen', () => {
    const m = magazine(1080, 1920);
    expect(m.photo.y).toBeLessThanOrEqual(m.title.y + m.title.h);
    expect(m.footerY).toBeLessThan(1920);
  });
  it('split: big moments full, quick runs grouped 2–3, layouts cover the frame', () => {
    const d = [3, 0.5, 0.5, 0.5, 0.5, 0.5, 2, 0.5, 0.5, 2];
    const starts = d.map((_, i) => d.slice(0, i).reduce((a, b) => a + b, 0));
    expect(splitPages(d, starts, [])).toEqual([[0], [1, 2, 3], [4, 5], [6], [7, 8], [9]]);
    for (const v of [true, false]) {
      const area = splitLayout(3, 2, v).reduce((s, r) => s + r.w * r.h, 0);
      expect(area).toBeCloseTo(1);
    }
  });
  it('disposable-camera stamp', () => {
    expect(stampText(new Date(2026, 5, 1).getTime())).toBe("6 01 '26");
  });
});
