import exifr from 'exifr';

export interface ExifInfo {
  takenAt: number | null;
  lat: number | null;
  lon: number | null;
}

const EMPTY: ExifInfo = { takenAt: null, lat: null, lon: null };
const OPTIONS = { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'] };

function toInfo(data: Record<string, unknown> | undefined | null): ExifInfo {
  if (!data) return EMPTY;
  const date = data.DateTimeOriginal ?? data.CreateDate;
  const takenAt = date instanceof Date && !isNaN(date.getTime()) ? date.getTime() : null;
  const lat = typeof data.latitude === 'number' ? data.latitude : null;
  const lon = typeof data.longitude === 'number' ? data.longitude : null;
  return { takenAt, lat, lon };
}

/**
 * exifr rejects the Exif item layout some HEIC encoders write ("Malformed EXIF
 * data"). Fallback: find the "Exif\0\0" + TIFF header anywhere in the file and
 * parse that TIFF block directly.
 */
async function heifExifFallback(file: Blob): Promise<ExifInfo> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('latin1').decode(buf);
  const i = text.search(/Exif\x00\x00(MM\x00\*|II\*\x00)/);
  if (i < 0) return EMPTY;
  return toInfo(await exifr.parse(buf.subarray(i + 6), OPTIONS));
}

/**
 * Reads capture time and GPS from a photo. Never throws: photos without EXIF
 * (screenshots, WhatsApp re-saves) just return nulls.
 */
export async function readExif(file: File, isHeif = false): Promise<ExifInfo> {
  let info = EMPTY;
  try {
    info = toInfo(await exifr.parse(file, OPTIONS));
  } catch {
    /* fall through */
  }
  if (info.takenAt === null && isHeif) {
    try {
      info = await heifExifFallback(file);
    } catch {
      /* no EXIF */
    }
  }
  return info;
}
