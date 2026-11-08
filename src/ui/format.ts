/** "0:01.5" style timecode for the reel timeline. */
export function timecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function shotTime(ms: number): string {
  const d = new Date(ms);
  return `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
