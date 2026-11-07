/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITheme } from './interfaces';
import type { GhosttyCell, RGB } from './types';
import { CellFlags, UnderlineStyle } from './types';

/**
 * What the renderer draws: a terminal whose viewport it can scroll and read
 * row by row (GhosttyTerminal).
 */
export interface IRenderable {
  /**
   * Row y of the viewport as displayed, including scrollback rows when scrolled. The caller keeps
   * the buffer's viewport on the offset it passes to render().
   */
  getViewportLine(y: number): GhosttyCell[] | null;
  getCursor(): {
    x: number;
    y: number;
    /**
     * Position in the frame being drawn, which a render hold (mode 2026)
     * freezes, or -1 when it is not in view; x and y are used when absent.
     */
    viewportX?: number;
    viewportY?: number;
    visible: boolean;
    /** Shape in effect (the program may have changed it); overrides cursorStyle. */
    style?: 'block' | 'underline' | 'bar';
    /** Whether it blinks (the program may have changed it); overrides cursorBlink. */
    blinking?: boolean;
  };
  /**
   * Colors in effect. The background is the default cell background (a
   * program can change it with OSC 11); a cursor color set by the program
   * (OSC 12) overrides the theme's.
   */
  getColors?(): { background?: RGB; cursor: RGB | null };
  getDimensions(): { cols: number; rows: number };
  /** Rows of history above the active area, for the scrollbar. */
  getScrollbackLength?(): number;
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  /** Let a theme background with alpha show through (default: drawn opaque). */
  allowTransparency?: boolean;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

/** Scrollbar geometry in CSS px, relative to the canvas. */
export interface ScrollbarThumb {
  x: number;
  width: number;
  trackY: number;
  trackHeight: number;
  y: number;
  height: number;
}

// ============================================================================
// Default Theme
// ============================================================================

/**
 * Minimum width in CSS pixels kept free to the right of the cell grid for the
 * scrollbar, so it never covers the last column. FitAddon reserves it.
 */
export const SCROLLBAR_GUTTER = 15;

/** Columns start..end (inclusive) of a viewport row painted in `color`. */
export interface HighlightRange {
  row: number;
  start: number;
  end: number;
  /** Background ('' for none). */
  color: string;
  /** Text color (decorations), unless the cell is selected. */
  foreground?: string;
  /** The current match: drawn over the selection, with its normal text color. */
  active?: boolean;
}
const SCROLLBAR_THUMB_WIDTH = 8;
const SCROLLBAR_RIGHT_INSET = 3;
const SCROLLBAR_PADDING = 4;
const SCROLLBAR_MIN_THUMB = 20;

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

/** Parse a CSS hex or rgb() color to 0xRRGGBB (alpha ignored), or undefined. */
export function parseCssColor(color: string | undefined): number | undefined {
  if (!color) return undefined;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex;
    return Number.parseInt(full.slice(0, 6), 16);
  }
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (rgb) return (+rgb[1] << 16) | (+rgb[2] << 8) | +rgb[3];
  return undefined;
}

/** How the cursor was last drawn, to know when its old cell needs repainting. */
interface DrawnCursor {
  x: number;
  y: number;
  /** Cells covered (2 on a wide character). */
  width: number;
  /** 'outline' is the hollow block drawn while the terminal doesn't have focus. */
  shape: 'block' | 'underline' | 'bar' | 'outline';
  color: string;
}

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private allowTransparency: boolean;
  private metrics: FontMetrics;

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  /** Shape and color in effect this frame (options, or what the program set). */
  private cursorShape: 'block' | 'underline' | 'bar' = 'block';
  private cursorColor = '';
  /** Whether the blink timer is running. */
  private blinkActive = false;
  /** The cursor as drawn on the canvas, or null when it isn't. */
  private drawnCursor: DrawnCursor | null = null;
  /** Whether the terminal has keyboard focus; without it the cursor is a steady hollow block. */
  private focused = true;

  /** Default cell background in effect (the theme's, or what the program set). */
  private background: string;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;
  /** Width of the scrollbar gutter right of the grid (CSS px). */
  private scrollbarGutter = SCROLLBAR_GUTTER;
  private gridCols = 0;
  private gridRows = 0;
  /** Canvas size in CSS px and in device pixels, as set by resize(). */
  private cssWidth = 0;
  private cssHeight = 0;
  private backingWidth = 0;
  private backingHeight = 0;
  /** Set when the canvas was cleared outside render(), e.g. by resize(). */
  private needsFullRender = false;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.allowTransparency = options.allowTransparency ?? false;
    // The context keeps its alpha channel even when the background is drawn opaque: an opaque
    // context would switch Chromium on Linux to subpixel (LCD) text antialiasing, whose color
    // fringes look wrong on many themes. allowTransparency only decides how the background is
    // drawn.
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.background = this.themeBackground();
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    this.applyCursorBlink(this.cursorBlink);
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const width = Math.ceil(widthMetrics.width);

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

    return { width, height, baseline };
  }

  /**
   * Measure the font again, e.g. after a web font finished loading. Returns
   * whether the cell size changed (the caller then resizes).
   */
  public remeasureFont(): boolean {
    const old = this.metrics;
    this.metrics = this.measureFont();
    this.needsFullRender = true;
    return (
      old.width !== this.metrics.width ||
      old.height !== this.metrics.height ||
      old.baseline !== this.metrics.baseline
    );
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * The theme's background as painted: its own CSS color, which keeps a background with alpha
   * transparent, only with allowTransparency; otherwise the color without its alpha
   * ('transparent' is black, as libghostty is told).
   */
  private themeBackground(): string {
    if (this.allowTransparency) return this.theme.background;
    const hex = parseCssColor(this.theme.background) ?? 0;
    return this.rgbToCSS((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff);
  }

  /**
   * The default background to paint: the theme's (themeBackground) unless the program set
   * another (OSC 11).
   */
  private resolveBackground(rgb: RGB | undefined): string {
    if (!rgb) return this.themeBackground();
    const hex = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
    if (hex === (parseCssColor(this.theme.background) ?? 0)) return this.themeBackground();
    return this.rgbToCSS(rgb.r, rgb.g, rgb.b);
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    this.gridCols = cols;
    this.gridRows = rows;
    this.needsFullRender = true;
    this.drawnCursor = null;
    const cssWidth = cols * this.metrics.width + this.scrollbarGutter;
    const cssHeight = rows * this.metrics.height;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Backing store in device pixels. canvas.width truncates, so round once
    // and keep the values render() compares against.
    this.backingWidth = Math.round(cssWidth * this.devicePixelRatio);
    this.backingHeight = Math.round(cssHeight * this.devicePixelRatio);
    this.canvas.width = this.backingWidth;
    this.canvas.height = this.backingHeight;

    // Draw in CSS pixels (setting canvas.width/height resets the context)
    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  /** Use another device pixel ratio (the window moved to another screen, or zoom). */
  public setDevicePixelRatio(dpr: number): void {
    if (!(dpr > 0) || dpr === this.devicePixelRatio) return;
    this.devicePixelRatio = dpr;
    if (this.gridCols > 0 && this.gridRows > 0) this.resize(this.gridCols, this.gridRows);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas. Returns the range of viewport rows
   * redrawn (inclusive), or null when no row was.
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbarOpacity: number = 1
  ): { start: number; end: number } | null {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // The buffer's viewport is already scrolled to this offset (Terminal keeps it there), so every
    // visible row, scrollback included, is read the same way below.
    const offset = Math.max(0, Math.floor(viewportY));

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    this.cursorShape = cursor.style ?? this.cursorStyle;
    this.applyCursorBlink(cursor.blinking ?? this.cursorBlink);
    const colors = buffer.getColors?.();
    this.cursorColor = colors?.cursor
      ? this.rgbToCSS(colors.cursor.r, colors.cursor.g, colors.cursor.b)
      : this.theme.cursor;
    const background = this.resolveBackground(colors?.background);
    if (background !== this.background) {
      this.background = background;
      forceAll = true;
    }
    const scrollbackLength = buffer.getScrollbackLength?.() ?? 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    if (
      dims.cols !== this.gridCols ||
      dims.rows !== this.gridRows ||
      this.canvas.width !== this.backingWidth ||
      this.canvas.height !== this.backingHeight
    ) {
      this.resize(dims.cols, dims.rows);
    }
    if (this.needsFullRender) {
      forceAll = true;
      this.needsFullRender = false;
    }
    if (this.refreshHighlights()) forceAll = true;

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // The cursor is drawn only at the bottom, while shown (and in the visible
    // phase of a blink). When anything about it changes, the row it was drawn
    // on is repainted to erase it. Its position comes from the frame being
    // drawn (viewportX/Y), which a render hold (mode 2026) freezes along with
    // the cells; x/y are the terminal's live position.
    // Without focus it is a hollow block that doesn't blink, whatever the shape (as in Ghostty
    // and xterm.js).
    let nextCursor: DrawnCursor | null = null;
    const cx = cursor.viewportX ?? cursor.x;
    const cy = cursor.viewportY ?? cursor.y;
    const shown = this.cursorVisible || !this.focused;
    if (offset === 0 && cursor.visible && shown && cy >= 0 && cy < dims.rows) {
      const line = buffer.getViewportLine(cy);
      nextCursor = {
        x: cx,
        y: cy,
        width: line?.[cx]?.width === 2 ? 2 : 1,
        shape: this.focused ? this.cursorShape : 'outline',
        color: this.cursorColor,
      };
    }
    const cursorRows = new Set<number>();
    if (!sameCursor(nextCursor, this.drawnCursor)) {
      if (this.drawnCursor) cursorRows.add(this.drawnCursor.y);
      if (nextCursor) cursorRows.add(nextCursor.y);
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      for (let y = 0; y < dims.rows; y++) {
        const line = buffer.getViewportLine(y);

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      if (forceAll || buffer.isRowDirty(y) || hyperlinkRows.has(y)) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }
    for (const y of cursorRows) if (y < dims.rows) rowsToRender.add(y);

    // Render each line
    let start = -1;
    let end = -1;
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) continue;
      if (start < 0) start = y;
      end = y;
      const line = buffer.getViewportLine(y);
      if (line) {
        this.renderLine(line, y, dims.cols);
      }
    }

    // Selection highlighting is integrated into renderCellBackground/renderCellText,
    // link underlines into renderCellText.

    if (nextCursor) this.renderCursor(nextCursor);
    this.drawnCursor = nextCursor;

    // Also drawn at zero opacity: the gutter isn't covered by row redraws, so
    // the faded-out bar has to be cleared here.
    this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
    return start < 0 ? null : { start, end };
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Search highlight (SearchAddon decorations). The active match is drawn
    // over the selection; other matches under it.
    const highlight = this.highlightAt(x, y);
    if (highlight?.active && highlight.color) {
      this.ctx.fillStyle = highlight.color;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return;
    }

    if (cell.selected === true) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    if (highlight?.color) {
      this.ctx.fillStyle = highlight.color;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return;
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Cells without a background of their own show the default background
    // (drawn with the row), which keeps transparent themes transparent. Any
    // explicit background is painted, black included; inverse always paints.
    const isDefaultBg =
      !(cell.flags & CellFlags.INVERSE) &&
      (cell.bg_default ?? (bg_r === 0 && bg_g === 0 && bg_b === 0));
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Selected, unless the active search match is drawn over the selection
    const highlight = this.highlightAt(x, y);
    const isSelected = cell.selected === true && !highlight?.active;

    // Set text style
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use override, selection foreground, or normal color
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else if (highlight?.foreground) {
      this.ctx.fillStyle = highlight.foreground;
    } else {
      // Extract colors and handle inverse
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;

      if (cell.flags & CellFlags.INVERSE) {
        // When inverted, foreground becomes background
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }

      this.ctx.fillStyle = this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // The full grapheme cluster (cells carry it), else the single codepoint
    const char = cell.chars || String.fromCodePoint(cell.codepoint || 32);
    this.ctx.fillText(char, textX, textY);

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline, in its own style and color when the program set them
    if (cell.flags & CellFlags.UNDERLINE) {
      this.drawUnderline(cell, cellX, cellY, cellWidth);
    }

    // Draw overline (SGR 53) and strikethrough
    const thick = this.lineThickness();
    const textColor = String(this.ctx.fillStyle);
    if (cell.overline) {
      this.strokeLine(cellX, cellWidth, this.lineY(cellY, thick), thick, textColor);
    }
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const top = cellY + this.metrics.height / 2 - thick / this.devicePixelRatio / 2;
      this.strokeLine(cellX, cellWidth, this.lineY(top, thick), thick, textColor);
    }

    // A hovered link is underlined once, whether it is an OSC 8 hyperlink (matched by ID) or a
    // range from the link detector (plain-text URLs, and OSC 8 links it also reports).
    const range = this.hoveredLinkRange;
    const hovered =
      (cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId) ||
      (range !== null &&
        ((y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
          (y > range.startY && y < range.endY) ||
          (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))));
    if (hovered) {
      const y = this.lineY(this.underlineTop(cellY, thick), thick);
      this.strokeLine(cellX, cellWidth, y, thick, '#4A90E2');
    }
  }

  /** Thickness of underlines and other lines, in whole device pixels growing with the font. */
  private lineThickness(): number {
    return Math.max(1, Math.round((this.fontSize * this.devicePixelRatio) / 16));
  }

  /**
   * Where to stroke a line `thick` device pixels wide whose top edge is the device pixel row at
   * `top` (CSS px, rounded), so that it covers whole rows: odd widths fall on half pixels.
   */
  private lineY(top: number, thick: number): number {
    const dpr = this.devicePixelRatio;
    return (Math.round(top * dpr) + thick / 2) / dpr;
  }

  /** Top edge of a single underline (CSS px): just below the baseline, inside the cell. */
  private underlineTop(cellY: number, thick: number): number {
    const t = thick / this.devicePixelRatio;
    return Math.min(cellY + this.metrics.baseline + 2, cellY + this.metrics.height - t);
  }

  /** Stroke a horizontal line `thick` device pixels wide at y (from lineY). */
  private strokeLine(x: number, width: number, y: number, thick: number, color: string): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = thick / this.devicePixelRatio;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x + width, y);
    this.ctx.stroke();
  }

  /**
   * Highlight ranges to draw this frame (search matches), by viewport row.
   * The provider is asked once per frame; when its answer changes the whole
   * viewport is redrawn.
   */
  private highlightProvider?: () => HighlightRange[];
  private highlightRows = new Map<number, HighlightRange[]>();
  private highlightKey = '';

  /** Set (or clear) where cell highlights come from, e.g. the SearchAddon. */
  public setHighlightProvider(provider: (() => HighlightRange[]) | undefined): void {
    this.highlightProvider = provider;
    this.needsFullRender = true;
  }

  /** Refresh highlights for this frame; true when they changed. */
  private refreshHighlights(): boolean {
    const ranges = this.highlightProvider?.() ?? [];
    const key = JSON.stringify(ranges);
    if (key === this.highlightKey) return false;
    this.highlightKey = key;
    this.highlightRows.clear();
    for (const r of ranges) {
      const row = this.highlightRows.get(r.row) ?? [];
      row.push(r);
      this.highlightRows.set(r.row, row);
    }
    return true;
  }

  private highlightAt(x: number, y: number): HighlightRange | null {
    const ranges = this.highlightRows.get(y);
    if (!ranges) return null;
    for (const r of ranges) {
      if (x >= r.start && x <= r.end) return r;
    }
    return null;
  }

  /**
   * Draw a cell's underline: single, double, curly, dotted or dashed. Lines cover whole device
   * pixel rows (see lineY) and stay inside the cell. Dash patterns are offset by x so they
   * continue across neighboring cells.
   */
  private drawUnderline(cell: GhosttyCell, x: number, cellY: number, width: number): void {
    const ctx = this.ctx;
    const dpr = this.devicePixelRatio;
    const thick = this.lineThickness();
    const t = thick / dpr;
    const top = this.underlineTop(cellY, thick);
    const y = this.lineY(top, thick);
    const bottom = cellY + this.metrics.height;
    const style = cell.underline_style ?? UnderlineStyle.SINGLE;
    ctx.save();
    ctx.strokeStyle =
      cell.underline_color !== undefined
        ? `#${cell.underline_color.toString(16).padStart(6, '0')}`
        : ctx.fillStyle;
    ctx.lineWidth = t;
    ctx.beginPath();
    switch (style) {
      case UnderlineStyle.DOUBLE: {
        // Two lines with a gap as wide as one of them, moved up if the lower one would leave
        // the cell.
        const lower = Math.min(top + t, bottom - t);
        const first = this.lineY(lower - 2 * t, thick);
        const second = this.lineY(lower, thick);
        ctx.moveTo(x, first);
        ctx.lineTo(x + width, first);
        ctx.moveTo(x, second);
        ctx.lineTo(x + width, second);
        break;
      }
      case UnderlineStyle.CURLY: {
        // One wave per cell, so neighboring cells join up. It rises and falls by twice the line
        // thickness (a quadratic curve reaches half way to its control point), raised to fit.
        const amplitude = 2 * t;
        const mid = Math.min(y, bottom - amplitude - t / 2);
        ctx.moveTo(x, mid);
        ctx.quadraticCurveTo(x + width / 4, mid - 2 * amplitude, x + width / 2, mid);
        ctx.quadraticCurveTo(x + (3 * width) / 4, mid + 2 * amplitude, x + width, mid);
        break;
      }
      case UnderlineStyle.DOTTED:
      case UnderlineStyle.DASHED:
        ctx.setLineDash(style === UnderlineStyle.DOTTED ? [t, 2 * t] : [3 * t, 2 * t]);
        ctx.lineDashOffset = x;
        ctx.moveTo(x, y);
        ctx.lineTo(x + width, y);
        break;
      default:
        ctx.moveTo(x, y);
        ctx.lineTo(x + width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render cursor
   */
  private renderCursor(c: DrawnCursor): void {
    const cursorX = c.x * this.metrics.width;
    const cursorY = c.y * this.metrics.height;
    const width = this.metrics.width * c.width;

    this.ctx.fillStyle = c.color;

    switch (c.shape) {
      case 'block': {
        // Full cell block (both cells of a wide character)
        this.ctx.fillRect(cursorX, cursorY, width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        const line = this.currentBuffer?.getViewportLine(c.y);
        if (line?.[c.x]) {
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.rect(cursorX, cursorY, width, this.metrics.height);
          this.ctx.clip();
          this.renderCellText(line[c.x], c.x, c.y, this.theme.cursorAccent);
          this.ctx.restore();
        }
        break;
      }

      case 'underline': {
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          width,
          underlineHeight
        );
        break;
      }

      case 'bar': {
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
      }

      case 'outline': {
        // The cell's edges, one device pixel per CSS pixel thick, filled rather than stroked so
        // they stay crisp.
        const t = Math.max(1, Math.round(this.devicePixelRatio)) / this.devicePixelRatio;
        const h = this.metrics.height;
        this.ctx.fillRect(cursorX, cursorY, width, t);
        this.ctx.fillRect(cursorX, cursorY + h - t, width, t);
        this.ctx.fillRect(cursorX, cursorY + t, t, h - 2 * t);
        this.ctx.fillRect(cursorX + width - t, cursorY + t, t, h - 2 * t);
        break;
      }
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval; the render loop redraws the cursor row.
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.background = this.themeBackground();
    this.needsFullRender = true;
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /** Whether the terminal has keyboard focus (the cursor is drawn hollow without it). */
  public setFocused(focused: boolean): void {
    this.focused = focused;
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking (the default; a program can change it)
   */
  public setCursorBlink(enabled: boolean): void {
    this.cursorBlink = enabled;
    this.applyCursorBlink(enabled);
  }

  /** Run the blink timer exactly when the cursor should blink. */
  private applyCursorBlink(blink: boolean): void {
    if (blink === this.blinkActive) return;
    this.blinkActive = blink;
    if (blink) {
      this.startCursorBlink();
    } else {
      this.stopCursorBlink();
      this.cursorVisible = true;
    }
  }

  /**
   * Draw the scrollbar in the gutter right of the grid.
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;

    // Always clear the gutter first (fixes ghosting when fading out)
    const gutterX = this.cssWidth - this.scrollbarGutter;
    ctx.clearRect(gutterX, 0, this.scrollbarGutter, this.cssHeight);
    ctx.fillStyle = this.background;
    ctx.fillRect(gutterX, 0, this.scrollbarGutter, this.cssHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    const bar = this.getScrollbarThumb(viewportY, scrollbackLength, visibleRows);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(bar.x, bar.trackY, bar.width, bar.trackHeight);

    // Draw scrollbar thumb with opacity
    const baseOpacity = viewportY > 0 ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
  }

  /** Horizontal position of the scrollbar in CSS px, for drawing and hit-testing. */
  public getScrollbarRect(): { x: number; width: number } {
    return {
      x: this.cssWidth - SCROLLBAR_RIGHT_INSET - SCROLLBAR_THUMB_WIDTH,
      width: SCROLLBAR_THUMB_WIDTH,
    };
  }

  /**
   * Scrollbar track and thumb in CSS px for a view scrolled `viewportY` rows
   * above the bottom of `scrollbackLength` rows of history. Used for drawing,
   * hit-testing and dragging.
   */
  public getScrollbarThumb(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number
  ): ScrollbarThumb {
    const { x, width } = this.getScrollbarRect();
    const trackY = SCROLLBAR_PADDING;
    const trackHeight = Math.max(0, this.cssHeight - SCROLLBAR_PADDING * 2);
    if (scrollbackLength <= 0) {
      return { x, width, trackY, trackHeight, y: trackY, height: trackHeight };
    }
    const totalLines = scrollbackLength + visibleRows;
    const height = Math.min(
      trackHeight,
      Math.max(SCROLLBAR_MIN_THUMB, (visibleRows / totalLines) * trackHeight)
    );
    // 0 = at bottom, 1 = at top
    const position = Math.max(0, Math.min(1, viewportY / scrollbackLength));
    const y = trackY + (trackHeight - height) * (1 - position);
    return { x, width, trackY, trackHeight, y, height };
  }

  /**
   * Set the gutter right of the grid (at least SCROLLBAR_GUTTER). FitAddon
   * widens it by the space left over after whole cells, so the canvas fills
   * its container and the scrollbar sits against the container's edge.
   */
  public setScrollbarGutter(px: number): void {
    const gutter = Math.max(SCROLLBAR_GUTTER, Math.floor(px));
    if (gutter === this.scrollbarGutter) return;
    this.scrollbarGutter = gutter;
    if (this.gridCols > 0 && this.gridRows > 0) this.resize(this.gridCols, this.gridRows);
  }

  /**
   * Get current font metrics
   */
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /** The hovered hyperlink ID (0 for none). */
  public getHoveredHyperlinkId(): number {
    return this.hoveredHyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear the canvas; the next render() redraws every row.
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    this.drawnCursor = null;
    this.needsFullRender = true;
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}

function sameCursor(a: DrawnCursor | null, b: DrawnCursor | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.shape === b.shape && a.color === b.color
  );
}
