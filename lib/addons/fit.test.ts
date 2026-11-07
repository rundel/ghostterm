import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FitAddon } from './fit';

// A terminal stand-in with a real DOM element whose size is set per test. Cells are 9x16 and the
// scrollbar gutter takes at least 15px.
class MockTerminal {
  public element: HTMLElement;
  public cols = 80;
  public rows = 24;
  public resizes: Array<[number, number]> = [];
  public gutters: number[] = [];
  public renderer = {
    getMetrics: () => ({ width: 9, height: 16, baseline: 12 }),
    setScrollbarGutter: (px: number) => {
      this.gutters.push(px);
    },
  };

  constructor(width: number, height: number) {
    this.element = document.createElement('div');
    document.body.appendChild(this.element);
    this.setSize(width, height);
  }

  setSize(width: number, height: number): void {
    Object.defineProperty(this.element, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(this.element, 'clientHeight', { value: height, configurable: true });
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }
}

describe('FitAddon', () => {
  let addon: FitAddon;
  let terminal: MockTerminal;

  beforeEach(() => {
    addon = new FitAddon();
    // (900 - 15) / 9 = 98 cols, 480 / 16 = 30 rows
    terminal = new MockTerminal(900, 480);
  });

  afterEach(() => {
    addon.dispose();
    terminal.element.remove();
  });

  test('proposeDimensions() fits whole cells beside the scrollbar gutter', () => {
    addon.activate(terminal as any);
    expect(addon.proposeDimensions()).toEqual({ cols: 98, rows: 30 });
  });

  test('proposeDimensions() is undefined without an element or renderer', () => {
    const bare = { cols: 80, rows: 24 };
    addon.activate(bare as any);
    expect(addon.proposeDimensions()).toBeUndefined();

    addon.activate({ ...bare, element: terminal.element } as any);
    expect(addon.proposeDimensions()).toBeUndefined();
  });

  test('proposeDimensions() subtracts the element padding', () => {
    terminal.element.style.padding = '10px 20px';
    addon.activate(terminal as any);
    // (900 - 40 - 15) / 9 = 93 cols, (480 - 20) / 16 = 28 rows
    expect(addon.proposeDimensions()).toEqual({ cols: 93, rows: 28 });
  });

  test('proposeDimensions() enforces minimum cols and rows', () => {
    terminal.setSize(16, 4);
    addon.activate(terminal as any);
    expect(addon.proposeDimensions()).toEqual({ cols: 2, rows: 1 });
  });

  test('fit() resizes once and a repeated fit() does not resize again', () => {
    addon.activate(terminal as any);
    addon.fit();
    expect(terminal.resizes).toEqual([[98, 30]]);
    addon.fit();
    addon.fit();
    expect(terminal.resizes).toEqual([[98, 30]]);
  });

  test('fit() restores the fitted size after the terminal was resized elsewhere', () => {
    addon.activate(terminal as any);
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
    addon.activate(terminal as any);
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
    addon.activate(terminal as any);
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
    addon.activate(terminal as any);
    addon.dispose();
    addon.fit();
    expect(terminal.resizes).toEqual([]);
  });

  describe('observeResize()', () => {
    let observers: StubResizeObserver[];
    const original = globalThis.ResizeObserver;

    class StubResizeObserver {
      callback: ResizeObserverCallback;
      observed: Element[] = [];
      disconnected = false;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
      fire() {
        const entry = { target: this.observed[0] } as unknown as ResizeObserverEntry;
        this.callback([entry], this as unknown as ResizeObserver);
      }
    }

    beforeEach(() => {
      observers = [];
      (globalThis as any).ResizeObserver = StubResizeObserver;
    });

    afterEach(() => {
      globalThis.ResizeObserver = original;
    });

    test('debounces several callbacks into one resize', async () => {
      addon.activate(terminal as any);
      addon.observeResize();
      addon.observeResize();
      expect(observers.length).toBe(1);
      expect(observers[0].observed).toEqual([terminal.element]);

      observers[0].fire();
      terminal.setSize(500, 320);
      observers[0].fire();
      observers[0].fire();
      expect(terminal.resizes).toEqual([]);

      await new Promise((r) => setTimeout(r, 150));
      expect(terminal.resizes).toEqual([[53, 20]]);
    });

    test('dispose() disconnects and cancels a pending fit', async () => {
      addon.activate(terminal as any);
      addon.observeResize();
      observers[0].fire();
      addon.dispose();
      expect(observers[0].disconnected).toBe(true);

      await new Promise((r) => setTimeout(r, 150));
      expect(terminal.resizes).toEqual([]);
    });
  });
});

describe('FitAddon scrollbar gutter', () => {
  test('the canvas fills the container and the scrollbar sits in the gutter', async () => {
    const { createIsolatedTerminal } = await import('../test-helpers');
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 803, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 480, configurable: true });
    document.body.appendChild(container);
    const term = await createIsolatedTerminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
      const renderer = (term as any).renderer;
      const { width: cellWidth } = renderer.getMetrics();
      const canvas: HTMLCanvasElement = renderer.getCanvas();
      const gridWidth = term.cols * cellWidth;

      // Whole cells plus a gutter that takes up the rest of the width.
      expect(Number.parseFloat(canvas.style.width)).toBeCloseTo(803, 0);
      expect(803 - gridWidth).toBeGreaterThanOrEqual(15);

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
      expect(Number.parseFloat(canvas.style.width)).toBeCloseTo(wider, 0);
    } finally {
      term.dispose();
      container.remove();
    }
  });

  test('drawing the scrollbar never paints over the last column', async () => {
    const { createIsolatedTerminal } = await import('../test-helpers');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const term = await createIsolatedTerminal({ cols: 20, rows: 5 });
    term.open(container);
    try {
      for (let i = 0; i < 20; i++) term.write(`row ${i}\r\n`);
      const renderer = (term as any).renderer;
      const gridWidth = 20 * renderer.getMetrics().width;
      const painted: number[] = [];
      const ctx = renderer.ctx;
      const fillRect = ctx.fillRect;
      const clearRect = ctx.clearRect;
      ctx.fillRect = (x: number, ...rest: number[]) => {
        painted.push(x);
        return fillRect.call(ctx, x, ...rest);
      };
      ctx.clearRect = (x: number, ...rest: number[]) => {
        painted.push(x);
        return clearRect.call(ctx, x, ...rest);
      };
      try {
        (renderer as any).renderScrollbar(0, 15, 5, 1);
      } finally {
        ctx.fillRect = fillRect;
        ctx.clearRect = clearRect;
      }
      expect(painted.length).toBeGreaterThan(0);
      expect(Math.min(...painted)).toBeGreaterThanOrEqual(gridWidth);
    } finally {
      term.dispose();
      container.remove();
    }
  });

  test('scrollbar drags are hit-tested where the bar is drawn', async () => {
    const { createIsolatedTerminal } = await import('../test-helpers');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const term = await createIsolatedTerminal({ cols: 20, rows: 5 });
    term.open(container);
    try {
      for (let i = 0; i < 50; i++) term.write(`row ${i}\r\n`);
      const renderer = (term as any).renderer;
      const canvas: HTMLCanvasElement = renderer.getCanvas();
      const bar = renderer.getScrollbarRect();
      // Pressing near the top of the track jumps toward the top of history.
      const press = (x: number) => {
        term.scrollToBottom();
        canvas.dispatchEvent(
          new MouseEvent('mousedown', { clientX: x, clientY: 10, bubbles: true })
        );
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return term.viewportY;
      };
      expect(press(bar.x + bar.width / 2)).toBeGreaterThan(0);
      expect(press(5)).toBe(0);
    } finally {
      term.dispose();
      container.remove();
    }
  });
});
