/**
 * Buffer API (xterm.js IBuffer, IBufferLine, IBufferCell) over a written terminal.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { IBufferCell, IBufferLine } from './interfaces';
import type { Terminal } from './terminal';
import { drawnText, internals, render, terminalFixture } from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;

beforeEach(() => {
  term = fixture.open({ cols: 80, rows: 24 }).term;
});

function line(y: number): IBufferLine {
  const l = term.buffer.active.getLine(y);
  if (!l) throw new Error(`no line ${y}`);
  return l;
}

function cell(y: number, x: number): IBufferCell {
  const c = line(y).getCell(x);
  if (!c) throw new Error(`no cell ${x},${y}`);
  return c;
}

describe('buffers', () => {
  test('the active buffer follows the alternate screen', () => {
    expect(term.buffer.active).toBe(term.buffer.normal);
    expect(term.buffer.normal.type).toBe('normal');
    expect(term.buffer.alternate.type).toBe('alternate');
    term.write('\x1b[?1049h');
    expect(term.buffer.active).toBe(term.buffer.alternate);
    term.write('\x1b[?1049l');
    expect(term.buffer.active).toBe(term.buffer.normal);
  });

  test('the normal buffer reads the primary screen while the alternate screen is up', () => {
    for (let i = 0; i < 30; i++) term.write(`history ${i}\r\n`);
    term.write('\x1b[1mshell\x1b[0m prompt');
    term.write('\x1b[?1049h\x1b[Hfull screen');
    const { normal, alternate } = term.buffer;
    expect(term.buffer.active).toBe(alternate);
    expect(alternate.getLine(0)?.translateToString(true)).toBe('full screen');

    expect(normal.baseY).toBe(7);
    expect(normal.length).toBe(31);
    expect(normal.viewportY).toBe(7);
    expect(normal.getLine(0)?.translateToString(true)).toBe('history 0');
    expect(normal.getLine(29)?.translateToString(true)).toBe('history 29');
    expect(normal.getLine(30)?.translateToString(true)).toBe('shell prompt');
    expect(normal.getLine(30)?.getCell(0)?.isBold()).toBe(1);
    expect(normal.getLine(31)).toBeUndefined();
    // Its cursor isn't known (libghostty keeps it as the saved cursor).
    expect([normal.cursorX, normal.cursorY]).toEqual([0, 0]);

    // A write may change the primary screen (here, by leaving and coming back).
    term.write('\x1b[?1049l\r\nmore\x1b[?1049h');
    expect(normal.getLine(31)?.translateToString(true)).toBe('more');

    term.write('\x1b[?1049l');
    expect(normal.getLine(31)?.translateToString(true)).toBe('more');
    // The alternate buffer is empty while the normal screen is active, as in xterm.js.
    expect(alternate.length).toBe(0);
    expect(alternate.getLine(0)).toBeUndefined();
  });

  test('reading the normal buffer during the alternate screen leaves no trace', () => {
    const { term: t, sent } = fixture.open({ cols: 20, rows: 5 });
    for (let i = 0; i < 10; i++) t.write(`line ${i}\r\n`);
    t.write('\x1b[?1049h\x1b[?1h\x1b[>1u\x1b[Hfull\r\nscreen\x1b[2;3H');
    t.select(0, 1, 6);
    const { renderer } = internals(t);
    render(t);
    const before = {
      text: [0, 1].map((y) => t.buffer.active.getLine(y)?.translateToString(true)),
      cursor: [t.buffer.active.cursorX, t.buffer.active.cursorY],
      selection: t.getSelectionPosition(),
      modes: [47, 1047, 1049, 1].map((m) => t.getMode(m)),
      viewport: t.getViewportY(),
    };

    // Nothing is dirty, so a frame after the read draws nothing.
    expect(t.buffer.normal.getLine(3)?.translateToString(true)).toBe('line 3');
    expect(renderer.render(t.wasmTerm!, false, 0)).toBeNull();

    // Rows that were dirty before the read are drawn after it, and only those.
    const output = '\x1b[4;1Hdirty\x1b[2;3H';
    t.write(output);
    const drawn = renderer.render(t.wasmTerm!, false, 0);
    expect(drawn).not.toBeNull();
    t.write(output);
    expect(t.buffer.normal.getLine(9)?.translateToString(true)).toBe('line 9');
    expect(renderer.render(t.wasmTerm!, false, 0)).toEqual(drawn);

    expect({
      text: [0, 1].map((y) => t.buffer.active.getLine(y)?.translateToString(true)),
      cursor: [t.buffer.active.cursorX, t.buffer.active.cursorY],
      selection: t.getSelectionPosition(),
      modes: [47, 1047, 1049, 1].map((m) => t.getMode(m)),
      viewport: t.getViewportY(),
    }).toEqual(before);
    expect(t.buffer.active).toBe(t.buffer.alternate);
    // The Kitty keyboard flags of the alternate screen still apply.
    t.write('\x1b[?u');
    expect(sent).toEqual(['\x1b[?1u']);
    // Leaving the alternate screen restores the primary screen's cursor as usual.
    t.write('\x1b[?1049l');
    expect([t.buffer.active.cursorX, t.buffer.active.cursorY]).toEqual([0, 4]);
  });

  test('reading the normal buffer keeps a frame held by synchronized output', () => {
    const { term: t } = fixture.open({ cols: 20, rows: 5 });
    t.write('primary\x1b[?1049h\x1b[Hshown');
    render(t);
    t.write('\x1b[?2026h\x1b[Hhidden');
    expect(t.buffer.normal.getLine(0)?.translateToString(true)).toBe('primary');
    const text = drawnText(t)
      .filter((d) => d.row === 0)
      .map((d) => d.text)
      .join('');
    expect(text).toBe('shown');
  });

  test('cursor position, including the pending wrap at the last column', () => {
    term.write('Hello\r\nWorld');
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([5, 1]);
    term.write('\r\n' + 'X'.repeat(80));
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([79, 2]);
  });

  test('length is the rows plus the history', () => {
    expect(term.buffer.normal.length).toBe(24);
    for (let i = 0; i < 30; i++) term.write(`${i}\r\n`);
    expect(term.buffer.normal.length).toBe(24 + term.buffer.normal.baseY);
    expect(term.buffer.normal.baseY).toBe(7);
  });

  test('the null cell is empty', () => {
    const nullCell = term.buffer.active.getNullCell();
    expect([nullCell.getCode(), nullCell.getChars(), nullCell.getWidth()]).toEqual([0, '', 1]);
  });

  test('out of range lines and cells are undefined', () => {
    expect(term.buffer.active.getLine(10000)).toBeUndefined();
    expect(line(0).getCell(200)).toBeUndefined();
  });
});

describe('lines', () => {
  test('lines have the terminal width and read back what was written', () => {
    term.write('Line 1\r\n\x1b[32mLine 2\x1b[0m\r\nHéllo 日本語 😀');
    expect(line(0).length).toBe(80);
    expect([0, 1, 2].map((y) => line(y).translateToString(true))).toEqual([
      'Line 1',
      'Line 2',
      'Héllo 日本語 😀',
    ]);
    expect(line(3).translateToString(true)).toBe('');
  });

  test('translateToString pads unless trimmed and honors the column range', () => {
    term.write('Hello, World!');
    expect(line(0).translateToString()).toBe('Hello, World!'.padEnd(80));
    expect(line(0).translateToString(true)).toBe('Hello, World!');
    expect(line(0).translateToString(false, 7, 12)).toBe('World');
  });

  test('translateToString keeps empty cells as spaces', () => {
    term.write('a\x1b[3Cb');
    expect(line(0).translateToString(true)).toBe('a   b');
    expect(line(0).translateToString(false, 0, 6)).toBe('a   b ');
    expect(cell(0, 1).getChars()).toBe('');
  });

  test('translateToString adds nothing for the second half of a wide character', () => {
    term.write('日x');
    expect(line(0).translateToString(true)).toBe('日x');
    expect(cell(0, 0).getWidth()).toBe(2);
    expect(cell(0, 1).getWidth()).toBe(0);
  });

  test('a full line is kept whole and isWrapped marks the line it continues on', () => {
    term.write('A'.repeat(80));
    expect(line(0).translateToString(true)).toBe('A'.repeat(80));
    expect(line(0).isWrapped).toBe(false);
    term.write('BBBBB');
    expect(line(1).isWrapped).toBe(true);
    expect(line(1).translateToString(true)).toBe('BBBBB');
  });
});

describe('cells', () => {
  test('characters, codepoints and widths', () => {
    term.write('A😀');
    expect([cell(0, 0).getChars(), cell(0, 0).getCode(), cell(0, 0).getWidth()]).toEqual([
      'A',
      65,
      1,
    ]);
    expect([cell(0, 1).getChars(), cell(0, 1).getCode(), cell(0, 1).getWidth()]).toEqual([
      '😀',
      0x1f600,
      2,
    ]);
    expect([cell(0, 50).getChars(), cell(0, 50).getCode()]).toEqual(['', 0]);
  });

  test.each([
    ['1', 'isBold'],
    ['2', 'isFaint'],
    ['3', 'isItalic'],
    ['4', 'isUnderline'],
    ['5', 'isBlink'],
    ['7', 'isInverse'],
    ['8', 'isInvisible'],
    ['9', 'isStrikethrough'],
  ] as const)('SGR %s sets %s and nothing else', (sgr, attr) => {
    term.write(`\x1b[${sgr}mX\x1b[0mY`);
    const all = [
      'isBold',
      'isFaint',
      'isItalic',
      'isUnderline',
      'isBlink',
      'isInverse',
      'isInvisible',
      'isStrikethrough',
    ] as const;
    for (const a of all) expect([a, cell(0, 0)[a]()]).toEqual([a, a === attr ? 1 : 0]);
    for (const a of all) expect([a, cell(0, 1)[a]()]).toEqual([a, 0]);
  });

  test('attributes combine', () => {
    term.write('\x1b[1;3;4mX');
    const c = cell(0, 0);
    expect([c.isBold(), c.isItalic(), c.isUnderline(), c.isInverse()]).toEqual([1, 1, 1, 0]);
  });

  test('palette colors resolve to the theme RGB', () => {
    term.write('\x1b[31mr\x1b[0m\x1b[41mb');
    expect(cell(0, 0).getFgColor()).toBe(0xcd3131);
    expect(cell(0, 1).getBgColor()).toBe(0xcd3131);
  });

  test('color modes follow xterm.js', () => {
    term.write('\x1b[41mr\x1b[0md\x1b[38;2;1;2;3mf\x1b[0m\x1b[1mb');
    const red = cell(0, 0);
    expect(red.getBgColorMode()).toBe(0x3000000);
    expect(red.isBgRGB()).toBe(true);
    expect(red.isBgDefault()).toBe(false);
    expect(red.isFgDefault()).toBe(true);
    expect(red.isAttributeDefault()).toBe(false);
    const plain = cell(0, 1);
    expect(plain.getBgColorMode()).toBe(0);
    expect(plain.getFgColorMode()).toBe(0);
    expect(plain.isBgDefault()).toBe(true);
    expect(plain.isFgDefault()).toBe(true);
    expect(plain.isAttributeDefault()).toBe(true);
    const fg = cell(0, 2);
    expect(fg.getFgColorMode()).toBe(0x3000000);
    expect(fg.isFgRGB()).toBe(true);
    expect(fg.isFgDefault()).toBe(false);
    expect(fg.isAttributeDefault()).toBe(false);
    expect(fg.getFgColor()).toBe(0x010203);
    expect(cell(0, 3).isAttributeDefault()).toBe(false);
    // An empty cell past the text
    expect(cell(0, 10).isAttributeDefault()).toBe(true);
  });
});
