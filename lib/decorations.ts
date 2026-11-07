/**
 * Decorations - DOM elements and cell colors attached to markers (xterm.js IDecoration)
 *
 * Each decoration gets an absolutely positioned element over the canvas once
 * its line is first on screen. The element follows the marker's line as the
 * view scrolls and output arrives, and is hidden while the line is off screen.
 * backgroundColor and foregroundColor color the marker line's cells through
 * the renderer's highlight ranges, as xterm.js colors cells under its
 * decorations; when several decorations set a color, the last registered one
 * wins. Overview ruler options are kept on the decoration but not drawn:
 * ghostterm has no overview ruler.
 */

import { EventEmitter } from './event-emitter';
import type { IDecoration, IDecorationOptions, IDisposable, IEvent, IMarker } from './interfaces';
import type { Marker } from './markers';
import type { HighlightRange } from './renderer';

/** What the decorations need from the Terminal. */
export interface DecorationHost {
  gridSize(): { cols: number; rows: number };
  /** Cell size in CSS pixels, or undefined before open(). */
  cellSize(): { width: number; height: number } | undefined;
  /** The absolute buffer line at the top of the viewport. */
  topLine(): number;
  isAlternateScreen(): boolean;
}

export class Decoration implements IDecoration {
  private renderEmitter = new EventEmitter<HTMLElement>();
  private disposeEmitter = new EventEmitter<void>();
  private disposed = false;
  private markerListener: IDisposable;

  readonly marker: IMarker;
  readonly options: IDecorationOptions;
  element: HTMLElement | undefined;
  readonly onRender: IEvent<HTMLElement> = this.renderEmitter.event;
  readonly onDispose: IEvent<void> = this.disposeEmitter.event;

  constructor(
    options: IDecorationOptions,
    private service: DecorationService
  ) {
    this.options = options;
    this.marker = options.marker;
    this.markerListener = this.marker.onDispose(() => this.dispose());
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.markerListener.dispose();
    this.element?.remove();
    this.service.remove(this);
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.renderEmitter.dispose();
  }

  /** @internal */
  fireRender(element: HTMLElement): void {
    this.renderEmitter.fire(element);
  }
}

/** @internal The decorations of one Terminal. */
export class DecorationService implements IDisposable {
  private list: Decoration[] = [];
  private container?: HTMLDivElement;
  private parent?: HTMLElement;
  private canvas?: HTMLElement;
  private refreshQueued = false;

  constructor(private host: DecorationHost) {}

  get decorations(): readonly Decoration[] {
    return this.list;
  }

  /** Where the elements go: next to the canvas, in its parent (called by open()). */
  attach(parent: HTMLElement, canvas: HTMLElement): void {
    this.parent = parent;
    this.canvas = canvas;
    this.refreshQueued = true;
  }

  /** The elements' container, added to the parent with the first element. */
  private getContainer(): HTMLDivElement | undefined {
    if (this.container || !this.parent) return this.container;
    const container = document.createElement('div');
    container.className = 'xterm-decoration-container';
    // Zero height, so it never covers the canvas; the elements overflow it.
    container.style.position = 'absolute';
    container.style.height = '0';
    container.style.overflow = 'visible';
    this.parent.appendChild(container);
    this.container = container;
    return container;
  }

  register(options: IDecorationOptions): Decoration | undefined {
    if (options.marker.isDisposed) return undefined;
    const decoration = new Decoration(options, this);
    this.list.push(decoration);
    this.refreshQueued = true;
    return decoration;
  }

  /** @internal */
  remove(decoration: Decoration): void {
    const index = this.list.indexOf(decoration);
    if (index >= 0) this.list.splice(index, 1);
  }

  /** Position the elements again on the next refresh (cell size or layout changed). */
  invalidate(): void {
    this.refreshQueued = true;
  }

  /**
   * Place every decoration's element for the frame just drawn. Runs when
   * rows were drawn (the content or the view moved) or something queued it,
   * and fires each decoration's onRender, as xterm.js does on each render.
   */
  refresh(rowsDrawn: boolean): void {
    if (!rowsDrawn && !this.refreshQueued) return;
    this.refreshQueued = false;
    const cell = this.host.cellSize();
    if (!this.parent || !cell || this.list.length === 0) return;
    const container = this.getContainer()!;

    const { cols, rows } = this.host.gridSize();
    // Over the grid; the canvas and the container share an offset parent.
    container.style.left = `${this.canvas?.offsetLeft ?? 0}px`;
    container.style.top = `${this.canvas?.offsetTop ?? 0}px`;
    container.style.width = `${cols * cell.width}px`;

    const top = this.host.topLine();
    const alt = this.host.isAlternateScreen();
    for (const decoration of [...this.list]) {
      const row = decoration.marker.line - top;
      const onScreen =
        row >= 0 && row < rows && onActiveScreen(decoration.marker, alt) && !decoration.isDisposed;
      if (!onScreen) {
        if (decoration.element) {
          decoration.element.style.display = 'none';
          decoration.fireRender(decoration.element);
        }
        continue;
      }
      const element = decoration.element ?? this.createElement(decoration);
      const { x = 0, width = 1, height = 1, anchor = 'left' } = decoration.options;
      element.style.width = `${Math.round(width * cell.width)}px`;
      element.style.height = `${height * cell.height}px`;
      element.style.lineHeight = `${cell.height}px`;
      element.style.top = `${row * cell.height}px`;
      if (anchor === 'right') element.style.right = x ? `${x * cell.width}px` : '0';
      else element.style.left = x ? `${x * cell.width}px` : '0';
      element.style.display = x >= cols ? 'none' : 'block';
      decoration.fireRender(element);
    }
  }

  private createElement(decoration: Decoration): HTMLElement {
    const element = document.createElement('div');
    element.classList.add('xterm-decoration');
    const top = decoration.options.layer === 'top';
    if (top) element.classList.add('xterm-decoration-top-layer');
    element.style.position = 'absolute';
    // As in xterm.js's stylesheet.
    element.style.zIndex = top ? '7' : '6';
    decoration.element = element;
    this.container!.appendChild(element);
    return element;
  }

  /**
   * Cell colors of the decorations on screen, in viewport rows, for the
   * renderer. Colors apply to the marker's line, from x for width cells
   * (from the right edge with anchor 'right'); a later decoration's color
   * replaces an earlier one's. A background on the top layer is drawn over
   * the selection.
   */
  highlights(): HighlightRange[] {
    if (this.list.length === 0) return [];
    const { cols, rows } = this.host.gridSize();
    const top = this.host.topLine();
    const alt = this.host.isAlternateScreen();
    const byRow = new Map<number, Array<{ bg?: string; fg?: string; top: boolean }>>();
    for (const d of this.list) {
      const { backgroundColor: bg, foregroundColor: fg } = d.options;
      if (!bg && !fg) continue;
      const row = d.marker.line - top;
      if (row < 0 || row >= rows || !onActiveScreen(d.marker, alt)) continue;
      const { x = 0, width = 1, anchor = 'left' } = d.options;
      const start = anchor === 'right' ? cols - x - width : x;
      let cells = byRow.get(row);
      if (!cells) {
        cells = Array.from({ length: cols }, () => ({ top: false }));
        byRow.set(row, cells);
      }
      for (let col = Math.max(0, start); col < Math.min(cols, start + width); col++) {
        if (bg) {
          cells[col].bg = bg;
          cells[col].top = d.options.layer === 'top';
        }
        if (fg) cells[col].fg = fg;
      }
    }

    const out: HighlightRange[] = [];
    for (const [row, cells] of byRow) {
      let start = 0;
      for (let col = 1; col <= cols; col++) {
        const a = cells[start];
        const b = cells[col];
        if (b && b.bg === a.bg && b.fg === a.fg && b.top === a.top) continue;
        if (a.bg || a.fg) {
          out.push({
            row,
            start,
            end: col - 1,
            color: a.bg ?? '',
            foreground: a.fg,
            active: a.top || undefined,
          });
        }
        start = col;
      }
    }
    return out;
  }

  dispose(): void {
    for (const decoration of [...this.list]) decoration.dispose();
    this.container?.remove();
    this.container = undefined;
    this.parent = undefined;
    this.canvas = undefined;
  }
}

/** Whether the marker belongs to the screen being shown. */
function onActiveScreen(marker: IMarker, alternate: boolean): boolean {
  return ((marker as Marker).alternate ?? false) === alternate;
}
