/**
 * The scrollbar's behavior: dragging its thumb, jumping on a track click, and fading in while the
 * view scrolls and out after a pause. CanvasRenderer draws it (in the gutter right of the grid) at
 * the opacity this reports; Terminal routes presses here (PointerRouter) and calls show() when the
 * view scrolls.
 */

import type { IDisposable } from './interfaces';
import type { ScrollbarThumb } from './renderer';

/** How long the scrollbar stays after the view last scrolled (ms). */
const HIDE_DELAY_MS = 1500;
/** How long it takes to fade in or out (ms). */
const FADE_DURATION_MS = 200;

/** What the scrollbar needs from its terminal. */
export interface ScrollbarHost {
  /** The canvas the scrollbar is drawn on, once open. */
  canvas(): HTMLCanvasElement | undefined;
  /** The track and thumb as drawn now, in CSS px relative to the canvas. */
  thumb(): ScrollbarThumb;
  /** Rows of history above the screen. */
  scrollbackLength(): number;
  /** Rows the view is scrolled above the bottom (may be fractional). */
  viewportY(): number;
  /** Scroll the view to `offset` rows above the bottom, at once. */
  scrollTo(offset: number): void;
  /** Schedule a frame (the opacity changed). */
  requestRender(): void;
}

export class Scrollbar implements IDisposable {
  /** The thumb drag in progress: where it started (canvas y) and the view's offset then. */
  private drag: { startY: number; startViewportY: number } | null = null;
  private fade = { from: 0, to: 0, start: 0 };
  private hideTimeout?: number;

  constructor(private host: ScrollbarHost) {}

  /** Whether the thumb is being dragged. */
  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Whether a pointer event is over the scrollbar's gutter while there is history to scroll. */
  isOver(e: MouseEvent): boolean {
    const canvas = this.host.canvas();
    if (!canvas || this.host.scrollbackLength() === 0) return false;
    const x = e.clientX - canvas.getBoundingClientRect().left;
    const bar = this.host.thumb();
    return x >= bar.x && x <= bar.x + bar.width;
  }

  /** A press on the scrollbar: start dragging the thumb, or jump to where the track was clicked. */
  press(e: MouseEvent): void {
    const canvas = this.host.canvas();
    if (!canvas) return;
    const y = e.clientY - canvas.getBoundingClientRect().top;
    const bar = this.host.thumb();
    if (y >= bar.y && y <= bar.y + bar.height) {
      this.drag = { startY: y, startViewportY: this.host.viewportY() };
      canvas.style.userSelect = 'none';
      canvas.style.webkitUserSelect = 'none';
      this.show();
    } else {
      // Top of the track = oldest line, bottom = newest
      const fraction = 1 - (y - bar.trackY) / bar.trackHeight;
      this.host.scrollTo(Math.round(fraction * this.host.scrollbackLength()));
    }
  }

  /** Pointer movement during a thumb drag; returns whether it was one. */
  move(e: MouseEvent): boolean {
    const drag = this.drag;
    const canvas = this.host.canvas();
    if (!drag || !canvas) return false;
    const scrollback = this.host.scrollbackLength();
    if (scrollback === 0) return true;
    const deltaY = e.clientY - canvas.getBoundingClientRect().top - drag.startY;
    const bar = this.host.thumb();
    const travel = bar.trackHeight - bar.height;
    if (travel <= 0) return true;
    // The thumb moving down scrolls toward the bottom (a smaller offset).
    const rows = Math.round((-deltaY / travel) * scrollback);
    this.host.scrollTo(drag.startViewportY + rows);
    return true;
  }

  /** The pointer was released anywhere: end a thumb drag. */
  release(): void {
    if (!this.drag) return;
    this.drag = null;
    const canvas = this.host.canvas();
    if (canvas) {
      canvas.style.userSelect = '';
      canvas.style.webkitUserSelect = '';
    }
    // Start the hide timer again
    if (this.host.scrollbackLength() > 0) this.show();
  }

  /** Fade in, and fade out again after a pause (not while dragging). */
  show(): void {
    this.clearHideTimeout();
    this.fadeTo(1);
    if (!this.drag) {
      this.hideTimeout = window.setTimeout(() => {
        this.hideTimeout = undefined;
        this.fadeTo(0);
      }, HIDE_DELAY_MS);
    }
  }

  /** The opacity to draw it at now, fading by time between `from` and `to`. */
  get opacity(): number {
    const { from, to, start } = this.fade;
    const progress = Math.min(1, (performance.now() - start) / FADE_DURATION_MS);
    return from + (to - from) * Math.max(0, progress);
  }

  /** Whether the fade has finished, so frames need no longer be drawn for it. */
  get settled(): boolean {
    return this.opacity === this.fade.to;
  }

  private fadeTo(to: number): void {
    if (this.fade.to === to) return;
    this.fade = { from: this.opacity, to, start: performance.now() };
    this.host.requestRender();
  }

  private clearHideTimeout(): void {
    if (this.hideTimeout === undefined) return;
    window.clearTimeout(this.hideTimeout);
    this.hideTimeout = undefined;
  }

  /** Stop the hide timer and any drag (the view is going away). */
  dispose(): void {
    this.clearHideTimeout();
    this.drag = null;
  }
}
