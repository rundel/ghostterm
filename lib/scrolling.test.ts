/**
 * Terminal Scrolling Tests
 *
 * Test Isolation Pattern:
 * Uses createIsolatedTerminal() to ensure each test gets its own WASM instance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('Terminal Scrolling', () => {
  let terminal: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    terminal = await createIsolatedTerminal({ cols: 80, rows: 24 });
    terminal.open(container);
  });

  afterEach(() => {
    if (terminal) {
      terminal.dispose();
    }
    if (container && document.body.contains(container)) {
      document.body.removeChild(container);
    }
  });

  describe('Normal Screen Mode', () => {
    test('should scroll viewport on wheel event in normal mode', async () => {
      // Fill with enough lines to create scrollback
      for (let i = 0; i < 50; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      // Initial viewport should be at bottom
      const initialViewportY = terminal.viewportY;

      // Simulate wheel up (negative deltaY)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Viewport should have scrolled up (viewportY increases away from 0)
      expect(terminal.viewportY).toBeGreaterThan(initialViewportY);
    });

    test('should scroll down on positive deltaY', async () => {
      // Fill with scrollback
      for (let i = 0; i < 50; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      // Scroll up first
      terminal.scrollLines(-10);
      const scrolledUpViewportY = terminal.viewportY;

      // Simulate wheel down (positive deltaY)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Viewport should have scrolled down (viewportY decreases towards 0)
      expect(terminal.viewportY).toBeLessThan(scrolledUpViewportY);
    });

    test('should not send data to application in normal mode', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate wheel event
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // No data should be sent to application
      expect(dataSent).toEqual([]);
    });
  });

  describe('Rendering While Scrolled', () => {
    /** Render a full frame and return the text drawn on each row. */
    function drawnRows(): string[] {
      const renderer = (terminal as any).renderer;
      const ctx = renderer.ctx;
      const height = renderer.charHeight;
      const rows: string[][] = [];
      const original = ctx.fillText;
      ctx.fillText = (char: string, x: number, y: number) => {
        const row = Math.floor(y / height);
        rows[row] ??= [];
        rows[row][Math.round(x / renderer.charWidth)] = char;
      };
      try {
        renderer.render(terminal.wasmTerm, true, terminal.viewportY);
      } finally {
        ctx.fillText = original;
      }
      return Array.from(rows, (r) =>
        Array.from(r ?? [], (c) => c ?? ' ')
          .join('')
          .trimEnd()
      );
    }

    test('draws scrollback rows read from the library viewport', () => {
      for (let i = 0; i < 50; i++) terminal.write(`Line ${i}\r\n`);
      // 24 rows: Line 27..Line 49 plus the empty cursor row.
      expect(drawnRows()[0]).toBe('Line 27');

      terminal.scrollLines(-10);
      expect(terminal.viewportY).toBe(10);
      const rows = drawnRows();
      expect(rows[0]).toBe('Line 17');
      expect(rows[23]).toBe('Line 40');
      expect(terminal.wasmTerm!.getViewportOffset()).toBe(10);

      terminal.scrollToBottom();
      expect(drawnRows()[22]).toBe('Line 49');
      expect(terminal.wasmTerm!.getViewportOffset()).toBe(0);
    });

    test('output while scrolled keeps the same content on screen', () => {
      for (let i = 0; i < 50; i++) terminal.write(`Line ${i}\r\n`);
      terminal.scrollLines(-5);
      const before = drawnRows();
      expect(before[0]).toBe('Line 22');

      for (let i = 50; i < 60; i++) terminal.write(`Line ${i}\r\n`);
      expect(terminal.viewportY).toBe(15);
      expect(drawnRows()).toEqual(before);
    });

    test('typing while scrolled returns to the bottom', () => {
      for (let i = 0; i < 50; i++) terminal.write(`Line ${i}\r\n`);
      terminal.scrollLines(-5);
      const input = (terminal as any).inputHandler;
      input.onDataCallback('x');
      expect(terminal.viewportY).toBe(0);
    });

    test('output while at the bottom keeps following it', () => {
      for (let i = 0; i < 50; i++) terminal.write(`Line ${i}\r\n`);
      expect(terminal.viewportY).toBe(0);
      terminal.write('fresh');
      expect(drawnRows()[23]).toBe('fresh');
    });
  });

  describe('Alternate Screen Mode', () => {
    beforeEach(async () => {
      // Enter alternate screen mode (vim, less, htop, etc.)
      terminal.write('\x1B[?1049h');
    });

    test('should detect alternate screen mode', async () => {
      expect(terminal.wasmTerm?.isAlternateScreen()).toBe(true);
    });

    test('should send arrow up sequences on wheel up in alternate screen', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate wheel up (negative deltaY = -100, should send ~3 arrow ups)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should send arrow up sequences (ESC[A)
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent.every((data) => data === '\x1B[A')).toBe(true);
      expect(dataSent.length).toBeCloseTo(3, 1); // ~3 arrows per click
    });

    test('should send arrow down sequences on wheel down in alternate screen', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate wheel down (positive deltaY = +100)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should send arrow down sequences (ESC[B)
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent.every((data) => data === '\x1B[B')).toBe(true);
      expect(dataSent.length).toBeCloseTo(3, 1); // ~3 arrows per click
    });

    test('should not scroll viewport in alternate screen', async () => {
      const initialViewportY = terminal.viewportY;

      // Simulate wheel event
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Viewport should not have changed
      expect(terminal.viewportY).toBe(initialViewportY);
    });

    test('should cap arrow count at 5 per wheel event', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate very large wheel delta
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -1000, // Very large delta
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should cap at 5 arrows
      expect(dataSent.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Mode Transitions', () => {
    test('should switch behavior when entering alternate screen', async () => {
      // Start in normal mode
      for (let i = 0; i < 30; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      // Scroll up in normal mode
      const wheelUpNormal = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelUpNormal);
      const normalModeViewportY = terminal.viewportY;

      // Should have scrolled viewport
      expect(normalModeViewportY).toBeLessThan(terminal.rows);

      // Enter alternate screen
      terminal.write('\x1B[?1049h');

      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Wheel should now send arrow keys
      const wheelUpAlt = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelUpAlt);

      // Should have sent arrow keys, not scrolled
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent[0]).toBe('\x1B[A');
    });

    test('should switch back to viewport scrolling when exiting alternate screen', async () => {
      // Enter alternate screen
      terminal.write('\x1B[?1049h');
      expect(terminal.wasmTerm?.isAlternateScreen()).toBe(true);

      // Exit alternate screen
      terminal.write('\x1B[?1049l');
      expect(terminal.wasmTerm?.isAlternateScreen()).toBe(false);

      // Fill with lines
      for (let i = 0; i < 30; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      const initialViewportY = terminal.viewportY;

      // Wheel should scroll viewport again
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should have scrolled up, not sent data
      expect(dataSent.length).toBe(0);
      expect(terminal.viewportY).toBeGreaterThan(initialViewportY);
    });
  });

  describe('Custom Wheel Handler', () => {
    test('should respect custom wheel handler in both modes', async () => {
      let customHandlerCalled = false;
      terminal.attachCustomWheelEventHandler(() => {
        customHandlerCalled = true;
        return true; // Override default behavior
      });

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      expect(customHandlerCalled).toBe(true);
    });

    test('custom handler can delegate to default behavior', async () => {
      terminal.attachCustomWheelEventHandler(() => {
        return false; // Don't override, use default
      });

      // Enter alternate screen
      terminal.write('\x1B[?1049h');

      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should still send arrow keys
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent[0]).toBe('\x1B[A');
    });
  });

  describe('Edge Cases', () => {
    test('should handle zero deltaY gracefully', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 0,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should not send any data or crash
      expect(dataSent.length).toBe(0);
    });

    test('should handle very small deltaY values', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Enter alternate screen
      terminal.write('\x1B[?1049h');

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -10, // Small delta, rounds to 0
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should not send any arrows (count is 0)
      expect(dataSent.length).toBe(0);
    });

    test('should handle terminal not yet opened', async () => {
      const closedTerminal = await createIsolatedTerminal({ cols: 80, rows: 24 });

      // Should not crash when handleWheel is called without wasmTerm
      expect(() => {
        const wheelEvent = new WheelEvent('wheel', {
          deltaY: -100,
          bubbles: true,
          cancelable: true,
        });
        // Can't dispatch without container, but we can test the internal state
        expect(closedTerminal.wasmTerm).toBeUndefined();
      }).not.toThrow();

      closedTerminal.dispose();
    });
  });
});

/**
 *
 * Tests for scrolling methods and events (Phase 2)
 */
describe('Scrolling Methods', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    document.body.removeChild(container);
    term = null!;
    container = null!;
  });

  test('scrollLines() should scroll viewport up', async () => {
    // Write some content to create scrollback
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll up 5 lines
    term.scrollLines(-5);

    // Should be scrolled up
    expect((term as any).viewportY).toBe(5);
  });

  test('scrollLines() should scroll viewport down', async () => {
    // Write content and scroll up first
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    // Now scroll down 5 lines
    term.scrollLines(5);

    // Should be at viewportY = 5
    expect((term as any).viewportY).toBe(5);
  });

  test('scrollLines() should not scroll beyond bounds', async () => {
    // Write limited content
    for (let i = 0; i < 10; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Try to scroll way up
    term.scrollLines(-1000);

    // Should be clamped to scrollback length
    const scrollbackLength = term.wasmTerm!.getScrollbackLength();
    expect((term as any).viewportY).toBeLessThanOrEqual(scrollbackLength);
  });

  test('scrollLines() should not scroll below bottom', async () => {
    // Write content and scroll up
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    // Try to scroll way down
    term.scrollLines(1000);

    // Should be at bottom (viewportY = 0)
    expect((term as any).viewportY).toBe(0);
  });

  test('scrollPages() should scroll by page', async () => {
    // Write content
    for (let i = 0; i < 100; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll up 2 pages
    term.scrollPages(-2);

    // Should be scrolled by 2 * rows lines
    expect((term as any).viewportY).toBe(2 * term.rows);
  });

  test('scrollToTop() should scroll to top of buffer', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll to top
    term.scrollToTop();

    // Should be at max scroll position
    const scrollbackLength = term.wasmTerm!.getScrollbackLength();
    expect((term as any).viewportY).toBe(scrollbackLength);
  });

  test('scrollToBottom() should scroll to bottom', async () => {
    // Write content and scroll up
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    // Scroll to bottom
    term.scrollToBottom();

    // Should be at bottom (viewportY = 0)
    expect((term as any).viewportY).toBe(0);
  });

  test('scrollToLine() should scroll to specific line', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Line 15 of the buffer (0 = oldest scrollback line) becomes the top row,
    // as in xterm.js.
    term.scrollToLine(15);

    const scrollbackLength = term.wasmTerm!.getScrollbackLength();
    expect(term.buffer.active.viewportY).toBe(15);
    expect(term.viewportY).toBe(scrollbackLength - 15);
    expect(term.buffer.active.getLine(15)!.translateToString(true)).toBe('Line 15');
  });

  test('scrollToLine() past the end scrolls to the bottom', async () => {
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    term.scrollToLine(1000);

    expect(term.viewportY).toBe(0);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  test('scrollToLine() before the start scrolls to the top', async () => {
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    term.scrollToLine(-5);

    expect(term.viewportY).toBe(term.wasmTerm!.getScrollbackLength());
    expect(term.buffer.active.viewportY).toBe(0);
  });

  test('immediate scrolls stop a running smooth scroll', async () => {
    for (let i = 0; i < 100; i++) {
      term.write(`Line ${i}\r\n`);
    }
    // Start a smooth scroll up with the wheel...
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, cancelable: true }));
    expect((term as any).scrollAnimationFrame).toBeDefined();

    // ...then jump to the bottom before it finishes.
    term.scrollToBottom();
    expect((term as any).scrollAnimationFrame).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(term.viewportY).toBe(0);

    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, cancelable: true }));
    term.scrollToLine(10);
    await new Promise((r) => setTimeout(r, 50));
    expect(term.buffer.active.viewportY).toBe(10);
  });
});

describe('Scroll Events', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    document.body.removeChild(container!);
    term = null!;
    container = null!;
  });

  test('onScroll should fire when scrolling', async () => {
    let scrollPosition = -1;
    let fireCount = 0;

    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    term.onScroll((position) => {
      scrollPosition = position;
      fireCount++;
    });

    // Scroll up
    term.scrollLines(-5);

    // Reports the top line, like xterm.js (buffer.active.viewportY)
    expect(fireCount).toBe(1);
    expect(scrollPosition).toBe(term.buffer.active.viewportY);
    expect(scrollPosition).toBe(term.wasmTerm!.getScrollbackLength() - 5);
  });

  test('onScroll fires as output scrolls the view at the bottom', async () => {
    const positions: number[] = [];
    term.onScroll((position) => positions.push(position));
    for (let i = 0; i < 30; i++) {
      term.write(`Line ${i}\r\n`);
    }
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.at(-1)).toBe(term.buffer.active.baseY);
  });

  test('onScroll does not fire for output while scrolled up', async () => {
    for (let i = 0; i < 50; i++) term.write(`Line ${i}\r\n`);
    term.scrollLines(-5);
    const positions: number[] = [];
    term.onScroll((position) => positions.push(position));
    for (let i = 0; i < 5; i++) term.write(`More ${i}\r\n`);
    expect(positions).toEqual([]);
  });

  test('onScroll should not fire if position unchanged', async () => {
    let fireCount = 0;

    term.onScroll(() => {
      fireCount++;
    });

    // Try to scroll at bottom (already at 0)
    term.scrollToBottom();

    expect(fireCount).toBe(0);
  });

  test('onScroll should fire multiple times for multiple scrolls', async () => {
    const positions: number[] = [];

    // Write content
    for (let i = 0; i < 100; i++) {
      term.write(`Line ${i}\r\n`);
    }
    const base = term.buffer.active.baseY;

    term.onScroll((position) => {
      positions.push(position);
    });

    // Multiple scrolls
    term.scrollLines(-5);
    term.scrollLines(-3);
    term.scrollLines(2);

    expect(positions).toEqual([base - 5, base - 8, base - 6]);
  });

  // Note: onRender event implementation uses dirty tracking for performance
  // implementation. Firing it every frame causes performance issues.

  test('onCursorMove should fire when cursor moves', async () => {
    let moveCount = 0;

    term.onCursorMove(() => {
      moveCount++;
    });

    // Write some lines (cursor moves)
    term.write('Line 1\r\n');
    term.write('Line 2\r\n');

    // Wait for render loop to detect cursor movement
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have fired at least once (cursor moved down)
    expect(moveCount).toBeGreaterThan(0);
  });
});

describe('Custom Wheel Event Handler', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
  });

  afterEach(() => {
    term!.dispose();
    document.body.removeChild(container!);
    term = null!;
    container = null!;
  });

  test('attachCustomWheelEventHandler() should set handler', async () => {
    const handler = () => true;
    term.attachCustomWheelEventHandler(handler);

    expect((term as any).customWheelEventHandler).toBe(handler);
  });

  test('attachCustomWheelEventHandler() should allow clearing handler', async () => {
    const handler = () => true;
    term.attachCustomWheelEventHandler(handler);
    term.attachCustomWheelEventHandler(undefined);

    expect((term as any).customWheelEventHandler).toBeUndefined();
  });

  test('custom wheel handler should block default scrolling when returning true', async () => {
    let handlerCalled = false;

    term.attachCustomWheelEventHandler(() => {
      handlerCalled = true;
      return true; // Block default
    });

    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Simulate wheel event
    const wheelEvent = new WheelEvent('wheel', { deltaY: 100 });
    container.dispatchEvent(wheelEvent);

    expect(handlerCalled).toBe(true);
    // Viewport should not have changed (blocked)
    expect((term as any).viewportY).toBe(0);
  });

  test('custom wheel handler should allow default scrolling when returning false', async () => {
    let handlerCalled = false;

    term.attachCustomWheelEventHandler(() => {
      handlerCalled = true;
      return false; // Allow default
    });

    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Simulate wheel event (scroll down)
    const wheelEvent = new WheelEvent('wheel', { deltaY: 100 });
    container.dispatchEvent(wheelEvent);

    expect(handlerCalled).toBe(true);
    // Viewport should have changed (default behavior)
    // Note: Due to scrolling at bottom, it won't change. Let's scroll up first.
  });

  test('wheel events should scroll terminal by default', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Simulate wheel up (negative deltaY = scroll up)
    const wheelEvent = new WheelEvent('wheel', { deltaY: -100 });
    container.dispatchEvent(wheelEvent);

    // Should have scrolled up
    expect((term as any).viewportY).toBeGreaterThan(0);
  });
});

describe('Scrolled view under heavy output', () => {
  test('stays within scrollback when history is pruned underneath it', async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 500 });
    term.open(c);
    try {
      for (let i = 0; i < 600; i++) term.write(`Line ${i}\r\n`);
      term.scrollLines(-100);
      for (let i = 600; i < 3000; i++) term.write(`Line ${i}\r\n`);
      const scrollback = term.wasmTerm!.getScrollbackLength();
      expect(term.viewportY).toBeGreaterThan(0);
      expect(term.viewportY).toBeLessThanOrEqual(scrollback);
      expect(term.wasmTerm!.getViewportOffset()).toBe(Math.floor(term.viewportY));
    } finally {
      term.dispose();
      c.remove();
    }
  });

  test('entering the alternate screen while scrolled shows it from the top', async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
    term.open(c);
    try {
      for (let i = 0; i < 100; i++) term.write(`Line ${i}\r\n`);
      term.scrollLines(-10);
      term.write('\x1b[?1049h\x1b[Hvim');
      expect(term.viewportY).toBe(0);
      term.write('\x1b[?1049l');
      expect(term.wasmTerm!.getScrollbackLength()).toBeGreaterThan(0);
    } finally {
      term.dispose();
      c.remove();
    }
  });
});

describe('Scrollbar', () => {
  let term: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10 });
    term.open(container);
    for (let i = 0; i < 100; i++) term.write(`Line ${i}\r\n`);
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  const bar = () =>
    (term as any).renderer.getScrollbarThumb(
      term.viewportY,
      term.wasmTerm!.getScrollbackLength(),
      term.rows
    );
  const mouse = (type: string, x: number, y: number) =>
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });

  test('clicking the track jumps there', () => {
    const b = bar();
    const down = mouse('mousedown', b.x + 1, b.trackY);
    container.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(term.buffer.active.viewportY).toBe(0);

    container.dispatchEvent(mouse('mousedown', b.x + 1, b.trackY + b.trackHeight / 2));
    const scrollback = term.wasmTerm!.getScrollbackLength();
    expect(term.viewportY).toBe(Math.round(scrollback / 2));
  });

  test('dragging the thumb scrolls in proportion, and mouseup ends the drag', () => {
    const b = bar();
    const scrollback = term.wasmTerm!.getScrollbackLength();
    const startY = b.y + b.height / 2;
    container.dispatchEvent(mouse('mousedown', b.x + 1, startY));
    const travel = b.trackHeight - b.height;
    container.dispatchEvent(mouse('mousemove', b.x + 1, startY - travel / 2));
    expect(term.viewportY).toBe(Math.round(scrollback / 2));
    container.dispatchEvent(mouse('mousemove', b.x + 1, startY - travel * 2));
    expect(term.buffer.active.viewportY).toBe(0);

    document.dispatchEvent(mouse('mouseup', b.x + 1, 0));
    expect((term as any).isDraggingScrollbar).toBe(false);
    container.dispatchEvent(mouse('mousemove', b.x + 1, startY));
    expect(term.buffer.active.viewportY).toBe(0);
  });

  test('clicks left of the scrollbar are not taken', () => {
    const down = mouse('mousedown', 5, 5);
    container.dispatchEvent(down);
    expect((term as any).isDraggingScrollbar).toBe(false);
    expect(term.viewportY).toBe(0);
  });

  test('fades in when scrolling and out after a delay, without its own animation loop', async () => {
    expect((term as any).scrollbarOpacity).toBe(0);
    let frames = 0;
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      frames++;
      return raf(cb);
    };
    try {
      term.scrollLines(-1);
      expect(frames).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
    await new Promise((r) => setTimeout(r, 250));
    expect((term as any).scrollbarOpacity).toBe(1);
    (term as any).hideScrollbar();
    await new Promise((r) => setTimeout(r, 250));
    expect((term as any).scrollbarOpacity).toBe(0);
  });
});
