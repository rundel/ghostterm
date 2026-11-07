/**
 * Selection: the xterm.js selection API in absolute buffer rows, mouse
 * gestures (libghostty's selection gesture), drawing, copying and the context
 * menu, driven through dispatched DOM events and the public Terminal API.
 */

import { beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { DEFAULT_THEME } from './renderer';
import type { Terminal } from './terminal';
import {
  internals,
  keyDown,
  mouseEvent,
  paintedRects,
  stub,
  terminalFixture,
} from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;
let container: HTMLElement;

function open(cols: number, rows: number, scrollback?: number): void {
  ({ term, container } = fixture.open({ cols, rows, scrollback }));
}

interface CellEventInit {
  /** How far across the cell the pointer is (0..1). */
  fx?: number;
  time?: number;
  altKey?: boolean;
  shiftKey?: boolean;
  button?: number;
  target?: EventTarget;
}

/** Dispatch a mouse event over a cell (0-based viewport column and row). */
function cellEvent(type: string, col: number, row: number, init: CellEventInit = {}): MouseEvent {
  const { renderer, canvas } = internals(term);
  const { fx = 0.5, time = 1000, target = canvas, ...mods } = init;
  const e = mouseEvent(type, (col + fx) * renderer.charWidth, (row + 0.5) * renderer.charHeight, {
    button: 0,
    ...mods,
  });
  Object.defineProperty(e, 'timeStamp', { value: time });
  target.dispatchEvent(e);
  return e;
}

/**
 * Press near the left edge of one cell and drag past the midpoint of another
 * (Ghostty anchors and extends selections by cell halves), then release.
 */
function drag(from: [number, number], to: [number, number], init: CellEventInit = {}): void {
  cellEvent('mousedown', from[0], from[1], { ...init, fx: 0.1 });
  cellEvent('mousemove', to[0], to[1], { ...init, fx: 0.9, time: (init.time ?? 1000) + 50 });
  cellEvent('mouseup', to[0], to[1], { ...init, time: (init.time ?? 1000) + 60, target: document });
}

function click(col: number, row: number, time: number): void {
  cellEvent('mousedown', col, row, { time });
  cellEvent('mouseup', col, row, { time: time + 10, target: document });
}

/** Columns painted with the selection background, by viewport row. */
function drawnSelection(): Record<number, number[]> {
  const { renderer } = internals(term);
  const rows: Record<number, number[]> = {};
  for (const r of paintedRects(term, DEFAULT_THEME.selectionBackground)) {
    const row = r.y / renderer.charHeight;
    for (let x = r.x; x < r.x + r.w; x += renderer.charWidth) {
      rows[row] = [...(rows[row] ?? []), x / renderer.charWidth];
    }
  }
  return rows;
}

function writeLines(count: number, label = (i: number) => `Line ${i}`): void {
  for (let i = 0; i < count; i++) term.write(`${label(i)}\r\n`);
}

describe('selection API (absolute buffer rows, as in xterm.js)', () => {
  beforeEach(() => {
    open(10, 3);
    writeLines(6, (i) => `line ${i}`);
    term.write('last');
  });

  test('nothing is selected at first', () => {
    expect(term.hasSelection()).toBe(false);
    expect(term.getSelection()).toBe('');
    expect(term.getSelectionPosition()).toBeUndefined();
  });

  test('select() takes absolute rows, scrollback included, and continues onto later rows', () => {
    expect(term.buffer.active.baseY).toBe(4);
    term.select(0, 1, 6);
    expect(term.getSelection()).toBe('line 1');
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 1 }, end: { x: 6, y: 1 } });
    // A selection to the end of a row ends at x = cols.
    term.select(5, 1, 15);
    expect(term.getSelectionPosition()).toEqual({ start: { x: 5, y: 1 }, end: { x: 10, y: 2 } });
    term.select(5, 1, 20);
    expect(term.getSelectionPosition()).toEqual({ start: { x: 5, y: 1 }, end: { x: 5, y: 3 } });
    expect(term.getSelection()).toBe('1\nline 2\nline');
  });

  test('a one-cell selection is a selection', () => {
    term.select(5, 6, 1);
    expect(term.hasSelection()).toBe(true);
    expect(term.getSelectionPosition()).toEqual({ start: { x: 5, y: 6 }, end: { x: 6, y: 6 } });
  });

  test('selectLines() selects whole lines in either order', () => {
    term.selectLines(2, 3);
    expect(term.getSelection()).toBe('line 2\nline 3');
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 2 }, end: { x: 10, y: 3 } });
    term.selectLines(3, 2);
    expect(term.getSelection()).toBe('line 2\nline 3');
  });

  test('positions past the end of the buffer are clamped', () => {
    term.select(0, 100, 5);
    expect(term.getSelectionPosition()).toEqual({ start: { x: 9, y: 6 }, end: { x: 10, y: 6 } });
    term.selectLines(5, 100);
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 5 }, end: { x: 10, y: 6 } });
  });

  test('selectAll() selects everything, scrollback included', () => {
    term.selectAll();
    expect(term.getSelection()).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nline 5\nlast');
  });

  test('a selection keeps its text and position while scrolled away', () => {
    term.select(0, 6, 4);
    term.scrollToTop();
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 6 }, end: { x: 4, y: 6 } });
    expect(term.getSelection()).toBe('last');
  });

  test('a selection follows its content into scrollback', () => {
    term.select(0, 6, 4);
    term.write('\r\nmore\r\nand more');
    expect(term.getSelection()).toBe('last');
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 6 }, end: { x: 4, y: 6 } });
  });

  test('onSelectionChange fires for select and for clearing an existing selection', () => {
    let changes = 0;
    term.onSelectionChange(() => changes++);
    term.clearSelection();
    expect(changes).toBe(0);
    term.select(0, 0, 5);
    term.selectLines(1, 2);
    term.selectAll();
    expect(changes).toBe(3);
    term.clearSelection();
    expect(changes).toBe(4);
    expect(term.getSelectionPosition()).toBeUndefined();
  });

  test('typing clears the selection and fires onSelectionChange', () => {
    let changes = 0;
    term.onSelectionChange(() => changes++);
    term.select(0, 0, 5);
    keyDown(internals(term).textarea, 'KeyA', 'a');
    expect(term.hasSelection()).toBe(false);
    expect(changes).toBe(2);
  });
});

describe('drawing', () => {
  beforeEach(() => {
    open(20, 3);
    term.write('Line 1\r\nLine 2\r\nLine 3');
  });

  test('selected cells are painted with the selection background until cleared', () => {
    term.select(2, 0, 4);
    expect(drawnSelection()).toEqual({ 0: [2, 3, 4, 5] });
    term.clearSelection();
    expect(drawnSelection()).toEqual({});
  });

  test('a selection spanning rows paints to the end of the first and from the start of the last', () => {
    term.select(18, 0, 4);
    expect(drawnSelection()).toEqual({ 0: [18, 19], 1: [0, 1] });
  });
});

describe('mouse gestures', () => {
  beforeEach(() => open(40, 5));

  test('dragging selects text and copies it on release', () => {
    const written: string[] = [];
    fixture.defer(stub(globalThis as { ClipboardItem?: unknown }, 'ClipboardItem', undefined));
    fixture.defer(
      stub(navigator, 'clipboard', {
        writeText: async (t: string) => void written.push(t),
      } as unknown as Clipboard)
    );
    let changes = 0;
    term.onSelectionChange(() => changes++);
    term.write('hello world');
    drag([0, 0], [4, 0]);
    expect(term.getSelection()).toBe('hello');
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } });
    expect(written).toEqual(['hello']);
    expect(changes).toBe(1);
  });

  test('a drag ends only once the pointer passes the end cell midpoint', () => {
    term.write('hello world');
    cellEvent('mousedown', 0, 0, { fx: 0.1 });
    cellEvent('mousemove', 4, 0, { fx: 0.2, time: 1050 });
    cellEvent('mouseup', 4, 0, { time: 1060, target: document });
    expect(term.getSelection()).toBe('hell');
  });

  test('a plain click clears an existing selection', () => {
    term.write('hello world');
    term.select(0, 0, 5);
    let changes = 0;
    term.onSelectionChange(() => changes++);
    click(8, 0, 1000);
    expect(term.hasSelection()).toBe(false);
    expect(changes).toBe(1);
  });

  test('a click outside the terminal clears the selection; a drag ending outside does not', () => {
    term.write('hello world');
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    fixture.defer(() => outside.remove());

    drag([0, 0], [4, 0]);
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.getSelection()).toBe('hello');

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(term.hasSelection()).toBe(false);
  });

  test('double-click selects a word by Ghostty rules, triple-click the line', () => {
    term.write('ls ~/projects/ghostterm now');
    click(10, 0, 1000);
    click(10, 0, 1100);
    expect(term.getSelection()).toBe('~/projects/ghostterm');
    click(10, 0, 1200);
    expect(term.getSelection()).toBe('ls ~/projects/ghostterm now');
  });

  test('clicks far apart in time are not a double-click', () => {
    term.write('ls ~/projects/ghostterm');
    click(10, 0, 1000);
    click(10, 0, 3000);
    expect(term.hasSelection()).toBe(false);
  });

  test('triple-click while scrolled selects the scrollback line shown', () => {
    writeLines(20, (i) => `TestLine${i}`);
    term.scrollToTop();
    for (const t of [1000, 1100, 1200]) click(3, 1, t);
    expect(term.getSelection()).toBe('TestLine1');
    expect(term.getSelectionPosition()).toEqual({ start: { x: 0, y: 1 }, end: { x: 9, y: 1 } });
  });

  test('a program tracking the mouse gets clicks; Shift+drag still selects', () => {
    term.write('hello world\x1b[?1000h');
    drag([0, 0], [4, 0]);
    expect(term.hasSelection()).toBe(false);
    drag([0, 0], [4, 0], { shiftKey: true });
    expect(term.getSelection()).toBe('hello');
  });

  test('a click focuses the input textarea, so IME composes there', () => {
    const { textarea } = internals(term);
    textarea.blur();
    click(1, 1, 1000);
    expect(document.activeElement).toBe(textarea);
  });

  test('focusing the terminal element passes focus on to the textarea', () => {
    const { textarea } = internals(term);
    textarea.blur();
    container.focus();
    expect(document.activeElement).toBe(textarea);
  });

  test('dragging above the top autoscrolls into scrollback, one row per tick', () => {
    writeLines(20, (i) => `row ${i}`);
    term.write('last');
    jest.useFakeTimers();
    fixture.defer(() => jest.useRealTimers());
    cellEvent('mousedown', 2, 4);
    const { canvas } = internals(term);
    const rect = canvas.getBoundingClientRect();
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: rect.left + 5, clientY: rect.top - 20, bubbles: true })
    );
    jest.advanceTimersByTime(30 * 6);
    cellEvent('mouseup', 0, 0, { time: 1500, target: document });
    jest.advanceTimersByTime(30 * 6);

    // Six ticks scroll six rows (then the release stops them). The pointer, 5 px
    // into the row, is past the first cell's midpoint.
    expect(term.getViewportY()).toBe(6);
    expect(term.getSelectionPosition()).toEqual({ start: { x: 1, y: 10 }, end: { x: 2, y: 20 } });
    expect(term.getSelection()).toStartWith('ow 10\nrow 11\n');
  });

  test('selection keeps working after reset()', () => {
    term.write('before');
    term.select(0, 0, 3);
    term.reset();
    expect(term.hasSelection()).toBe(false);
    term.write('after');
    drag([0, 0], [4, 0]);
    expect(term.getSelection()).toBe('after');
  });
});

describe('selecting scrollback', () => {
  /** A terminal with 100 numbered lines (77 in history, 23 on screen and an empty last row). */
  function withHistory(prefix = 'Line ') {
    fixture.defer(
      stub(navigator, 'clipboard', { writeText: async () => {} } as unknown as Clipboard)
    );
    const opened = fixture.open({ cols: 80, rows: 24, scrollback: 1000 });
    for (let i = 0; i < 100; i++) opened.term.write(`${prefix}${String(i).padStart(3, '0')}\r\n`);
    return opened.term;
  }

  /** Drag from the middle of cell (c0, r0) past the middle of cell (c1, r1), which includes it. */
  function dragCells(term: Terminal, c0: number, r0: number, c1: number, r1: number) {
    const { canvas, renderer } = internals(term);
    const at = (c: number, r: number) =>
      [(c + 0.5) * renderer.charWidth, (r + 0.5) * renderer.charHeight] as const;
    canvas.dispatchEvent(mouseEvent('mousedown', ...at(c0, r0), { button: 0 }));
    canvas.dispatchEvent(mouseEvent('mousemove', ...at(c1 + 0.4, r1), { buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  test('a drag in a view scrolled into history selects the displayed lines', () => {
    const term = withHistory();
    term.scrollLines(-50);
    expect(term.getViewportY()).toBe(50);
    // Viewport row 0 is absolute row 77 - 50 = 27.
    dragCells(term, 0, 5, 7, 7);
    expect(term.getSelection()).toBe('Line 032\nLine 033\nLine 034');
    expect(term.getSelectionPosition()?.start).toEqual({ x: 0, y: 32 });
  });

  test('a drag spanning history and the screen', () => {
    const term = withHistory();
    term.scrollLines(-10);
    dragCells(term, 0, 8, 7, 12);
    expect(term.getSelection()).toBe('Line 075\nLine 076\nLine 077\nLine 078\nLine 079');
  });

  test('a drag at the bottom selects screen lines', () => {
    const term = withHistory();
    expect(term.getViewportY()).toBe(0);
    dragCells(term, 0, 0, 7, 2);
    expect(term.getSelection()).toBe('Line 077\nLine 078\nLine 079');
  });

  test('a fractional (smooth scrolling) viewport maps rows like the renderer, floored', () => {
    const term = withHistory();
    term.viewportY = 10.7;
    dragCells(term, 0, 0, 7, 1);
    expect(term.getSelection()).toBe('Line 067\nLine 068');
  });

  test('the oldest history lines, scrolled to the top', () => {
    const term = withHistory('Scrollback line ');
    term.scrollToTop();
    expect(term.getViewportY()).toBe(77);
    dragCells(term, 0, 0, 18, 2);
    expect(term.getSelection()).toBe(
      'Scrollback line 000\nScrollback line 001\nScrollback line 002'
    );
  });

  test('dragging past the top or bottom edge at the first column autoscrolls both ways', () => {
    const term = withHistory();
    jest.useFakeTimers();
    fixture.defer(() => jest.useRealTimers());
    term.scrollLines(-10);
    const { canvas, renderer } = internals(term);
    canvas.dispatchEvent(mouseEvent('mousedown', 4, 5 * renderer.charHeight + 4, { button: 0 }));
    const rect = canvas.getBoundingClientRect();
    const move = (clientY: number) =>
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: rect.left, clientY, bubbles: true })
      );
    move(rect.top - 20);
    jest.advanceTimersByTime(30 * 3);
    expect(term.getViewportY()).toBe(13);
    move(rect.top + 24 * renderer.charHeight + 20);
    jest.advanceTimersByTime(30 * 5);
    expect(term.getViewportY()).toBe(8);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
});

describe('block selection (Alt-drag)', () => {
  beforeEach(() => {
    open(40, 5);
    term.write('abcdef\r\nghijkl\r\nmnopqr');
  });

  test('Alt-drag selects and paints a block of columns', () => {
    drag([1, 0], [3, 2], { altKey: true });
    expect(term.getSelection()).toBe('bcd\nhij\nnop');
    expect(drawnSelection()).toEqual({ 0: [1, 2, 3], 1: [1, 2, 3], 2: [1, 2, 3] });
  });

  test('a block dragged up and to the left is the same block', () => {
    cellEvent('mousedown', 3, 2, { fx: 0.9, altKey: true });
    cellEvent('mousemove', 1, 0, { fx: 0.1, altKey: true, time: 1050 });
    cellEvent('mouseup', 1, 0, { altKey: true, target: document });
    expect(term.getSelection()).toBe('bcd\nhij\nnop');
  });

  test('the same drag without Alt is a linear selection', () => {
    drag([1, 0], [3, 2]);
    expect(term.getSelection()).toBe('bcdef\nghijkl\nmnop');
    expect(drawnSelection()).toEqual({
      0: [1, 2, 3, 4, 5, ...Array.from({ length: 34 }, (_, i) => i + 6)],
      1: Array.from({ length: 40 }, (_, i) => i),
      2: [0, 1, 2, 3],
    });
  });
});

describe('copying', () => {
  beforeEach(() => {
    open(40, 5);
    term.write('copy me');
    term.select(0, 0, 4);
  });

  const copyKeys = () => [
    keyDown(internals(term).textarea, 'KeyC', 'c', { metaKey: true }),
    keyDown(internals(term).textarea, 'KeyC', 'C', { ctrlKey: true, shiftKey: true }),
  ];

  test('Cmd+C and Ctrl+Shift+C write the selection as a ClipboardItem', async () => {
    const items: ClipboardItem[] = [];
    fixture.defer(
      stub(navigator, 'clipboard', {
        write: async (data: ClipboardItem[]) => void items.push(...data),
      } as unknown as Clipboard)
    );
    const sent: string[] = [];
    term.onData((d) => sent.push(d));
    const events = copyKeys();
    expect(events.map((e) => e.defaultPrevented)).toEqual([true, true]);
    expect(sent).toEqual([]);
    expect(items).toHaveLength(2);
    expect(await (await items[0].getType('text/plain')).text()).toBe('copy');
  });

  test('without ClipboardItem, writeText is used', () => {
    const written: string[] = [];
    fixture.defer(stub(globalThis as { ClipboardItem?: unknown }, 'ClipboardItem', undefined));
    fixture.defer(
      stub(navigator, 'clipboard', {
        writeText: async (t: string) => void written.push(t),
      } as unknown as Clipboard)
    );
    copyKeys();
    expect(written).toEqual(['copy', 'copy']);
  });

  test('a failed ClipboardItem write falls back to writeText, then to execCommand', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fixture.defer(() => warn.mockRestore());
    const copied: string[] = [];
    const { textarea } = internals(term);
    fixture.defer(
      stub(document, 'execCommand', (command: string) => {
        if (command === 'copy') copied.push(textarea.value);
        return true;
      })
    );
    fixture.defer(
      stub(navigator, 'clipboard', {
        write: () => Promise.reject(new Error('denied')),
        writeText: () => Promise.reject(new Error('denied')),
      } as unknown as Clipboard)
    );
    expect(term.copySelection()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toEqual(['copy']);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      'ClipboardItem write failed, trying writeText:',
      'Clipboard writeText failed, trying execCommand:',
    ]);
  });

  test('without the clipboard API, execCommand copies and the textarea is restored', () => {
    fixture.defer(stub(navigator, 'clipboard', undefined as unknown as Clipboard));
    const { textarea } = internals(term);
    const style = textarea.style.cssText;
    let valueDuringCopy = '';
    fixture.defer(
      stub(document, 'execCommand', (command: string) => {
        valueDuringCopy = command === 'copy' ? textarea.value : '';
        return true;
      })
    );
    copyKeys();
    expect(valueDuringCopy).toBe('copy');
    expect(textarea.value).toBe('');
    expect(textarea.style.cssText).toBe(style);
  });

  test('an execCommand copy that fails or throws is reported', () => {
    fixture.defer(stub(navigator, 'clipboard', undefined as unknown as Clipboard));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fixture.defer(() => warn.mockRestore());
    const results: Array<() => boolean> = [
      () => false,
      () => {
        throw new Error('blocked');
      },
    ];
    for (const result of results) {
      fixture.defer(stub(document, 'execCommand', result));
      term.copySelection();
    }
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      'execCommand copy failed',
      'execCommand copy threw:',
    ]);
  });

  test('copySelection() is false without a selection', () => {
    term.clearSelection();
    expect(term.copySelection()).toBe(false);
  });
});

describe('context menu', () => {
  beforeEach(() => {
    open(40, 5);
    term.write('copy this text');
  });

  function rightDown(): void {
    internals(term).canvas.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 50, clientY: 20 })
    );
  }

  /** prepareContextMenu() starts listening for the end of the menu in a 0 ms timeout. */
  const listening = () => new Promise((r) => setTimeout(r, 0));

  test('right mousedown puts the selected text under the pointer until the next key', async () => {
    term.select(0, 0, 9);
    const { textarea } = internals(term);
    const original = textarea.style.cssText;

    rightDown();
    expect(term.getSelection()).toBe('copy this'); // not cleared by the click
    expect(textarea.value).toBe('copy this');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 9]);
    expect(textarea.style.position).toBe('fixed');
    expect(textarea.style.left).toBe('48px');
    expect(textarea.style.clipPath).toBe('none');
    expect(textarea.style.pointerEvents).toBe('auto');
    expect(document.activeElement).toBe(textarea);

    await listening();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(textarea.style.cssText).toBe(original);
    expect(textarea.value).toBe('');
  });

  test('with no selection the textarea is still prepared (for Paste), and a press restores it', async () => {
    const { textarea } = internals(term);
    const original = textarea.style.cssText;
    rightDown();
    expect(textarea.value).toBe('');
    expect(textarea.style.clipPath).toBe('none');
    await listening();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(textarea.style.cssText).toBe(original);
  });

  test('the context-menu key prepares the textarea at the event position', () => {
    term.select(0, 0, 4);
    const { canvas, textarea } = internals(term);
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 12 })
    );
    expect(textarea.value).toBe('copy');
    expect([textarea.style.left, textarea.style.top]).toEqual(['28px', '10px']);
  });
});
