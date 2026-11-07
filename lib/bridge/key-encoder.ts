/**
 * libghostty-vt's key encoder.
 */

import type { GhosttyWasmExports, KeyEncoderOption, KeyEvent } from '../types';
import { GHOSTTY_SUCCESS } from './abi-constants';
import type { Layout } from './layout';
import type { Memory } from './memory';
import type { GhosttyTerminal } from './terminal';

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private exports: GhosttyWasmExports;
  private mem: Memory;
  private encoder: number = 0;
  private L: Layout;

  constructor(exports: GhosttyWasmExports, mem: Memory, layout: Layout) {
    this.exports = exports;
    this.mem = mem;
    this.L = layout;
    const slot = this.exports.ghostty_wasm_alloc_opaque();
    const result = this.exports.ghostty_key_encoder_new(0, slot);
    this.encoder = this.exports.ghostty_wasm_take_opaque(slot);
    this.exports.ghostty_wasm_free_opaque(slot);
    if (result !== GHOSTTY_SUCCESS) throw new Error(`Failed to create key encoder: ${result}`);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    // Options are a bool, a u8 (kitty flags) or a 4-byte enum (option-as-alt);
    // a little-endian u32 write covers all three.
    const valuePtr = this.exports.ghostty_wasm_alloc(4);
    this.mem.view().setUint32(valuePtr, typeof value === 'boolean' ? (value ? 1 : 0) : value, true);
    this.exports.ghostty_key_encoder_set(this.encoder, option, valuePtr);
    this.exports.ghostty_wasm_free(valuePtr, 4);
  }

  /**
   * Copy the terminal's keyboard modes into the encoder: cursor and keypad
   * application modes, Kitty keyboard flags, modifyOtherKeys, the alt escape
   * prefix and backarrow mode. Programs change these in any write, so call it
   * right before encoding. It resets MACOS_OPTION_AS_ALT, which is not a
   * terminal mode; set that again afterwards.
   */
  syncFromTerminal(terminal: GhosttyTerminal): void {
    this.exports.ghostty_key_encoder_set_from_terminal(this.encoder, terminal.handle);
  }

  encode(event: KeyEvent): Uint8Array {
    const ex = this.exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    const createResult = ex.ghostty_key_event_new(0, slot);
    const eventPtr = ex.ghostty_wasm_take_opaque(slot);
    ex.ghostty_wasm_free_opaque(slot);
    if (createResult !== GHOSTTY_SUCCESS)
      throw new Error(`Failed to create key event: ${createResult}`);

    // The key event borrows its UTF-8 text, so it must outlive encode().
    let utf8Ptr = 0;
    let utf8Len = 0;
    let stringPtr = 0;
    const bufferSize = 128;
    const bufPtr = ex.ghostty_wasm_alloc(bufferSize);
    const writtenPtr = ex.ghostty_wasm_alloc(4);

    try {
      ex.ghostty_key_event_set_action(eventPtr, event.action);
      ex.ghostty_key_event_set_key(eventPtr, event.key);
      ex.ghostty_key_event_set_mods(eventPtr, event.mods);
      if (event.consumedMods !== undefined) {
        ex.ghostty_key_event_set_consumed_mods(eventPtr, event.consumedMods);
      }
      if (event.composing !== undefined) {
        ex.ghostty_key_event_set_composing(eventPtr, event.composing);
      }
      if (event.unshiftedCodepoint !== undefined) {
        ex.ghostty_key_event_set_unshifted_codepoint(eventPtr, event.unshiftedCodepoint);
      }

      if (event.utf8) {
        const utf8Bytes = new TextEncoder().encode(event.utf8);
        utf8Len = utf8Bytes.length;
        utf8Ptr = ex.ghostty_wasm_alloc(utf8Len);
        stringPtr = ex.ghostty_wasm_alloc(this.L.string.size);
        this.mem.bytes().set(utf8Bytes, utf8Ptr);
        const view = this.mem.view();
        view.setUint32(stringPtr + this.L.string.ptr, utf8Ptr, true);
        view.setUint32(stringPtr + this.L.string.len, utf8Len, true);
        ex.ghostty_key_event_set_utf8(eventPtr, stringPtr);
      }

      const encodeResult = ex.ghostty_key_encoder_encode(
        this.encoder,
        eventPtr,
        bufPtr,
        bufferSize,
        writtenPtr
      );
      if (encodeResult !== GHOSTTY_SUCCESS) {
        throw new Error(`Failed to encode key: ${encodeResult}`);
      }

      const bytesWritten = this.mem.view().getUint32(writtenPtr, true);
      return this.mem.bytes().slice(bufPtr, bufPtr + bytesWritten);
    } finally {
      ex.ghostty_wasm_free(bufPtr, bufferSize);
      ex.ghostty_wasm_free(writtenPtr, 4);
      if (stringPtr) ex.ghostty_wasm_free(stringPtr, this.L.string.size);
      if (utf8Ptr) ex.ghostty_wasm_free(utf8Ptr, utf8Len);
      ex.ghostty_key_event_free(eventPtr);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}
