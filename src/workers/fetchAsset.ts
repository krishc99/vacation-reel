/**
 * Download a model/engine file with retries. Big downloads on phones sometimes
 * break part-way ("Failed to fetch") even though the file is there; a retry
 * usually succeeds (the browser's HTTP cache keeps what it got).
 */
export async function fetchBytes(url: string, tries = 3): Promise<Uint8Array<ArrayBuffer>> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (err) {
      last = err;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 800 * (i + 1) ** 2));
    }
  }
  throw new Error(`${url.split('/').slice(-2).join('/')}: ${last instanceof Error ? last.message : String(last)} (after ${tries} tries)`);
}

/** Same bytes as a local blob: URL (for libraries that only take a path). */
export async function fetchAsBlobUrl(url: string, type: string): Promise<string> {
  return URL.createObjectURL(new Blob([await fetchBytes(url)], { type }));
}
