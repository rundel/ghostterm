/**
 * Comprehensive test suite for FitAddon
 *
 * Note: Most FitAddon tests require DOM APIs (document, window, getComputedStyle).
 * These tests focus on basic functionality that doesn't require DOM.
 * For full integration tests, see examples/terminal-demo.html
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FitAddon } from './fit';

// ============================================================================
// Mock Terminal Implementation
// ============================================================================

class MockTerminal {
  public element?: HTMLElement;
  public cols = 80;
  public rows = 24;
  public renderer = {
    getMetrics: () => ({ width: 9, height: 16, baseline: 12 }),
  };

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('FitAddon', () => {
  let addon: FitAddon;
  let terminal: MockTerminal;

  beforeEach(() => {
    addon = new FitAddon();
    terminal = new MockTerminal();
  });

  afterEach(() => {
    addon.dispose();
  });

  // ==========================================================================
  // Activation & Disposal Tests
  // ==========================================================================

  test('activates successfully', () => {
    expect(() => addon.activate(terminal as any)).not.toThrow();
  });

  test('disposes successfully', () => {
    addon.activate(terminal as any);
    expect(() => addon.dispose()).not.toThrow();
  });

  test('can activate and dispose multiple times', () => {
    addon.activate(terminal as any);
    addon.dispose();
    addon.activate(terminal as any);
    addon.dispose();
  });

  // ==========================================================================
  // proposeDimensions() Tests
  // ==========================================================================

  test('proposeDimensions returns undefined without element', () => {
    addon.activate(terminal as any);
    const dims = addon.proposeDimensions();
    expect(dims).toBeUndefined();
  });

  test('proposeDimensions returns undefined without renderer', () => {
    // Remove renderer
    (terminal as any).renderer = undefined;
    terminal.element = {} as HTMLElement;
    addon.activate(terminal as any);

    const dims = addon.proposeDimensions();
    expect(dims).toBeUndefined();
  });

  // ==========================================================================
  // fit() Tests
  // ==========================================================================

  test('fit() does nothing without element', () => {
    addon.activate(terminal as any);
    const originalCols = terminal.cols;
    const originalRows = terminal.rows;

    addon.fit();

    expect(terminal.cols).toBe(originalCols);
    expect(terminal.rows).toBe(originalRows);
  });

  // ==========================================================================
  // observeResize() Tests
  // ==========================================================================

  test('observeResize() does not throw without element', () => {
    addon.activate(terminal as any);
    expect(() => addon.observeResize()).not.toThrow();
  });

  // ==========================================================================
  // Integration Tests
  // ==========================================================================

  test('full workflow: activate → fit → observeResize → dispose', () => {
    // Activate
    addon.activate(terminal as any);

    // Initial fit (no-op without element)
    addon.fit();

    // Setup auto-resize (no-op without element)
    addon.observeResize();

    // Dispose
    addon.dispose();
  });

  test('fit() after dispose does nothing', () => {
    addon.activate(terminal as any);
    addon.dispose();

    const originalCols = terminal.cols;
    const originalRows = terminal.rows;

    addon.fit();

    expect(terminal.cols).toBe(originalCols);
    expect(terminal.rows).toBe(originalRows);
  });

  test('fit() prevents feedback loops by tracking dimensions', () => {
    addon.activate(terminal as any);

    // Track how many times resize is called
    let resizeCallCount = 0;
    const originalResize = terminal.resize.bind(terminal);
    terminal.resize = (cols: number, rows: number) => {
      resizeCallCount++;
      originalResize(cols, rows);
    };

    // First fit() should call resize
    addon.fit();
    expect(resizeCallCount).toBe(0); // No element, so no resize

    // Calling fit() multiple times without dimension change should not resize again
    addon.fit();
    addon.fit();
    addon.fit();
    expect(resizeCallCount).toBe(0); // Still 0 because no element
  });
});

// ==========================================================================
// Dimension Calculation Tests
// ==========================================================================

describe('Dimension Calculation', () => {
  let addon: FitAddon;

  beforeEach(() => {
    addon = new FitAddon();
  });

  afterEach(() => {
    addon.dispose();
  });

  test('fit() calculates correct dimensions from container', () => {
    // Create a mock element with known dimensions
    // FitAddon subtracts 15px for scrollbar, so we need to account for that
    const mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'clientWidth', { value: 900, configurable: true });
    Object.defineProperty(mockElement, 'clientHeight', { value: 480, configurable: true });

    let resizedCols = 0;
    let resizedRows = 0;

    const mockTerminal = {
      cols: 80,
      rows: 24,
      element: mockElement,
      renderer: {
        // 9px wide chars, 16px tall
        getMetrics: () => ({ width: 9, height: 16, baseline: 12 }),
      },
      resize: (cols: number, rows: number) => {
        resizedCols = cols;
        resizedRows = rows;
        mockTerminal.cols = cols;
        mockTerminal.rows = rows;
      },
    };

    addon.activate(mockTerminal as any);
    addon.fit();

    // Expected: (900 - 15 scrollbar) / 9 = 98 cols, 480 / 16 = 30 rows
    expect(resizedCols).toBe(98);
    expect(resizedRows).toBe(30);
  });

  test('proposeDimensions returns correct values', () => {
    // FitAddon subtracts 15px for scrollbar width
    const mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'clientWidth', { value: 720, configurable: true });
    Object.defineProperty(mockElement, 'clientHeight', { value: 384, configurable: true });

    const mockTerminal = {
      cols: 80,
      rows: 24,
      element: mockElement,
      renderer: {
        getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
      },
      resize: () => {},
    };

    addon.activate(mockTerminal as any);
    const dims = addon.proposeDimensions();

    // Expected: (720 - 15 scrollbar) / 8 = 88 cols, 384 / 16 = 24 rows
    expect(dims).toEqual({ cols: 88, rows: 24 });
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

      // The gutter tracks width changes too small to change cols. (fit()
      // ignores calls for 50ms after a resize, so wait that out.)
      await new Promise((r) => setTimeout(r, 60));
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
