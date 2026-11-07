/**
 * Scrolling: the wheel (history on the normal screen, arrow keys on the
 * alternate screen), the scroll methods, onScroll, output while scrolled,
 * and the scrollbar.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { ITerminalOptions } from './interfaces';
import type { Terminal } from './terminal';
import {
  drawnText,
  internals,
  keyDown,
  mouseEvent,
  nextFrame,
  paintedRects,
  stub,
  terminalFixture,
  wheelEvent,
} from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;
let container: HTMLElement;
let sent: string[];

function setup(options: Omit<ITerminalOptions, 'ghostty'> = {}): void {
  ({ term, container, sent } = fixture.open({
    cols: 80,
    rows: 24,
    smoothScrollDuration: 0,
    ...options,
  }));
}

beforeEach(() => setup());

function fill(lines: number, prefix = 'Line'): void {
  for (let i = 0; i < lines; i++) term.write(`${prefix} ${i}\r\n`);
}

/** Dispatch a wheel event on the terminal (delta in lines unless a mode says otherwise). */
function wheel(deltaY: number, deltaMode: number = WheelEvent.DOM_DELTA_LINE): WheelEvent {
  const event = wheelEvent(deltaY, { deltaMode });
  container.dispatchEvent(event);
  return event;
}

/** Text drawn on each viewport row by a full frame. */
function drawnRows(): string[] {
  const rows: string[][] = [];
  for (const t of drawnText(term)) {
    rows[t.row] ??= [];
    rows[t.row][t.col] = t.text;
  }
  return Array.from(rows, (r) =>
    Array.from(r ?? [], (c) => c ?? ' ')
      .join('')
      .trimEnd()
  );
}

describe('wheel on the normal screen', () => {
  test('scrolls the history and sends nothing', () => {
    fill(50);
    const up = wheel(-3);
    expect(term.getViewportY()).toBe(3);
    expect(up.defaultPrevented).toBe(true);
    wheel(2);
    expect(term.getViewportY()).toBe(1);
    expect(sent).toEqual([]);
  });

  test('line, page and pixel delta modes', () => {
    fill(100);
    wheel(-3);
    expect(term.getViewportY()).toBe(3);
    wheel(-1, WheelEvent.DOM_DELTA_PAGE);
    expect(term.getViewportY()).toBe(3 + term.rows);
    wheel(2);
    expect(term.getViewportY()).toBe(1 + term.rows);
    const lineHeight = internals(term).renderer.charHeight;
    wheel(4 * lineHeight, WheelEvent.DOM_DELTA_PIXEL);
    expect(term.getViewportY()).toBe(term.rows - 3);
  });

  test('a zero delta is swallowed without moving', () => {
    fill(50);
    const event = wheel(0);
    expect(event.defaultPrevented).toBe(true);
    expect(term.getViewportY()).toBe(0);
  });

  test('wheel scrolls accumulate while a smooth scroll runs', async () => {
    term.options.smoothScrollDuration = 100;
    fill(100);
    wheel(-5);
    wheel(-5);
    expect(term.getViewportY()).toBeLessThan(10);
    for (let i = 0; i < 50 && term.getViewportY() !== 10; i++) await nextFrame();
    expect(term.getViewportY()).toBe(10);
  });

  test('immediate scrolls stop a running smooth scroll', async () => {
    term.options.smoothScrollDuration = 100;
    fill(100);
    wheel(-30);
    term.scrollToBottom();
    for (let i = 0; i < 5; i++) await nextFrame();
    expect(term.getViewportY()).toBe(0);

    wheel(-30);
    term.scrollToLine(10);
    for (let i = 0; i < 5; i++) await nextFrame();
    expect(term.buffer.active.viewportY).toBe(10);
  });
});

describe('wheel on the alternate screen', () => {
  beforeEach(() => term.write('\x1b[?1049h'));

  test('sends one arrow per line moved, never scrolling', () => {
    wheel(-3);
    expect(sent).toEqual(['\x1b[A', '\x1b[A', '\x1b[A']);
    sent.length = 0;
    wheel(2);
    expect(sent).toEqual(['\x1b[B', '\x1b[B']);
    expect(term.getViewportY()).toBe(0);
  });

  test('pixel deltas convert at one line per cell height', () => {
    const lineHeight = internals(term).renderer.charHeight;
    wheel(-100, WheelEvent.DOM_DELTA_PIXEL);
    expect(sent).toEqual(Array(Math.trunc(100 / lineHeight)).fill('\x1b[A'));
  });

  test('small trackpad deltas add up to arrows', () => {
    const step = internals(term).renderer.charHeight / 4;
    for (let i = 0; i < 3; i++) wheel(-step, WheelEvent.DOM_DELTA_PIXEL);
    expect(sent).toEqual([]);
    wheel(-step, WheelEvent.DOM_DELTA_PIXEL);
    expect(sent).toEqual(['\x1b[A']);
  });

  test('arrows follow application cursor mode', () => {
    term.write('\x1b[?1h');
    wheel(-2);
    expect(sent).toEqual(['\x1bOA', '\x1bOA']);
  });

  test('a huge delta is capped at a screenful of arrows', () => {
    wheel(-10000, WheelEvent.DOM_DELTA_PIXEL);
    expect(sent).toEqual(Array(term.rows).fill('\x1b[A'));
  });

  test('no arrows when the program turned alternate scroll (mode 1007) off', () => {
    term.write('\x1b[?1007l');
    const event = wheel(-3);
    expect(sent).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test('switching screens switches between arrows and scrolling', () => {
    term.write('\x1b[?1049l');
    fill(30);
    wheel(-3);
    expect(term.getViewportY()).toBe(3);
    expect(sent).toEqual([]);

    term.write('\x1b[?1049h');
    expect(term.getViewportY()).toBe(0);
    wheel(-1);
    expect(sent).toEqual(['\x1b[A']);

    sent.length = 0;
    term.write('\x1b[?1049l');
    wheel(-2);
    expect(sent).toEqual([]);
    expect(term.getViewportY()).toBe(2);
  });
});

describe('custom wheel handler', () => {
  test('sees each event first; true lets the terminal handle it', () => {
    const seen: WheelEvent[] = [];
    term.attachCustomWheelEventHandler((e) => {
      seen.push(e);
      return true;
    });
    fill(50);
    const event = wheel(-3);
    expect(seen).toEqual([event]);
    expect(term.getViewportY()).toBe(3);
    expect(event.defaultPrevented).toBe(true);

    term.write('\x1b[?1049h');
    wheel(-1);
    expect(sent).toEqual(['\x1b[A']);
  });

  test('false stops all processing and leaves the page free to scroll', () => {
    term.attachCustomWheelEventHandler(() => false);
    fill(50);
    const scroll = wheel(-3);
    expect(term.getViewportY()).toBe(0);
    expect(scroll.defaultPrevented).toBe(false);

    term.write('\x1b[?1049h');
    const arrows = wheel(-3);
    expect(sent).toEqual([]);
    expect(arrows.defaultPrevented).toBe(false);
  });

  test('clearing the handler restores default handling', () => {
    term.attachCustomWheelEventHandler(() => false);
    term.attachCustomWheelEventHandler(undefined);
    fill(50);
    wheel(-3);
    expect(term.getViewportY()).toBe(3);
  });
});

describe('scroll methods', () => {
  beforeEach(() => fill(50));

  test('scrollLines moves by lines, clamped to the history', () => {
    term.scrollLines(-10);
    expect(term.getViewportY()).toBe(10);
    term.scrollLines(5);
    expect(term.getViewportY()).toBe(5);
    term.scrollLines(1000);
    expect(term.getViewportY()).toBe(0);
    term.scrollLines(-1000);
    expect(term.getViewportY()).toBe(term.buffer.active.baseY);
    expect(term.buffer.active.viewportY).toBe(0);
  });

  test('scrollPages moves by screenfuls', () => {
    fill(50, 'More');
    term.scrollPages(-2);
    expect(term.getViewportY()).toBe(2 * term.rows);
    term.scrollPages(1);
    expect(term.getViewportY()).toBe(term.rows);
  });

  test('scrollToTop and scrollToBottom', () => {
    term.scrollToTop();
    expect(term.getViewportY()).toBe(term.buffer.active.baseY);
    expect(term.buffer.active.viewportY).toBe(0);
    term.scrollToBottom();
    expect(term.getViewportY()).toBe(0);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  test('scrollToLine puts that buffer line at the top, clamped', () => {
    // Line 15 of the buffer (0 = oldest scrollback line), as in xterm.js.
    term.scrollToLine(15);
    expect(term.buffer.active.viewportY).toBe(15);
    expect(term.getViewportY()).toBe(term.buffer.active.baseY - 15);
    expect(drawnRows()[0]).toBe('Line 15');

    term.scrollToLine(1000);
    expect(term.getViewportY()).toBe(0);
    term.scrollToLine(-5);
    expect(term.buffer.active.viewportY).toBe(0);
  });
});

describe('onScroll and onCursorMove', () => {
  test('onScroll reports the top line for each scroll that moved', () => {
    fill(100);
    const base = term.buffer.active.baseY;
    const positions: number[] = [];
    term.onScroll((position) => positions.push(position));
    term.scrollToBottom();
    term.scrollLines(-5);
    term.scrollLines(-3);
    term.scrollLines(2);
    expect(positions).toEqual([base - 5, base - 8, base - 6]);
  });

  test('onScroll fires as output scrolls the view at the bottom, not while scrolled up', () => {
    const positions: number[] = [];
    term.onScroll((position) => positions.push(position));
    fill(30);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7]);

    term.scrollLines(-5);
    positions.length = 0;
    fill(5, 'More');
    expect(positions).toEqual([]);
  });

  test('onCursorMove fires from the render loop when the cursor moved', async () => {
    let moves = 0;
    term.onCursorMove(() => moves++);
    await nextFrame();
    expect(moves).toBe(0);
    term.write('Line 1\r\nLine 2');
    await nextFrame();
    expect(moves).toBe(1);
    await nextFrame();
    expect(moves).toBe(1);
  });
});

describe('rendering while scrolled', () => {
  test('draws scrollback rows read from the library viewport', () => {
    fill(50);
    // 24 rows: Line 27..Line 49 plus the empty cursor row.
    expect(drawnRows()[0]).toBe('Line 27');

    term.scrollLines(-10);
    const rows = drawnRows();
    expect(rows[0]).toBe('Line 17');
    expect(rows[23]).toBe('Line 40');
    expect(term.wasmTerm?.getViewportOffset()).toBe(10);

    term.scrollToBottom();
    expect(drawnRows()[22]).toBe('Line 49');
    expect(term.wasmTerm?.getViewportOffset()).toBe(0);
  });

  test('output while scrolled keeps the same content on screen', () => {
    fill(50);
    term.scrollLines(-5);
    const before = drawnRows();
    expect(before[0]).toBe('Line 22');

    for (let i = 50; i < 60; i++) term.write(`Line ${i}\r\n`);
    expect(term.getViewportY()).toBe(15);
    expect(drawnRows()).toEqual(before);
  });

  test('output while at the bottom keeps following it', () => {
    fill(50);
    term.write('fresh');
    expect(term.getViewportY()).toBe(0);
    expect(drawnRows()[23]).toBe('fresh');
  });

  test('typing while scrolled returns to the bottom', () => {
    fill(50);
    term.scrollLines(-5);
    keyDown(internals(term).textarea, 'KeyX', 'x');
    expect(sent).toEqual(['x']);
    expect(term.getViewportY()).toBe(0);
  });

  test('stays within the history when it is pruned underneath the view', () => {
    setup({ scrollback: 500 });
    fill(600);
    term.scrollLines(-100);
    for (let i = 600; i < 3000; i++) term.write(`Line ${i}\r\n`);
    expect(term.getViewportY()).toBeGreaterThan(0);
    expect(term.getViewportY()).toBeLessThanOrEqual(term.buffer.active.baseY);
    expect(term.wasmTerm?.getViewportOffset()).toBe(Math.floor(term.getViewportY()));
    // The rows drawn are the history rows at that offset.
    const top = term.buffer.active.viewportY;
    expect(drawnRows()[0]).toBe(term.buffer.active.getLine(top)?.translateToString(true) ?? '');
  });

  test('entering the alternate screen while scrolled shows it from the top', () => {
    fill(100);
    term.scrollLines(-10);
    term.write('\x1b[?1049h\x1b[Hvim');
    expect(term.getViewportY()).toBe(0);
    expect(drawnRows()[0]).toBe('vim');
    term.write('\x1b[?1049l');
    expect(term.buffer.active.baseY).toBe(77);
  });
});

describe('scrollbar', () => {
  beforeEach(() => {
    setup({ cols: 40, rows: 10 });
    fill(100);
  });

  const bar = () =>
    internals(term).renderer.getScrollbarThumb(
      term.getViewportY(),
      term.buffer.active.baseY,
      term.rows
    );

  test('clicking the track jumps there', () => {
    const b = bar();
    const down = mouseEvent('mousedown', b.x + 1, b.trackY);
    container.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(term.buffer.active.viewportY).toBe(0);

    container.dispatchEvent(mouseEvent('mousedown', b.x + 1, b.trackY + b.trackHeight / 2));
    expect(term.getViewportY()).toBe(Math.round(term.buffer.active.baseY / 2));
  });

  test('dragging the thumb scrolls in proportion, and mouseup ends the drag', () => {
    const b = bar();
    const scrollback = term.buffer.active.baseY;
    const startY = b.y + b.height / 2;
    container.dispatchEvent(mouseEvent('mousedown', b.x + 1, startY));
    const travel = b.trackHeight - b.height;
    container.dispatchEvent(mouseEvent('mousemove', b.x + 1, startY - travel / 2));
    expect(term.getViewportY()).toBe(Math.round(scrollback / 2));
    container.dispatchEvent(mouseEvent('mousemove', b.x + 1, startY - travel * 2));
    expect(term.buffer.active.viewportY).toBe(0);

    document.dispatchEvent(mouseEvent('mouseup', b.x + 1, 0));
    container.dispatchEvent(mouseEvent('mousemove', b.x + 1, startY));
    expect(term.buffer.active.viewportY).toBe(0);
  });

  test('clicks left of the scrollbar are not taken', () => {
    // They start a selection instead.
    const { canvas } = internals(term);
    canvas.dispatchEvent(mouseEvent('mousedown', 5, 5));
    canvas.dispatchEvent(mouseEvent('mousemove', 5, 50));
    document.dispatchEvent(mouseEvent('mouseup', 5, 50));
    expect(term.getViewportY()).toBe(0);
    expect(term.hasSelection()).toBe(true);
  });

  test('fades in when scrolling and out after a delay, drawn by the render loop', () => {
    // A whole number, so the fade fractions come out exact.
    let now = 1000;
    fixture.defer(stub(performance, 'now', () => now));
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const realSetTimeout = window.setTimeout;
    fixture.defer(
      stub(window, 'setTimeout', ((fn: () => void, ms?: number) => {
        if (ms === 1500) {
          timers.push({ fn, ms });
          return 1e9;
        }
        return realSetTimeout(fn, ms);
      }) as typeof window.setTimeout)
    );
    const thumbs = () => paintedRects(term).filter((r) => r.fillStyle.startsWith('rgba(128'));

    expect(thumbs()).toEqual([]);
    term.scrollLines(-1);
    now += 100;
    // Halfway through the fade: track at 0.1 and thumb at 0.5 times half opacity.
    expect(thumbs().map((r) => r.fillStyle)).toEqual([
      'rgba(128, 128, 128, 0.05)',
      'rgba(128, 128, 128, 0.25)',
    ]);
    now += 200;
    expect(thumbs().map((r) => r.fillStyle)).toEqual([
      'rgba(128, 128, 128, 0.1)',
      'rgba(128, 128, 128, 0.5)',
    ]);

    // The hide timer starts the fade out.
    expect(timers.map((t) => t.ms)).toEqual([1500]);
    timers[0].fn();
    now += 300;
    expect(thumbs()).toEqual([]);
  });
});
