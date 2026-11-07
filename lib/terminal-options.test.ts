/**
 * Terminal options: defaults, runtime changes through the options proxy,
 * theme and cursor settings, and what they change on screen.
 */

import { describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { drawnText, internals, paintedRects, render, stub, terminalFixture } from './test-helpers';

const fixture = terminalFixture();

/** The cursor as drawn by a full frame: its rectangle in cells, or null when not drawn. */
function drawnCursor(term: Terminal, color = 'rgb(255, 255, 255)') {
  const { renderer } = internals(term);
  const rects = paintedRects(render(term), color);
  if (rects.length === 0) return null;
  const r = rects[0];
  const w = renderer.charWidth;
  const h = renderer.charHeight;
  const shape = r.h < h ? 'underline' : r.w < w ? 'bar' : 'block';
  return { shape, col: Math.round(r.x / w), row: Math.round(r.y / h) };
}

describe('defaults and mutation', () => {
  test('options reflect the constructor values, with xterm.js defaults otherwise', () => {
    const term = fixture.create({ cols: 100, rows: 30, scrollback: 5000 });
    expect([term.options.cols, term.options.rows, term.options.scrollback]).toEqual([
      100, 30, 5000,
    ]);
    const plain = fixture.create();
    expect(plain.options).toMatchObject({
      cols: 80,
      rows: 24,
      scrollback: 10000,
      cursorStyle: 'block',
      cursorBlink: false,
      fontSize: 15,
      fontFamily: 'monospace',
      convertEol: false,
      disableStdin: false,
    });
  });

  test('options set before open() are kept and applied by open()', () => {
    const term = fixture.create({ cursorStyle: 'block' });
    term.options.cursorStyle = 'underline';
    term.options.cols = 50;
    term.options.rows = 12;
    expect(term.options.cursorStyle).toBe('underline');
    const container = document.createElement('div');
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    term.open(container);
    expect([term.cols, term.rows]).toEqual([50, 12]);
    expect([term.wasmTerm?.cols, term.wasmTerm?.rows]).toEqual([50, 12]);
    expect(drawnCursor(term)?.shape).toBe('underline');
  });

  test('changing cols or rows resizes', () => {
    const { term } = fixture.open({ cols: 80, rows: 24 });
    const events: Array<{ cols: number; rows: number }> = [];
    term.onResize((e) => events.push(e));
    term.options.cols = 100;
    term.options.rows = 40;
    expect([term.cols, term.rows]).toEqual([100, 40]);
    expect(events).toEqual([
      { cols: 100, rows: 24 },
      { cols: 100, rows: 40 },
    ]);
  });

  test('convertEol turns LF into CR LF', () => {
    const { term } = fixture.open({ cols: 80, rows: 24, convertEol: true });
    term.write('line1\nline2');
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([5, 1]);
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe('line2');
  });
});

describe('scrollback', () => {
  test('the limit is passed to libghostty, which prunes whole pages', () => {
    const { term } = fixture.open({ cols: 80, rows: 24, scrollback: 500 });
    const { term: roomy } = fixture.open({ cols: 80, rows: 24 });
    for (let i = 0; i < 600; i++) {
      term.write(`Line ${i}\r\n`);
      roomy.write(`Line ${i}\r\n`);
    }
    // Pruning drops a page at a time, so fewer lines than the limit can remain.
    expect(term.getScrollbackLength()).toBeLessThanOrEqual(500);
    expect(term.getScrollbackLength()).toBeGreaterThan(0);
    // The same output with the default limit keeps every line.
    expect(roomy.getScrollbackLength()).toBe(600 + 1 - 24);
  });

  test('changes apply after open()', () => {
    const { term } = fixture.open({ cols: 20, rows: 5, scrollback: 0 });
    for (let i = 0; i < 20; i++) term.write(`${i}\r\n`);
    expect(term.buffer.active.baseY).toBe(0);

    term.options.scrollback = 1000;
    for (let i = 0; i < 20; i++) term.write(`${i}\r\n`);
    expect(term.buffer.active.baseY).toBe(20);
    term.scrollToTop();

    term.options.scrollback = 0;
    term.write('more\r\n');
    expect(term.buffer.active.baseY).toBe(0);
    expect(term.getViewportY()).toBe(0);
  });
});

describe('fonts', () => {
  test('fontSize resizes the cells and canvas, keeping cols and rows', () => {
    const { term } = fixture.open({ fontSize: 15, cols: 80, rows: 24 });
    const { renderer, canvas } = internals(term);
    // The canvas mock measures ascent + descent as the font size.
    expect(renderer.charHeight).toBe(15 + 2);
    term.options.fontSize = 20;
    expect(renderer.charHeight).toBe(20 + 2);
    expect(canvas.style.height).toBe(`${24 * 22}px`);
    expect([term.cols, term.rows]).toEqual([80, 24]);
    term.write('x');
    expect(drawnText(term)[0].font).toBe('20px monospace');
  });

  test('fontFamily is used for drawing', () => {
    const { term } = fixture.open({ fontFamily: 'monospace' });
    term.options.fontFamily = 'Courier New, monospace';
    term.write('\x1b[1;3mx');
    expect(drawnText(term)[0].font).toBe('italic bold 15px Courier New, monospace');
  });

  test('a font change clears the selection (its pixel positions moved)', () => {
    const { term } = fixture.open({ fontSize: 15 });
    term.write('Hello World');
    term.select(0, 0, 5);
    expect(term.getSelection()).toBe('Hello');
    term.options.fontSize = 20;
    expect(term.hasSelection()).toBe(false);
  });
});

describe('cursor', () => {
  test('the configured style is the default, drawn at the cursor', () => {
    const { term } = fixture.open({ cursorStyle: 'bar' });
    term.write('ab');
    expect(term.wasmTerm?.getCursor()).toMatchObject({ style: 'bar', blinking: false });
    expect(drawnCursor(term)).toEqual({ shape: 'bar', col: 2, row: 0 });
  });

  test('changing cursorStyle redraws the cursor in the new shape', () => {
    const { term } = fixture.open();
    expect(drawnCursor(term)?.shape).toBe('block');
    term.options.cursorStyle = 'underline';
    expect(drawnCursor(term)?.shape).toBe('underline');
  });

  test('cursorBlink hides the cursor every other blink tick, and stops when turned off', () => {
    const ticks: Array<() => void> = [];
    fixture.defer(
      stub(window, 'setInterval', ((fn: () => void) => {
        ticks.push(fn);
        return 1;
      }) as unknown as typeof window.setInterval)
    );
    const { term } = fixture.open({ cursorBlink: false });
    expect(ticks).toHaveLength(0);
    term.options.cursorBlink = true;
    expect(term.wasmTerm?.getCursor().blinking).toBe(true);
    expect(ticks).toHaveLength(1);
    expect(drawnCursor(term)).not.toBeNull();
    ticks[0]();
    expect(drawnCursor(term)).toBeNull();
    ticks[0]();
    expect(drawnCursor(term)).not.toBeNull();
    ticks[0]();
    term.options.cursorBlink = false;
    expect(drawnCursor(term)).not.toBeNull();
  });

  test('programs can change shape and blink (DECSCUSR), and reset to the default', () => {
    const { term } = fixture.open();
    expect(term.wasmTerm?.getCursor()).toMatchObject({ style: 'block', blinking: false });
    term.write('\x1b[5 q'); // blinking bar, as vim uses in insert mode
    expect(term.wasmTerm?.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    expect(drawnCursor(term)?.shape).toBe('bar');
    term.write('\x1b[0 q');
    expect(term.wasmTerm?.getCursor()).toMatchObject({ style: 'block', blinking: false });
    expect(drawnCursor(term)?.shape).toBe('block');
  });

  test('programs can set the cursor color (OSC 12)', () => {
    const { term } = fixture.open();
    term.write('\x1b]12;#ff8800\x07');
    expect(drawnCursor(term, 'rgb(255, 136, 0)')).toEqual({ shape: 'block', col: 0, row: 0 });
    expect(drawnCursor(term)).toBeNull();
  });
});

describe('theme', () => {
  const rgb = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b];

  test('foreground, background and palette are passed to libghostty', () => {
    const { term } = fixture.open({
      theme: { foreground: '#00ff00', background: '#000080', red: '#ff0000' },
    });
    const colors = term.wasmTerm?.getColors();
    expect(colors && rgb(colors.foreground)).toEqual([0, 255, 0]);
    expect(colors && rgb(colors.background)).toEqual([0, 0, 128]);
    term.write('\x1b[31mRed text\x1b[0m');
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(0xff0000);
  });

  test('without a theme libghostty uses the default theme colors', () => {
    const { term } = fixture.open();
    const colors = term.wasmTerm?.getColors();
    expect(colors && rgb(colors.foreground)).toEqual([0xd4, 0xd4, 0xd4]);
    expect(colors && rgb(colors.background)).toEqual([0x1e, 0x1e, 0x1e]);
  });

  test('a pure black background is honored (0x000000 is a real color)', () => {
    const { term } = fixture.open({ theme: { background: '#000000', foreground: '#ffffff' } });
    term.write('x');
    expect(term.wasmTerm?.getColors().background).toEqual({ r: 0, g: 0, b: 0 });
    expect(term.wasmTerm?.getColors().foreground).toEqual({ r: 255, g: 255, b: 255 });
  });

  test('changing the theme after open() recolors existing text', () => {
    const { term } = fixture.open();
    term.write('\x1b[31mred\x1b[0m plain');
    const fg = (x: number) => term.buffer.active.getLine(0)?.getCell(x)?.getFgColor();
    term.options.theme = { background: '#fdf6e3', foreground: '#657b83', red: '#dc322f' };
    expect(fg(0)).toBe(0xdc322f);
    expect(fg(4)).toBe(0x657b83);
    const cell = term.wasmTerm?.getLine(0)?.[4];
    expect(cell && [cell.bg_r, cell.bg_g, cell.bg_b]).toEqual([0xfd, 0xf6, 0xe3]);

    // Back to the defaults
    term.options.theme = {};
    expect(fg(0)).toBe(0xcd3131);
  });

  test('programs asking for the colors get the defaults even without a theme', () => {
    const { term, sent } = fixture.open();
    term.write('\x1b]10;?\x07\x1b]11;?\x07');
    expect(sent.join('')).toBe('\x1b]10;rgb:d4d4/d4d4/d4d4\x07\x1b]11;rgb:1e1e/1e1e/1e1e\x07');
  });

  test('color scheme queries are answered from the theme, and follow changes', () => {
    const { term, sent } = fixture.open();
    term.write('\x1b[?996n');
    expect(sent).toEqual(['\x1b[?997;1n']); // the default theme is dark
    term.options.theme = { background: '#ffffff' };
    term.write('\x1b[?996n');
    expect(sent).toEqual(['\x1b[?997;1n', '\x1b[?997;2n']);

    const light = fixture.open({ theme: { background: '#fafafa' } });
    light.term.write('\x1b[?996n');
    expect(light.sent).toEqual(['\x1b[?997;2n']);
  });
});

describe('allowClipboardWrite', () => {
  function clipboardWrites() {
    const writes: string[] = [];
    fixture.defer(
      stub(navigator, 'clipboard', {
        writeText: async (t: string) => void writes.push(t),
      } as unknown as Clipboard)
    );
    return writes;
  }

  test('OSC 52 writes reach the clipboard by default', () => {
    const writes = clipboardWrites();
    const { term } = fixture.open();
    term.write(`\x1b]52;c;${btoa('copied')}\x07`);
    expect(writes).toEqual(['copied']);
  });

  test('false is honored, while onClipboardWrite still reports the request', () => {
    const writes = clipboardWrites();
    const { term } = fixture.open({ allowClipboardWrite: false });
    const events: string[] = [];
    term.onClipboardWrite(({ text }) => events.push(text));
    term.write(`\x1b]52;c;${btoa('secret')}\x07`);
    expect(writes).toEqual([]);
    expect(events).toEqual(['secret']);
  });
});
