/**
 * The default module sources of the two bundles. The bundled one points at the repo's
 * ghostty-vt.wasm (inlined by the build); the slim one at the file next to the module that holds
 * it, which is dist/ghostterm-slim.js after the build. scripts/check-dist.ts loads the built slim
 * bundle itself.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { defaultWasmUrl } from './wasm-default';
import { defaultWasmUrl as slimWasmUrl } from './wasm-default-slim';

describe('default module source', () => {
  test('the bundled build loads the repo ghostty-vt.wasm', async () => {
    expect(defaultWasmUrl().href).toBe(new URL('../ghostty-vt.wasm', import.meta.url).href);
    const ghostty = await Ghostty.load();
    expect(ghostty.optimizeMode).toBe('release-small');
  });

  test('the slim build points at ghostty-vt.wasm next to its own module', () => {
    const url = slimWasmUrl();
    expect(url.protocol).toBe('file:');
    expect(url.href).toBe(new URL('./ghostty-vt.wasm', import.meta.url).href);
  });

  test('an http URL, as the slim bundle has in a browser, is fetched', async () => {
    const bytes = await Bun.file(new URL('../ghostty-vt-fast.wasm', import.meta.url)).arrayBuffer();
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(bytes))) as unknown as typeof fetch);
    try {
      const url = new URL('https://app.example/assets/ghostty-vt.wasm');
      const ghostty = await Ghostty.load(url);
      expect(ghostty.optimizeMode).toBe('release-fast');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe(url.href);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('a failed fetch names the status', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(
        new Response('', { status: 404, statusText: 'Not Found' })
      )) as unknown as typeof fetch);
    try {
      await expect(Ghostty.load(new URL('https://app.example/missing.wasm'))).rejects.toThrow(
        'Failed to fetch WASM: 404 Not Found'
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
