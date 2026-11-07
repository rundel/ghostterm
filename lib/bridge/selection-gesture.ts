/**
 * libghostty-vt's selection gestures: clicks, multi-clicks and drags.
 */

import type { GhosttyWasmExports } from '../types';
import {
  GHOSTTY_SUCCESS,
  GestureData,
  GestureEventOpt,
  GestureEventType,
  PointTag,
  type SelectionAutoscroll,
  type SelectionGeometry,
} from './abi-constants';
import type { Layout } from './layout';
import { type Memory, Scratch } from './memory';
import type { GhosttyTerminal } from './terminal';

export const DOUBLE_CLICK_INTERVAL_MS = 500;
export const DOUBLE_CLICK_DISTANCE_PX = 10;

/**
 * Turns pointer events into selections using libghostty's selection gesture
 * state machine: click counts (cell, word, line), word-granular dragging and
 * autoscroll at the edges. Every selection it produces is installed as the
 * terminal's selection. Pointer positions are viewport cells plus CSS pixels.
 */
export class SelectionGesture {
  private gesture = 0;
  private events: Record<number, number> = {};
  private scratch: Scratch<
    | 'ref'
    | 'position'
    | 'geometry'
    | 'time'
    | 'selection'
    | 'viewport'
    | 'autoscroll'
    | 'rectangle'
    | 'repeatInterval'
    | 'repeatDistance'
  >;

  constructor(
    private exports: GhosttyWasmExports,
    private mem: Memory,
    private L: Layout,
    private term: GhosttyTerminal
  ) {
    const ex = this.exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      if (ex.ghostty_selection_gesture_new(0, slot) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create selection gesture');
      }
      this.gesture = ex.ghostty_wasm_take_opaque(slot);
      for (const type of [
        GestureEventType.PRESS,
        GestureEventType.RELEASE,
        GestureEventType.DRAG,
        GestureEventType.AUTOSCROLL_TICK,
      ]) {
        if (ex.ghostty_selection_gesture_event_new(0, slot, type) !== GHOSTTY_SUCCESS) {
          throw new Error('libghostty-vt: failed to create selection gesture event');
        }
        this.events[type] = ex.ghostty_wasm_take_opaque(slot);
      }
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    this.scratch = new Scratch(ex, {
      ref: L.gridRef,
      position: L.surface.size,
      geometry: L.geometry.size,
      time: 8,
      selection: L.selection.size,
      viewport: L.coordinate.size,
      autoscroll: 4,
      rectangle: 4,
      repeatInterval: 8,
      repeatDistance: 8,
    });
    this.setRepeat(DOUBLE_CLICK_INTERVAL_MS, DOUBLE_CLICK_DISTANCE_PX);
  }

  /**
   * How close in time (ms) and space (CSS px) presses must be to count as a
   * double or triple click. libghostty has no defaults for these; browsers
   * don't expose the OS settings, so ghostterm picks common values.
   */
  setRepeat(intervalMs: number, distancePx: number): void {
    const ex = this.exports;
    const press = this.events[GestureEventType.PRESS];
    const interval = this.scratch.at('repeatInterval');
    const distance = this.scratch.at('repeatDistance');
    this.mem.view().setBigUint64(interval, BigInt(Math.round(intervalMs * 1e6)), true);
    ex.ghostty_selection_gesture_event_set(press, GestureEventOpt.REPEAT_INTERVAL_NS, interval);
    this.mem.view().setFloat64(distance, distancePx, true);
    ex.ghostty_selection_gesture_event_set(press, GestureEventOpt.REPEAT_DISTANCE, distance);
  }

  private setRef(event: number, col: number, row: number): void {
    const ref = this.scratch.at('ref');
    if (this.term.viewportRef(col, row, ref)) {
      this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.REF, ref);
    } else {
      this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.REF, 0);
    }
  }

  private setPosition(event: number, x: number, y: number): void {
    const p = this.scratch.at('position');
    const view = this.mem.view();
    view.setFloat64(p + this.L.surface.x, x, true);
    view.setFloat64(p + this.L.surface.y, y, true);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.POSITION, p);
  }

  private setRectangle(event: number, rectangle: boolean): void {
    const p = this.scratch.at('rectangle');
    this.mem.view().setUint8(p, rectangle ? 1 : 0);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.RECTANGLE, p);
  }

  private setGeometry(event: number, g: SelectionGeometry): void {
    const p = this.scratch.at('geometry');
    const G = this.L.geometry;
    const view = this.mem.view();
    view.setUint32(p + G.columns, Math.max(1, g.columns), true);
    view.setUint32(p + G.cellWidth, Math.max(1, Math.round(g.cellWidth)), true);
    view.setUint32(p + G.paddingLeft, 0, true);
    view.setUint32(p + G.screenHeight, Math.max(1, Math.round(g.screenHeight)), true);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.GEOMETRY, p);
  }

  /** Apply an event; install its selection, or clear when it yields none. */
  private apply(event: number, clearOnNone: boolean): boolean {
    const out = this.scratch.at('selection');
    const result = this.exports.ghostty_selection_gesture_event(
      this.gesture,
      this.term.handle,
      event,
      out
    );
    // Autoscroll ticks scroll the viewport even when no selection results.
    this.term.invalidate();
    if (result === GHOSTTY_SUCCESS) {
      this.term.installSelection(out);
      return true;
    }
    if (clearOnNone) this.term.clearSelection();
    return false;
  }

  /**
   * Pointer pressed on a viewport cell. `timeMs` is a monotonic time (such as
   * performance.now()) that lets repeated presses count as double and triple
   * clicks. Returns true when the press itself selected something.
   */
  press(col: number, row: number, x: number, y: number, timeMs: number): boolean {
    const event = this.events[GestureEventType.PRESS];
    this.setRef(event, col, row);
    this.setPosition(event, x, y);
    const t = this.scratch.at('time');
    this.mem.view().setBigUint64(t, BigInt(Math.max(0, Math.round(timeMs * 1e6))), true);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.TIME_NS, t);
    return this.apply(event, true);
  }

  /**
   * Pointer dragged to a viewport cell; x and y may lie outside the surface.
   * With `rectangle` the drag selects a block of columns (Alt-drag).
   */
  drag(
    col: number,
    row: number,
    x: number,
    y: number,
    geometry: SelectionGeometry,
    rectangle = false
  ): boolean {
    const event = this.events[GestureEventType.DRAG];
    this.setRef(event, col, row);
    this.setPosition(event, x, y);
    this.setGeometry(event, geometry);
    this.setRectangle(event, rectangle);
    return this.apply(event, true);
  }

  /** Pointer released. */
  release(): void {
    this.apply(this.events[GestureEventType.RELEASE], false);
  }

  /**
   * Continue an edge drag: scrolls libghostty's viewport one row and extends
   * the selection. Returns false once the gesture has cancelled itself.
   */
  autoscrollTick(
    col: number,
    row: number,
    x: number,
    y: number,
    geometry: SelectionGeometry,
    rectangle = false
  ): boolean {
    const ex = this.exports;
    const event = this.events[GestureEventType.AUTOSCROLL_TICK];
    this.setRectangle(event, rectangle);
    const coord = this.scratch.zero('viewport', this.mem.bytes());
    const view = this.mem.view();
    view.setUint16(coord + this.L.coordinate.x, col, true);
    view.setUint32(coord + this.L.coordinate.y, row, true);
    ex.ghostty_selection_gesture_event_set(event, GestureEventOpt.VIEWPORT, coord);
    this.setPosition(event, x, y);
    this.setGeometry(event, geometry);
    return this.apply(event, false);
  }

  /** The autoscroll the current drag asks for. */
  autoscroll(): SelectionAutoscroll {
    const out = this.scratch.at('autoscroll');
    this.mem.view().setUint32(out, 0, true);
    this.exports.ghostty_selection_gesture_get(
      this.gesture,
      this.term.handle,
      GestureData.AUTOSCROLL,
      out
    );
    return this.mem.view().getUint32(out, true) as SelectionAutoscroll;
  }

  /** Cancel the current click sequence. */
  reset(): void {
    this.exports.ghostty_selection_gesture_reset(this.gesture, this.term.handle);
  }

  /** Free the gesture. Pass terminalAlive=false if its terminal was already freed. */
  dispose(terminalAlive = true): void {
    const ex = this.exports;
    if (!this.gesture) return;
    for (const event of Object.values(this.events)) ex.ghostty_selection_gesture_event_free(event);
    this.events = {};
    ex.ghostty_selection_gesture_free(this.gesture, terminalAlive ? this.term.handle : 0);
    this.gesture = 0;
    this.scratch.free();
  }
}
