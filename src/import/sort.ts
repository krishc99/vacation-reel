import type { Photo } from '../types';

/** Chronological order; name breaks ties so bursts with equal seconds stay in shot order. */
export function sortByTime(photos: Photo[]): Photo[] {
  return [...photos].sort(
    (a, b) => a.takenAt - b.takenAt || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
