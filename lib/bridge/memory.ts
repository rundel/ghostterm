/**
 * WebAssembly memory helpers: views that survive memory growth, scratch slots, and callbacks that
 * the module can call through its function table.
 */

import type { GhosttyWasmExports } from '../types';

/**
 * Views over the module's linear memory. Any export can grow memory, which
 * detaches earlier views, so callers fetch a fresh view right before each access.
 */
export class Memory {
  private buffer: ArrayBuffer | null = null;
  private dv!: DataView;
  private u8!: Uint8Array;

  constructor(private memory: WebAssembly.Memory) {}

  private refresh(): void {
    const buffer = this.memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.dv = new DataView(buffer);
      this.u8 = new Uint8Array(buffer);
    }
  }

  view(): DataView {
    this.refresh();
    return this.dv;
  }

  bytes(): Uint8Array {
    this.refresh();
    return this.u8;
  }
}

/**
 * Named out-parameter and argument slots in one allocation, laid out end to end so no two overlap.
 * Each kind of value passed to or read back from libghostty gets its own slot, so values that are
 * live at the same time (a selection being built while a point is resolved, say) can't clobber
 * each other. Slot sizes come from the module's manifest where a struct is involved.
 *
 * @internal
 */
export class Scratch<K extends string> {
  private base: number;
  private readonly offsets: Record<K, number>;
  private readonly sizes: Record<K, number>;
  readonly size: number;

  constructor(
    private exports: GhosttyWasmExports,
    slots: Record<K, number>
  ) {
    const offsets = {} as Record<K, number>;
    let at = 0;
    for (const name of Object.keys(slots) as K[]) {
      offsets[name] = at;
      at += (slots[name] + 7) & ~7;
    }
    this.offsets = offsets;
    this.sizes = { ...slots };
    this.size = at;
    this.base = exports.ghostty_wasm_alloc(at);
    if (!this.base) throw new Error('libghostty-vt: failed to allocate scratch memory');
  }

  /** The address of slot `name`. */
  at(name: K): number {
    return this.base + this.offsets[name];
  }

  /** The size of slot `name` in bytes. */
  sizeOf(name: K): number {
    return this.sizes[name];
  }

  /** Zero slot `name` and return its address. */
  zero(name: K, bytes: Uint8Array): number {
    const at = this.at(name);
    bytes.fill(0, at, at + this.sizes[name]);
    return at;
  }

  free(): void {
    if (this.base) this.exports.ghostty_wasm_free(this.base, this.size);
    this.base = 0;
  }
}

/**
 * Build a tiny module that re-exports a JavaScript function as a WebAssembly
 * function taking `params` i32 arguments and returning nothing. Only WebAssembly
 * functions can be stored in a function table, so this is how a JS callback gets
 * a function pointer that libghostty-vt can call.
 */
export function wasmCallback(
  fn: (...args: number[]) => unknown,
  params: number,
  returnsI32 = false
): unknown {
  const results = returnsI32 ? [0x01, 0x7f] : [0x00];
  const typeSection = [0x01, 0x60, params, ...new Array(params).fill(0x7f), ...results];
  const importSection = [0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00];
  const exportSection = [0x01, 0x01, 0x66, 0x00, 0x00];
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    typeSection.length,
    ...typeSection,
    0x02,
    importSection.length,
    ...importSection,
    0x07,
    exportSection.length,
    ...exportSection,
  ]);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, { env: { f: fn } });
  return instance.exports.f;
}
