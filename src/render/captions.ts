// Milestone 8: optional captions ("June 2026 / Lisbon", "Day 2 / Sintra").
// Place names come from an offline GeoNames list (public/geo/places.tsv, CC BY 4.0);
// GPS never leaves the device.
import type { Caption, Clip, Photo } from '../types';

export interface Place {
  name: string;
  lat: number;
  lon: number;
  /** log10(population) */
  pop: number;
}

export type PlaceIndex = Map<string, Place[]>;

const cellKey = (lat: number, lon: number) => `${Math.floor(lat)},${Math.floor(lon)}`;

export function parsePlaces(tsv: string): PlaceIndex {
  const index: PlaceIndex = new Map();
  for (const line of tsv.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, , la, lo, pop] = line.split('\t');
    const p: Place = { name, lat: Number(la), lon: Number(lo), pop: Number(pop) };
    const k = cellKey(p.lat, p.lon);
    const cell = index.get(k);
    if (cell) cell.push(p);
    else index.set(k, [p]);
  }
  return index;
}

let loading: Promise<PlaceIndex> | null = null;
/** Loaded once, only when captions are on (about 0.6 MB compressed). */
export function loadPlaces(url = `${import.meta.env.BASE_URL}geo/places.tsv`): Promise<PlaceIndex> {
  loading ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`place names: HTTP ${r.status}`);
      return r.text();
    })
    .then(parsePlaces)
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

export const CAPTIONS = {
  /** Towns farther than this don't name the spot. */
  maxKm: 25,
  /** Minimum time on screen (s). */
  minShow: 1.8,
  /** Minimum gap between caption starts (s). */
  minGap: 2.1,
};

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Nearest town, with bigger towns winning close calls (a beach 3 km from a city takes the city's name). */
export function nearestPlace(index: PlaceIndex, lat: number, lon: number): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      for (const p of index.get(cellKey(lat + dy, lon + dx)) ?? []) {
        const d = km(lat, lon, p.lat, p.lon);
        if (d > CAPTIONS.maxKm) continue;
        const score = d / (1 + 0.5 * Math.max(0, p.pop - 3.7));
        if (score < bestScore) {
          bestScore = score;
          best = p.name;
        }
      }
    }
  return best;
}

const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const monthYear = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/**
 * Title on the opening photo (where + when), then "Day N / Place" when a later
 * photo starts a new day or place, going forward in time only (the opener and
 * finale are picked out of order). Photos without a camera date get no day.
 */
export function buildCaptions(clips: Clip[], photos: Photo[], placeOf: (p: Photo) => string | null): Caption[] {
  if (!clips.length) return [];
  const byId = new Map(photos.map((p) => [p.id, p]));
  const shot = clips.map((c) => byId.get(c.photoId)!);
  const dated = shot.filter((p) => p.timeSource === 'exif');
  const first = dated.length ? Math.min(...dated.map((p) => dayStart(p.takenAt))) : null;
  const dayOf = (p: Photo) => (first !== null && p.timeSource === 'exif' ? Math.round((dayStart(p.takenAt) - first) / 86_400_000) + 1 : null);
  const multiDay = new Set(dated.map((p) => dayStart(p.takenAt))).size > 1;
  const end = clips[clips.length - 1].start + clips[clips.length - 1].duration;
  const out: Caption[] = [];
  const show = (top: string, main: string, i: number) => {
    const c = clips[i];
    const start = c.start + (i === 0 ? 0.25 : 0.1);
    const stop = Math.min(end - 0.1, Math.max(c.start + c.duration - 0.05, start + CAPTIONS.minShow));
    if (stop - start >= 1) out.push({ top, main, start, end: stop });
  };

  // Title: most common place, and the month.
  const places = shot.map(placeOf);
  const counts = new Map<string, { n: number; t: number }>();
  places.forEach((pl, i) => {
    if (!pl) return;
    const c = counts.get(pl) ?? { n: 0, t: Infinity };
    counts.set(pl, { n: c.n + 1, t: Math.min(c.t, shot[i].takenAt) });
  });
  // Most photos; ties go to where the trip started.
  const home = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].t - b[1].t)[0]?.[0] ?? null;
  const when = first !== null ? monthYear(first) : '';
  if (home) show(when, home, 0);
  else if (when) show('', when, 0);

  let lastKey = '';
  let lastDay = 0;
  let lastStart = out.length ? out[0].start : -Infinity;
  for (let i = 1; i < clips.length - 1; i++) {
    const day = dayOf(shot[i]);
    const place = places[i];
    if (day !== null && day < lastDay) continue; // out of time order
    const key = `${multiDay ? day : ''}|${place ?? ''}`;
    if (key === lastKey) continue;
    lastKey = key;
    if (day !== null) lastDay = day;
    if (clips[i].start - lastStart < CAPTIONS.minGap) continue;
    const dayText = multiDay && day !== null ? `Day ${day}` : '';
    if (place) show(dayText, place, i);
    else if (dayText) show('', dayText, i);
    else continue;
    lastStart = clips[i].start;
  }
  // Never overlap: each caption ends before the next begins.
  for (let k = 0; k + 1 < out.length; k++) out[k].end = Math.min(out[k].end, out[k + 1].start - 0.05);
  return out.filter((c) => c.end - c.start >= 0.8);
}

export interface PhotoLabels {
  /** Film date stamp: 6 01 '26. */
  stamps: Record<string, string>;
  /** Booth strip label: "Sintra · 3 June". */
  notes: Record<string, string>;
  /** Magazine cover title: place, else "Day 2", else the month. */
  titles: Record<string, string>;
  /** Magazine issue line: "NO. 02 — JUNE 2026". */
  kickers: Record<string, string>;
}

/** Per-photo text for the looks that show place and date their own way. */
export function photoLabels(clips: Clip[], photos: Photo[], placeOf: (p: Photo) => string | null): PhotoLabels {
  const out: PhotoLabels = { stamps: {}, notes: {}, titles: {}, kickers: {} };
  const byId = new Map(photos.map((p) => [p.id, p]));
  const shot = clips.map((c) => byId.get(c.photoId)!);
  const dated = shot.filter((p) => p.timeSource === 'exif');
  const first = dated.length ? Math.min(...dated.map((p) => dayStart(p.takenAt))) : null;
  const multiDay = new Set(dated.map((p) => dayStart(p.takenAt))).size > 1;
  for (const p of shot) {
    const isDated = p.timeSource === 'exif';
    const day = first !== null && isDated ? Math.round((dayStart(p.takenAt) - first) / 86_400_000) + 1 : null;
    const place = placeOf(p);
    const when = isDated ? new Date(p.takenAt) : null;
    if (when) out.stamps[p.id] = `${when.getMonth() + 1} ${String(when.getDate()).padStart(2, '0')} '${String(when.getFullYear()).slice(2)}`;
    const date = when ? when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '';
    out.notes[p.id] = [place, date].filter(Boolean).join(' · ');
    out.titles[p.id] = place ?? (multiDay && day ? `Day ${day}` : when ? when.toLocaleDateString('en-US', { month: 'long' }) : 'Travels');
    const issue = `NO. ${String(day ?? 1).padStart(2, '0')}`;
    out.kickers[p.id] = when ? `${issue} — ${monthYear(when.getTime()).toUpperCase()}` : issue;
  }
  return out;
}
