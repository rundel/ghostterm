// Vite server for the Playwright fixture page (started by playwright.config.ts). It serves only what
// the page needs, as the demo server does.
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { servedPaths } from '../demo/bin/served-paths.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root: repoRoot,
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    strictPort: true,
    cors: false,
    fs: {
      strict: true,
      allow: servedPaths(repoRoot, 'e2e'),
    },
  },
});
