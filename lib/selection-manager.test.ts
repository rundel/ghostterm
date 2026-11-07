/**
 * Selection Manager Tests
 *
 * Tests for text selection functionality including:
 * - Basic selection operations
 * - Absolute coordinate system for scroll persistence
 * - Selection clearing behavior
 * - Auto-scroll during drag selection
 * - Copy functionality with scrollback
 *
 * Test Isolation Pattern:
 * Uses createIsolatedTerminal() to ensure each test gets its own WASM instance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

/**
 * Helper to set selection using absolute coordinates
 */
function setSelectionAbsolute(
  term: Terminal,
  startCol: number,
  startAbsRow: number,
  endCol: number,
  endAbsRow: number
): void {
  const selMgr = (term as any).selectionManager;
  selMgr?.setSelectionAbsolute(startCol, startAbsRow, endCol, endAbsRow);
}

/**
 * Helper to convert viewport row to absolute row
 */
function viewportToAbsolute(term: Terminal, viewportRow: number): number {
  const scrollbackLength = term.wasmTerm?.getScrollbackLength() ?? 0;
  const viewportY = term.getViewportY();
  return scrollbackLength + viewportRow - Math.floor(viewportY);
}

describe('SelectionManager', () => {
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    if (typeof document !== 'undefined') {
      container = document.createElement('div');
      document.body.appendChild(container);
    }
  });

  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  describe('Construction', () => {
    test('creates without errors', async () => {
      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      expect(term).toBeDefined();
    });
  });

  describe('API', () => {
    test('has required public methods', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(typeof selMgr.getSelection).toBe('function');
      expect(typeof selMgr.hasSelection).toBe('function');
      expect(typeof selMgr.clearSelection).toBe('function');
      expect(typeof selMgr.selectAll).toBe('function');
      expect(typeof selMgr.getSelectionCoords).toBe('function');
      expect(typeof selMgr.dispose).toBe('function');
      expect(typeof selMgr.getDirtySelectionRows).toBe('function');
      expect(typeof selMgr.clearDirtySelectionRows).toBe('function');

      term.dispose();
    });
  });

  describe('Selection with absolute coordinates', () => {
    test('hasSelection returns false when no selection', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(false);

      term.dispose();
    });

    test('hasSelection returns true when selection exists', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      // Set selection using absolute coordinates
      setSelectionAbsolute(term, 0, 0, 5, 0);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(true);

      term.dispose();
    });

    test('hasSelection returns true for single cell programmatic selection', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      // Programmatic single-cell selection should be valid
      // (e.g., triple-click on single-char line, or select(col, row, 1))
      setSelectionAbsolute(term, 5, 0, 5, 0);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(true);

      term.dispose();
    });

    test('clearSelection clears selection and marks rows dirty', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen + 2);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(true);

      selMgr.clearSelection();

      expect(selMgr.hasSelection()).toBe(false);
      // Dirty rows should be marked for redraw
      const dirtyRows = selMgr.getDirtySelectionRows();
      expect(dirtyRows.size).toBeGreaterThan(0);

      term.dispose();
    });
  });

  describe('Selection text extraction', () => {
    test('getSelection returns empty string when no selection', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.getSelection()).toBe('');

      term.dispose();
    });

    test('getSelection extracts text from screen buffer', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select "Hello" (first 5 characters)
      setSelectionAbsolute(term, 0, scrollbackLen, 4, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.getSelection()).toBe('Hello');

      term.dispose();
    });

    test('getSelection extracts multi-line text', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select all three lines
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen + 2);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');
      expect(text).toContain('Line 3');

      term.dispose();
    });

    test('getSelection extracts text from scrollback', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write enough lines to create scrollback
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      expect(scrollbackLen).toBeGreaterThan(0);

      // Select from scrollback (first few lines)
      setSelectionAbsolute(term, 0, 0, 10, 2);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toContain('Line 000');
      expect(text).toContain('Line 001');
      expect(text).toContain('Line 002');

      term.dispose();
    });

    test('getSelection extracts text spanning scrollback and screen', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write enough lines to fill scrollback and screen
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();

      // Select spanning scrollback and screen
      // End of scrollback through beginning of screen
      setSelectionAbsolute(term, 0, scrollbackLen - 2, 10, scrollbackLen + 2);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      // Should contain lines from both regions
      expect(text.split('\n').length).toBeGreaterThanOrEqual(4);

      term.dispose();
    });
  });

  describe('Selection persistence during scroll', () => {
    test('selection coordinates are preserved when scrolling', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write content
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();

      // Set selection at specific absolute position
      const startAbsRow = scrollbackLen + 5;
      const endAbsRow = scrollbackLen + 10;
      setSelectionAbsolute(term, 0, startAbsRow, 10, endAbsRow);

      const selMgr = (term as any).selectionManager;
      const textBefore = selMgr.getSelection();

      // Scroll up
      term.scrollLines(-10);

      // Selection should still return the same text
      const textAfter = selMgr.getSelection();
      expect(textAfter).toBe(textBefore);

      term.dispose();
    });

    test('selection coords convert correctly after scrolling', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write content
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();

      // Set selection in screen buffer area
      setSelectionAbsolute(term, 0, scrollbackLen, 10, scrollbackLen + 5);

      const selMgr = (term as any).selectionManager;

      // Get viewport coords before scroll
      const coordsBefore = selMgr.getSelectionCoords();
      expect(coordsBefore).not.toBeNull();

      // Scroll up 10 lines
      term.scrollLines(-10);

      // Get viewport coords after scroll - they should have shifted
      const coordsAfter = selMgr.getSelectionCoords();
      expect(coordsAfter).not.toBeNull();

      // Viewport row should have increased by the scroll amount
      expect(coordsAfter!.startRow).toBe(coordsBefore!.startRow + 10);
      expect(coordsAfter!.endRow).toBe(coordsBefore!.endRow + 10);

      term.dispose();
    });

    test('selection outside viewport returns null coords but preserves text', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write content
      for (let i = 0; i < 100; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      // Select near the bottom of the buffer
      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen + 10, 10, scrollbackLen + 15);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      // Scroll to top - selection should be way off screen
      term.scrollToTop();

      // Coords should be null (off screen) but text should still work
      const coords = selMgr.getSelectionCoords();
      expect(coords).toBeNull();

      // Text extraction should still work
      expect(selMgr.getSelection()).toBe(text);

      term.dispose();
    });
  });

  describe('Dirty row tracking', () => {
    test('getDirtySelectionRows returns empty set initially', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.getDirtySelectionRows().size).toBe(0);

      term.dispose();
    });

    test('clearSelection marks selection rows as dirty', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Test content\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen + 3);

      const selMgr = (term as any).selectionManager;
      selMgr.clearSelection();

      const dirtyRows = selMgr.getDirtySelectionRows();
      expect(dirtyRows.size).toBeGreaterThan(0);

      term.dispose();
    });

    test('clearDirtySelectionRows clears the set', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Test\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      selMgr.clearSelection();

      expect(selMgr.getDirtySelectionRows().size).toBeGreaterThan(0);

      selMgr.clearDirtySelectionRows();

      expect(selMgr.getDirtySelectionRows().size).toBe(0);

      term.dispose();
    });
  });

  describe('Backward selection', () => {
    test('handles selection from right to left', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select backwards (end before start)
      setSelectionAbsolute(term, 10, scrollbackLen, 0, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toBe('Hello World');

      term.dispose();
    });

    test('handles selection from bottom to top', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select backwards (end row before start row)
      setSelectionAbsolute(term, 5, scrollbackLen + 2, 0, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');
      expect(text).toContain('Line 3');

      term.dispose();
    });
  });

  describe('selectAll', () => {
    test('selectAll selects all content, scrollback included (as in xterm.js)', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 5 });
      term.open(container);

      for (let i = 0; i < 8; i++) term.write(`Row ${i}\r\n`);
      term.write('Last');

      const selMgr = (term as any).selectionManager;
      selMgr.selectAll();

      expect(selMgr.hasSelection()).toBe(true);
      const text = selMgr.getSelection();
      expect(text.startsWith('Row 0\nRow 1')).toBe(true);
      expect(text.endsWith('Row 7\nLast')).toBe(true);

      const coords = selMgr.getSelectionCoords();
      expect(coords).not.toBeNull();
      expect(coords!.startRow).toBe(0);
      expect(coords!.startCol).toBe(0);

      term.dispose();
    });
  });

  describe('select() API', () => {
    test('select() creates selection at specified position', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.select(0, 0, 5);

      expect(selMgr.hasSelection()).toBe(true);
      expect(selMgr.getSelection()).toBe('Hello');

      term.dispose();
    });
  });

  describe('selectLines() API', () => {
    test('selectLines() selects entire lines', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.selectLines(0, 1);

      expect(selMgr.hasSelection()).toBe(true);

      const text = selMgr.getSelection();
      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');

      term.dispose();
    });
  });

  describe('scrollback content accuracy', () => {
    test('getScrollbackLine returns correct content after lines scroll off', async () => {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 800 });
      Object.defineProperty(container, 'clientHeight', { value: 480 });
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      // Write 50 lines to push content into scrollback (terminal has 24 rows)
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i}\r\n`);
      }

      const wasmTerm = (term as any).wasmTerm;
      const scrollbackLen = wasmTerm.getScrollbackLength();
      expect(scrollbackLen).toBeGreaterThan(0);

      // First scrollback line (oldest) should contain "Line 0"
      const firstLine = wasmTerm.getScrollbackLine(0);
      expect(firstLine).not.toBeNull();
      const firstText = firstLine!
        .map((c: any) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ''))
        .join('')
        .trim();
      expect(firstText).toContain('Line 0');

      // Last scrollback line should contain content near the boundary
      const lastLine = wasmTerm.getScrollbackLine(scrollbackLen - 1);
      expect(lastLine).not.toBeNull();
      const lastText = lastLine!
        .map((c: any) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ''))
        .join('')
        .trim();
      // The last scrollback line is the one just above the visible viewport
      expect(lastText).toMatch(/Line \d+/);

      term.dispose();
    });

    test('selection clears when user types', async () => {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 800 });
      Object.defineProperty(container, 'clientHeight', { value: 480 });
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.selectLines(0, 0);
      expect(selMgr.hasSelection()).toBe(true);

      // Simulate the input callback clearing selection
      // The actual input handler calls clearSelection before firing data
      selMgr.clearSelection();
      expect(selMgr.hasSelection()).toBe(false);

      term.dispose();
    });

    test('triple-click selects correct line in scrollback region', async () => {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 800 });
      Object.defineProperty(container, 'clientHeight', { value: 480 });
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      // Write enough lines to create scrollback
      for (let i = 0; i < 50; i++) {
        term.write(`TestLine${i}\r\n`);
      }

      const wasmTerm = (term as any).wasmTerm;
      const scrollbackLen = wasmTerm.getScrollbackLength();
      expect(scrollbackLen).toBeGreaterThan(0);

      // Verify multiple scrollback lines have correct content
      for (let i = 0; i < Math.min(5, scrollbackLen); i++) {
        const line = wasmTerm.getScrollbackLine(i);
        expect(line).not.toBeNull();
        const text = line!
          .map((c: any) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ''))
          .join('')
          .trim();
        expect(text).toContain(`TestLine${i}`);
      }

      // Use selectLines to select a single line and verify content
      const selMgr = (term as any).selectionManager;
      selMgr.selectLines(0, 0);
      expect(selMgr.hasSelection()).toBe(true);
      const selectedText = selMgr.getSelection();
      expect(selectedText.length).toBeGreaterThan(0);

      term.dispose();
    });
  });
});

describe('SelectionManager mouse gestures (libghostty)', () => {
  let container: HTMLElement;
  let term: Terminal;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 5 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  /**
   * Dispatch a mouse event in a cell. `fx` is how far across the cell the
   * pointer is; like Ghostty, a drag only includes its end cell once the
   * pointer passes the cell's midpoint.
   */
  function mouse(
    type: string,
    col: number,
    row: number,
    timeStamp: number,
    target?: EventTarget,
    fx = 0.5
  ) {
    const renderer = (term as any).renderer;
    const metrics = renderer.getMetrics();
    const canvas: HTMLCanvasElement = renderer.getCanvas();
    const x = (col + fx) * metrics.width;
    const y = (row + 0.5) * metrics.height;
    const e = new MouseEvent(type, { button: 0, bubbles: true });
    Object.defineProperty(e, 'offsetX', { value: x });
    Object.defineProperty(e, 'offsetY', { value: y });
    Object.defineProperty(e, 'timeStamp', { value: timeStamp });
    (target ?? canvas).dispatchEvent(e);
  }

  const selMgr = () => (term as any).selectionManager;

  test('dragging selects text', () => {
    term.write('hello world');
    mouse('mousedown', 0, 0, 1000);
    mouse('mousemove', 4, 0, 1050, undefined, 0.9);
    mouse('mouseup', 4, 0, 1060, document);
    expect(selMgr().getSelection()).toBe('hello');
  });

  test('a plain click clears an existing selection', () => {
    term.write('hello world');
    selMgr().select(0, 0, 5);
    expect(selMgr().hasSelection()).toBe(true);
    mouse('mousedown', 8, 0, 1000);
    mouse('mouseup', 8, 0, 1010, document);
    expect(selMgr().hasSelection()).toBe(false);
  });

  test('double-click selects a word using Ghostty word rules', () => {
    term.write('ls ~/projects/ghostty-web');
    for (const t of [1000, 1100]) {
      mouse('mousedown', 10, 0, t);
      mouse('mouseup', 10, 0, t + 10, document);
    }
    expect(selMgr().getSelection()).toBe('~/projects/ghostty-web');
  });

  test('selection fires onSelectionChange and copies on release', () => {
    term.write('copy me');
    let changes = 0;
    selMgr().onSelectionChange(() => changes++);
    const copied: string[] = [];
    (selMgr() as any).copyToClipboard = (text: string) => copied.push(text);
    mouse('mousedown', 0, 0, 1000);
    mouse('mousemove', 3, 0, 1050, undefined, 0.9);
    mouse('mouseup', 3, 0, 1060, document);
    expect(copied).toEqual(['copy']);
    expect(changes).toBe(1);
  });

  test('dragging above the top autoscrolls into scrollback', async () => {
    for (let i = 0; i < 20; i++) term.write(`row ${i}\r\n`);
    term.write('last');
    mouse('mousedown', 2, 4, 1000);

    const canvas: HTMLCanvasElement = (term as any).renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const out = new MouseEvent('mousemove', {
      clientX: rect.left + 5,
      clientY: rect.top - 20,
      bubbles: true,
    });
    document.dispatchEvent(out);

    await new Promise((r) => setTimeout(r, 200));
    mouse('mouseup', 0, 0, 1500, document);

    expect(term.getViewportY()).toBeGreaterThan(0);
    const text: string = selMgr().getSelection();
    expect(text.endsWith('la')).toBe(true);
    expect(text.split('\n').length).toBeGreaterThan(5);
  });

  test('selection keeps working after reset()', () => {
    term.write('before');
    selMgr().select(0, 0, 3);
    term.reset();
    expect(selMgr().hasSelection()).toBe(false);
    term.write('after');
    mouse('mousedown', 0, 0, 1000);
    mouse('mousemove', 4, 0, 1050, undefined, 0.9);
    mouse('mouseup', 4, 0, 1060, document);
    expect(selMgr().getSelection()).toBe('after');
  });
});

describe('SelectionManager block selection (Alt-drag)', () => {
  let container: HTMLElement;
  let term: Terminal;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 5 });
    term.open(container);
    term.write('abcdef\r\nghijkl\r\nmnopqr');
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  /**
   * Presses land near a cell's left edge and drags past its midpoint, since
   * Ghostty anchors and extends selections by cell halves.
   */
  function mouse(type: string, col: number, row: number, altKey: boolean, target?: EventTarget) {
    const fx = type === 'mousedown' ? 0.1 : 0.9;
    const renderer = (term as any).renderer;
    const metrics = renderer.getMetrics();
    const e = new MouseEvent(type, { button: 0, bubbles: true, altKey });
    Object.defineProperty(e, 'offsetX', { value: (col + fx) * metrics.width });
    Object.defineProperty(e, 'offsetY', { value: (row + 0.5) * metrics.height });
    Object.defineProperty(e, 'timeStamp', { value: 1000 });
    (target ?? renderer.getCanvas()).dispatchEvent(e);
  }

  const selMgr = () => (term as any).selectionManager;

  test('Alt-drag selects a block of columns', () => {
    mouse('mousedown', 1, 0, true);
    mouse('mousemove', 3, 2, true);
    mouse('mouseup', 3, 2, true, document);
    expect(selMgr().getSelection()).toBe('bcd\nhij\nnop');
    const coords = selMgr().getSelectionCoords();
    expect(coords).toMatchObject({
      startCol: 1,
      endCol: 3,
      startRow: 0,
      endRow: 2,
      rectangle: true,
    });
  });

  test('a block dragged up and to the left is normalized', () => {
    mouse('mousedown', 4, 2, true);
    mouse('mousemove', 1, 0, true);
    mouse('mouseup', 1, 0, true, document);
    const coords = selMgr().getSelectionCoords();
    expect(coords.startCol).toBeLessThanOrEqual(coords.endCol);
    expect(coords.startRow).toBe(0);
    expect(selMgr().getSelection().split('\n')).toHaveLength(3);
  });

  test('the same drag without Alt is a linear selection', () => {
    mouse('mousedown', 1, 0, false);
    mouse('mousemove', 3, 2, false);
    mouse('mouseup', 3, 2, false, document);
    expect(selMgr().getSelection()).toBe('bcdef\nghijkl\nmnop');
    expect(selMgr().getSelectionCoords().rectangle).toBe(false);
  });

  test('the renderer highlights only the block columns', () => {
    mouse('mousedown', 1, 0, true);
    mouse('mousemove', 3, 2, true);
    mouse('mouseup', 3, 2, true, document);
    const renderer = (term as any).renderer;
    renderer.currentSelectionCoords = selMgr().getSelectionCoords();
    const inSel = (x: number, y: number) => renderer.isInSelection(x, y);
    expect([inSel(0, 1), inSel(1, 1), inSel(3, 1), inSel(4, 1)]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect([inSel(5, 0), inSel(0, 2)]).toEqual([false, false]);
  });
});

describe('SelectionManager context menu', () => {
  let container: HTMLElement;
  let term: Terminal;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 5 });
    term.open(container);
    term.write('copy this text');
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  function rightDown(init: MouseEventInit = { button: 2 }) {
    const canvas: HTMLCanvasElement = (term as any).renderer.getCanvas();
    const e = new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 20, ...init });
    canvas.dispatchEvent(e);
  }

  test('right mousedown puts the selected text under the pointer, unclipped', () => {
    const selMgr = (term as any).selectionManager;
    selMgr.select(0, 0, 9);
    const ta = (term as any).textarea as HTMLTextAreaElement;
    const original = ta.style.cssText;

    rightDown();

    expect(selMgr.getSelection()).toBe('copy this'); // not cleared by the click
    expect(ta.value).toBe('copy this');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 9]);
    expect(ta.style.position).toBe('fixed');
    expect(ta.style.left).toBe('48px');
    expect(ta.style.clipPath).toBe('none');
    expect(ta.style.pointerEvents).toBe('auto');
    expect(document.activeElement).toBe(ta);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        expect(ta.style.cssText).toBe(original);
        expect(ta.value).toBe('');
        resolve();
      }, 5);
    });
  });

  test('right-click with no selection still prepares the textarea (for Paste)', () => {
    rightDown();
    const ta = (term as any).textarea as HTMLTextAreaElement;
    expect(ta.value).toBe('');
    expect(ta.style.clipPath).toBe('none');
  });
});
