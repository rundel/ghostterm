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
    const found = await detector().getLinkAt(1, 0);
    expect(found?.text).toBe('https://old.example');
    expect(found?.range).toEqual({ start: { x: 0, y: 0 }, end: { x: 2, y: 0 } });
  });

  test('a link that wraps is one range across the rows', async () => {
    term.write('ab' + link('https://wrap.example', 'abcdefghijkl') + ' x');
    for (const [col, row] of [
      [5, 0],
      [3, 1],
    ]) {
      const found = await detector().getLinkAt(col, row);
      expect(found?.text).toBe('https://wrap.example');
      expect(found?.range).toEqual({ start: { x: 2, y: 0 }, end: { x: 3, y: 1 } });
    }
    expect(await detector().getLinkAt(5, 1)).toBeUndefined();
  });

  test('takes precedence over a URL in the same text', async () => {
    term.write(link('https://real.example', 'https://shown.example'));
    expect((await detector().getLinkAt(3, 0))?.text).toBe('https://real.example');
  });
});

const detector = () => (term as any).linkDetector;

describe('link lookup after the screen changes', () => {
  test('a link that was overwritten is not returned', async () => {
    term.write('http://a.b');
    expect((await detector().getLinkAt(2, 0))?.text).toBe('http://a.b');
    term.write('\r\x1b[2Kno link');
    expect(await detector().getLinkAt(2, 0)).toBeUndefined();
  });

  test('no stale link after reset or a resize that reflows the text', async () => {
    term.write('http://a.b');
    expect((await detector().getLinkAt(2, 0))?.text).toBe('http://a.b');
    term.reset();
    expect(await detector().getLinkAt(2, 0)).toBeUndefined();

    term.write('xxxxx http://c.d');
    expect((await detector().getLinkAt(2, 1))?.text).toBe('http://c.d');
    term.resize(20, 3);
    expect(await detector().getLinkAt(2, 1)).toBeUndefined();
    expect((await detector().getLinkAt(8, 0))?.range).toEqual({
      start: { x: 6, y: 0 },
      end: { x: 15, y: 0 },
    });
  });

  test('a link is found after content scrolls under it', async () => {
    term.write('plain\r\n');
    expect(await detector().getLinkAt(2, 1)).toBeUndefined();
    term.write('https://b.org');
    expect((await detector().getLinkAt(2, 1))?.text).toBe('https://b.org');
  });

  test('the same link is returned as the same object while it is unchanged', async () => {
    term.write('https://c.org');
    expect(await detector().getLinkAt(1, 0)).toBe(await detector().getLinkAt(4, 0));
  });
});

describe('hovering and clicking links', () => {
  const g = globalThis as any;
  let opened: string[];
  let savedOpen: unknown;

  beforeEach(() => {
    opened = [];
    savedOpen = g.window.open;
    g.window.open = (url: string) => {
      opened.push(url);
      return null;
    };
  });

  afterEach(() => {
    g.window.open = savedOpen;
  });

  function mouse(type: string, col: number, row: number, init: MouseEventInit = {}) {
    const renderer = (term as any).renderer;
    const canvas: HTMLCanvasElement = renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const e = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + (col + 0.5) * renderer.charWidth,
      clientY: rect.top + (row + 0.5) * renderer.charHeight,
      ...init,
    });
    canvas.dispatchEvent(e);
    return e;
  }

  const tick = () => new Promise((r) => setTimeout(r, 20));
  const canvasCursor = () => ((term as any).renderer.getCanvas() as HTMLCanvasElement).style.cursor;

  test('hovering an OSC 8 link shows a pointer', async () => {
    term.write(`x${'\x1b]8;;https://h.example\x1b\\'}link${'\x1b]8;;\x1b\\'} y`);
    mouse('mousemove', 2, 0);
    await tick();
    expect(canvasCursor()).toBe('pointer');
    mouse('mousemove', 7, 0);
    await tick();
    expect(canvasCursor()).toBe('text');
  });

  test('Cmd/Ctrl+click opens a link; a plain click does not', () => {
    term.write(`${'\x1b]8;;https://o.example\x1b\\'}open${'\x1b]8;;\x1b\\'} https://r.example`);
    const plain = mouse('click', 1, 0);
    expect(opened).toEqual([]);
    expect(plain.defaultPrevented).toBe(false);

    const cmd = mouse('click', 1, 0, { metaKey: true });
    const ctrl = mouse('click', 8, 0, { ctrlKey: true });
    // Opened synchronously, inside the click's user gesture.
    expect(opened).toEqual(['https://o.example', 'https://r.example']);
    expect(cmd.defaultPrevented).toBe(true);
    expect(ctrl.defaultPrevented).toBe(true);
  });

  test('links with schemes other than http, https, mailto and ftp are not opened', () => {
    const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
    term.write(osc8('javascript:alert(1)', 'js') + ' ' + osc8('file:///etc/passwd', 'file'));
    mouse('click', 0, 0, { metaKey: true });
    mouse('click', 4, 0, { metaKey: true });
    expect(opened).toEqual([]);

    term.write('\r\n' + osc8('mailto:a@b.org', 'mail'));
    mouse('click', 1, 1, { metaKey: true });
    expect(opened).toEqual(['mailto:a@b.org']);
  });
});
