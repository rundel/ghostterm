/**
 * TypeScript wrapper for the official libghostty-vt WebAssembly module.
 *
 * This talks to the prebuilt `ghostty-vt.wasm` that Ghostty publishes with each
 * libghostty-vt release, using only its stable C ABI. This module loads it (`Ghostty`); the
 * objects it creates live in lib/bridge/: the terminal and its render state, the key and mouse
 * encoders, selection gestures and search, over the ABI constants, the manifest-derived
 * layout and the memory helpers. Only lib/ghostty.ts and lib/bridge/ call into the module.
 */

import { AbiLayout } from './abi';
import { EffectOpt } from './bridge/abi-constants';
import { KeyEncoder } from './bridge/key-encoder';
import { type Layout, buildLayout } from './bridge/layout';
import { Memory, wasmCallback } from './bridge/memory';
import { MouseEncoder } from './bridge/mouse-encoder';
import { GhosttyTerminal } from './bridge/terminal';
import type { GhosttyTerminalConfig, GhosttyWasmExports } from './types';
import { defaultWasmUrl } from './wasm-default';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
} from './types';
export * from './bridge/abi-constants';
export * from './bridge/key-encoder';
export * from './bridge/layout';
export * from './bridge/memory';
export * from './bridge/mouse-encoder';
export * from './bridge/search';
export * from './bridge/selection-gesture';
export * from './bridge/terminal';

// ============================================================================
// Ghostty: module loader and factory
// ============================================================================

/** The file system path of a `file:` URL, without a leading slash before a Windows drive letter. */
export function fileUrlPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/** How the loaded libghostty-vt module was optimized (`GhosttyOptimizeMode` in build_info.h). */
export type GhosttyOptimizeMode =
  | 'debug'
  | 'release-safe'
  | 'release-small'
  | 'release-fast'
  | 'unknown';

/** @internal GhosttyBuildInfo's OPTIMIZE query. */
export const BUILD_INFO_OPTIMIZE = 4;
/** @internal GhosttyOptimizeMode. */
export const OPTIMIZE_MODES: Record<number, GhosttyOptimizeMode> = {
  0: 'debug',
  1: 'release-safe',
  2: 'release-small',
  3: 'release-fast',
};

/**
 * Main Ghostty WASM wrapper class
 */
export class Ghostty {
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;
  private mem: Memory;
  private layout: Layout;
  private terminals = new Map<number, GhosttyTerminal>();
  private writePtyFn = 0;

  constructor(wasmInstance: WebAssembly.Instance) {
    this.exports = wasmInstance.exports as GhosttyWasmExports;
    this.memory = this.exports.memory;
    this.mem = new Memory(this.memory);
    this.layout = buildLayout(new AbiLayout(this.readTypeJson()));
  }

  /** The libghostty-vt version reported by the loaded module. */
  get version(): string | undefined {
    return this.layout.abi.version;
  }

  /** Cells a codepoint takes on its own (0, 1 or 2), by libghostty's width rules. */
  codepointWidth(codepoint: number): 0 | 1 | 2 {
    return this.exports.ghostty_unicode_codepoint_width(codepoint >>> 0) as 0 | 1 | 2;
  }

  /**
   * The optimization mode the loaded module was built with: `'release-small'` for the default
   * `ghostty-vt.wasm`, `'release-fast'` for `ghostty-vt-fast.wasm`.
   */
  get optimizeMode(): GhosttyOptimizeMode {
    const ex = this.exports;
    const out = ex.ghostty_wasm_alloc(4);
    try {
      const result = ex.ghostty_build_info(BUILD_INFO_OPTIMIZE, out);
      if (result !== 0) throw new Error(`ghostty-vt: failed to read build info (${result})`);
      return OPTIMIZE_MODES[this.mem.view().getInt32(out, true)] ?? 'unknown';
    } finally {
      ex.ghostty_wasm_free(out, 4);
    }
  }

  private readTypeJson(): string {
    const ptr = this.exports.ghostty_type_json();
    const bytes = this.mem.bytes();
    let end = ptr;
    while (bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(ptr, end));
  }

  /**
   * Function-table index of the shared write_pty callback, created on first use.
   * libghostty-vt passes the terminal handle as the first argument, which routes
   * the bytes to the right GhosttyTerminal.
   */
  private writePtyCallback(): number {
    if (this.writePtyFn) return this.writePtyFn;
    const fn = wasmCallback((term: number, _userdata: number, ptr: number, len: number) => {
      this.terminals.get(term)?.queueResponse(this.mem.bytes().slice(ptr, ptr + len));
    }, 4);
    const table = this.exports.__indirect_function_table;
    const index = table.grow(1);
    table.set(index, fn);
    this.writePtyFn = index;
    return index;
  }

  private effectFns = new Map<number, number>();

  /**
   * Install every effect callback on a terminal. Each callback type gets one
   * shared function-table entry; libghostty passes the terminal handle first,
   * which routes the call to the right GhosttyTerminal.
   */
  private installEffects(term: GhosttyTerminal): void {
    const route =
      (impl: (t: GhosttyTerminal, ...args: number[]) => unknown) =>
      (handle: number, _userdata: number, ...args: number[]) => {
        const t = this.terminals.get(handle);
        return t ? impl(t, ...args) : 0;
      };
    const table: [number, number, boolean, (t: GhosttyTerminal, ...a: number[]) => unknown][] = [
      [EffectOpt.BELL, 2, false, (t) => t.onEffect('bell')],
      [EffectOpt.TITLE_CHANGED, 2, false, (t) => t.onEffect('title')],
      [EffectOpt.PWD_CHANGED, 2, false, (t) => t.onEffect('pwd')],
      [EffectOpt.CLIPBOARD_WRITE, 3, false, (t, ptr) => t.onClipboardWrite(ptr)],
      [EffectOpt.DESKTOP_NOTIFICATION, 3, false, (t, ptr) => t.onNotification(ptr)],
      [EffectOpt.PROGRESS_REPORT, 3, false, (t, ptr) => t.onProgress(ptr)],
      [EffectOpt.PROGRAM_STATUS, 3, false, (t, ptr) => t.onProgramStatus(ptr)],
      [EffectOpt.SEMANTIC_PROMPT, 3, false, (t, ptr) => t.onSemanticPrompt(ptr)],
      [EffectOpt.COLOR_SCHEME, 3, true, (t, ptr) => t.onColorScheme(ptr)],
      [EffectOpt.SIZE, 3, true, (t, ptr) => t.onSizeQuery(ptr)],
      [EffectOpt.RENDER_HOLD, 3, false, (t, held) => t.onRenderHold(held !== 0)],
      [EffectOpt.RESET, 2, false, (t) => t.onEffect('reset')],
    ];
    for (const [option, params, returnsI32, impl] of table) {
      let index = this.effectFns.get(option);
      if (index === undefined) {
        index = this.tableFunction(wasmCallback(route(impl), params, returnsI32));
        this.effectFns.set(option, index);
      }
      this.exports.ghostty_terminal_set(term.handle, option, index);
    }

    // The enquiry callback returns a GhosttyString by value, which the wasm32 C ABI turns into
    // a pointer to fill, passed before the other arguments.
    let enquiry = this.effectFns.get(EffectOpt.ENQUIRY);
    if (enquiry === undefined) {
      const fn = (ret: number, handle: number) => {
        const t = this.terminals.get(handle);
        if (t) t.onEnquiry(ret);
        else this.mem.bytes().fill(0, ret, ret + this.layout.string.size);
      };
      enquiry = this.tableFunction(wasmCallback(fn, 3));
      this.effectFns.set(EffectOpt.ENQUIRY, enquiry);
    }
    this.exports.ghostty_terminal_set(term.handle, EffectOpt.ENQUIRY, enquiry);
  }

  /** @internal Call a function pointer from the module's function table. */
  callTable(index: number, ...args: number[]): number {
    const fn = this.exports.__indirect_function_table.get(index) as (...a: number[]) => number;
    return fn(...args);
  }

  /** Put a JS function in the module's function table; returns its index. */
  private tableFunction(fn: unknown): number {
    const table = this.exports.__indirect_function_table;
    const index = table.grow(1);
    table.set(index, fn);
    return index;
  }

  private mimeReaderFn = 0;
  /** Bytes the paste being performed should read, if any. */
  private pasteData: Uint8Array | null = null;

  /**
   * Function-table index of the GhosttyMimeReaderFn used by
   * ghostty_terminal_paste. It hands the current paste's bytes to the
   * GhosttyWriter that libghostty passes in, by calling its function pointer.
   */
  private mimeReaderCallback(): number {
    if (this.mimeReaderFn) return this.mimeReaderFn;
    const ex = this.exports;
    const fn = wasmCallback(
      (_userdata: number, _mimePtr: number, writerPtr: number) => {
        const data = this.pasteData;
        if (!data) return 0;
        const view = this.mem.view();
        const W = this.layout.writer;
        const write = view.getUint32(writerPtr + W.write, true);
        const writerData = view.getUint32(writerPtr + W.userdata, true);
        const len = Math.max(1, data.length);
        const ptr = ex.ghostty_wasm_alloc(len);
        if (!ptr) return 0;
        this.mem.bytes().set(data, ptr);
        const writeFn = ex.__indirect_function_table.get(write) as (
          ud: number,
          p: number,
          n: number
        ) => number;
        const ok = writeFn(writerData, ptr, data.length);
        ex.ghostty_wasm_free(ptr, len);
        return ok ? 1 : 0;
      },
      3,
      true
    );
    this.mimeReaderFn = this.tableFunction(fn);
    return this.mimeReaderFn;
  }

  /** @internal Run a paste with `data` as the clipboard's text/plain. */
  withPasteData<T>(data: Uint8Array, run: (readerFn: number) => T): T {
    const readerFn = this.mimeReaderCallback();
    this.pasteData = data;
    try {
      return run(readerFn);
    } finally {
      this.pasteData = null;
    }
  }

  /** @internal */
  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this.exports, this.mem, this.layout);
  }

  /** @internal */
  createMouseEncoder(): MouseEncoder {
    return new MouseEncoder(this.exports, this.mem, this.layout);
  }

  /** @internal Terminal creates its libghostty terminal with this in open(). */
  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    const term = new GhosttyTerminal(this.exports, this.mem, this.layout, cols, rows, config);
    term.ghostty = this;
    this.terminals.set(term.handle, term);
    term.setWritePty(this.writePtyCallback(), () => this.terminals.delete(term.handle));
    this.installEffects(term);
    return term;
  }

  /**
   * Load the libghostty-vt module.
   *
   * Without an argument this loads the size-optimized `ghostty-vt.wasm` (inlined into the default
   * bundle; next to the bundle for `ghostterm/slim`). Pass a path or URL to load another copy,
   * such as the speed-optimized `ghostty-vt-fast.wasm` shipped alongside it.
   */
  static async load(wasmPath?: string | URL): Promise<Ghostty> {
    if (wasmPath) {
      if (typeof wasmPath === 'string') return Ghostty.loadFromPath(wasmPath);
      return Ghostty.loadFromPath(
        wasmPath.protocol === 'file:' ? fileUrlPath(wasmPath) : wasmPath.href
      );
    }

    // The bundled module (inlined), or the one next to the slim bundle
    const moduleUrl = defaultWasmUrl();

    // Build paths to try, prioritizing file system paths for Node/Bun
    const defaultPaths: string[] = [];

    // For Node/Bun: try absolute file path first
    if (moduleUrl.protocol === 'file:') {
      defaultPaths.push(fileUrlPath(moduleUrl));
    }

    // Also try other common paths
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');

    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work. The specifier is a variable so bundlers
    // leave it alone; browsers never get here.
    if (!wasmBytes && typeof process !== 'undefined' && process.versions?.node) {
      try {
        const fsModule = 'node:fs/promises';
        const fs = await import(/* @vite-ignore */ fsModule);
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // fs failed, try fetch
      }
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    // The official module has no imports.
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
    return new Ghostty(wasmInstance);
  }
}
