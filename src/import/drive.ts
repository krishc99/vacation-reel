// Photos from a Google Drive link shared as "Anyone with the link".
// The browser asks Google directly (Drive API v3 with a free API key); photos are
// held in memory like picked files, never saved to the phone's gallery or Downloads,
// and never sent anywhere else.

/** Set at build time from the GitHub secret GOOGLE_API_KEY. Empty = Drive links hidden. */
export const DRIVE_KEY: string = (import.meta.env.VITE_GOOGLE_API_KEY as string | undefined) ?? '';

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
}

/** Folder or single-file id from any Drive share link (or a bare id). */
export function parseDriveLink(link: string): { kind: 'folder' | 'file' | 'unknown'; id: string } | null {
  const s = link.trim();
  let m = s.match(/\/folders\/([\w-]{10,})/);
  if (m) return { kind: 'folder', id: m[1] };
  m = s.match(/\/file\/d\/([\w-]{10,})/);
  if (m) return { kind: 'file', id: m[1] };
  m = s.match(/[?&]id=([\w-]{10,})/);
  if (m) return { kind: 'unknown', id: m[1] };
  if (/^[\w-]{20,}$/.test(s)) return { kind: 'unknown', id: s };
  return null;
}

export const isPhoto = (f: DriveFile) => f.mimeType.startsWith('image/') || /\.(jpe?g|heic|heif|png|webp)$/i.test(f.name);

/** Turns Google's error into something Krish can act on. */
async function failure(r: Response, what: string): Promise<Error> {
  let reason = '';
  try {
    const j = await r.json();
    reason = j?.error?.message ?? '';
  } catch {
    /* not JSON */
  }
  if (r.status === 404) return new Error(`${what} not found. Check the link, and that it's shared as "Anyone with the link".`);
  if (r.status === 403 && /key|referer|referrer/i.test(reason)) return new Error(`Google refused this site's API key (${reason}).`);
  if (r.status === 403 || r.status === 401)
    return new Error(`${what} isn't public. In Drive: Share → General access → "Anyone with the link" (Viewer), then try again.`);
  if (r.status === 429) return new Error('Google says too many requests; wait a minute and try again.');
  return new Error(`${what}: Google answered ${r.status}${reason ? ` (${reason})` : ''}.`);
}

type Fetch = typeof fetch;

async function getJson(url: string, what: string, f: Fetch) {
  const r = await f(url);
  if (!r.ok) throw await failure(r, what);
  return r.json();
}

/** Photos in a folder, including subfolders (2 levels: trip → day → photos). */
export async function listDrive(link: string, key = DRIVE_KEY, f: Fetch = fetch, depth = 2): Promise<DriveFile[]> {
  const parsed = parseDriveLink(link);
  if (!parsed) throw new Error("That doesn't look like a Google Drive link. Open the folder in Drive, tap Share → Copy link, and paste it here.");
  const meta: DriveFile = await getJson(
    `${API}/${parsed.id}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true&key=${encodeURIComponent(key)}`,
    'This link',
    f,
  );
  if (meta.mimeType !== FOLDER) return isPhoto(meta) ? [meta] : [];
  const out: DriveFile[] = [];
  const walk = async (folderId: string, level: number) => {
    let page = '';
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const j = await getJson(
        `${API}?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${encodeURIComponent(key)}${page ? `&pageToken=${page}` : ''}`,
        'This folder',
        f,
      );
      for (const file of j.files as DriveFile[]) {
        if (file.mimeType === FOLDER) {
          if (level < depth) await walk(file.id, level + 1);
        } else if (isPhoto(file)) out.push(file);
      }
      page = j.nextPageToken ?? '';
    } while (page);
  };
  await walk(meta.id, 1);
  return out;
}

/** Downloads 3 at a time (2 retries each) into memory as File objects. */
export async function downloadDrive(
  files: DriveFile[],
  onProgress: (done: number, total: number) => void,
  key = DRIVE_KEY,
  f: Fetch = fetch,
): Promise<{ files: File[]; failed: { name: string; reason: string }[] }> {
  const got: (File | null)[] = new Array(files.length).fill(null);
  const failed: { name: string; reason: string }[] = [];
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < files.length) {
      const i = next++;
      const d = files[i];
      let lastErr = '';
      for (let attempt = 0; attempt < 3 && !got[i]; attempt++) {
        try {
          const r = await f(`${API}/${d.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(key)}`);
          if (!r.ok) throw await failure(r, d.name);
          const blob = await r.blob();
          got[i] = new File([blob], d.name, {
            type: d.mimeType.startsWith('image/') ? d.mimeType : blob.type,
            lastModified: d.modifiedTime ? Date.parse(d.modifiedTime) : Date.now(),
          });
        } catch (err) {
          lastErr = (err as Error).message;
          if (attempt < 2) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
        }
      }
      if (!got[i]) failed.push({ name: d.name, reason: `Couldn't download from Drive: ${lastErr}` });
      onProgress(++done, files.length);
    }
  };
  await Promise.all([lane(), lane(), lane()]);
  return { files: got.filter((x): x is File => x !== null), failed };
}
