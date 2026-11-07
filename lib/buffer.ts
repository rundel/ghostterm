/**
 * Buffer API - xterm.js-compatible buffer access
 *
 * Provides read-only access to terminal buffer contents, cursor state,
 * and viewport position. Wraps Ghostty WASM terminal state.
 *
 * Usage:
 * ```typescript
 * const cell = term.buffer.active.getLine(0)?.getCell(5);
 * console.log(cell?.getChars(), cell?.isBold());
 *
 * if (term.buffer.active.type === 'alternate') {
 *   console.log('Full-screen app running');
 * }
 * ```
 */

import { EventEmitter } from './event-emitter';
import type { GhosttyTerminal } from './ghostty';
import { CellFlags } from './ghostty';
import type { IBuffer, IBufferCell, IBufferLine, IBufferNamespace, IEvent } from './interfaces';
import type { Terminal } from './terminal';
import type { GhosttyCell } from './types';

/** Color modes as xterm.js reports them (getFgColorMode/getBgColorMode). */
const COLOR_MODE_DEFAULT = 0;
const COLOR_MODE_RGB = 0x3000000;

// ============================================================================
// BufferNamespace - Top-level buffer API
// ============================================================================

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
export class BufferNamespace implements IBufferNamespace {
  private terminal: Terminal;
  private bufferChangeEmitter = new EventEmitter<IBuffer>();

  // Lazy-initialized buffer wrappers (stateless, so we can cache them)
  private _normalBuffer?: Buffer;
  private _alternateBuffer?: Buffer;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  get active(): IBuffer {
    const wasmTerm = this.terminal.wasmTerm;
    if (!wasmTerm) {
      return this.normal; // Default to normal if not initialized
    }

    return wasmTerm.isAlternateScreen() ? this.alternate : this.normal;
  }

  get normal(): IBuffer {
    if (!this._normalBuffer) {
      this._normalBuffer = new Buffer(this.terminal, 'normal');
    }
    return this._normalBuffer;
  }

  get alternate(): IBuffer {
    if (!this._alternateBuffer) {
      this._alternateBuffer = new Buffer(this.terminal, 'alternate');
    }
    return this._alternateBuffer;
  }

  get onBufferChange(): IEvent<IBuffer> {
    return this.bufferChangeEmitter.event;
  }

  /** @internal Fired by Terminal when the program switches screens. */
  _fireBufferChange(buffer: IBuffer): void {
    this.bufferChangeEmitter.fire(buffer);
  }
}

// ============================================================================
// Buffer - Represents a terminal buffer (normal or alternate)
// ============================================================================

/**
 * A terminal buffer (normal or alternate screen). libghostty gives access to
 * the active screen only, so the inactive buffer reads as empty (length 0, no
 * lines) until the program switches to it.
 */
export class Buffer implements IBuffer {
  private terminal: Terminal;
  private bufferType: 'normal' | 'alternate';
  private nullCell: BufferCell;

  constructor(terminal: Terminal, type: 'normal' | 'alternate') {
    this.terminal = terminal;
    this.bufferType = type;
    this.nullCell = new BufferCell(blankCell(), 0);
  }

  get type(): 'normal' | 'alternate' {
    return this.bufferType;
  }

  get cursorX(): number {
    return this.activeTerm()?.getCursor().x ?? 0;
  }

  /** Cursor row in the active area (add baseY for the buffer line). */
  get cursorY(): number {
    return this.activeTerm()?.getCursor().y ?? 0;
  }

  /** Line index of the top of the viewport (xterm.js semantics). */
  get viewportY(): number {
    if (!this.activeTerm()) return 0;
    const offset = Math.max(0, Math.floor(this.terminal.viewportY ?? 0));
    return Math.max(0, this.baseY - offset);
  }

  /** Line index of the top of the active area: the scrollback length. */
  get baseY(): number {
    const wasmTerm = this.activeTerm();
    if (!wasmTerm || this.bufferType === 'alternate') return 0;
    return wasmTerm.getScrollbackLength();
  }

  get length(): number {
    const wasmTerm = this.activeTerm();
    if (!wasmTerm) return 0;
    return this.baseY + wasmTerm.rows;
  }

  getLine(y: number): IBufferLine | undefined {
    const wasmTerm = this.activeTerm();
    if (!wasmTerm) return undefined;

    // Check bounds
    if (y < 0 || y >= this.length) {
      return undefined;
    }

    // libghostty addresses the whole buffer (scrollback, then the active
    // area) by one absolute row, the same numbering as y here.
    const cells = wasmTerm.getScreenLine(y);
    if (!cells) {
      return undefined;
    }
    return new BufferLine(cells, wasmTerm.isScreenRowWrapped(y), wasmTerm.cols);
  }

  getNullCell(): IBufferCell {
    return this.nullCell;
  }

  /** The terminal, when this buffer is the screen it is showing. */
  private activeTerm(): GhosttyTerminal | undefined {
    const wasmTerm = this.terminal.wasmTerm;
    if (!wasmTerm) return undefined;
    return wasmTerm.isAlternateScreen() === (this.bufferType === 'alternate')
      ? wasmTerm
      : undefined;
  }
}

/** An empty cell with default colors. */
function blankCell(): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 204,
    fg_g: 204,
    fg_b: 204,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    bg_default: true,
  };
}

// ============================================================================
// BufferLine - Represents a single line in the buffer
// ============================================================================

/**
 * A single line in the buffer
 */
export class BufferLine implements IBufferLine {
  private cells: GhosttyCell[];
  private _isWrapped: boolean;
  private _length: number;

  constructor(cells: GhosttyCell[], isWrapped: boolean, length: number) {
    this.cells = cells;
    this._isWrapped = isWrapped;
    this._length = length;
  }

  get length(): number {
    return this._length;
  }

  get isWrapped(): boolean {
    return this._isWrapped;
  }

  getCell(x: number): IBufferCell | undefined {
    if (x < 0 || x >= this._length) {
      return undefined;
    }
    // Cells beyond what was returned are empty
    return new BufferCell(x < this.cells.length ? this.cells[x] : blankCell(), x);
  }

  /**
   * The line's text. As in xterm.js, empty cells are spaces (so `a`, three
   * empty cells and `b` give "a   b"); the second half of a wide character
   * adds nothing.
   */
  translateToString(trimRight = false, startColumn = 0, endColumn = this._length): string {
    // Clamp bounds
    const start = Math.max(0, Math.min(startColumn, this._length));
    const end = Math.max(start, Math.min(endColumn, this._length));

    let result = '';
    for (let x = start; x < end; x++) {
      const cell = this.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      result += cell.getChars() || ' ';
    }

    if (trimRight) {
      result = result.trimEnd();
    }

    return result;
  }
}

// ============================================================================
// BufferCell - Represents a single cell in the buffer
// ============================================================================

/**
 * A single cell in the buffer. Colors are the resolved RGB values libghostty
 * draws with: palette colors are reported as RGB, and the background as
 * default when the cell has none of its own.
 */
export class BufferCell implements IBufferCell {
  private cell: GhosttyCell;
  private x: number;

  constructor(cell: GhosttyCell, x: number) {
    this.cell = cell;
    this.x = x;
  }

  getChars(): string {
    // Grapheme clusters (emoji sequences, combining marks) carry their text.
    if (this.cell.chars) return this.cell.chars;
    const codepoint = this.cell.codepoint;

    // Return empty string for null character or invalid codepoints
    if (codepoint === 0) {
      return '';
    }

    // Validate codepoint is within valid Unicode range
    // Valid: 0x0000 to 0x10FFFF, excluding surrogates (0xD800-0xDFFF)
    if (codepoint < 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      // Return replacement character for invalid codepoints
      return '�';
    }

    return String.fromCodePoint(codepoint);
  }

  getCode(): number {
    return this.cell.codepoint;
  }

  getWidth(): number {
    return this.cell.width;
  }

  /** Always RGB: the foreground is reported resolved (see getFgColor). */
  getFgColorMode(): number {
    return COLOR_MODE_RGB;
  }

  /** Default when the cell has no background of its own, else RGB. */
  getBgColorMode(): number {
    return this.isBgDefault() ? COLOR_MODE_DEFAULT : COLOR_MODE_RGB;
  }

  getFgColor(): number {
    // Pack RGB into a single number: 0xRRGGBB
    return (this.cell.fg_r << 16) | (this.cell.fg_g << 8) | this.cell.fg_b;
  }

  /** The background as 0xRRGGBB (the resolved default color for default cells). */
  getBgColor(): number {
    return (this.cell.bg_r << 16) | (this.cell.bg_g << 8) | this.cell.bg_b;
  }

  isFgRGB(): boolean {
    return true;
  }

  isBgRGB(): boolean {
    return !this.isBgDefault();
  }

  isFgPalette(): boolean {
    return false;
  }

  isBgPalette(): boolean {
    return false;
  }

  isBgDefault(): boolean {
    return this.cell.bg_default ?? false;
  }

  isBold(): number {
    return (this.cell.flags & CellFlags.BOLD) !== 0 ? 1 : 0;
  }

  isItalic(): number {
    return (this.cell.flags & CellFlags.ITALIC) !== 0 ? 1 : 0;
  }

  isUnderline(): number {
    return (this.cell.flags & CellFlags.UNDERLINE) !== 0 ? 1 : 0;
  }

  isStrikethrough(): number {
    return (this.cell.flags & CellFlags.STRIKETHROUGH) !== 0 ? 1 : 0;
  }

  isBlink(): number {
    return (this.cell.flags & CellFlags.BLINK) !== 0 ? 1 : 0;
  }

  isInverse(): number {
    return (this.cell.flags & CellFlags.INVERSE) !== 0 ? 1 : 0;
  }

  isInvisible(): number {
    return (this.cell.flags & CellFlags.INVISIBLE) !== 0 ? 1 : 0;
  }

  isFaint(): number {
    return (this.cell.flags & CellFlags.FAINT) !== 0 ? 1 : 0;
  }

  /**
   * Get hyperlink ID for this cell (0 = no link)
   * Used by link detection system
   */
  getHyperlinkId(): number {
    return this.cell.hyperlink_id;
  }

  /**
   * Get the Unicode codepoint for this cell
   * Used by link detection system
   */
  getCodepoint(): number {
    return this.cell.codepoint;
  }

  /**
   * Check if cell has dim/faint attribute
   * Added for IBufferCell compatibility
   */
  isDim(): boolean {
    return (this.cell.flags & CellFlags.FAINT) !== 0;
  }
}
