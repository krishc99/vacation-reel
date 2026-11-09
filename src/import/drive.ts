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

export const DRIVE_DOWNLOAD = {
  /** Parallel downloads. Google starts refusing anonymous downloads (403, no CORS header) when pushed. */
  lanes: 2,
  /** Tries per photo, spread over the whole run (a refused photo goes to the back of the queue). */
  tries: 6,
  /** After a refusal every lane waits this long, doubling up to maxPauseMs; successes shrink it again. */
  pauseMs: 2000,
  maxPauseMs: 30000,
};

/**
 * Downloads into memory as File objects. Google rate-limits anonymous
 * downloads of shared files; a refusal arrives as a 403 without a CORS header,
 * which the browser reports only as "Failed to fetch". So: few lanes, and on
 * any refusal everybody pauses (backing off), and the photo is retried later.
 */
export async function downloadDrive(
  files: DriveFile[],
  onProgress: (done: number, total: number, waitingSec: number) => void,
  key = DRIVE_KEY,
  f: Fetch = fetch,
  o = DRIVE_DOWNLOAD,
): Promise<{ files: File[]; failed: { name: string; reason: string }[] }> {
  const got: (File | null)[] = new Array(files.length).fill(null);
  const tries = new Array(files.length).fill(0);
  const lastErr: string[] = new Array(files.length).fill('');
  const queue = files.map((_, i) => i);
  let done = 0;
  let pause = 0;
  let resumeAt = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const lane = async () => {
    for (;;) {
      const i = queue.shift();
      if (i === undefined) return;
      const wait = resumeAt - Date.now();
      if (wait > 0) {
        onProgress(done, files.length, Math.ceil(wait / 1000));
        await sleep(wait);
      }
      const d = files[i];
      tries[i]++;
      try {
        const r = await f(`${API}/${d.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(key)}`);
        if (!r.ok) throw await failure(r, d.name);
        const blob = await r.blob();
        got[i] = new File([blob], d.name, {
          type: d.mimeType.startsWith('image/') ? d.mimeType : blob.type,
          lastModified: d.modifiedTime ? Date.parse(d.modifiedTime) : Date.now(),
        });
        pause = Math.max(0, pause / 2 - 250);
        onProgress(++done, files.length, 0);
      } catch (err) {
        lastErr[i] = (err as Error).message;
        const missing = /not found/i.test(lastErr[i]);
        if (!missing) {
          pause = Math.min(o.maxPauseMs, pause ? pause * 2 : o.pauseMs);
          resumeAt = Math.max(resumeAt, Date.now() + pause);
        }
        if (!missing && tries[i] < o.tries) queue.push(i);
        else onProgress(++done, files.length, 0);
      }
    }
  };
  await Promise.all(Array.from({ length: o.lanes }, lane));
  const failed = files
    .map((d, i) => (got[i] ? null : { name: d.name, reason: `Couldn't download from Drive after ${tries[i]} tries: ${/Failed to fetch/i.test(lastErr[i]) ? 'Google refused (too many downloads at once). Add the same link again later to fetch the rest; photos already added are skipped' : lastErr[i]}` }))
    .filter((x): x is { name: string; reason: string } => x !== null);
  return { files: got.filter((x): x is File => x !== null), failed };
}
