/**
 * The xterm.js buffer API and link detection, backed by libghostty's grid.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

let container: HTMLElement;
let term: Terminal;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  term = await createIsolatedTerminal({ cols: 10, rows: 3 });
  term.open(container);
});

afterEach(() => {
  term.dispose();
  container.remove();
});

describe('buffer', () => {
  test('wrapped lines in scrollback are reported as wrapped', () => {
    term.write('0123456789abcdef\r\nx\r\ny\r\nz');
    const buffer = term.buffer.active;
    expect(buffer.baseY).toBeGreaterThan(0);
    expect(buffer.getLine(0)!.isWrapped).toBe(false);
    expect(buffer.getLine(1)!.isWrapped).toBe(true); // continuation, now in scrollback
    expect(buffer.getLine(1)!.translateToString(true)).toBe('abcdef');
  });

  test('translateToString keeps whole grapheme clusters', () => {
    term.write('a👨‍👩‍👧b');
    expect(term.buffer.active.getLine(term.buffer.active.baseY)!.translateToString(true)).toBe(
      'a👨‍👩‍👧b'
    );
  });

  test('baseY and viewportY follow the scrollback and scroll position (xterm.js semantics)', () => {
    for (let i = 0; i < 10; i++) term.write(`line ${i}\r\n`);
    const buffer = term.buffer.active;
    const base = buffer.baseY;
    expect(base).toBe(term.wasmTerm!.getScrollbackLength());
    expect(buffer.viewportY).toBe(base);
    term.scrollLines(-2);
    expect(buffer.viewportY).toBe(base - 2);
  });
});

describe('OSC 8 hyperlinks', () => {
  const link = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

  test('neighboring links get different IDs; one link keeps its ID across lines', () => {
    term.write(link('https://a.example', 'aaaa') + link('https://b.example', 'bbbbbbbbbbbb'));
    const row0 = term.wasmTerm!.getViewportLine(0)!;
    const row1 = term.wasmTerm!.getViewportLine(1)!;
    expect(row0[0].hyperlink_id).toBeGreaterThan(0);
    expect(row0[4].hyperlink_id).toBeGreaterThan(0);
    expect(row0[0].hyperlink_id).not.toBe(row0[4].hyperlink_id);
    expect(row1[0].hyperlink_id).toBe(row0[4].hyperlink_id); // same link, wrapped
  });

  test('the provider finds links in scrollback by absolute row', async () => {
    term.write(link('https://old.example', 'old') + '\r\n1\r\n2\r\n3\r\n4');
    const detector = (term as any).linkDetector;
    const found = await detector.getLinkAt(1, 0);
    expect(found?.text ?? found?.uri ?? found).toBeTruthy();
    expect(JSON.stringify(found)).toContain('https://old.example');
  });
});
