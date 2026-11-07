/**
 * Mouse reporting through libghostty's mouse encoder, end to end: DOM events
 * on the terminal produce the reports a program asked for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('Mouse reporting', () => {
  let container: HTMLElement;
  let term: Terminal;
  let sent: string[];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10 });
    term.open(container);
    sent = [];
    term.onData((d) => sent.push(d));
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  /** Dispatch a mouse event in the middle of a cell (0-based col/row). */
  function mouse(type: string, col: number, row: number, init: MouseEventInit = {}) {
    const renderer = (term as any).renderer;
    const canvas: HTMLCanvasElement = renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const e = new (type === 'wheel' ? WheelEvent : MouseEvent)(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + (col + 0.5) * renderer.charWidth,
      clientY: rect.top + (row + 0.5) * renderer.charHeight,
      ...init,
    });
    canvas.dispatchEvent(e);
    return e;
  }

  test('nothing is reported until a program asks', () => {
    mouse('mousedown', 2, 1);
    mouse('mouseup', 2, 1);
    expect(sent).toEqual([]);
  });

  test('SGR reports for press and release (modes 1000 + 1006)', () => {
    term.write('\x1b[?1000h\x1b[?1006h');
    mouse('mousedown', 2, 1);
    mouse('mouseup', 2, 1);
    expect(sent).toEqual(['\x1b[<0;3;2M', '\x1b[<0;3;2m']);
  });

  test('X10/normal format when SGR is not requested', () => {
    term.write('\x1b[?1000h');
    mouse('mousedown', 2, 1);
    expect(sent).toEqual(['\x1b[M' + String.fromCharCode(32, 32 + 3, 32 + 2)]);
  });

  test('modifiers are reported (Ctrl adds 16, Alt adds 8)', () => {
    term.write('\x1b[?1000h\x1b[?1006h');
    mouse('mousedown', 0, 0, { ctrlKey: true });
    mouse('mousedown', 0, 0, { button: 2, altKey: true });
    expect(sent).toEqual(['\x1b[<16;1;1M', '\x1b[<10;1;1M']);
  });

  test('motion only while dragging in button mode, always in any-event mode', () => {
    term.write('\x1b[?1002h\x1b[?1006h');
    mouse('mousemove', 5, 5);
    expect(sent).toEqual([]);
    mouse('mousedown', 5, 5);
    mouse('mousemove', 6, 5);
    expect(sent.slice(1)).toEqual(['\x1b[<32;7;6M']);

    sent = [];
    mouse('mouseup', 6, 5);
    term.write('\x1b[?1003h');
    mouse('mousemove', 8, 2);
    expect(sent.slice(1)).toEqual(['\x1b[<35;9;3M']);
  });

  test('a drag that leaves the terminal is followed, clamped to the edge, and released', () => {
    term.write('\x1b[?1002h\x1b[?1006h');
    mouse('mousedown', 5, 5);
    // Outside the terminal, the events reach only the document.
    const renderer = (term as any).renderer;
    const rect = renderer.getCanvas().getBoundingClientRect();
    const outside = (type: string) =>
      document.body.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          clientX: rect.left + 100 * renderer.charWidth,
          clientY: rect.top - 3 * renderer.charHeight,
        })
      );
    outside('mousemove');
    outside('mouseup');
    expect(sent).toEqual(['\x1b[<0;6;6M', '\x1b[<32;40;1M', '\x1b[<0;40;1m']);

    // The button is no longer held: motion is not a drag.
    sent = [];
    mouse('mousemove', 6, 5);
    outside('mousemove');
    expect(sent).toEqual([]);
  });

  test('a drag inside the terminal is reported once per event', () => {
    term.write('\x1b[?1002h\x1b[?1006h');
    mouse('mousedown', 1, 1);
    mouse('mousemove', 2, 1);
    mouse('mouseup', 2, 1);
    expect(sent).toEqual(['\x1b[<0;2;2M', '\x1b[<32;3;2M', '\x1b[<0;3;2m']);
  });

  test('dispose during a drag stops following the pointer', async () => {
    term.write('\x1b[?1002h\x1b[?1006h');
    mouse('mousedown', 1, 1);
    term.dispose();
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(sent).toEqual(['\x1b[<0;2;2M']);
    term = await createIsolatedTerminal();
  });

  test('the wheel is reported instead of scrolling', () => {
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    term.write('\x1b[?1000h\x1b[?1006h');
    // (happy-dom ignores clientX/clientY on WheelEvent, so only the button is checked.)
    mouse('wheel', 1, 1, { deltaY: -100 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\x1b\[<64;\d+;\d+M$/);
    expect(term.viewportY).toBe(0);
  });

  test('a custom wheel handler runs first and false stops the report', () => {
    term.write('\x1b[?1000h\x1b[?1006h');
    const seen: WheelEvent[] = [];
    term.attachCustomWheelEventHandler((e) => {
      seen.push(e);
      return false;
    });
    const stopped = mouse('wheel', 1, 1, { deltaY: -100 });
    expect(seen).toEqual([stopped]);
    expect(sent).toEqual([]);
    expect(stopped.defaultPrevented).toBe(false);

    term.attachCustomWheelEventHandler(() => true);
    mouse('wheel', 1, 1, { deltaY: -100 });
    expect(sent).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  test('Shift+drag selects text instead of reporting', () => {
    term.write('hello world\r\n\x1b[?1000h\x1b[?1006h');
    mouse('mousedown', 0, 0, { shiftKey: true });
    mouse('mousemove', 4, 0, { shiftKey: true, clientX: undefined });
    const renderer = (term as any).renderer;
    const move = new MouseEvent('mousemove', { bubbles: true, shiftKey: true });
    Object.defineProperty(move, 'offsetX', { value: 4.9 * renderer.charWidth });
    Object.defineProperty(move, 'offsetY', { value: 0.5 * renderer.charHeight });
    renderer.getCanvas().dispatchEvent(move);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, shiftKey: true }));
    expect(sent).toEqual([]);
    expect(term.getSelection()).toBe('hello');
  });

  test('a plain drag goes to the program, not to selection', () => {
    term.write('hello world\r\n\x1b[?1002h\x1b[?1006h');
    mouse('mousedown', 0, 0);
    mouse('mousemove', 4, 0);
    mouse('mouseup', 4, 0);
    expect(sent.length).toBeGreaterThan(0);
    expect(term.hasSelection()).toBe(false);
  });

  test('wheel in a full-screen app sends arrows that follow cursor key mode', () => {
    term.write('\x1b[?1049h\x1b[?1h'); // alternate screen + application cursor keys
    mouse('wheel', 1, 1, { deltaY: -2 * (term as any).renderer.charHeight }); // two lines
    expect(sent).toEqual(['\x1bOA', '\x1bOA']);
  });

  test('a wheel notch is one report; a big flick several; trackpad pixels accumulate', () => {
    term.write('\x1b[?1000h\x1b[?1006h');
    mouse('wheel', 1, 1, { deltaY: 100 });
    expect(sent).toHaveLength(1);
    sent = [];
    mouse('wheel', 1, 1, { deltaY: 300 });
    expect(sent).toHaveLength(3);
    sent = [];
    const cell = (term as any).renderer.charHeight;
    for (let i = 0; i < 4; i++) mouse('wheel', 1, 1, { deltaY: cell / 4 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\x1b\[<65;/);
  });
});
