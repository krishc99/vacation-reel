import { describe, expect, it } from 'vitest';
import { downloadDrive, listDrive, parseDriveLink } from './drive';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Google Drive links', () => {
  it('reads folder and file links', () => {
    expect(parseDriveLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing')).toEqual({ kind: 'folder', id: '1AbCdEfGhIjKlMnOp' });
    expect(parseDriveLink('https://drive.google.com/file/d/1XyZ0123456789ab/view')).toEqual({ kind: 'file', id: '1XyZ0123456789ab' });
    expect(parseDriveLink('https://drive.google.com/open?id=1QwErTyUiOp12345')?.id).toBe('1QwErTyUiOp12345');
    expect(parseDriveLink('hello')).toBeNull();
  });

  it('lists photos in the folder and its day subfolders, skipping videos', async () => {
    const f = (async (url: string) => {
      if (url.includes('/files/ROOTFOLDER123?')) return json({ id: 'ROOTFOLDER123', name: 'Trip', mimeType: 'application/vnd.google-apps.folder' });
      if (url.includes(encodeURIComponent("'ROOTFOLDER123' in parents")))
        return json({ files: [
          { id: 'a', name: 'a.jpg', mimeType: 'image/jpeg' },
          { id: 'v', name: 'clip.mp4', mimeType: 'video/mp4' },
          { id: 'DAY2FOLDER1', name: 'Day 2', mimeType: 'application/vnd.google-apps.folder' },
        ] });
      if (url.includes(encodeURIComponent("'DAY2FOLDER1' in parents")))
        return json({ files: [{ id: 'b', name: 'IMG_1.HEIC', mimeType: 'application/octet-stream' }] });
      return json({}, 404);
    }) as typeof fetch;
    const list = await listDrive('https://drive.google.com/drive/folders/ROOTFOLDER123', { key: 'k' }, f);
    expect(list.map((x) => x.name)).toEqual(['a.jpg', 'IMG_1.HEIC']);
  });

  it('explains a folder that is not shared publicly', async () => {
    const f = (async () => json({ error: { message: 'The user does not have sufficient permissions' } }, 403)) as unknown as typeof fetch;
    await expect(listDrive('https://drive.google.com/drive/folders/PRIVATEFOLDER1', { key: 'k' }, f)).rejects.toThrow(/Anyone with the link/);
  });

  it('downloads with retries and reports failures', async () => {
    let tries = 0;
    const f = (async (url: string) => {
      if (url.includes('/files/ok?')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      if (url.includes('/files/flaky?')) return ++tries < 2 ? json({}, 500) : new Response(new Uint8Array([4]), { status: 200 });
      return json({ error: { message: 'nope' } }, 404);
    }) as typeof fetch;
    const r = await downloadDrive(
      [
        { id: 'ok', name: 'ok.jpg', mimeType: 'image/jpeg' },
        { id: 'flaky', name: 'flaky.jpg', mimeType: 'image/jpeg' },
        { id: 'gone', name: 'gone.jpg', mimeType: 'image/jpeg' },
      ],
      () => {},
      { key: 'k' },
      f,
      { lanes: 2, tries: 3, pauseMs: 5, maxPauseMs: 20 },
    );
    expect(r.files.map((x) => x.name).sort()).toEqual(['flaky.jpg', 'ok.jpg']);
    expect(r.failed.map((x) => x.name)).toEqual(['gone.jpg']);
  });
});

describe('signed-in Drive requests', () => {
  it('send the token as a header and no API key', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    await downloadDrive([{ id: 'x', name: 'x.jpg', mimeType: 'image/jpeg' }], () => {}, { token: 'TOKEN' }, f);
    expect(seen[0].auth).toBe('Bearer TOKEN');
    expect(seen[0].url).not.toContain('key=');
  });
});
