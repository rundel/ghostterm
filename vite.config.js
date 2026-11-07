import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts', 'lib/test-helpers.ts'],
      rollupTypes: true, // Bundle all .d.ts into single file
      copyDtsFiles: false, // Don't copy individual .d.ts files
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
