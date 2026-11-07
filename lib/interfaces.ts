/**
 * xterm.js-compatible interfaces
 */

import type { Ghostty, GhosttyTerminal } from './ghostty';
import type { FontMetrics, HighlightRange } from './renderer';

export interface ITerminalOptions {
  cols?: number; // Default: 80
  rows?: number; // Default: 24
  cursorBlink?: boolean; // Default: false
  cursorStyle?: 'block' | 'underline' | 'bar';
  theme?: ITheme;
  /** Lines of history to keep (default 10000, 0 = none). Can be changed after open(). */
  scrollback?: number;
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  /**
   * Whether a theme background with alpha (or 'transparent') shows what is
   * behind the terminal (default false: the background is drawn opaque,
   * without its alpha). As in xterm.js, set it before open(); later changes
   * have no effect.
   */
  allowTransparency?: boolean;

  convertEol?: boolean; // Convert \n to \r\n (default: false)
  disableStdin?: boolean; // Disable keyboard input (default: false)

  // Scrolling options
  smoothScrollDuration?: number; // Duration in ms for smooth scroll animation (default: 100, 0 = instant)

  /**
   * Let programs write to the clipboard with OSC 52 (default: true, as in
   * Ghostty). Reading the clipboard is always denied. onClipboardWrite fires
   * either way.
   */
  allowClipboardWrite?: boolean;

  // Internal: Ghostty WASM instance (optional, for test isolation)
  // If not provided, uses the module-level instance from init()
  ghostty?: Ghostty;
}

export interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;

  // ANSI colors (0-15)
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface IDisposable {
  dispose(): void;
}

export type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

export interface ITerminalAddon {
  activate(terminal: ITerminalCore): void;
  dispose(): void;
}

export interface ITerminalCore {
  cols: number;
  rows: number;
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
}

/**
 * @internal What the bundled addons use from Terminal. It is left out of the published typings
 * along with the internal members it names, so addons take an ITerminalCore in activate() and
 * cast; Terminal.loadAddon checks that Terminal satisfies it.
 */
export interface IAddonTerminal extends ITerminalCore {
  readonly wasmTerm?: GhosttyTerminal;
  resize(cols: number, rows: number): void;
  /** Cell size in CSS pixels, or undefined before open(). */
  getMetrics(): FontMetrics | undefined;
  /** Width right of the grid for the scrollbar, at least SCROLLBAR_GUTTER. */
  setScrollbarGutter(px: number): void;
  /** Where the renderer gets search highlights from (undefined: none). */
  setHighlightProvider(provider: (() => HighlightRange[]) | undefined): void;
  getViewportY(): number;
  scrollToViewportOffset(offset: number): void;
  clearSelection(): void;
}

/**
 * A cell position in the buffer: x is the 0-based column, y the 0-based absolute buffer row
 * (0 = oldest scrollback line).
 */
export interface IBufferCellPosition {
  x: number;
  y: number;
}

/**
 * A range of cells in the buffer, used for selections and links. Both ends are inclusive and may
 * be on different rows.
 */
export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition;
}

/**
 * Represents a detected link in the terminal
 */
export interface ILink {
  /** The URL or text of the link */
  text: string;

  /** The range of the link in the buffer (may span multiple lines) */
  range: IBufferRange;

  /** Called when the link is activated (clicked with modifier) */
  activate(event: MouseEvent): void;

  /** Optional: called when mouse enters/leaves the link */
  hover?(isHovered: boolean): void;

  /** Optional: called to clean up resources */
  dispose?(): void;
}

/**
 * Provides link detection for a specific type of link
 * Examples: OSC 8 hyperlinks, URL regex detection
 */
export interface ILinkProvider {
  /**
   * Provide links for a given row
   * @param y Absolute row in buffer (0-based)
   * @param callback Called with detected links (or undefined if none)
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;

  /** Optional: called when terminal is disposed */
  dispose?(): void;
}

/**
 * Keyboard event with key and DOM event
 */
export interface IKeyEvent {
  key: string;
  domEvent: KeyboardEvent;
}

/**
 * Unicode version provider (xterm.js compatibility)
 */
export interface IUnicodeVersionProvider {
  readonly activeVersion: string;
}

// ============================================================================
// Buffer API Interfaces (xterm.js compatibility)
// ============================================================================

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
export interface IBufferNamespace {
  /** The currently active buffer (normal or alternate) */
  readonly active: IBuffer;
  /** The normal buffer (primary screen) */
  readonly normal: IBuffer;
  /** The alternate buffer (used by full-screen apps like vim) */
  readonly alternate: IBuffer;

  /** Event fired when buffer changes (normal ↔ alternate) */
  readonly onBufferChange: IEvent<IBuffer>;
}

/**
 * A terminal buffer (normal or alternate screen). Only the active one can be
 * read: libghostty doesn't expose the inactive screen, so the inactive
 * buffer has length 0 and no lines.
 */
export interface IBuffer {
  /** Buffer type: 'normal' or 'alternate' */
  readonly type: 'normal' | 'alternate';
  /** Cursor X position (0-indexed) */
  readonly cursorX: number;
  /** Cursor Y position (0-indexed, relative to baseY: the top of the active area) */
  readonly cursorY: number;
  /** Buffer line shown at the top of the viewport (baseY when not scrolled) */
  readonly viewportY: number;
  /** Buffer line at the top of the active area: the scrollback length (0 for alternate) */
  readonly baseY: number;
  /** Total buffer length (rows + scrollback for normal, just rows for alternate) */
  readonly length: number;

  /**
   * Get a line from the buffer
   * @param y Line index (0 = top of scrollback for normal buffer)
   * @returns Line object or undefined if out of bounds
   */
  getLine(y: number): IBufferLine | undefined;

  /**
   * Get the null cell (used for empty/uninitialized cells)
   */
  getNullCell(): IBufferCell;
}

/**
 * A single line in the buffer
 */
export interface IBufferLine {
  /** Length of the line (in columns) */
  readonly length: number;
  /** Whether this line continues the previous one (the text wrapped onto it) */
  readonly isWrapped: boolean;

  /**
   * Get a cell from this line
   * @param x Column index (0-indexed)
   * @returns Cell object or undefined if out of bounds
   */
  getCell(x: number): IBufferCell | undefined;

  /**
   * Translate the line to a string
   * @param trimRight Whether to trim trailing whitespace (default: false)
   * @param startColumn Start column (default: 0)
   * @param endColumn End column (default: length)
   * @returns String representation of the line
   */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/**
 * A single cell in the buffer
 */
export interface IBufferCell {
  /** Character(s) in this cell (may be empty, single char, or emoji) */
  getChars(): string;
  /** Unicode codepoint (0 for null cell) */
  getCode(): number;
  /** Character width (1 = normal, 2 = wide/emoji, 0 = combining) */
  getWidth(): number;

  /**
   * Color mode, with xterm.js's values (0 = default, 0x3000000 = RGB). Colors
   * are reported resolved to RGB, so a color is RGB unless it is the default.
   */
  getFgColorMode(): number;
  /** Background color mode: 0 (default) or 0x3000000 (RGB); see getFgColorMode */
  getBgColorMode(): number;
  /** Foreground color as 0xRRGGBB (the default foreground for default cells) */
  getFgColor(): number;
  /** Background color as 0xRRGGBB (the default background for default cells) */
  getBgColor(): number;
  /** Whether the cell has a foreground color of its own */
  isFgRGB(): boolean;
  /** Whether the cell has a background color of its own */
  isBgRGB(): boolean;
  /** Always false: palette colors are reported as RGB */
  isFgPalette(): boolean;
  /** Always false: palette colors are reported as RGB */
  isBgPalette(): boolean;
  /** Whether the cell uses the default foreground */
  isFgDefault(): boolean;
  /** Whether the cell shows the default background */
  isBgDefault(): boolean;
  /** Whether no style is set (default colors, no attributes) */
  isAttributeDefault(): boolean;

  /** Whether cell has bold style */
  isBold(): number;
  /** Whether cell has italic style */
  isItalic(): number;
  /** Whether cell has underline style */
  isUnderline(): number;
  /** Whether cell has strikethrough style */
  isStrikethrough(): number;
  /** Whether cell has blink style */
  isBlink(): number;
  /** Whether cell has inverse video style */
  isInverse(): number;
  /** Whether cell has invisible style */
  isInvisible(): number;
  /** Whether cell has faint/dim style */
  isFaint(): number;

  // Link detection support
  /** Get hyperlink ID for this cell (0 = no link) */
  getHyperlinkId(): number;
  /** Get the Unicode codepoint for this cell */
  getCodepoint(): number;
  /** Whether cell has dim/faint attribute (boolean version) */
  isDim(): boolean;
}
