/**
 * Selection Manager - Handles text selection in the terminal
 *
 * Selection is owned by libghostty-vt: the terminal keeps the selection in
 * step with its content (scrolling, new output, scrollback pruning), Ghostty's
 * selection gesture interprets clicks, double/triple clicks and drags, and
 * Ghostty's formatter produces the copied text. This class connects DOM mouse
 * events to that and keeps the xterm.js-style selection API.
 *
 * Features:
 * - Mouse drag selection, with autoscroll past the top or bottom edge
 * - Double-click word and triple-click line selection (Ghostty's rules)
 * - Automatic clipboard copy
 * - Visual selection highlighting (integrated into CanvasRenderer cell rendering)
 */

import { EventEmitter } from './event-emitter';
import {
  type GhosttyTerminal,
  SelectionAutoscroll,
  type SelectionGeometry,
  type SelectionGesture,
} from './ghostty';
import type { IEvent } from './interfaces';
import type { CanvasRenderer } from './renderer';
import type { Terminal } from './terminal';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SelectionCoordinates {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
  /** A block selection: columns startCol..endCol on every row. */
  rectangle?: boolean;
}

// ============================================================================
// SelectionManager Class
// ============================================================================

export class SelectionManager {
  private terminal: Terminal;
  private renderer: CanvasRenderer;
  private initialWasmTerm: GhosttyTerminal;
  private textarea: HTMLTextAreaElement;

  private gesture: SelectionGesture | null = null;
  private isSelecting: boolean = false;
  private mouseDownTarget: EventTarget | null = null; // Track where mousedown occurred
  /** Last pointer position during a drag, relative to the canvas (CSS px). */
  private lastPointer = { x: 0, y: 0 };
  /** Whether the current drag is a block selection (Alt held). */
  private rectangle = false;

  /** The textarea's own style while it is borrowed for a context menu. */
  private textareaStyle: string | null = null;

  // Event emitter
  private selectionChangedEmitter = new EventEmitter<void>();

  // Store bound event handlers for cleanup
  private boundMouseUpHandler: ((e: MouseEvent) => void) | null = null;
  private boundContextMenuHandler: ((e: MouseEvent) => void) | null = null;
  private boundClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundDocumentMouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private boundDocumentMouseDownHandler: ((e: MouseEvent) => void) | null = null;

  // Auto-scroll state for drag selection
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly AUTO_SCROLL_INTERVAL = 30; // ms per row, as the gesture scrolls one row per tick

  constructor(
    terminal: Terminal,
    renderer: CanvasRenderer,
    wasmTerm: GhosttyTerminal,
    textarea: HTMLTextAreaElement
  ) {
    this.terminal = terminal;
    this.renderer = renderer;
    this.initialWasmTerm = wasmTerm;
    this.textarea = textarea;

    // Attach mouse event listeners
    this.attachEventListeners();
  }

  /**
   * The terminal's current WASM terminal. Terminal.reset() replaces it, so it
   * is looked up on every use rather than kept.
   */
  private get wasmTerm(): GhosttyTerminal {
    return this.terminal.wasmTerm ?? this.initialWasmTerm;
  }

  /** The gesture for the current WASM terminal, recreated after a reset. */
  private getGesture(): SelectionGesture {
    const term = this.wasmTerm;
    if (this.gesture && this.gesture.terminal !== term) {
      // The old terminal has been freed; release the gesture without it.
      this.gesture.dispose(false);
      this.gesture = null;
    }
    if (!this.gesture) this.gesture = term.createSelectionGesture();
    return this.gesture;
  }

  /**
   * Get current viewport Y position (how many lines scrolled into history)
   */
  private getViewportY(): number {
    return Math.max(0, Math.floor(this.terminal.getViewportY()));
  }

  /** Number of rows in the buffer: scrollback, then the screen. */
  private bufferLength(): number {
    return this.wasmTerm.getScrollbackLength() + this.wasmTerm.getDimensions().rows;
  }

  /**
   * Convert absolute buffer row to viewport row (may be outside visible range)
   */
  private absoluteRowToViewport(absoluteRow: number): number {
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    const viewportY = this.getViewportY();
    return absoluteRow - scrollbackLength + viewportY;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  getSelection(): string {
    return this.wasmTerm.getSelectionText();
  }

  /**
   * Check if there's an active selection
   */
  hasSelection(): boolean {
    return this.wasmTerm.hasSelection();
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  copySelection(): boolean {
    if (!this.hasSelection()) return false;

    const text = this.getSelection();
    if (text) {
      this.copyToClipboard(text);
      return true;
    }
    return false;
  }

  /**
   * Clear the selection, firing onSelectionChange if there was one
   */
  clearSelection(): void {
    if (!this.hasSelection()) return;
    this.wasmTerm.clearSelection();
    this.isSelecting = false;
    this.stopAutoScroll();
    this.gesture?.reset();
    this.selectionChangedEmitter.fire();
  }

  /**
   * Select all text in the terminal, scrollback included
   */
  selectAll(): void {
    this.wasmTerm.selectAll();
    this.selectionChangedEmitter.fire();
  }

  /**
   * Select `length` cells starting at a column of an absolute buffer row
   * (0 = oldest scrollback row), continuing onto the following rows as
   * xterm.js does.
   */
  select(column: number, row: number, length: number): void {
    const cols = this.wasmTerm.getDimensions().cols;
    const last = this.bufferLength() * cols - 1;
    const start = Math.max(0, Math.min(row * cols + Math.max(0, Math.min(column, cols - 1)), last));
    const end = Math.min(start + Math.max(1, length) - 1, last);
    this.setSelectionAbsolute(
      start % cols,
      Math.floor(start / cols),
      end % cols,
      Math.floor(end / cols)
    );
    this.selectionChangedEmitter.fire();
  }

  /**
   * Select whole lines between two absolute buffer rows, both included
   * xterm.js compatible API
   */
  selectLines(start: number, end: number): void {
    const cols = this.wasmTerm.getDimensions().cols;
    const maxRow = this.bufferLength() - 1;
    start = Math.max(0, Math.min(start, maxRow));
    end = Math.max(0, Math.min(end, maxRow));
    if (start > end) [start, end] = [end, start];

    this.setSelectionAbsolute(0, start, cols - 1, end);
    this.selectionChangedEmitter.fire();
  }

  /**
   * Select between two cells given in absolute buffer rows (0 = oldest
   * scrollback row), both included. Does not fire onSelectionChange.
   * @internal
   */
  setSelectionAbsolute(startCol: number, startRow: number, endCol: number, endRow: number): void {
    this.wasmTerm.setSelectionRange(startCol, startRow, endCol, endRow);
  }

  /**
   * The selection as xterm.js reports it: absolute buffer rows (0 = oldest
   * scrollback row, whether or not it is on screen), start column included and
   * end column excluded, so a selection to the end of a row ends at x = cols.
   */
  getSelectionPosition():
    | { start: { x: number; y: number }; end: { x: number; y: number } }
    | undefined {
    const range = this.wasmTerm.getSelectionRange();
    if (!range) return undefined;
    return {
      start: { x: range.startCol, y: range.startRow },
      end: { x: range.endCol + 1, y: range.endRow },
    };
  }

  /**
   * Deselect all text
   * xterm.js compatible API
   */
  deselect(): void {
    this.clearSelection();
  }

  /**
   * Get current selection coordinates (for rendering)
   */
  getSelectionCoords(): SelectionCoordinates | null {
    return this.normalizeSelection();
  }

  /**
   * Get selection change event accessor
   */
  get onSelectionChange(): IEvent<void> {
    return this.selectionChangedEmitter.event;
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.selectionChangedEmitter.dispose();

    // Stop auto-scroll if active
    this.stopAutoScroll();
    this.restoreTextarea();

    // The terminal may already have been freed by the time we are disposed.
    if (this.gesture) {
      this.gesture.dispose(this.terminal.wasmTerm === this.gesture.terminal);
      this.gesture = null;
    }

    // Clean up document event listeners
    if (this.boundMouseUpHandler) {
      document.removeEventListener('mouseup', this.boundMouseUpHandler);
      this.boundMouseUpHandler = null;
    }
    if (this.boundDocumentMouseMoveHandler) {
      document.removeEventListener('mousemove', this.boundDocumentMouseMoveHandler);
      this.boundDocumentMouseMoveHandler = null;
    }
    if (this.boundDocumentMouseDownHandler) {
      document.removeEventListener('mousedown', this.boundDocumentMouseDownHandler);
      this.boundDocumentMouseDownHandler = null;
    }

    // Clean up context menu event listener
    if (this.boundContextMenuHandler) {
      const canvas = this.renderer.getCanvas();
      canvas.removeEventListener('contextmenu', this.boundContextMenuHandler);
      this.boundContextMenuHandler = null;
    }

    // Clean up document click listener
    if (this.boundClickHandler) {
      document.removeEventListener('click', this.boundClickHandler);
      this.boundClickHandler = null;
    }

    // Canvas event listeners will be cleaned up when canvas is removed from DOM
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /** Geometry the gesture needs to interpret drags and autoscroll. */
  private geometry(): SelectionGeometry {
    const metrics = this.renderer.getMetrics();
    return {
      columns: this.terminal.cols,
      cellWidth: metrics.width,
      screenHeight: this.terminal.rows * metrics.height,
    };
  }

  /**
   * Point libghostty's viewport at what is displayed, so viewport cells under
   * the pointer resolve to the content the user sees.
   */
  private syncViewport(): void {
    this.wasmTerm.setViewportOffset(this.getViewportY());
  }

  /**
   * Feed a drag at canvas position (x, y), which may lie outside the canvas.
   * Holding Alt makes it a block (rectangular) selection, as in Ghostty.
   */
  private dragTo(x: number, y: number, altKey: boolean): void {
    this.lastPointer = { x, y };
    this.rectangle = altKey;
    this.syncViewport();
    const cell = this.pixelToCell(x, y);
    this.getGesture().drag(cell.col, cell.row, x, y, this.geometry(), this.rectangle);

    if (this.getGesture().autoscroll() === SelectionAutoscroll.NONE) {
      this.stopAutoScroll();
    } else {
      this.startAutoScroll();
    }
  }

  /**
   * Attach mouse event listeners to canvas
   */
  private attachEventListeners(): void {
    const canvas = this.renderer.getCanvas();

    // Mouse down - start a gesture. A single click clears the selection; a
    // double or triple click selects a word or line.
    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      // A context-menu click must not start (or clear) a selection. The textarea
      // is moved under the pointer now, before the browser picks the menu's
      // target; doing it in the contextmenu event is too late.
      if (e.button === 2 || (e.button === 0 && e.ctrlKey && SelectionManager.isMac())) {
        this.prepareContextMenu(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0) return;

      // A program tracking the mouse gets plain clicks and drags (reported by
      // the InputHandler); Shift+drag still selects, as in Ghostty.
      if (this.wasmTerm.hasMouseTracking() && !e.shiftKey) return;

      // Keyboard input, IME composition included, goes to the textarea.
      this.textarea.focus();

      this.syncViewport();
      const cell = this.pixelToCell(e.offsetX, e.offsetY);
      const time = e.timeStamp > 0 ? e.timeStamp : performance.now();
      const hadSelection = this.hasSelection();
      this.getGesture().press(cell.col, cell.row, e.offsetX, e.offsetY, time);
      this.isSelecting = true;
      // A plain click clears the selection; a double or triple click makes one.
      if (hadSelection || this.hasSelection()) this.selectionChangedEmitter.fire();
      this.lastPointer = { x: e.offsetX, y: e.offsetY };
    });

    // Mouse move on canvas - update selection
    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isSelecting) this.dragTo(e.offsetX, e.offsetY, e.altKey);
    });

    // Document-level mousemove for tracking the pointer while dragging outside
    // the canvas. Positions stay unclamped so the gesture sees which edge the
    // pointer is past and asks for autoscroll.
    this.boundDocumentMouseMoveHandler = (e: MouseEvent) => {
      if (!this.isSelecting) return;
      const rect = canvas.getBoundingClientRect();
      const outside =
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom;
      if (outside) this.dragTo(e.clientX - rect.left, e.clientY - rect.top, e.altKey);
    };
    document.addEventListener('mousemove', this.boundDocumentMouseMoveHandler);

    // Track mousedown on document to know if a click started inside the canvas
    this.boundDocumentMouseDownHandler = (e: MouseEvent) => {
      this.mouseDownTarget = e.target;
    };
    document.addEventListener('mousedown', this.boundDocumentMouseDownHandler);

    // CRITICAL FIX: Listen for mouseup on DOCUMENT, not just canvas
    // This catches mouseup events that happen outside the canvas (common during drag)
    this.boundMouseUpHandler = () => {
      if (!this.isSelecting) return;
      this.isSelecting = false;
      this.stopAutoScroll();
      this.getGesture().release();

      if (this.hasSelection()) {
        const text = this.getSelection();
        if (text) {
          this.copyToClipboard(text);
          this.selectionChangedEmitter.fire();
        }
      }
    };
    document.addEventListener('mouseup', this.boundMouseUpHandler);

    // Keyboard context-menu key (no mousedown): prepare as late as possible.
    this.boundContextMenuHandler = (e: MouseEvent) => {
      if (this.textareaStyle === null) this.prepareContextMenu(e.clientX, e.clientY);
      // Don't prevent default - let browser show the context menu on the textarea
    };
    canvas.addEventListener('contextmenu', this.boundContextMenuHandler);

    // Click outside canvas - clear selection
    // This allows users to deselect by clicking anywhere outside the terminal
    this.boundClickHandler = (e: MouseEvent) => {
      // Don't clear selection if we're actively selecting
      if (this.isSelecting) {
        return;
      }

      // A click is only valid for clearing selection if BOTH mousedown and mouseup
      // happened outside the canvas. If mousedown was inside (drag selection),
      // don't clear even if mouseup/click is outside.
      const mouseDownWasInCanvas =
        this.mouseDownTarget && canvas.contains(this.mouseDownTarget as Node);
      if (mouseDownWasInCanvas) {
        return;
      }

      // Check if the click is outside the canvas
      const target = e.target as Node;
      if (!canvas.contains(target)) {
        // Clicked outside the canvas - clear selection
        if (this.hasSelection()) {
          this.clearSelection();
        }
      }
    };

    document.addEventListener('click', this.boundClickHandler);
  }

  private static isMac(): boolean {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  }

  /**
   * Put the hidden input textarea under the pointer, holding the selected text
   * (selected), so the browser's native context menu opens on it and offers
   * Copy and Paste. The terminal hides the textarea with a clip-path, which
   * also stops it being hit, so that is lifted until the menu is done.
   */
  private prepareContextMenu(clientX: number, clientY: number): void {
    const ta = this.textarea;
    if (this.textareaStyle === null) this.textareaStyle = ta.style.cssText;
    Object.assign(ta.style, {
      position: 'fixed',
      left: `${clientX - 2}px`,
      top: `${clientY - 2}px`,
      width: '4px',
      height: '4px',
      zIndex: '1000',
      opacity: '0',
      clipPath: 'none',
      pointerEvents: 'auto',
    });

    ta.value = this.hasSelection() ? this.getSelection() : '';
    ta.focus();
    if (ta.value) ta.setSelectionRange(0, ta.value.length);

    // Put the textarea back once the menu is done with: on the next pointer
    // press or key press anywhere, or when it loses focus. Registered after
    // this event so the press that opened the menu doesn't count.
    setTimeout(() => {
      document.addEventListener('mousedown', this.restoreTextarea, true);
      document.addEventListener('keydown', this.restoreTextarea, true);
      ta.addEventListener('blur', this.restoreTextarea);
    }, 0);
  }

  /** Undo prepareContextMenu(). */
  private restoreTextarea = (): void => {
    document.removeEventListener('mousedown', this.restoreTextarea, true);
    document.removeEventListener('keydown', this.restoreTextarea, true);
    this.textarea.removeEventListener('blur', this.restoreTextarea);
    if (this.textareaStyle === null) return;
    this.textarea.style.cssText = this.textareaStyle;
    this.textareaStyle = null;
    this.textarea.value = '';
  };

  /**
   * Keep ticking the gesture while it asks for autoscroll. Each tick scrolls
   * libghostty's viewport one row and extends the selection; ghostterm's
   * viewport then follows.
   */
  private startAutoScroll(): void {
    if (this.autoScrollInterval !== null) return;

    this.autoScrollInterval = setInterval(() => {
      if (!this.isSelecting) {
        this.stopAutoScroll();
        return;
      }
      this.syncViewport();
      const { x, y } = this.lastPointer;
      const cell = this.pixelToCell(x, y);
      const ok = this.getGesture().autoscrollTick(
        cell.col,
        cell.row,
        x,
        y,
        this.geometry(),
        this.rectangle
      );
      this.terminal.scrollToLine(this.wasmTerm.getViewportOffset());
      if (!ok || this.getGesture().autoscroll() === SelectionAutoscroll.NONE) {
        this.stopAutoScroll();
      }
    }, SelectionManager.AUTO_SCROLL_INTERVAL);
  }

  /**
   * Stop auto-scrolling
   */
  private stopAutoScroll(): void {
    if (this.autoScrollInterval !== null) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
  }

  /**
   * Convert pixel coordinates to terminal cell coordinates, clamped to the grid
   */
  private pixelToCell(x: number, y: number): { col: number; row: number } {
    const metrics = this.renderer.getMetrics();

    const col = Math.floor(x / metrics.width);
    const row = Math.floor(y / metrics.height);

    return {
      col: Math.max(0, Math.min(col, this.terminal.cols - 1)),
      row: Math.max(0, Math.min(row, this.terminal.rows - 1)),
    };
  }

  /**
   * The selection in VIEWPORT space for rendering, clamped to the visible area,
   * or null when there is none or it is entirely off screen.
   */
  private normalizeSelection(): SelectionCoordinates | null {
    const range = this.wasmTerm.getSelectionRange();
    if (!range) return null;

    let { startCol, endCol } = range;
    let startRow = this.absoluteRowToViewport(range.startRow);
    let endRow = this.absoluteRowToViewport(range.endRow);

    const dims = this.wasmTerm.getDimensions();
    const maxRow = dims.rows - 1;

    // If entire selection is outside viewport, return null
    if (endRow < 0 || startRow > maxRow) {
      return null;
    }

    // Clamp rows to visible range. A linear selection continues to the start
    // or end of the clamped row; a block keeps its columns.
    if (startRow < 0) {
      startRow = 0;
      if (!range.rectangle) startCol = 0;
    }
    if (endRow > maxRow) {
      endRow = maxRow;
      if (!range.rectangle) endCol = dims.cols - 1;
    }

    return { startCol, startRow, endCol, endRow, rectangle: range.rectangle };
  }

  /**
   * Copy text to clipboard
   *
   * Strategy (modern APIs first):
   * 1. Try ClipboardItem API (works in Safari and modern browsers)
   *    - Safari requires the ClipboardItem to be created synchronously within user gesture
   * 2. Try navigator.clipboard.writeText (modern async API, may fail in Safari)
   * 3. Fall back to execCommand (legacy, for older browsers)
   */
  private copyToClipboard(text: string): void {
    // First try: ClipboardItem API (modern, Safari-compatible)
    // Safari allows this because we create the ClipboardItem synchronously
    // within the user gesture, even though the write is async
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        const blob = new Blob([text], { type: 'text/plain' });
        const clipboardItem = new ClipboardItem({
          'text/plain': blob,
        });
        navigator.clipboard.write([clipboardItem]).catch((err) => {
          console.warn('ClipboardItem write failed, trying writeText:', err);
          // Try writeText as fallback
          this.copyWithWriteText(text);
        });
        return;
      } catch (err) {
        // ClipboardItem not supported or failed, fall through
      }
    }

    // Second try: basic async writeText (works in Chrome, may fail in Safari)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn('Clipboard writeText failed, trying execCommand:', err);
        // Fall back to execCommand
        this.copyWithExecCommand(text);
      });
      return;
    }

    // Third try: legacy execCommand fallback
    this.copyWithExecCommand(text);
  }

  /**
   * Copy using navigator.clipboard.writeText
   */
  private copyWithWriteText(text: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn('Clipboard writeText failed, trying execCommand:', err);
        this.copyWithExecCommand(text);
      });
    } else {
      this.copyWithExecCommand(text);
    }
  }

  /**
   * Copy using legacy execCommand (fallback for older browsers)
   */
  private copyWithExecCommand(text: string): void {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const textarea = this.textarea;
    const style = textarea.style.cssText;
    try {
      // Position textarea offscreen but in a way that allows selection
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.opacity = '0';

      // Select all text and copy
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);

      if (!document.execCommand('copy')) {
        console.warn('execCommand copy failed');
      }
    } catch (err) {
      console.warn('execCommand copy threw:', err);
    } finally {
      textarea.value = '';
      textarea.style.cssText = style;
      previouslyFocused?.focus();
    }
  }
}
