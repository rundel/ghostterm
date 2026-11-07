/**
 * The xterm.js buffer API and link detection, backed by libghostty's grid.
 */

import { beforeEach, describe, expect, jest, test } from 'bun:test';
import type { ILink } from './interfaces';
import type { LinkDetector } from './link-detector';
import type { Terminal } from './terminal';
import {
  timers,
  type DrawCall,
  internals,
  mouseEvent,
  render,
  strokes,
  stub,
  terminalFixture,
} from './test-helpers';

const fixture = terminalFixture();
// Bun has advanceTimersByTime; the installed bun-types (1.3.2) don't declare it yet.
let term: Terminal;

beforeEach(() => {
  term = fixture.open({ cols: 10, rows: 3 }).term;
});

const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

function detector(): LinkDetector {
  const d = term['linkDetector'];
  if (!d) throw new Error('no link detector');
  return d;
}

describe('buffer', () => {
  test('wrapped lines in scrollback are reported as wrapped', () => {
    term.write('0123456789abcdef\r\nx\r\ny\r\nz');
    const buffer = term.buffer.active;
    expect(buffer.baseY).toBe(2);
    expect(buffer.getLine(0)?.isWrapped).toBe(false);
    expect(buffer.getLine(1)?.isWrapped).toBe(true); // continuation, now in scrollback
    expect(buffer.getLine(1)?.translateToString(true)).toBe('abcdef');
  });

  test('translateToString keeps whole grapheme clusters', () => {
    term.write('a👨‍👩‍👧b');
    const buffer = term.buffer.active;
    expect(buffer.getLine(buffer.baseY)?.translateToString(true)).toBe('a👨‍👩‍👧b');
  });

  test('baseY and viewportY follow the scrollback and scroll position (xterm.js semantics)', () => {
    for (let i = 0; i < 10; i++) term.write(`line ${i}\r\n`);
    const buffer = term.buffer.active;
    expect(buffer.baseY).toBe(8);
    expect(buffer.baseY).toBe(term.getScrollbackLength());
    expect(buffer.viewportY).toBe(8);
    term.scrollLines(-2);
    expect(buffer.viewportY).toBe(6);
  });
});

describe('OSC 8 hyperlinks', () => {
  test('neighboring links get different IDs; one link keeps its ID across lines', () => {
    term.write(osc8('https://a.example', 'aaaa') + osc8('https://b.example', 'bbbbbbbbbbbb'));
    const { wasmTerm } = internals(term);
    const row0 = wasmTerm.getViewportLine(0) ?? [];
    const row1 = wasmTerm.getViewportLine(1) ?? [];
    expect(row0[0].hyperlink_id).toBeGreaterThan(0);
    expect(row0[4].hyperlink_id).toBeGreaterThan(0);
    expect(row0[0].hyperlink_id).not.toBe(row0[4].hyperlink_id);
    expect(row1[0].hyperlink_id).toBe(row0[4].hyperlink_id); // same link, wrapped
  });

  test('the provider finds links in scrollback by absolute row', async () => {
    term.write(osc8('https://old.example', 'old') + '\r\n1\r\n2\r\n3\r\n4');
    expect(term.buffer.active.baseY).toBe(2);
    const found = await detector().getLinkAt(1, 0);
    expect(found?.text).toBe('https://old.example');
    expect(found?.range).toEqual({ start: { x: 0, y: 0 }, end: { x: 2, y: 0 } });
    expect(await detector().getLinkAt(3, 0)).toBeUndefined();
  });

  test('a link that wraps is one range across the rows', async () => {
    term.write('ab' + osc8('https://wrap.example', 'abcdefghijkl') + ' x');
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
    term.write(osc8('https://real.example', 'https://shown.example'));
    expect((await detector().getLinkAt(3, 0))?.text).toBe('https://real.example');
  });

  test('positions outside the buffer have no link', async () => {
    term.write('http://a.b');
    expect(await detector().getLinkAt(-1, 0)).toBeUndefined();
    expect(await detector().getLinkAt(10, 0)).toBeUndefined();
    expect(await detector().getLinkAt(0, 99)).toBeUndefined();
  });
});

describe('link lookup after the screen changes', () => {
  test('a link that was overwritten is not returned', async () => {
    term.write('http://a.b');
    expect((await detector().getLinkAt(2, 0))?.text).toBe('http://a.b');
    term.write('\r\x1b[2Kno link');
    expect(await detector().getLinkAt(2, 0)).toBeUndefined();
  });

  test('a link replaced by another at the same place returns the new one', async () => {
    term.write('http://a.b');
    const first = await detector().getLinkAt(2, 0);
    term.write('\rhttp://c.d');
    const second = await detector().getLinkAt(2, 0);
    expect(second?.text).toBe('http://c.d');
    expect(second).not.toBe(first);
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

  test('a link keeps its absolute row as output scrolls it into history', async () => {
    term.write('http://a.b\r\n');
    expect((await detector().getLinkAt(2, 0))?.text).toBe('http://a.b');
    term.write('1\r\n2\r\n3\r\n');
    expect(term.buffer.active.baseY).toBe(2);
    expect((await detector().getLinkAt(2, 0))?.text).toBe('http://a.b');
    expect(await detector().getLinkAt(2, 2)).toBeUndefined();
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
  let opened: string[];

  beforeEach(() => {
    opened = [];
    fixture.defer(
      stub(window, 'open', (url?: string | URL) => {
        opened.push(String(url));
        return null;
      })
    );
  });

  /** Dispatch a mouse event in the middle of a cell. */
  function mouse(type: string, col: number, row: number, init: MouseEventInit = {}) {
    const { renderer, canvas } = internals(term);
    const e = mouseEvent(
      type,
      (col + 0.5) * renderer.charWidth,
      (row + 0.5) * renderer.charHeight,
      init
    );
    canvas.dispatchEvent(e);
    return e;
  }

  /** Let a link lookup started by a mouse move settle. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const canvasCursor = () => internals(term).canvas.style.cursor;

  /**
   * Columns of viewport row `row` given the blue hover underline in `calls`. (An OSC 8 link is
   * underlined twice per cell, for its hyperlink ID and for the hovered link range.)
   */
  function underlinedCells(calls: DrawCall[], row = 0): number[] {
    const { charWidth, charHeight } = internals(term).renderer;
    const cols = strokes(calls)
      .filter((s) => s.strokeStyle === '#4A90E2')
      .map((s) => s.path[0])
      .filter(([, , y]) => Math.floor(y / charHeight) === row)
      .map(([, x]) => x / charWidth);
    return [...new Set(cols)];
  }

  test('hovering an OSC 8 link shows a pointer until the mouse moves off or leaves', async () => {
    term.write(`x${osc8('https://h.example', 'link')} y`);
    render(term);
    jest.useFakeTimers();
    try {
      mouse('mousemove', 2, 0);
      await settle();
      expect(canvasCursor()).toBe('pointer');
      // The hovered link is underlined, cell by cell, on the next frame.
      expect(underlinedCells(render(term, false))).toEqual([1, 2, 3, 4]);
      // Moves are throttled: the next one is handled once 16 ms have passed.
      mouse('mousemove', 7, 0);
      await settle();
      expect(canvasCursor()).toBe('pointer');
      timers.advanceTimersByTime(16);
      await settle();
      expect(canvasCursor()).toBe('text');
      expect(underlinedCells(render(term, false))).toEqual([]);

      timers.advanceTimersByTime(16);
      mouse('mousemove', 2, 0);
      await settle();
      expect(canvasCursor()).toBe('pointer');
      term.element?.dispatchEvent(new MouseEvent('mouseleave'));
      expect(canvasCursor()).toBe('text');
      expect(underlinedCells(render(term, false))).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('hovering a plain URL underlines its cells across the wrap', async () => {
    term.write('> https://wrap.org/xyz');
    render(term);
    mouse('mousemove', 4, 0);
    await settle();
    expect(canvasCursor()).toBe('pointer');
    const calls = render(term, false);
    expect(underlinedCells(calls, 0)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(underlinedCells(calls, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(underlinedCells(calls, 2)).toEqual([0, 1]);
    term.element?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(underlinedCells(render(term, false))).toEqual([]);
  });

  test('Cmd/Ctrl+click opens a link; a plain click does not', () => {
    term.write(`${osc8('https://o.example', 'open')} https://r.example`);
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
    term.write(
      osc8('javascript:alert(1)', 'js') +
        ' ' +
        osc8('file:///etc/passwd', 'file') +
        ' ' +
        osc8('not a uri', 'x')
    );
    mouse('click', 0, 0, { metaKey: true });
    mouse('click', 4, 0, { metaKey: true });
    mouse('click', 8, 0, { metaKey: true });
    expect(opened).toEqual([]);

    term.write('\r\n' + osc8('mailto:a@b.org', 'mail'));
    mouse('click', 1, 1, { metaKey: true });
    expect(opened).toEqual(['mailto:a@b.org']);
  });

  test('an asynchronous custom provider is consulted for hover and click', async () => {
    term.write('see TICKET-1');
    const events: string[] = [];
    const link: ILink = {
      text: 'TICKET-1',
      range: { start: { x: 4, y: 0 }, end: { x: 11, y: 0 } },
      activate: () => events.push('activate'),
      hover: (on) => events.push(on ? 'enter' : 'leave'),
    };
    // The provider answers when the test says so.
    const pending: Array<() => void> = [];
    term.registerLinkProvider({
      provideLinks(y, callback) {
        pending.push(() => callback(y === 0 ? [link] : undefined));
      },
    });
    const answered = async () => {
      for (const answer of pending.splice(0)) answer();
      await settle();
    };

    mouse('mousemove', 6, 0);
    await settle();
    expect(events).toEqual([]);
    await answered();
    expect(events).toEqual(['enter']);
    expect(canvasCursor()).toBe('pointer');

    mouse('click', 6, 0);
    expect(events).toEqual(['enter']);
    await answered();
    expect(events).toEqual(['enter', 'activate']);

    term.element?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(events).toEqual(['enter', 'activate', 'leave']);
  });
});
