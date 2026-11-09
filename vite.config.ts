import { defineConfig } from 'vite';

// Shown in the page footer so we can tell which deploy a device is running.
const sha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
const stamp = new Date().toISOString();

// Relative base so the build works on any static host (GitHub Pages subpath, Netlify, etc.)
export default defineConfig({
  base: './',
  define: { __BUILD_TIME__: JSON.stringify(stamp), __BUILD_SHA__: JSON.stringify(sha) },
  worker: { format: 'es' },
  // libheif wasm chunk is ~2 MB by design (lazy, HEIC only).
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
