/**
 * libghostty-vt's mouse encoder.
 */

import type { GhosttyWasmExports } from '../types';
import { GHOSTTY_SUCCESS } from './abi-constants';
import type { Layout } from './layout';
import { type Memory, Scratch } from './memory';
import type { GhosttyTerminal } from './terminal';

/** Mouse button (GhosttyMouseButton). Wheel ticks are buttons 4-7. */
export enum MouseButton {
  LEFT = 1,
  RIGHT = 2,
  MIDDLE = 3,
  WHEEL_UP = 4,
  WHEEL_DOWN = 5,
  WHEEL_LEFT = 6,
  WHEEL_RIGHT = 7,
}

/** Mouse event action (GhosttyMouseAction). */
export enum MouseAction {
  PRESS = 0,
  RELEASE = 1,
  MOTION = 2,
}

/** Surface geometry for mouse encoding, in CSS pixels. */
export interface MouseGeometry {
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
}

/** @internal GhosttyMouseEncoderOption. */
export const MouseEncoderOpt = {
  SIZE: 3,
  ANY_BUTTON_PRESSED: 4,
  TRACK_LAST_CELL: 5,
} as const;

/**
 * Mouse Encoder - converts pointer events into mouse reports for programs
 * that turned on mouse tracking, in whichever mode and format (X10, UTF-8,
 * SGR, URxvt, SGR-Pixels) they asked for.
 */
/** Room for one encoded mouse report (bytes). */
export const MOUSE_REPORT_SIZE = 128;

export class MouseEncoder {
  private exports: GhosttyWasmExports;
  private mem: Memory;
  private encoder = 0;
  private event = 0;
  private scratch!: Scratch<'flag' | 'size' | 'position' | 'written' | 'out'>;
  private L: Layout;

  constructor(exports: GhosttyWasmExports, mem: Memory, layout: Layout) {
    this.exports = exports;
    this.mem = mem;
    this.L = layout;
    const ex = exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      if (ex.ghostty_mouse_encoder_new(0, slot) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create mouse encoder');
      }
      this.encoder = ex.ghostty_wasm_take_opaque(slot);
      if (ex.ghostty_mouse_event_new(0, slot) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create mouse event');
      }
      this.event = ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    this.scratch = new Scratch(ex, {
      flag: 4,
      size: layout.mouseSize.size,
      position: layout.mousePosition.size,
      written: 4,
      out: MOUSE_REPORT_SIZE,
    });
    // Report motion only when the pointer moves to another cell.
    const flag = this.scratch.at('flag');
    this.mem.view().setUint8(flag, 1);
    ex.ghostty_mouse_encoder_set(this.encoder, MouseEncoderOpt.TRACK_LAST_CELL, flag);
  }

  /** Copy the terminal's mouse tracking mode and report format. */
  syncFromTerminal(terminal: GhosttyTerminal): void {
    this.exports.ghostty_mouse_encoder_set_from_terminal(this.encoder, terminal.handle);
  }

  /** Surface size and cell size; the encoder turns positions into cells. */
  setGeometry(g: MouseGeometry): void {
    const p = this.scratch.zero('size', this.mem.bytes());
    const S = this.L.mouseSize;
    const view = this.mem.view();
    const u32 = (offset: number, v: number) => view.setUint32(p + offset, v, true);
    u32(0, S.size); // sized struct: the size field comes first
    u32(S.screenWidth, Math.max(1, Math.round(g.screenWidth)));
    u32(S.screenHeight, Math.max(1, Math.round(g.screenHeight)));
    u32(S.cellWidth, Math.max(1, Math.round(g.cellWidth)));
    u32(S.cellHeight, Math.max(1, Math.round(g.cellHeight)));
    this.exports.ghostty_mouse_encoder_set(this.encoder, MouseEncoderOpt.SIZE, p);
  }

  /** Whether any button is held, which decides motion reporting in button mode. */
  setAnyButtonPressed(pressed: boolean): void {
    const flag = this.scratch.at('flag');
    this.mem.view().setUint8(flag, pressed ? 1 : 0);
    this.exports.ghostty_mouse_encoder_set(this.encoder, MouseEncoderOpt.ANY_BUTTON_PRESSED, flag);
  }

  /** Forget the last reported cell, so the next motion is reported. */
  reset(): void {
    this.exports.ghostty_mouse_encoder_reset(this.encoder);
  }

  /**
   * Encode one mouse event at surface position (x, y). Returns '' when the
   * current mode reports nothing for it.
   */
  encode(
    action: MouseAction,
    button: MouseButton | null,
    mods: number,
    x: number,
    y: number
  ): string {
    const ex = this.exports;
    const ev = this.event;
    ex.ghostty_mouse_event_set_action(ev, action);
    if (button === null) ex.ghostty_mouse_event_clear_button(ev);
    else ex.ghostty_mouse_event_set_button(ev, button);
    ex.ghostty_mouse_event_set_mods(ev, mods);
    const pos = this.scratch.at('position');
    const view = this.mem.view();
    view.setFloat32(pos + this.L.mousePosition.x, x, true);
    view.setFloat32(pos + this.L.mousePosition.y, y, true);
    ex.ghostty_mouse_event_set_position(ev, pos);

    const buf = this.scratch.at('out');
    const written = this.scratch.at('written');
    const cap = MOUSE_REPORT_SIZE;
    if (ex.ghostty_mouse_encoder_encode(this.encoder, ev, buf, cap, written) !== GHOSTTY_SUCCESS) {
      return '';
    }
    const len = this.mem.view().getUint32(written, true);
    const bytes = this.mem.bytes().slice(buf, buf + len);
    // The UTF-8 format is valid UTF-8. The X10/normal format puts raw bytes
    // up to 255 in the report, which go out one character per byte.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return String.fromCharCode(...bytes);
    }
  }

  dispose(): void {
    const ex = this.exports;
    if (this.event) ex.ghostty_mouse_event_free(this.event);
    if (this.encoder) ex.ghostty_mouse_encoder_free(this.encoder);
    this.scratch.free();
    this.event = this.encoder = 0;
  }
}
