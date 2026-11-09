import { describe, expect, it } from 'vitest';
import { parseMoov, utcToWallClock } from './videoMeta';

const enc = (s: string) => new TextEncoder().encode(s);
function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc(type), 4);
  out.set(body, 8);
  return out;
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe('video dates and places', () => {
  it('Android: mvhd UTC time and ©xyz location', () => {
    const mvhd = new Uint8Array(100);
    const secs = Date.UTC(2023, 5, 9, 9, 59, 57) / 1000 + 2082844800;
    new DataView(mvhd.buffer).setUint32(4, secs); // version 0, creation time
    const xyz = box('©xyz', cat(new Uint8Array(4), enc('+48.5839+007.7455/')));
    const m = parseMoov(box('moov', cat(box('mvhd', mvhd), box('udta', xyz))));
    expect(m.utc).toBe(Date.UTC(2023, 5, 9, 9, 59, 57));
    expect(m.wallClock).toBeNull();
    expect(m.lat).toBeCloseTo(48.5839);
    expect(m.lon).toBeCloseTo(7.7455);
  });
  it('iPhone: local creation date with its zone wins', () => {
    const m = parseMoov(box('moov', enc('....com.apple.quicktime.creationdate....data....2023-06-09T15:29:56+0200 +48.58+007.74+140.000/')));
    expect(m.wallClock).toBe(new Date(2023, 5, 9, 15, 29, 56).getTime());
  });
  it('UTC moved onto the trip clock', () => {
    const utc = Date.UTC(2023, 5, 9, 9, 59, 57);
    const wall = utcToWallClock(utc, 120); // trip in UTC+2
    const d = new Date(wall);
    expect([d.getHours(), d.getMinutes()]).toEqual([11, 59]);
  });
});
