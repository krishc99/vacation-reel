// When and where a phone video was shot, from its MP4/MOV container (Mediabunny
// doesn't surface these): iPhone writes a local date with its time-zone offset
// and an ISO 6709 location; Android writes the time in UTC (mvhd) and "©xyz".

export interface VideoMeta {
  /** Wall-clock capture time, as if local (same convention as photo EXIF times), when the file says its zone. */
  wallClock: number | null;
  /** Capture instant (UTC) when that's all the file has. */
  utc: number | null;
  lat: number | null;
  lon: number | null;
}

const MAC_EPOCH = 2082844800; // seconds from 1904-01-01 to 1970-01-01

/** Finds the moov box (it can be at the start or the end of the file) and returns its bytes. */
async function readMoov(file: Blob): Promise<Uint8Array | null> {
  let at = 0;
  for (let guard = 0; guard < 64 && at + 8 <= file.size; guard++) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - at;
    if (size < 8) return null;
    if (type === 'moov') return size > 64e6 ? null : new Uint8Array(await file.slice(at, at + size).arrayBuffer());
    at += size;
  }
  return null;
}

export function parseMoov(moov: Uint8Array): VideoMeta {
  const out: VideoMeta = { wallClock: null, utc: null, lat: null, lon: null };
  const text = new TextDecoder('latin1').decode(moov);
  // iPhone: com.apple.quicktime.creationdate = "2023-06-09T15:29:56+0200".
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[+-]\d{2}:?\d{2}|Z)/);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso.map(Number);
    out.wallClock = new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  // mvhd creation time (UTC seconds since 1904).
  const mv = text.indexOf('mvhd');
  if (mv >= 4 && mv + 16 <= moov.length) {
    const dv = new DataView(moov.buffer, moov.byteOffset + mv + 4);
    const version = dv.getUint8(0);
    const secs = version === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
    if (secs > MAC_EPOCH + 946684800) out.utc = (secs - MAC_EPOCH) * 1000; // after 2000: a real date
  }
  // ISO 6709 location: "+48.5839+007.7455+140.000/" (Apple and Android).
  const loc = text.match(/([+-]\d{1,2}\.\d{2,})([+-]\d{1,3}\.\d{2,})(?:[+-][\d.]+)?\//);
  if (loc) {
    const lat = Number(loc[1]);
    const lon = Number(loc[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.lat = lat;
      out.lon = lon;
    }
  }
  return out;
}

export async function readVideoMeta(file: Blob): Promise<VideoMeta> {
  try {
    const moov = await readMoov(file);
    return moov ? parseMoov(moov) : { wallClock: null, utc: null, lat: null, lon: null };
  } catch {
    return { wallClock: null, utc: null, lat: null, lon: null };
  }
}

/**
 * A UTC-only video time as the trip's wall clock (photos' EXIF times are wall
 * clock), given the trip's offset from UTC in minutes (from the photos), or the
 * device's own zone if unknown.
 */
export function utcToWallClock(utc: number, tripOffsetMin: number | null): number {
  const device = -new Date(utc).getTimezoneOffset();
  return utc + ((tripOffsetMin ?? device) - device) * 60_000;
}
