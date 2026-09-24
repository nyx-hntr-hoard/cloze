import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Relative asset paths so the built folder works when opened from disk or
  // served from a subdirectory (GitHub Pages serves from /<repo>/), not just
  // from a domain root.
  base: './',
  // `--mode single` builds the standalone cloze.html. That file runs from
  // file://, which can't sync, so it is always built local-only — whatever
  // VITE_DEXIE_CLOUD_URL says. That keeps the Dexie Cloud add-on (and the
  // extra chunk it would need) out of the one-file build entirely.
  ...(mode === 'single' ? { define: { 'import.meta.env.VITE_DEXIE_CLOUD_URL': JSON.stringify('') } } : {}),
}));
