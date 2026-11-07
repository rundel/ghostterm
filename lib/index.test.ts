// init() keeps module-level state, so these tests live in their own file and run in order.

import { describe, expect, spyOn, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { Terminal, init } from './index';

describe('init()', () => {
  test('new Terminal() throws the documented message before init()', () => {
    expect(() => new Terminal()).toThrow(
      'ghostterm not initialized. Call init() before creating Terminal instances.'
    );
  });

  test('a failed load rejects and lets a later call try again', async () => {
    const load = spyOn(Ghostty, 'load').mockImplementation(() =>
      Promise.reject(new Error('no such module'))
    );
    try {
      await expect(init({ wasmPath: './missing.wasm' })).rejects.toThrow('no such module');
      expect(() => new Terminal()).toThrow('ghostterm not initialized');
    } finally {
      load.mockRestore();
    }
  });

  test('concurrent calls load the default module once, and Terminal works afterwards', async () => {
    const load = spyOn(Ghostty, 'load');
    try {
      const first = init();
      const second = init();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0][0]).toBeUndefined();
    } finally {
      load.mockRestore();
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const term = new Terminal({ cols: 20, rows: 5 });
    try {
      term.open(container);
      term.write('hello');
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('hello');
    } finally {
      term.dispose();
      container.remove();
    }
  });

  test('a later call is a no-op, and warns if it asks for a different module', async () => {
    const load = spyOn(Ghostty, 'load');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await init();
      expect(warn).not.toHaveBeenCalled();
      await init({ wasmPath: './ghostty-vt-fast.wasm' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toBe(
        'ghostterm: init() was already called with the bundled module; ' +
          'ignoring wasmPath ./ghostty-vt-fast.wasm.'
      );
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      warn.mockRestore();
    }
  });
});
