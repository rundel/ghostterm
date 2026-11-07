/**
 * The slim bundle's (dist/ghostterm-slim.js) default module: `ghostty-vt.wasm` next to the bundle,
 * fetched at init(). Vite leaves the URL alone here (@vite-ignore), so it is resolved against the
 * bundle at run time, or by the app's bundler, which can then emit the file as an asset.
 */
export function defaultWasmUrl(): URL {
  return new URL(/* @vite-ignore */ './ghostty-vt.wasm', import.meta.url);
}
