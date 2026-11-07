/**
 * Terminal lifecycle: construction, open(), writing, resizing, clear/reset,
 * addons, display changes and dispose().
 */

import { describe, expect, test } from 'bun:test';
import { RecordingContext } from '../happydom';
import type { ITerminalAddon } from './interfaces';
import type { Terminal } from './terminal';
import { internals, nextFrame, stub, terminalFixture } from './test-helpers';

const fixture = terminalFixture();

/** Text of buffer line y (absolute), trailing blanks trimmed. */
const bufferLine = (term: Terminal, y: number) =>
  term.buffer.active.getLine(y)?.translateToString(true);

describe('construction and open()', () => {
  test('size comes from the options, 80x24 by default', () => {
    const plain = fixture.create();
    expect([plain.cols, plain.rows]).toEqual([80, 24]);
    const sized = fixture.create({ cols: 100, rows: 30 });
    expect([sized.cols, sized.rows]).toEqual([100, 30]);
  });

  test('open() attaches a canvas and textarea and sizes the module terminal', () => {
    const term = fixture.create({ cols: 100, rows: 50 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    expect(term.element).toBeUndefined();
    expect(term.open(container)).toBeUndefined();
    expect(term.element).toBe(container);
    expect(Array.from(container.children).map((c) => c.tagName)).toEqual(['CANVAS', 'TEXTAREA']);
    expect([term.wasmTerm?.cols, term.wasmTerm?.rows]).toEqual([100, 50]);
    expect(container.getAttribute('tabindex')).toBe('0');
  });

  test('open() twice, or after dispose(), throws', () => {
    const { term, container } = fixture.open();
    expect(() => term.open(container)).toThrow('already open');
    const disposed = fixture.create();
    disposed.dispose();
    expect(() => disposed.open(container)).toThrow('has been disposed');
  });

  test('methods that need the screen throw before open()', () => {
    const term = fixture.create();
    expect(() => term.getMode(25)).toThrow('must be opened');
    expect(() => term.hasBracketedPaste()).toThrow('must be opened');
    expect(() => term.paste('x')).toThrow('must be opened');
  });

  test('focus() and blur() before open() do nothing', () => {
    const term = fixture.create();
    term.focus();
    term.blur();
    expect(document.activeElement).toBe(document.body);
  });

  test('the contenteditable parent is never edited, input reaching the textarea is', () => {
    const { term, container, sent } = fixture.open();
    const drop = new InputEvent('beforeinput', {
      inputType: 'insertFromDrop',
      data: 'dropped',
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    // Text dropped onto the canvas would land in the parent too.
    const onCanvas = new InputEvent('beforeinput', {
      inputType: 'insertFromDrop',
      data: 'dropped',
      bubbles: true,
      cancelable: true,
    });
    container.querySelector('canvas')!.dispatchEvent(onCanvas);
    expect(onCanvas.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);

    const typed = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x',
      bubbles: true,
      cancelable: true,
    });
    internals(term).textarea.dispatchEvent(typed);
    expect(sent).toEqual(['x']);
  });

  test('unicode.activeVersion is the version libghostty implements', () => {
    expect(fixture.create().unicode.activeVersion).toBe('15.1');
  });
});

describe('writing', () => {
  test('writes before open() are kept and written by open(), as in xterm.js', async () => {
    const term = fixture.create({ cols: 20, rows: 5 });
    let called = false;
    term.write('hello ', () => {
      called = true;
    });
    term.writeln('world');
    term.write('next');
    expect(term.buffer.active.getLine(0)).toBeUndefined();
    const container = document.createElement('div');
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    term.open(container);
    expect(bufferLine(term, 0)).toBe('hello world');
    expect(bufferLine(term, 1)).toBe('next');
    expect(called).toBe(false);
    await nextFrame();
    expect(called).toBe(true);
  });

  test('strings and bytes are written in order', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('Line1\r\n');
    term.write(new TextEncoder().encode('Lïne2\r\n'));
    term.write('\x1b[1;31mLine3\x1b[0m');
    expect([0, 1, 2].map((y) => bufferLine(term, y))).toEqual(['Line1', 'Lïne2', 'Line3']);
  });

  test('writeln() ends the line, for strings and bytes', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.writeln('one');
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([0, 1]);
    term.writeln(new TextEncoder().encode('two'));
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([0, 2]);
    expect([bufferLine(term, 0), bufferLine(term, 1)]).toEqual(['one', 'two']);
  });

  test('write callbacks run in order after the next frame', async () => {
    const { term } = fixture.open();
    const order: number[] = [];
    term.write('First', () => order.push(1));
    term.write('Second', () => order.push(2));
    term.write('Third', () => order.push(3));
    expect(order).toEqual([]);
    await nextFrame();
    expect(order).toEqual([1, 2, 3]);
  });

  test('cursor movement sequences are applied', () => {
    const { term } = fixture.open();
    term.write('\x1b[5;10H\x1b[2A\x1b[3B');
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([9, 5]);
  });

  test('a write from an event listener during a write is not lost', () => {
    const { term } = fixture.open({ cols: 30, rows: 5 });
    term.onTitleChange((title) => term.write(`[${title}]`));
    term.write('a\x1b]2;T\x07b');
    expect(bufferLine(term, 0)).toBe('ab[T]');
  });

  test('a write from onData (a reply) during a write follows it', () => {
    const { term } = fixture.open({ cols: 30, rows: 5 });
    term.onData(() => term.write('!'));
    term.write('x\x1b[6ny');
    expect(bufferLine(term, 0)).toBe('xy!');
  });

  test('base characters keep their combining marks', () => {
    const { term } = fixture.open();
    term.write('e\u0301x');
    const line = term.buffer.active.getLine(0);
    expect([line?.getCell(0)?.getChars(), line?.getCell(1)?.getChars()]).toEqual(['é', 'x']);
    expect(term.buffer.active.getLine(-1)).toBeUndefined();
  });

  test('write() after dispose() throws', () => {
    const { term } = fixture.open();
    term.dispose();
    expect(() => term.write('test')).toThrow('Terminal has been disposed');
  });
});

describe('echo rendering', () => {
  /** onRender ranges fired synchronously by `fn`. */
  function syncRenders(term: Terminal, fn: () => void) {
    const ranges: Array<{ start: number; end: number }> = [];
    const sub = term.onRender((r) => ranges.push(r));
    try {
      fn();
    } finally {
      sub.dispose();
    }
    return ranges;
  }

  test('the first write after user input is drawn at once, only the rows that changed', () => {
    const { term } = fixture.open({ cols: 80, rows: 24 });
    expect(syncRenders(term, () => term.input('x', true))).toEqual([]);
    expect(syncRenders(term, () => term.write('x'))).toEqual([{ start: 0, end: 1 }]);
    // Further output waits for the render loop
    expect(syncRenders(term, () => term.write('bulk output'))).toEqual([]);
  });

  test('also after a paste and after a key press', () => {
    const { term, container } = fixture.open();
    term.paste('hello');
    expect(syncRenders(term, () => term.write('hello'))).toEqual([{ start: 0, end: 1 }]);
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true })
    );
    expect(syncRenders(term, () => term.write('a'))).toEqual([{ start: 0, end: 1 }]);
  });

  test('an echo written from a synchronous onData listener is drawn too', () => {
    const { term } = fixture.open();
    term.onData((data) => term.write(data));
    expect(syncRenders(term, () => term.input('z', true))).toEqual([{ start: 0, end: 1 }]);
    expect(syncRenders(term, () => term.write('bulk output'))).toEqual([]);
  });

  test('programmatic input and input with stdin disabled are not echoes', () => {
    const { term } = fixture.open();
    expect(syncRenders(term, () => term.input('x', false))).toEqual([]);
    expect(syncRenders(term, () => term.write('x'))).toEqual([]);
    term.options.disableStdin = true;
    term.input('x', true);
    term.paste('hello');
    expect(syncRenders(term, () => term.write('xhello'))).toEqual([]);
  });
});

describe('resize()', () => {
  test('resizes the screen and the canvas and fires onResize', () => {
    const { term } = fixture.open({ cols: 80, rows: 24 });
    const { renderer, canvas } = internals(term);
    const events: Array<{ cols: number; rows: number }> = [];
    term.onResize((e) => events.push(e));
    term.resize(100, 30);
    expect([term.cols, term.rows]).toEqual([100, 30]);
    expect([term.options.cols, term.options.rows]).toEqual([100, 30]);
    expect([term.wasmTerm?.cols, term.wasmTerm?.rows]).toEqual([100, 30]);
    expect(canvas.style.height).toBe(`${30 * renderer.charHeight}px`);
    expect(events).toEqual([{ cols: 100, rows: 30 }]);
    term.resize(100, 30);
    expect(events).toHaveLength(1);
  });

  test('before open(), sets the size open() uses', () => {
    const term = fixture.create();
    term.resize(100, 30);
    expect(term.options.cols).toBe(100);
    const container = document.createElement('div');
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    term.open(container);
    expect([term.wasmTerm?.cols, term.wasmTerm?.rows]).toEqual([100, 30]);
  });

  test('keeps a scrolled view within the remaining history', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    for (let i = 0; i < 10; i++) term.write(`${i}\r\n`);
    term.scrollToTop();
    expect(term.viewportY).toBe(6);
    // Taller: history rows move back onto the screen.
    term.resize(20, 15);
    expect(term.getScrollbackLength()).toBe(0);
    expect(term.viewportY).toBe(0);
    expect(term.wasmTerm?.getViewportOffset()).toBe(0);
  });

  test('leaves the canvas size to the renderer (device pixel ratio, gutter)', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const { renderer, canvas } = internals(term);
    renderer.setDevicePixelRatio(2);
    term.resize(30, 6);
    const cssWidth = Number.parseFloat(canvas.style.width);
    expect(cssWidth).toBe(30 * renderer.charWidth + 15);
    expect(canvas.width).toBe(cssWidth * 2);
  });
});

describe('clear() and reset()', () => {
  test('clear() keeps only the cursor line, at the top, and drops the scrollback', () => {
    const { term, sent } = fixture.open({ cols: 20, rows: 5 });
    for (let i = 0; i < 12; i++) term.write(`line ${i}\r\n`);
    term.write('$ cmd');
    term.scrollLines(-3);

    term.clear();

    const buf = term.buffer.active;
    expect(buf.baseY).toBe(0);
    expect(buf.length).toBe(5);
    expect([0, 1, 2, 3, 4].map((y) => bufferLine(term, y))).toEqual(['$ cmd', '', '', '', '']);
    expect([buf.cursorX, buf.cursorY]).toEqual([5, 0]);
    expect(term.viewportY).toBe(0);
    expect(sent).toEqual([]);

    // Output continues on the kept line
    term.write('\r\nnext');
    expect(bufferLine(term, 1)).toBe('next');
  });

  test('clear() with the cursor on the top line', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('top\r\nbelow\x1b[1;2H');
    term.clear();
    expect([bufferLine(term, 0), bufferLine(term, 1)]).toEqual(['top', '']);
    expect(term.buffer.active.cursorX).toBe(1);
  });

  test("clear() is not limited by the program's scroll region, origin mode or colors", () => {
    const { term, sent } = fixture.open({ cols: 20, rows: 8 });
    for (let i = 0; i < 12; i++) term.write(`line ${i}\r\n`);
    // Region rows 3-6, origin mode, a red background; the cursor on row 4 of the screen.
    term.write('\x1b[3;6r\x1b[?6h\x1b[41m\x1b[2;1Hcur\x1b[K');
    expect(term.buffer.active.cursorY).toBe(3);

    term.clear();

    const buf = term.buffer.active;
    expect(buf.baseY).toBe(0);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((y) => bufferLine(term, y))).toEqual([
      'cur',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect([buf.cursorX, buf.cursorY]).toEqual([3, 0]);
    // Erased with the default background, not the program's red.
    expect(buf.getLine(1)?.getCell(0)?.isBgDefault()).toBe(true);
    expect(sent).toEqual([]);

    // The program's state is as it left it: pen, origin mode and the region.
    term.write('X');
    expect(buf.getLine(0)?.getCell(3)?.getBgColor()).toBe(0xcd3131);
    expect(term.getMode(6)).toBe(true);
    term.write('\x1b[HR');
    expect(bufferLine(term, 2)).toBe('R');
    term.write('\x1b[4;1H\r\n');
    expect(bufferLine(term, 2)).toBe('');
    expect(bufferLine(term, 0)).toBe('curX');
  });

  test('clear() is not limited by left and right margins (DECSLRM)', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('above\r\nkeep this whole line\x1b[?69h\x1b[5;10s\x1b[2;1H');
    term.clear();
    expect([0, 1].map((y) => bufferLine(term, y))).toEqual(['keep this whole line', '']);
    expect(term.getMode(69)).toBe(true);
  });

  test('reset() clears screen, scrollback, modes, title and scrolling', () => {
    const { term, sent } = fixture.open({ cols: 20, rows: 5 });
    const wasmTerm = term.wasmTerm;
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]2;old\x07\x1b[?2004h');
    for (let i = 0; i < 12; i++) term.write(`line ${i}\r\n`);
    term.scrollLines(-3);

    term.reset();

    expect(term.wasmTerm).toBe(wasmTerm); // same handle: addons keep working
    expect(term.viewportY).toBe(0);
    expect(term.buffer.active.baseY).toBe(0);
    expect(bufferLine(term, 0)).toBe('');
    expect(term.hasBracketedPaste()).toBe(false);
    expect(titles).toEqual(['old', '']);
    // The same title set again is reported again
    term.write('\x1b]2;old\x07');
    expect(titles).toEqual(['old', '', 'old']);
    // Options still apply (the theme's default colors)
    term.write('\x1b]11;?\x07');
    expect(sent).toEqual(['\x1b]11;rgb:1e1e/1e1e/1e1e\x07']);
  });

  test('a program reset (RIS) resets what Terminal tracks too', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    for (let i = 0; i < 12; i++) term.write(`line ${i}\r\n`);
    term.write('\x1b]2;old\x07');
    term.scrollLines(-2);
    term.write('\x1bcafter');
    expect(term.viewportY).toBe(0);
    expect(titles).toEqual(['old', '']);
    expect(bufferLine(term, 0)).toBe('after');
    term.write('\x1b]2;old\x07');
    expect(titles).toEqual(['old', '', 'old']);
  });
});

describe('addons', () => {
  function addon() {
    const calls: Array<['activate', Terminal] | ['dispose']> = [];
    const a: ITerminalAddon = {
      activate: (t) => calls.push(['activate', t as Terminal]),
      dispose: () => calls.push(['dispose']),
    };
    return { a, calls };
  }

  test('loadAddon() activates with the terminal; dispose() disposes every addon', () => {
    const { term } = fixture.open();
    const first = addon();
    const second = addon();
    term.loadAddon(first.a);
    term.loadAddon(second.a);
    expect(first.calls).toEqual([['activate', term]]);
    term.dispose();
    expect(first.calls).toEqual([['activate', term], ['dispose']]);
    expect(second.calls).toEqual([['activate', term], ['dispose']]);
  });

  test('an addon can be loaded before open()', () => {
    const term = fixture.create();
    const { a, calls } = addon();
    term.loadAddon(a);
    expect(calls).toEqual([['activate', term]]);
  });
});

describe('display changes', () => {
  test('a devicePixelRatio change resizes the canvas backing store', () => {
    const queries: EventTarget[] = [];
    fixture.defer(
      stub(window, 'matchMedia', (() => {
        const q = new EventTarget();
        queries.push(q);
        return q;
      }) as unknown as typeof window.matchMedia)
    );
    fixture.defer(stub(window, 'devicePixelRatio', 1));
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const { canvas } = internals(term);
    const cssWidth = Number.parseFloat(canvas.style.width);
    expect(canvas.width).toBe(cssWidth);
    window.devicePixelRatio = 2;
    queries.at(-1)?.dispatchEvent(new Event('change'));
    expect(canvas.width).toBe(cssWidth * 2);
    // A query for the new ratio replaces the old one
    expect(queries.length).toBe(2);
  });

  test('a web font finishing loading remeasures the cells', () => {
    const fonts = new EventTarget();
    fixture.defer(stub(document, 'fonts', fonts as unknown as FontFaceSet));
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const { canvas } = internals(term);
    expect(canvas.style.width).toBe(`${20 * 8 + 15}px`);
    const measure = RecordingContext.prototype.measureText;
    fixture.defer(
      stub(RecordingContext.prototype, 'measureText', function (this: RecordingContext, text) {
        return { ...measure.call(this, text), width: text.length * 10 };
      })
    );
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(canvas.style.width).toBe(`${20 * 10 + 15}px`);
  });
});

describe('dispose()', () => {
  test('removes what open() added and can be called again', () => {
    const { term, container } = fixture.open();
    expect(container.children.length).toBe(2);
    term.dispose();
    term.dispose();
    expect(container.children.length).toBe(0);
    expect(container.hasAttribute('tabindex')).toBe(false);
    expect(container.hasAttribute('contenteditable')).toBe(false);
  });

  test('a terminal never opened can be disposed', () => {
    const term = fixture.create();
    term.dispose();
    expect(() => term.write('x')).toThrow('disposed');
  });

  test('removes the listeners open() added', () => {
    const { term, container } = fixture.open();
    const beforeInput = () => {
      const e = new Event('beforeinput', { cancelable: true });
      container.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(beforeInput()).toBe(true);
    term.dispose();

    expect(beforeInput()).toBe(false);
    // The document-level mouseup (scrollbar drag) is gone too.
    term['isDraggingScrollbar'] = true;
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(term['isDraggingScrollbar']).toBe(true);
    const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
    container.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  test('keeps a tabindex the page set', () => {
    const term = fixture.create();
    const container = document.createElement('div');
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    container.setAttribute('tabindex', '-1');
    term.open(container);
    term.dispose();
    expect(container.getAttribute('tabindex')).toBe('-1');
  });
});
