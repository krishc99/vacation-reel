/// <reference lib="webworker" />
// Shared by import and render workers. Native decode first; HEIC falls back to
// libheif (wasm, lazy-loaded so non-HEIC albums never download it).

type LibHeif = {
  HeifDecoder: new () => {
    decode(buf: ArrayBuffer | Uint8Array): HeifImage[];
  };
};
type HeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  free(): void;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    cb: (out: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
  ): void;
};

let libheifPromise: Promise<LibHeif> | null = null;
function loadLibheif(): Promise<LibHeif> {
  libheifPromise ??= import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(
    (m) => (m as { default: () => LibHeif }).default(),
  );
  return libheifPromise;
}

/** ISO-BMFF brand check: catches HEIC files with wrong/missing extension or MIME. */
export async function looksLikeHeif(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  return ascii.slice(4, 8) === 'ftyp' && /heic|heix|hevc|heim|heis|mif1|msf1/.test(ascii.slice(8));
}

async function decodeHeif(file: Blob): Promise<ImageBitmap> {
  const lib = await loadLibheif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  if (!images.length) throw new Error('No image found in HEIC file');
  const img = images.find((i) => i.is_primary()) ?? images[0];
  const width = img.get_width();
  const height = img.get_height();
  try {
    const pixels = await new Promise<Uint8ClampedArray>((resolve, reject) =>
      img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (out) =>
        out ? resolve(out.data) : reject(new Error('HEIC decode failed')),
      ),
    );
    // libheif already applies HEIF rotation/mirror, so no EXIF orientation needed.
    return await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height));
  } finally {
    images.forEach((i) => i.free());
  }
}

export class UnsupportedImageError extends Error {}

/** Full-resolution, correctly oriented bitmap. Caller must close() it. */
export async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    if (await looksLikeHeif(file)) return decodeHeif(file);
    throw new UnsupportedImageError('This file could not be opened as an image.');
  }
}
