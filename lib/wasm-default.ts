/**
 * Where Ghostty.load() finds libghostty-vt when it is given no path: the size-optimized build at
 * the repo root. The default bundle (dist/ghostterm.js) inlines it, since Vite turns this URL into
 * a data: URL in library mode. The slim bundle swaps this module for wasm-default-slim.ts (see
 * vite.config.js), and nothing else differs between the two.
 */
export function defaultWasmUrl(): URL {
  return new URL('../ghostty-vt.wasm', import.meta.url);
}
