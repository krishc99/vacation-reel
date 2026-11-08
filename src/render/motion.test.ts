import { describe, expect, it } from 'vitest';
import { ease, safeZoom, salientCentre, transitionFor, zoomAt, zoomed, zoomFor } from './motion';

describe('motion', () => {
  it('eases from 0 to 1', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBeCloseTo(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
  });

  it('zoom keeps the anchor still and stays inside the window', () => {
    const win = { sx: 100, sy: 0, sw: 1000, sh: 2000 };
    const r = zoomed(win, 600, 800, 1.08);
    expect(r.sw).toBeCloseTo(1000 / 1.08);
    // Anchor maps to the same relative spot.
    expect((600 - r.sx) / r.sw).toBeCloseTo((600 - win.sx) / win.sw);
    expect(r.sx).toBeGreaterThanOrEqual(win.sx);
    expect(r.sx + r.sw).toBeLessThanOrEqual(win.sx + win.sw + 1e-9);
  });

  it('limits zoom so people at the edges stay in frame', () => {
    const win = { sx: 0, sy: 0, sw: 1000, sh: 1000 };
    const wide = { x0: 20, y0: 400, x1: 980, y1: 600 };
    expect(safeZoom(win, 500, 500, wide, 1.08)).toBeLessThan(1.05);
    expect(safeZoom(win, 500, 500, { x0: 400, y0: 400, x1: 600, y1: 600 }, 1.08)).toBe(1.08);
    expect(safeZoom(win, 500, 500, null, 1.08)).toBe(1.08);
  });

  it('zooms less on short clips and alternates in / out', () => {
    expect(zoomFor(0.9)).toBeCloseTo(1.045);
    expect(zoomFor(3)).toBeCloseTo(1.08);
    expect(zoomAt(0, 1.08, 0)).toBe(1);
    expect(zoomAt(0, 1.08, 1)).toBeCloseTo(1.08);
    expect(zoomAt(1, 1.08, 0)).toBeCloseTo(1.08);
    expect(zoomAt(1, 1.08, 1)).toBeCloseTo(1);
  });

  it('hard cuts on downbeats and into the chorus, crossfades between', () => {
    expect(transitionFor(5, 1, false)).toBe('cut');
    expect(transitionFor(7, 1, false)).toBe('fade');
    expect(transitionFor(7, 1, true)).toBe('cut');
    expect(transitionFor(null, 0, false)).toBe('fade');
  });

  it('centres the crop on the detail', () => {
    const p = new Array(100).fill(1);
    for (let i = 70; i < 90; i++) p[i] = 20;
    expect(salientCentre(p, 0.5)).toBeGreaterThan(0.6);
    expect(salientCentre(new Array(100).fill(1), 0.5)).toBeCloseTo(0.5, 1);
  });
});
