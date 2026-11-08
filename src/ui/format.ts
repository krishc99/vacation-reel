/** "0:01.5" style timecode for the reel timeline. */
export function timecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Fits a 76px tile: "Thu 09:05". */
export function shotTime(ms: number): string {
  const d = new Date(ms);
  return `${weekdayFmt.format(d)} ${timeFmt.format(d)}`;
}

export function shotTimeFull(ms: number): string {
  return fullFmt.format(new Date(ms));
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
