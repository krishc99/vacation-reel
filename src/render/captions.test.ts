import { describe, expect, it } from 'vitest';
import type { Clip, Photo } from '../types';
import { buildCaptions, nearestPlace, parsePlaces } from './captions';

const TSV = '# header\nLisbon\tPT\t38.72\t-9.13\t5.7\nAmadora\tPT\t38.75\t-9.23\t5.2\nSintra\tPT\t38.80\t-9.38\t4.5\n';

describe('captions', () => {
  const idx = parsePlaces(TSV);
  it('names the nearest town, bigger towns winning close calls', () => {
    expect(nearestPlace(idx, 38.71, -9.14)).toBe('Lisbon');
    expect(nearestPlace(idx, 38.8, -9.39)).toBe('Sintra');
    expect(nearestPlace(idx, 10, 10)).toBeNull();
  });

  it('title first, then Day N / place going forward', () => {
    const day = (d: number, h: number) => new Date(2026, 5, d, h).getTime();
    const ph = (id: string, t: number, lat: number, lon: number) =>
      ({ id, takenAt: t, timeSource: 'exif', lat, lon }) as unknown as Photo;
    const photos = [
      ph('hook', day(3, 12), 38.8, -9.38),
      ph('a', day(1, 10), 38.72, -9.13),
      ph('b', day(1, 11), 38.72, -9.13),
      ph('c', day(2, 10), 38.8, -9.38),
      ph('d', day(2, 11), 38.8, -9.38),
      ph('fin', day(1, 9), 38.72, -9.13),
    ];
    const clips: Clip[] = photos.map((p, i) => ({ photoId: p.id, start: i === 0 ? 0 : 3 + (i - 1) * 2, duration: i === 0 ? 3 : 2 }));
    const caps = buildCaptions(clips, photos, (p) => nearestPlace(idx, p.lat!, p.lon!));
    expect(caps.map((c) => `${c.top}/${c.main}`)).toEqual(['June 2026/Lisbon', 'Day 1/Lisbon', 'Day 2/Sintra']);
    for (let i = 1; i < caps.length; i++) expect(caps[i].start).toBeGreaterThanOrEqual(caps[i - 1].end);
  });
});
