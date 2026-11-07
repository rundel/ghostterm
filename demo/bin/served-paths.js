import path from 'path';

/**
 * What a page under `pageDir` needs from the repo, for Vite's `server.fs.allow`: the page's own
 * directory, the library sources, node_modules and the WASM builds. Everything else in the repo
 * (.git, scripts, ...) is not served.
 */
export function servedPaths(repoRoot, pageDir) {
  return [
    path.join(repoRoot, pageDir),
    path.join(repoRoot, 'lib'),
    path.join(repoRoot, 'node_modules'),
    path.join(repoRoot, 'ghostty-vt.wasm'),
    path.join(repoRoot, 'ghostty-vt-fast.wasm'),
  ];
}
