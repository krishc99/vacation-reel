import exifr from 'exifr';

export interface ExifInfo {
  takenAt: number | null;
  lat: number | null;
  lon: number | null;
}

/**
 * Reads capture time and GPS from a photo. Never throws: photos without EXIF
 * (screenshots, WhatsApp re-saves) just return nulls.
 */
export async function readExif(file: File): Promise<ExifInfo> {
  try {
    const data = await exifr.parse(file, {
      gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
    });
    if (!data) return { takenAt: null, lat: null, lon: null };
    const date: unknown = data.DateTimeOriginal ?? data.CreateDate;
    const takenAt = date instanceof Date && !isNaN(date.getTime()) ? date.getTime() : null;
    const lat = typeof data.latitude === 'number' ? data.latitude : null;
    const lon = typeof data.longitude === 'number' ? data.longitude : null;
    return { takenAt, lat, lon };
  } catch {
    return { takenAt: null, lat: null, lon: null };
  }
}
