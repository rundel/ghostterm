import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { IAddonTerminal } from '../interfaces';
import { internals, mouseEvent, paintedRects, stub, terminalFixture } from '../test-helpers';
import { FitAddon } from './fit';

// A terminal stand-in with a real DOM element whose size is set per test. Cells are 9x16 and the
// scrollbar gutter takes at least 15px.
class MockTerminal implements IAddonTerminal {
  element?: HTMLElement;
  cols = 80;
  rows = 24;
  resizes: Array<[number, number]> = [];
  gutters: number[] = [];
  metrics: { width: number; height: number; baseline: number } | undefined = {
    width: 9,
    height: 16,
    baseline: 12,
  };

  constructor(width: number, height: number) {
    this.element = document.createElement('div');
    document.body.appendChild(this.element);
    this.setSize(width, height);
  }

  setSize(width: number, height: number): void {
    const el = this.element as HTMLElement;
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  }

  getMetrics() {
    return this.metrics;
  }

  setScrollbarGutter(px: number): void {
    this.gutters.push(px);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }

  setHighlightProvider(): void {}
  getViewportY(): number {
    return 0;
  }
  scrollToViewportOffset(): void {}
  clearSelection(): void {}
}

// Bun has advanceTimersByTime; the installed bun-types (1.3.2) don't declare it yet.

describe('FitAddon', () => {
  let addon: FitAddon;
  let terminal: MockTerminal;

  beforeEach(() => {
    addon = new FitAddon();
    // (900 - 15) / 9 = 98 cols, 480 / 16 = 30 rows
    terminal = new MockTerminal(900, 480);
    addon.activate(terminal);
  });

  afterEach(() => {
    addon.dispose();
    terminal.element?.remove();
  });

  test('proposeDimensions() fits whole cells beside the scrollbar gutter', () => {
    expect(addon.proposeDimensions()).toEqual({ cols: 98, rows: 30 });
  });

  test('proposeDimensions() is undefined without an element, metrics or a size', () => {
    terminal.setSize(0, 480);
    expect(addon.proposeDimensions()).toBeUndefined();
    terminal.setSize(900, 480);
    terminal.metrics = undefined;
    expect(addon.proposeDimensions()).toBeUndefined();
    terminal.element?.remove();
    terminal.element = undefined;
    expect(addon.proposeDimensions()).toBeUndefined();
  });

  test('proposeDimensions() subtracts the element padding', () => {
    terminal.element?.style.setProperty('padding', '10px 20px');
    // (900 - 40 - 15) / 9 = 93 cols, (480 - 20) / 16 = 28 rows
    expect(addon.proposeDimensions()).toEqual({ cols: 93, rows: 28 });
  });

  test('proposeDimensions() enforces minimum cols and rows', () => {
    terminal.setSize(16, 4);
    expect(addon.proposeDimensions()).toEqual({ cols: 2, rows: 1 });
  });

  test('fit() resizes once and a repeated fit() does not resize again', () => {
    addon.fit();
    expect(terminal.resizes).toEqual([[98, 30]]);
    // 900 - 98 * 9 = 18 px of gutter
    expect(terminal.gutters).toEqual([18]);
    addon.fit();
    addon.fit();
    expect(terminal.resizes).toEqual([[98, 30]]);
  });

  test('fit() restores the fitted size after the terminal was resized elsewhere', () => {
    addon.fit();
    terminal.resize(40, 10);
    addon.fit();
    expect(terminal.resizes).toEqual([
      [98, 30],
      [40, 10],
      [98, 30],
    ]);
  });

  test('fit() right after a resize still applies a new container size and gutter', () => {
    addon.fit();
    terminal.setSize(500, 320);
    addon.fit();
    // (500 - 15) / 9 = 53 cols, 320 / 16 = 20 rows, gutter 500 - 53 * 9 = 23
    expect(terminal.resizes).toEqual([
      [98, 30],
      [53, 20],
    ]);
    expect(terminal.gutters.at(-1)).toBe(23);
  });

  test('fit() ignores a re-entrant call made while resizing', () => {
    const resize = terminal.resize.bind(terminal);
    terminal.resize = (cols: number, rows: number) => {
      resize(cols, rows);
      terminal.setSize(500, 320);
      addon.fit();
    };
    addon.fit();
    expect(terminal.resizes).toEqual([[98, 30]]);
    // The guard is released once resize() returns.
    addon.fit();
    expect(terminal.resizes).toEqual([
      [98, 30],
      [53, 20],
    ]);
  });

  test('fit() does nothing after dispose', () => {
    addon.dispose();
    addon.fit();
    expect(terminal.resizes).toEqual([]);
  });

  describe('observeResize()', () => {
    let observers: StubResizeObserver[];
    let restore: () => void;

    class StubResizeObserver {
      observed: Element[] = [];
      disconnected = false;
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
      fire(entries = [{ target: this.observed[0] } as unknown as ResizeObserverEntry]) {
        this.callback(entries, this as unknown as ResizeObserver);
      }
    }

    beforeEach(() => {
      observers = [];
      restore = stub(
        globalThis,
        'ResizeObserver',
        StubResizeObserver as unknown as typeof ResizeObserver
      );
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      restore();
    });

    test('debounces several callbacks into one resize, 100 ms after the last', () => {
      addon.observeResize();
      addon.observeResize();
      expect(observers.length).toBe(1);
      expect(observers[0].observed).toEqual([terminal.element as HTMLElement]);

      observers[0].fire();
      terminal.setSize(500, 320);
      jest.advanceTimersByTime(60);
      observers[0].fire();
      observers[0].fire([]);
      jest.advanceTimersByTime(60);
      expect(terminal.resizes).toEqual([]);

      jest.advanceTimersByTime(40);
      expect(terminal.resizes).toEqual([[53, 20]]);
    });

    test('dispose() disconnects and cancels a pending fit', () => {
      addon.observeResize();
      observers[0].fire();
      addon.dispose();
      expect(observers[0].disconnected).toBe(true);
      jest.advanceTimersByTime(200);
      expect(terminal.resizes).toEqual([]);
    });

    test('does nothing without an element', () => {
      terminal.element?.remove();
      terminal.element = undefined;
      addon.observeResize();
      expect(observers).toEqual([]);
    });
  });
});

describe('FitAddon on a terminal', () => {
  const fixture = terminalFixture();

  test('the canvas fills the container and the scrollbar sits in the gutter', () => {
    const term = fixture.create();
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 803, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 480, configurable: true });
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    const { renderer, canvas } = internals(term);
    const cellWidth = renderer.charWidth;
    const gridWidth = term.cols * cellWidth;

    // Whole cells plus a gutter that takes up the rest of the width.
    expect(term.cols).toBe(Math.floor((803 - 15) / cellWidth));
    expect(term.rows).toBe(Math.floor(480 / renderer.charHeight));
    expect(Number.parseFloat(canvas.style.width)).toBe(803);

    // The bar is right of every cell and close to the container's edge.
    const bar = renderer.getScrollbarRect();
    expect(bar.x).toBeGreaterThanOrEqual(gridWidth);
    expect(803 - (bar.x + bar.width)).toBeLessThanOrEqual(4);

    // The gutter tracks width changes too small to change cols.
    const cols = term.cols;
    const slack = 803 - 15 - cols * cellWidth;
    const wider = 803 + Math.max(1, Math.floor((cellWidth - slack) / 2));
    Object.defineProperty(container, 'clientWidth', { value: wider });
    fit.fit();
    expect(term.cols).toBe(cols);
    expect(Number.parseFloat(canvas.style.width)).toBe(wider);
  });

  test('drawing the scrollbar never paints over the last column', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    for (let i = 0; i < 20; i++) term.write(`row ${i}\r\n`);
    const { renderer, wasmTerm, ctx } = internals(term);
    const gridWidth = 20 * renderer.charWidth;
    ctx.calls = [];
    renderer.render(wasmTerm, true, 0, 1);
    const rects = ctx.calls.filter((c) => c.op === 'fillRect' || c.op === 'clearRect');
    const scrollbar = paintedRects(ctx.calls).filter((r) => r.fillStyle.startsWith('rgba(128'));
    // Track and thumb, both in the gutter
    expect(scrollbar).toHaveLength(2);
    for (const r of scrollbar) expect(r.x).toBeGreaterThanOrEqual(gridWidth);
    // Everything else either stays in the grid or starts in the gutter.
    for (const c of rects) {
      const [x, , w] = c.args as number[];
      expect(x + w <= gridWidth || x >= gridWidth).toBe(true);
    }
  });

  test('scrollbar presses are hit-tested where the bar is drawn', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    for (let i = 0; i < 50; i++) term.write(`row ${i}\r\n`);
    const { renderer, canvas } = internals(term);
    const bar = renderer.getScrollbarRect();
    // Pressing near the top of the track jumps toward the top of history.
    const press = (x: number) => {
      term.scrollToBottom();
      canvas.dispatchEvent(mouseEvent('mousedown', x, 10));
      document.dispatchEvent(mouseEvent('mouseup', x, 10));
      return term.viewportY;
    };
    expect(press(bar.x + bar.width / 2)).toBeGreaterThan(40);
    expect(press(5)).toBe(0);
  });
});
