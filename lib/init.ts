/**
 * The shared libghostty-vt module behind `new Terminal()`, loaded by init().
 * Kept apart from the public entry point so its state is in one place.
 */

import { Ghostty } from './ghostty';

export interface InitOptions {
  /**
   * Where to load the libghostty-vt module from. Defaults to the size-optimized `ghostty-vt.wasm`:
   * inlined into `ghostterm`, and fetched from next to the bundle by `ghostterm/slim` (pass
   * `ghostterm/ghostty-vt.wasm`'s URL when your bundler doesn't handle that).
   * `ghostterm/ghostty-vt-fast.wasm` is the speed-optimized build: the same features, 10-20%
   * faster on output heavy in escape sequences, and about 1.5x larger.
   */
  wasmPath?: string | URL;
}

let ghosttyInstance: Ghostty | null = null;
let loading: Promise<void> | null = null;
let loadedPath: string | undefined;

/**
 * Initialize the ghostterm library by loading the WASM module.
 * Must be called before creating any Terminal instances.
 *
 * This creates a shared WASM instance that all Terminal instances will use. Later calls, including
 * concurrent ones, share the first call's module; one asking for a different `wasmPath` logs a
 * warning. For test isolation, pass a Ghostty instance directly to the Terminal constructor.
 *
 * @example
 * ```typescript
 * import { init, Terminal } from 'ghostterm';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('terminal'));
 * ```
 *
 * To use the speed-optimized module instead of the default size-optimized one, pass its URL.
 * With Vite, for example:
 *
 * ```typescript
 * import fastWasm from 'ghostterm/ghostty-vt-fast.wasm?url';
 *
 * await init({ wasmPath: fastWasm });
 * ```
 */
export function init(options: InitOptions = {}): Promise<void> {
  const path = options.wasmPath === undefined ? undefined : String(options.wasmPath);
  if (loading) {
    if (path !== loadedPath) {
      console.warn(
        `ghostterm: init() was already called with ${describe(loadedPath)}; ` +
          `ignoring ${describe(path)}.`
      );
    }
    return loading;
  }
  loadedPath = path;
  loading = Ghostty.load(options.wasmPath).then(
    (ghostty) => {
      ghosttyInstance = ghostty;
    },
    (error) => {
      // Let a later init() try again.
      loading = null;
      throw error;
    }
  );
  return loading;
}

function describe(path: string | undefined): string {
  return path === undefined ? 'the bundled module' : `wasmPath ${path}`;
}

/**
 * Get the initialized Ghostty instance.
 * Throws if init() hasn't finished.
 * @internal
 */
export function getGhostty(): Ghostty {
  if (!ghosttyInstance) {
    throw new Error(
      'ghostterm not initialized. Call init() before creating Terminal instances.\n' +
        'Example:\n' +
        '  import { init, Terminal } from "ghostterm";\n' +
        '  await init();\n' +
        '  const term = new Terminal();\n\n' +
        'For tests, pass a Ghostty instance directly:\n' +
        '  import { Ghostty, Terminal } from "ghostterm";\n' +
        '  const ghostty = await Ghostty.load();\n' +
        '  const term = new Terminal({ ghostty });'
    );
  }
  return ghosttyInstance;
}
