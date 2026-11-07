/**
 * Mouse reporting through libghostty's mouse encoder, end to end: DOM events
 * on the terminal produce the reports a program asked for.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { internals, mouseEvent, terminalFixture, wheelEvent } from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;
let sent: string[];

beforeEach(() => {
  ({ term, sent } = fixture.open({ cols: 40, rows: 10 }));
});

/** Client coordinates of the middle of a cell (0-based col/row). */
function cellPoint(col: number, row: number): [number, number] {
  const { canvas, renderer } = internals(term);
  const rect = canvas.getBoundingClientRect();
  return [
    rect.left + (col + 0.5) * renderer.charWidth,
    rect.top + (row + 0.5) * renderer.charHeight,
  ];
}

function mouse(type: string, col: number, row: number, init: MouseEventInit = {}): MouseEvent {
  const [x, y] = cellPoint(col, row);
  const event = mouseEvent(type, x, y, init);
  internals(term).canvas.dispatchEvent(event);
  return event;
}

function wheel(col: number, row: number, deltaY: number, init: WheelEventInit = {}): WheelEvent {
  const [x, y] = cellPoint(col, row);
  const event = wheelEvent(deltaY, init, x, y);
  // happy-dom's WheelEvent drops the modifier keys.
  Object.defineProperty(event, 'shiftKey', { value: init.shiftKey ?? false });
  internals(term).canvas.dispatchEvent(event);
  return event;
}

const SGR = '\x1b[?1006h';

describe('buttons and motion', () => {
  test('nothing is reported until a program asks', () => {
    mouse('mousedown', 2, 1);
    mouse('mouseup', 2, 1);
    expect(sent).toEqual([]);
  });

  test('SGR reports for press and release (modes 1000 + 1006)', () => {
    term.write(`\x1b[?1000h${SGR}`);
    mouse('mousedown', 2, 1);
    mouse('mouseup', 2, 1);
    expect(sent).toEqual(['\x1b[<0;3;2M', '\x1b[<0;3;2m']);
  });

  test('X10/normal format when SGR is not requested', () => {
    term.write('\x1b[?1000h');
    mouse('mousedown', 2, 1);
    expect(sent).toEqual([`\x1b[M${String.fromCharCode(32, 32 + 3, 32 + 2)}`]);
  });

  test('modifiers are reported (Ctrl adds 16, Alt adds 8)', () => {
    term.write(`\x1b[?1000h${SGR}`);
    mouse('mousedown', 0, 0, { ctrlKey: true });
    mouse('mousedown', 0, 0, { button: 2, altKey: true });
    expect(sent).toEqual(['\x1b[<16;1;1M', '\x1b[<10;1;1M']);
  });

  test('motion only while dragging in button mode, always in any-event mode', () => {
    term.write(`\x1b[?1002h${SGR}`);
    mouse('mousemove', 5, 5);
    expect(sent).toEqual([]);
    mouse('mousedown', 5, 5);
    mouse('mousemove', 6, 5);
    mouse('mouseup', 6, 5);
    expect(sent).toEqual(['\x1b[<0;6;6M', '\x1b[<32;7;6M', '\x1b[<0;7;6m']);

    sent.length = 0;
    term.write('\x1b[?1003h');
    mouse('mousemove', 8, 2);
    expect(sent).toEqual(['\x1b[<35;9;3M']);
  });

  test('a drag that leaves the terminal is followed, clamped to the edge, and released', () => {
    term.write(`\x1b[?1002h${SGR}`);
    mouse('mousedown', 5, 5);
    // Outside the terminal, the events reach only the document.
    const [x, y] = cellPoint(100, -3);
    const outside = (type: string) => document.body.dispatchEvent(mouseEvent(type, x, y));
    outside('mousemove');
    outside('mouseup');
    expect(sent).toEqual(['\x1b[<0;6;6M', '\x1b[<32;40;1M', '\x1b[<0;40;1m']);

    // The button is no longer held: motion is not a drag.
    sent.length = 0;
    mouse('mousemove', 6, 5);
    outside('mousemove');
    expect(sent).toEqual([]);
  });

  test('dispose during a drag stops following the pointer', () => {
    term.write(`\x1b[?1002h${SGR}`);
    mouse('mousedown', 1, 1);
    term.dispose();
    document.body.dispatchEvent(mouseEvent('mousemove', 0, 0));
    document.body.dispatchEvent(mouseEvent('mouseup', 0, 0));
    expect(sent).toEqual(['\x1b[<0;2;2M']);
  });

  test('Shift+drag selects text instead of reporting', () => {
    term.write(`hello world\r\n\x1b[?1000h${SGR}`);
    mouse('mousedown', 0, 0, { shiftKey: true });
    const { renderer, canvas } = internals(term);
    // Past the middle of the fifth cell, so it is included.
    canvas.dispatchEvent(
      mouseEvent('mousemove', 4.9 * renderer.charWidth, 0.5 * renderer.charHeight, {
        shiftKey: true,
      })
    );
    document.dispatchEvent(mouseEvent('mouseup', 0, 0, { shiftKey: true }));
    expect(sent).toEqual([]);
    expect(term.getSelection()).toBe('hello');
  });

  test('a plain drag goes to the program, not to selection', () => {
    term.write(`hello world\r\n\x1b[?1002h${SGR}`);
    mouse('mousedown', 0, 0);
    mouse('mousemove', 4, 0);
    mouse('mouseup', 4, 0);
    expect(sent).toEqual(['\x1b[<0;1;1M', '\x1b[<32;5;1M', '\x1b[<0;5;1m']);
    expect(term.hasSelection()).toBe(false);
  });
});

describe('wheel', () => {
  test('the wheel is reported at the pointer instead of scrolling', () => {
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    term.write(`\x1b[?1000h${SGR}`);
    const up = wheel(1, 2, -100);
    wheel(3, 4, 100);
    expect(sent).toEqual(['\x1b[<64;2;3M', '\x1b[<65;4;5M']);
    expect(up.defaultPrevented).toBe(true);
    expect(term.viewportY).toBe(0);
  });

  test('horizontal movement reports wheel left and right', () => {
    term.write(`\x1b[?1000h${SGR}`);
    wheel(0, 0, 0, { deltaX: -100 });
    wheel(0, 0, 0, { deltaX: 100 });
    expect(sent).toEqual(['\x1b[<66;1;1M', '\x1b[<67;1;1M']);
  });

  test('a notch is one report, a big flick several, trackpad pixels accumulate', () => {
    term.write(`\x1b[?1000h${SGR}`);
    wheel(0, 0, 100);
    expect(sent).toEqual(['\x1b[<65;1;1M']);
    sent.length = 0;
    wheel(0, 0, 300);
    expect(sent).toEqual(Array(3).fill('\x1b[<65;1;1M'));
    sent.length = 0;
    const cell = internals(term).renderer.charHeight;
    for (let i = 0; i < 3; i++) wheel(0, 0, cell / 4);
    expect(sent).toEqual([]);
    const last = wheel(0, 0, cell / 4);
    expect(sent).toEqual(['\x1b[<65;1;1M']);
    expect(last.defaultPrevented).toBe(true);
  });

  test('line and page delta modes: three lines per notch, one report per page', () => {
    term.write(`\x1b[?1000h${SGR}`);
    wheel(0, 0, 3, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    wheel(0, 0, 1, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    wheel(0, 0, -9, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(sent).toEqual(['\x1b[<65;1;1M', '\x1b[<65;1;1M', ...Array(3).fill('\x1b[<64;1;1M')]);
    sent.length = 0;
    wheel(0, 0, 5, { deltaMode: WheelEvent.DOM_DELTA_PAGE });
    expect(sent).toEqual(['\x1b[<65;1;1M']);
  });

  test('a custom wheel handler runs first and false stops the report', () => {
    term.write(`\x1b[?1000h${SGR}`);
    const seen: WheelEvent[] = [];
    term.attachCustomWheelEventHandler((e) => {
      seen.push(e);
      return false;
    });
    const stopped = wheel(1, 1, -100);
    expect(seen).toEqual([stopped]);
    expect(sent).toEqual([]);
    expect(stopped.defaultPrevented).toBe(false);

    term.attachCustomWheelEventHandler(() => true);
    wheel(1, 1, -100);
    expect(sent).toEqual(['\x1b[<64;2;2M']);
  });

  test('Shift+wheel is not reported', () => {
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    term.write(`\x1b[?1000h${SGR}`);
    wheel(0, 0, -100, { shiftKey: true });
    expect(sent).toEqual([]);
  });
});
