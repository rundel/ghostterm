// Library build. `vite build` writes the default bundle, dist/ghostterm.js, with ghostty-vt.wasm
// inlined, and the typings. `vite build --mode slim` adds dist/ghostterm-slim.js, the same modules
// with lib/wasm-default.ts swapped for lib/wasm-default-slim.ts, so it loads ghostty-vt.wasm by URL.
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib');

const VITE_IGNORE = /\/\*\s*@vite-ignore\s*\*\/\s*/g;

/**
 * Resolve lib/ghostty.ts's import of ./wasm-default to the slim module, and drop the @vite-ignore
 * that keeps this build from inlining its `new URL('./ghostty-vt.wasm', import.meta.url)`, so the
 * app's bundler sees a plain asset URL. Fails if either step finds nothing to do.
 */
function slimWasmDefault() {
  const from = path.join(lib, 'ghostty.ts');
  const to = path.join(lib, 'wasm-default-slim.ts');
  let swapped = false;
  return {
    name: 'ghostterm-slim-wasm-default',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './wasm-default' || importer !== from) return null;
      swapped = true;
      return to;
    },
    buildEnd() {
      if (!swapped) this.error('lib/ghostty.ts no longer imports ./wasm-default');
    },
    renderChunk(code) {
      if (code.search(VITE_IGNORE) < 0) this.error('no @vite-ignore left in the slim bundle');
      return { code: code.replace(VITE_IGNORE, ''), map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const slim = mode === 'slim';
  return {
    plugins: slim
      ? [slimWasmDefault()]
      : [
          dts({
            include: ['lib/**/*.ts'],
            exclude: ['lib/**/*.test.ts', 'lib/test-helpers.ts'],
            // One rolled-up dist/index.d.ts instead of a .d.ts per source file. It is API
            // Extractor's public trimmed rollup, which leaves out everything tagged @internal; a
            // public declaration that names an internal one is left dangling, which
            // scripts/check-dist.ts catches.
            bundleTypes: true,
          }),
        ],
    build: {
      // The slim build runs second and adds to dist/.
      emptyOutDir: !slim,
      lib: {
        entry: 'lib/index.ts',
        formats: ['es'],
        fileName: () => (slim ? 'ghostterm-slim.js' : 'ghostterm.js'),
      },
    },
  };
});
