import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts', 'lib/test-helpers.ts'],
      // One rolled-up dist/index.d.ts (API Extractor) instead of a .d.ts per source file.
      bundleTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: 'lib/index.ts',
      formats: ['es'],
      fileName: () => 'ghostterm.js',
    },
  },
});
