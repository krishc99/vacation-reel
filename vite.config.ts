import { defineConfig } from 'vite';

// Relative base so the build works on any static host (GitHub Pages subpath, Netlify, etc.)
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
