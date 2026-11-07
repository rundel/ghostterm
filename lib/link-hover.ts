/**
 * Links under the pointer: the underline and pointer shape while one is hovered, its hover()
 * callbacks, and opening it on a click. The links come from the LinkDetector's providers; the
 * renderer draws the underline. Terminal forwards pointer events over the terminal here and calls
 * refresh() when content or the view moves under a pointer that stayed put.
 */

import type { ILink } from './interfaces';
import type { LinkDetector } from './link-detector';
import type { CanvasRenderer } from './renderer';
import type { GhosttyCell } from './types';

/** How often hover is re-checked while the pointer moves (ms), so moves don't block scrolling. */
const MOVE_THROTTLE_MS = 16;

/** What link hover needs from its terminal. */
export interface LinkHoverHost {
  readonly links: LinkDetector;
  canvas(): HTMLCanvasElement | undefined;
  /** The element the terminal was opened in (its pointer shape follows the canvas's). */
  element(): HTMLElement | undefined;
  renderer(): CanvasRenderer | undefined;
  rows(): number;
  /** Viewport row `row` as displayed. */
  viewportLine(row: number): GhosttyCell[] | null;
  viewportRowToBufferRow(row: number): number;
  bufferRowToViewportRow(row: number): number;
  /** The pointer shape the program asked for over the text (OSC 22), else a text cursor. */
  programPointerShape(): string;
}

export class LinkHover {
  private hovered?: ILink;
  private throttle?: number;
  private pendingMove?: MouseEvent;
  /** Where the pointer last moved over the canvas, to re-check the hover when content moves. */
  private lastPointer?: { clientX: number; clientY: number };

  constructor(private host: LinkHoverHost) {}

  /** The pointer moved over the terminal (throttled). */
  move(e: MouseEvent): void {
    if (this.throttle !== undefined) {
      this.pendingMove = e;
      return;
    }
    this.update(e);
    this.throttle = window.setTimeout(() => {
      this.throttle = undefined;
      const pending = this.pendingMove;
      this.pendingMove = undefined;
      if (pending) this.update(pending);
    }, MOVE_THROTTLE_MS);
  }

  /** The pointer left the terminal. */
  leave(): void {
    this.lastPointer = undefined;
    const renderer = this.host.renderer();
    renderer?.setHoveredHyperlinkId(0);
    renderer?.setHoveredLinkRange(null);
    if (this.hovered) this.setHovered(undefined);
  }

  /**
   * A click: open the link under it. The link is looked up at click time rather than taken from
   * the (throttled) hover. The built-in providers answer synchronously, so the link opens within
   * the click's user gesture and the default action can still be prevented; only custom
   * asynchronous providers resolve later.
   */
  click(e: MouseEvent): void {
    const cell = this.cellAt(e);
    if (!cell) return;
    const found = this.host.links.findLinkAt(cell.x, this.host.viewportRowToBufferRow(cell.y));
    if (found instanceof Promise) {
      found.then((link) => link?.activate(e)).catch(() => {});
      return;
    }
    if (!found) return;
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    found.activate(e);
  }

  /**
   * Re-check the link under a pointer that hasn't moved, after output or scrolling moved the
   * content under it. Only needed while a link is hovered: otherwise its underline would stay on
   * screen over whatever replaced it until the next mousemove.
   */
  refresh(): void {
    const renderer = this.host.renderer();
    if (!this.lastPointer || !renderer) return;
    if (!this.hovered && renderer.getHoveredHyperlinkId() === 0) return;
    this.update(this.lastPointer);
  }

  /** Forget the hovered link (the terminal was reset), keeping the pointer position. */
  reset(): void {
    this.hovered?.hover?.(false);
    this.hovered = undefined;
    const renderer = this.host.renderer();
    renderer?.setHoveredHyperlinkId(0);
    renderer?.setHoveredLinkRange(null);
    this.setPointerShape(this.host.programPointerShape());
  }

  /** Follow the program's pointer shape (OSC 22), except over a hovered link. */
  updatePointerShape(): void {
    if (!this.hovered) this.setPointerShape(this.host.programPointerShape());
  }

  dispose(): void {
    if (this.throttle !== undefined) clearTimeout(this.throttle);
    this.throttle = undefined;
    this.pendingMove = undefined;
    this.lastPointer = undefined;
    this.hovered = undefined;
  }

  /** The viewport cell under a pointer position. */
  private cellAt(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const canvas = this.host.canvas();
    const renderer = this.host.renderer();
    if (!canvas || !renderer) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - rect.left) / renderer.charWidth),
      y: Math.floor((e.clientY - rect.top) / renderer.charHeight),
    };
  }

  private update(e: { clientX: number; clientY: number }): void {
    const cell = this.cellAt(e);
    const renderer = this.host.renderer();
    if (!cell || !renderer) return;
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY };

    // OSC 8 links are underlined by hyperlink ID, read from the cell as displayed.
    const line = this.host.viewportLine(cell.y);
    const id = line && cell.x >= 0 && cell.x < line.length ? line[cell.x].hyperlink_id : 0;
    renderer.setHoveredHyperlinkId(id);

    this.host.links
      .getLinkAt(cell.x, this.host.viewportRowToBufferRow(cell.y))
      .then((link) => {
        if (link !== this.hovered) this.setHovered(link);
        // The underline is kept in viewport rows, so recompute it even for the same link: the
        // view may have scrolled under a pointer that stayed put.
        const r = this.host.renderer();
        if (!r) return;
        const rows = this.host.rows();
        const start = link ? this.host.bufferRowToViewportRow(link.range.start.y) : -1;
        const end = link ? this.host.bufferRowToViewportRow(link.range.end.y) : -1;
        if (link && start < rows && end >= 0) {
          r.setHoveredLinkRange({
            startX: link.range.start.x,
            startY: Math.max(0, start),
            endX: link.range.end.x,
            endY: Math.min(rows - 1, end),
          });
        } else {
          r.setHoveredLinkRange(null);
        }
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  private setHovered(link: ILink | undefined): void {
    this.hovered?.hover?.(false);
    this.hovered = link;
    link?.hover?.(true);
    this.setPointerShape(link ? 'pointer' : this.host.programPointerShape());
  }

  private setPointerShape(shape: string): void {
    const canvas = this.host.canvas();
    if (canvas && canvas.style.cursor !== shape) canvas.style.cursor = shape;
    const element = this.host.element();
    if (element && element.style.cursor !== shape) element.style.cursor = shape;
  }
}
