import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { experiences } from './src/experiences.js';

// Every piece is its own page: build one HTML entry per registry entry, plus the 404 page.
const input = { notFound: resolve(__dirname, '404.html') };
for (const x of experiences) input[x.id] = resolve(__dirname, '.' + x.path, 'index.html');

export default defineConfig({
  base: '/',
  appType: 'mpa',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700, // three.js is one shared ~530 kB chunk, cached across all pieces
    rollupOptions: {
      input,
      output: { manualChunks: (id) => (id.includes('node_modules/three/') ? 'three' : undefined) },
    },
  },
});
