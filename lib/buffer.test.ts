/**
 * Buffer API (xterm.js IBuffer, IBufferLine, IBufferCell) over a written terminal.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { IBufferCell, IBufferLine } from './interfaces';
import type { Terminal } from './terminal';
import { terminalFixture } from './test-helpers';

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

  test('the inactive buffer is empty instead of showing the active screen', () => {
    term.write('shell prompt');
    term.write('\x1b[?1049h\x1b[Hfull screen');
    const { normal, alternate } = term.buffer;
    expect(alternate.getLine(0)?.translateToString(true)).toBe('full screen');
    expect(normal.length).toBe(0);
    expect(normal.getLine(0)).toBeUndefined();

    term.write('\x1b[?1049l');
    expect(normal.getLine(0)?.translateToString(true)).toBe('shell prompt');
    expect(alternate.length).toBe(0);
    expect(alternate.getLine(0)).toBeUndefined();
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
