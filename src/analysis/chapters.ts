// Chapters (plan step 3): the trip split by time and place. Never by CLIP alone.

export interface ChapterInput {
  id: string;
  takenAt: number;
  lat: number | null;
  lon: number | null;
}

export const CHAPTER_DEFAULTS = {
  /** A gap this long starts a new chapter (meal → beach, day → night). */
  gapHours: 2,
  /** Moving this far from where the chapter started starts a new one (needs GPS on both). */
  km: 1.5,
};

export function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLon = r(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Time-sorted photos → chapters of ids. */
export function chapters(sorted: ChapterInput[], o = CHAPTER_DEFAULTS): string[][] {
  const out: string[][] = [];
  let prevT: number | null = null;
  let anchor: { lat: number; lon: number } | null = null;
  for (const p of sorted) {
    const gap = prevT === null ? Infinity : (p.takenAt - prevT) / 3_600_000;
    const moved = anchor && p.lat !== null && p.lon !== null ? km(anchor.lat, anchor.lon, p.lat, p.lon) > o.km : false;
    if (prevT === null || gap > o.gapHours || moved) {
      out.push([]);
      anchor = p.lat !== null && p.lon !== null ? { lat: p.lat, lon: p.lon } : null;
    } else if (!anchor && p.lat !== null && p.lon !== null) {
      anchor = { lat: p.lat, lon: p.lon };
    }
    out[out.length - 1].push(p.id);
    prevT = p.takenAt;
  }
  return out;
}
