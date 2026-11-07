import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts', 'lib/test-helpers.ts'],
      // One rolled-up dist/index.d.ts instead of a .d.ts per source file. It is API Extractor's
      // public trimmed rollup, which leaves out everything tagged @internal; a public declaration
      // that names an internal one is left dangling, which scripts/check-dist.ts catches.
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
