/**
 * One libghostty-vt terminal and its render state.
 */

import { readBits } from '../abi';
import type { Ghostty } from '../ghostty';
import {
  CellFlags,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
  type TerminalHandle,
  UnderlineStyle,
} from '../types';
import {
  CLIPBOARD_LOCATIONS,
  CellContent,
  CellWide,
  type ClipboardWriteRequest,
  ClipboardWriteResult,
  ColorScheme,
  CursorStyle,
  FocusEvent,
  type FormatScreenOptions,
  FormatterExtras,
  FormatterFormat,
  FormatterOpt,
  GHOSTTY_OUT_OF_SPACE,
  GHOSTTY_SUCCESS,
  GridRowData,
  MODE_GRAPHEME_CLUSTER,
  MOUSE_SHAPES,
  OSC_PAYLOAD_LIMIT,
  OSC_TERMINATORS,
  PROGRAM_STATUS_KINDS,
  PROGRAM_STATUS_STATES,
  PROGRESS_STATES,
  PROMPT_KINDS,
  PasteSource,
  PointTag,
  type PrimaryScreen,
  RENDER_HOLD_TIMEOUT_MS,
  RenderData,
  RowCellsData,
  RowData,
  SELECTION_ADJUST,
  SEMANTIC_PROMPT_KINDS,
  SIZE_MAX,
  ScrollViewport,
  type SelectionAdjust,
  SelectionOrder,
  type SelectionRange,
  StyleColorTag,
  type TerminalColors,
  TerminalData,
  type TerminalEffects,
  TerminalOpt,
  TerminalScreen,
  WRITE_BOUNDARY_OSC_START,
  packMode,
} from './abi-constants';
import type { Layout } from './layout';
import { type Memory, Scratch } from './memory';
import { TerminalSearch } from './search';
import { SelectionGesture } from './selection-gesture';

/** Rows of the inactive primary screen read per screen switch (primaryScreen()). */
export const PRIMARY_BLOCK_ROWS = 64;
/** The render state's own default colors, used when setColors() leaves one out. */
export const DEFAULT_FOREGROUND = 0xffffff;
export const DEFAULT_BACKGROUND = 0x000000;
/**
 * Reported for XTGETTCAP "TN", as Ghostty does: libghostty answers the other capabilities from
 * Ghostty's own terminfo entry.
 */
export const DEFAULT_TERMINFO_NAME = 'xterm-ghostty';
/** Longest terminfo name libghostty accepts (bytes). */
export const MAX_TERMINFO_NAME = 128;
/** How many hyperlink URIs a terminal remembers IDs for. */
export const MAX_LINK_IDS = 4096;
/** Room for a grapheme cluster's codepoints before a larger buffer is allocated (bytes). */
export const GRAPHEME_SCRATCH_SIZE = 1024;

/** GhosttyTerminal's scratch slots (see Scratch). */
export function terminalSlots(L: Layout) {
  return {
    /** Small values read or written by one call: dirty state, flags, modes, row numbers. */
    value: Math.max(8, L.modeConfig.size),
    rgb: L.rgb.size,
    palette: 256 * L.rgb.size,
    terminfoString: L.string.size,
    terminfoName: MAX_TERMINFO_NAME,
    cursor: L.cursor.size,
    cursorX: 4,
    cursorY: 4,
    colors: L.colors.size,
    cellsView: L.cellsView.size,
    rowSelection: L.rowSelection.size,
    style: L.style.size,
    graphemeBuffer: L.codepointBuffer.size,
    graphemes: GRAPHEME_SCRATCH_SIZE,
    point: L.point.size,
    ref: L.gridRef,
    /** What a grid reference call writes: a raw cell or row (8 bytes), a length or a count. */
    refOut: 8,
    rowFlag: 8,
    trackedRef: 4,
    scrollbar: L.scrollbar.size,
    scrollViewport: L.scrollViewport.size,
    /** The terminal's selection as read. */
    selection: L.selection.size,
    orderedSelection: L.selection.size,
    selectionPoint: L.coordinate.size,
    /** A selection being built to install or to narrow the formatter. */
    newSelection: L.selection.size,
    clipboardReply: L.clipboardReply.size,
    focus: 16,
    focusWritten: 4,
    formatterOption: 4,
    formatterOutPtr: 4,
    formatterOutLen: 4,
    dataString: L.string.size,
    mouseShape: 4,
  };
}
export type TerminalSlot = keyof ReturnType<typeof terminalSlots>;

/**
 * GhosttyTerminal - terminal emulator backed by libghostty-vt
 *
 * The viewport is read through a RenderState. Rows are cached on the JS side and
 * only re-read when libghostty-vt reports them dirty, so rendering a frame costs
 * one call per changed row plus one call per styled cell in those rows.
 */
export class GhosttyTerminal {
  private exports: GhosttyWasmExports;
  private mem: Memory;
  private L: Layout;
  readonly handle: TerminalHandle;
  private _cols: number;
  private _rows: number;

  private renderState = 0;
  private rowIterSlot = 0;
  private rowCellsSlot = 0;
  private scratch: Scratch<TerminalSlot>;
  private onFree: (() => void) | null = null;
  private freed = false;

  /** Dirty flags since the last markClean(), mirroring the render state's. */
  private dirty: DirtyState = DirtyState.FULL;
  private rowDirty: Uint8Array;
  /** Rows whose cached cells no longer match the render state. */
  private rowStale: Uint8Array;

  /** Cell pool for zero-allocation rendering */
  private cellPool: GhosttyCell[] = [];

  /** Default colors and palette from the last update, used to resolve cell colors. */
  private fgDefault: RGB = { r: 204, g: 204, b: 204 };
  private bgDefault: RGB = { r: 0, g: 0, b: 0 };
  /** The 256-color palette as GhosttyColorRgb[256]. */
  private palette: Uint8Array;
  private colorsFresh = false;
  /** Whether libghostty's viewport is pinned to the active area. */
  private atBottom = true;

  /** Set by write()/resize(); getViewport() updates the render state first. */
  private pendingUpdate = true;

  /**
   * Called whenever the terminal changed in a way that may change what is drawn (output, resize,
   * scrolling, selection, colors, a reset, the end of a render hold, ...), so the owner can
   * schedule a frame. It runs synchronously, possibly inside a write, so it must not call back.
   */
  onChange?: () => void;

  /** Mark the render state stale and tell the owner. */
  private changed(): void {
    this.pendingUpdate = true;
    this.onChange?.();
  }

  /** Bytes the terminal wrote back for the pty (DSR, DA, DECRQM replies, ...). */
  private responses: Uint8Array[] = [];

  constructor(
    exports: GhosttyWasmExports,
    mem: Memory,
    layout: Layout,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.exports = exports;
    this.mem = mem;
    this.L = layout;
    this.palette = new Uint8Array(256 * layout.rgb.size);
    this._cols = cols;
    this._rows = rows;

    const ex = this.exports;
    this.scratch = new Scratch(ex, terminalSlots(layout));

    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      this.check(ex.ghostty_terminal_new(0, slot, cols, rows), 'create terminal');
      this.handle = ex.ghostty_wasm_take_opaque(slot);
      this.check(ex.ghostty_render_state_new(0, slot), 'create render state');
      this.renderState = ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }

    // Iterator and row-cell handles are reused for every frame; the render state
    // fills them in place, so they live in persistent slots.
    this.rowIterSlot = ex.ghostty_wasm_alloc_opaque();
    this.check(
      ex.ghostty_render_state_row_iterator_new(0, this.rowIterSlot),
      'create row iterator'
    );
    this.rowCellsSlot = ex.ghostty_wasm_alloc_opaque();
    this.check(ex.ghostty_render_state_row_cells_new(0, this.rowCellsSlot), 'create row cells');

    this.setMode(MODE_GRAPHEME_CLUSTER, false, true);
    this.applyConfig(config);

    this.rowDirty = new Uint8Array(rows).fill(1);
    this.rowStale = new Uint8Array(rows).fill(1);
    this.initCellPool();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  private check(result: number, what: string): void {
    if (result !== GHOSTTY_SUCCESS) throw new Error(`libghostty-vt: failed to ${what} (${result})`);
  }

  /** @internal Called by Ghostty to route write_pty callbacks here. */
  setWritePty(fnIndex: number, onFree: () => void): void {
    this.onFree = onFree;
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.WRITE_PTY, fnIndex);
  }

  /** @internal */
  queueResponse(bytes: Uint8Array): void {
    (this.capture ?? this.responses).push(bytes);
  }

  /** @internal The Ghostty instance that created this terminal. */
  ghostty?: Ghostty;

  /** Handlers for the program's requests (bell, title, clipboard, ...). */
  private effects: TerminalEffects = {};
  /** When the current render hold began (performance.now()), or null. */
  private holdStarted: number | null = null;

  setEffects(effects: TerminalEffects): void {
    this.effects = effects;
  }

  /** Read a GhosttyString (ptr, len) at `at` as UTF-8. */
  private readString(at: number): string {
    const view = this.mem.view();
    const ptr = view.getUint32(at + this.L.string.ptr, true);
    const len = view.getUint32(at + this.L.string.len, true);
    if (!ptr || !len) return '';
    return new TextDecoder().decode(this.mem.bytes().slice(ptr, ptr + len));
  }

  /** Read a GhosttyString-valued terminal data field (title, pwd). */
  private readDataString(data: number): string {
    const out = this.scratch.at('dataString');
    if (this.exports.ghostty_terminal_get(this.handle, data, out) !== GHOSTTY_SUCCESS) return '';
    return this.readString(out);
  }

  /** The window title the program set (OSC 0/2). */
  getTitle(): string {
    return this.readDataString(TerminalData.TITLE);
  }

  /**
   * The pointer shape in effect, as a CSS cursor name: what the program asked
   * for (OSC 22), else libghostty's default, 'text'. Null if it can't be read.
   */
  getMouseShape(): string | null {
    const out = this.scratch.at('mouseShape');
    if (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.MOUSE_SHAPE, out) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const shape = this.mem.view().getUint32(out, true);
    return MOUSE_SHAPES[shape] ?? null;
  }

  /** The working directory the program reported (OSC 7). */
  getPwd(): string {
    return this.readDataString(TerminalData.PWD);
  }

  /** @internal */
  onEffect(kind: 'bell' | 'title' | 'pwd' | 'reset'): void {
    const e = this.effects;
    if (kind === 'bell') e.bell?.();
    else if (kind === 'title') e.titleChanged?.(this.getTitle());
    else if (kind === 'pwd') e.pwdChanged?.(this.getPwd());
    else e.reset?.();
  }

  /** @internal Answer a GhosttyClipboardWrite; not replying denies it. */
  onClipboardWrite(ptr: number): void {
    const handler = this.effects.clipboardWrite;
    if (!handler || !this.ghostty) return;
    const W = this.L.clipboardWrite;
    const C = this.L.clipboardContent;
    const view = this.mem.view();
    const location = CLIPBOARD_LOCATIONS[view.getUint32(ptr + W.location, true)];
    const contentsPtr = view.getUint32(ptr + W.contents, true);
    const count = view.getUint32(ptr + W.contentsLen, true);
    const contents: ClipboardWriteRequest['contents'] = [];
    for (let i = 0; i < count; i++) {
      const c = contentsPtr + i * C.size;
      const v = this.mem.view();
      const dataPtr = v.getUint32(c + C.data + this.L.string.ptr, true);
      const dataLen = v.getUint32(c + C.data + this.L.string.len, true);
      contents.push({
        mime: this.readString(c + C.mime),
        data: this.mem.bytes().slice(dataPtr, dataPtr + dataLen),
      });
    }
    const ok = handler({ location: location ?? 'standard', contents });

    const R = this.L.clipboardReply;
    const reply = this.scratch.zero('clipboardReply', this.mem.bytes());
    const v = this.mem.view();
    v.setUint32(reply, R.size, true); // sized struct: the size field comes first
    v.setUint32(
      reply + R.result,
      ok ? ClipboardWriteResult.SUCCESS : ClipboardWriteResult.DENIED,
      true
    );
    v.setUint8(reply + R.remember, 0);
    const replyFn = v.getUint32(ptr + W.reply, true);
    this.ghostty.callTable(replyFn, ptr, reply);
  }

  /** @internal */
  onNotification(ptr: number): void {
    const N = this.L.notification;
    this.effects.notification?.({
      title: this.readString(ptr + N.title),
      body: this.readString(ptr + N.body),
    });
  }

  /** @internal */
  onProgress(ptr: number): void {
    const P = this.L.progress;
    const view = this.mem.view();
    const progress = view.getInt8(ptr + P.progress);
    this.effects.progress?.({
      state: PROGRESS_STATES[view.getUint32(ptr + P.state, true)] ?? 'remove',
      progress: progress < 0 ? null : progress,
    });
  }

  /** @internal */
  onProgramStatus(ptr: number): void {
    const S = this.L.programStatus;
    const view = this.mem.view();
    const progress = view.getInt8(ptr + S.progress);
    this.effects.programStatus?.({
      state: PROGRAM_STATUS_STATES[view.getUint32(ptr + S.state, true)] ?? 'idle',
      kind: PROGRAM_STATUS_KINDS[view.getUint32(ptr + S.kind, true)] ?? 'none',
      progress: progress < 0 ? null : progress,
      id: this.readString(ptr + S.id),
      app: this.readString(ptr + S.app),
      title: this.readString(ptr + S.title),
      message: this.readString(ptr + S.message),
    });
  }

  /** @internal */
  onSemanticPrompt(ptr: number): void {
    const S = this.L.semanticPrompt;
    const view = this.mem.view();
    const kind = SEMANTIC_PROMPT_KINDS[view.getUint32(ptr + S.kind, true)];
    if (!kind) return;
    this.effects.semanticPrompt?.({
      kind,
      promptKind: PROMPT_KINDS[view.getUint32(ptr + S.promptKind, true)] ?? 'primary',
      exitCode: view.getUint8(ptr + S.hasExitCode) ? view.getInt32(ptr + S.exitCode, true) : null,
      command: this.readString(ptr + S.command),
      error: this.readString(ptr + S.error),
    });
  }

  /** Where the answerback for ENQ is kept, since libghostty reads it after the callback returns. */
  private answerbackBuf = 0;
  private answerbackSize = 0;

  /** @internal Fill the GhosttyString at `ret` with the answerback for ENQ ('' sends nothing). */
  onEnquiry(ret: number): void {
    const bytes = new TextEncoder().encode(this.effects.answerback?.() ?? '');
    const ex = this.exports;
    if (bytes.length > this.answerbackSize) {
      if (this.answerbackBuf) ex.ghostty_wasm_free(this.answerbackBuf, this.answerbackSize);
      this.answerbackBuf = ex.ghostty_wasm_alloc(bytes.length);
      this.answerbackSize = this.answerbackBuf ? bytes.length : 0;
    }
    const len = this.answerbackBuf ? bytes.length : 0;
    if (len) this.mem.bytes().set(bytes, this.answerbackBuf);
    const view = this.mem.view();
    view.setUint32(ret + this.L.string.ptr, len ? this.answerbackBuf : 0, true);
    view.setUint32(ret + this.L.string.len, len, true);
  }

  /** @internal Fill a GhosttyColorScheme; returning 0 leaves the query unanswered. */
  onColorScheme(ptr: number): number {
    const scheme = this.effects.colorScheme?.();
    if (!scheme) return 0;
    const value = scheme === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT;
    this.mem.view().setUint32(ptr, value, true);
    return 1;
  }

  /** @internal Fill a GhosttySizeReportSize for XTWINOPS size queries. */
  onSizeQuery(ptr: number): number {
    const cell = this.effects.cellSize?.();
    if (!cell) return 0;
    const S = this.L.sizeReport;
    const view = this.mem.view();
    view.setUint16(ptr + S.rows, this._rows, true);
    view.setUint16(ptr + S.columns, this._cols, true);
    view.setUint32(ptr + S.cellWidth, Math.max(1, Math.round(cell.width)), true);
    view.setUint32(ptr + S.cellHeight, Math.max(1, Math.round(cell.height)), true);
    return 1;
  }

  /**
   * @internal Synchronized output (mode 2026): when a hold starts, capture the
   * frame the program wants left on screen; keep showing it until the hold
   * ends (or times out).
   */
  onRenderHold(held: boolean): void {
    if (held) {
      this.holdStarted = null;
      this.update();
      this.holdStarted = performance.now();
    } else {
      this.holdStarted = null;
      this.changed();
    }
  }

  /** Milliseconds until a render hold in effect times out, or null without one. */
  renderHoldRemaining(): number | null {
    if (!this.isRenderHeld()) return null;
    return Math.max(0, RENDER_HOLD_TIMEOUT_MS - (performance.now() - (this.holdStarted ?? 0)));
  }

  /** Whether a render hold is freezing the screen. */
  isRenderHeld(): boolean {
    if (this.holdStarted === null) return false;
    if (performance.now() - this.holdStarted > RENDER_HOLD_TIMEOUT_MS) {
      this.holdStarted = null;
      return false;
    }
    return true;
  }
  /** While set, write_pty output is collected here instead of as responses. */
  private capture: Uint8Array[] | null = null;

  /**
   * Encode a paste of `text` the way the terminal's current modes require:
   * bracketed paste (mode 2004) when the program asked for it, newlines as
   * carriage returns otherwise, unsafe control bytes replaced with spaces, and
   * a Kitty paste event (mode 5522) when applicable. Returns the bytes for the
   * pty, or '' if nothing should be written.
   *
   * Text that could run commands (a newline outside bracketed paste, or the
   * bracketed paste terminator) is allowed, as ghostterm and xterm.js always
   * have; libghostty can refuse it instead, which a future confirmation hook
   * could use.
   */
  encodePaste(text: string): string {
    const ghostty = this.ghostty;
    if (!ghostty) return '';
    const ex = this.exports;
    const data = new TextEncoder().encode(text);
    const mime = new TextEncoder().encode('text/plain');

    const P = this.L.paste;
    const S = this.L.string;
    const R = this.L.mimeReader;
    // One block: the GhosttyPaste, the out-param, a GhosttyString[1] of mime
    // types and the mime type's bytes.
    const align4 = (n: number) => (n + 3) & ~3;
    const out = align4(P.size);
    const mimes = out + 4;
    const mimeBytes = mimes + align4(S.size);
    const blockSize = mimeBytes + mime.length;

    return ghostty.withPasteData(data, (readerFn) => {
      const block = ex.ghostty_wasm_alloc(blockSize);
      const paste = block;
      this.mem.bytes().fill(0, block, block + blockSize);
      this.mem.bytes().set(mime, block + mimeBytes);
      const view = this.mem.view();
      view.setUint32(block + mimes + S.ptr, block + mimeBytes, true);
      view.setUint32(block + mimes + S.len, mime.length, true);
      view.setUint32(paste, P.size, true); // sized struct: the size field comes first
      view.setUint32(paste + P.location, CLIPBOARD_LOCATIONS.indexOf('standard'), true);
      view.setUint32(paste + P.source, PasteSource.CLIPBOARD, true);
      view.setUint32(paste + P.mimes, block + mimes, true);
      view.setUint32(paste + P.mimesLen, 1, true);
      view.setUint32(paste + P.reader + R.read, readerFn, true);
      view.setUint32(paste + P.reader + R.userdata, 0, true);
      view.setUint8(paste + P.allowUnsafe, 1);

      this.capture = [];
      try {
        const result = ex.ghostty_terminal_paste(this.handle, paste, block + out);
        const chunks = this.capture;
        if (result !== GHOSTTY_SUCCESS) return '';
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        return new TextDecoder().decode(all);
      } finally {
        this.capture = null;
        ex.ghostty_wasm_free(block, blockSize);
      }
    });
  }

  /**
   * Encode a focus change for a program that asked for focus reports (mode
   * 1004), or '' when it didn't.
   */
  encodeFocus(focused: boolean): string {
    if (!this.getMode(1004, false)) return '';
    const ex = this.exports;
    const buf = this.scratch.at('focus');
    const written = this.scratch.at('focusWritten');
    const cap = this.scratch.sizeOf('focus');
    if (
      ex.ghostty_focus_encode(focused ? FocusEvent.GAINED : FocusEvent.LOST, buf, cap, written) !==
      GHOSTTY_SUCCESS
    )
      return '';
    const len = this.mem.view().getUint32(written, true);
    return new TextDecoder().decode(this.mem.bytes().slice(buf, buf + len));
  }

  private setMode(mode: number, ansi: boolean, value: boolean, keepDefault = false): void {
    const ptr = this.scratch.at('value');
    const view = this.mem.view();
    view.setUint16(ptr, packMode(mode, ansi), true);
    view.setUint8(ptr + this.L.modeConfig.value, value ? 1 : 0);
    if (!keepDefault) this.exports.ghostty_terminal_set(this.handle, TerminalOpt.MODE_DEFAULT, ptr);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.MODE, ptr);
  }

  /** Write 0xRRGGBB as a GhosttyColorRgb at `at`. */
  private writeRgb(at: number, hex: number): void {
    const C = this.L.rgb;
    const view = this.mem.view();
    view.setUint8(at + C.r, (hex >> 16) & 0xff);
    view.setUint8(at + C.g, (hex >> 8) & 0xff);
    view.setUint8(at + C.b, hex & 0xff);
  }

  /** Read a GhosttyColorRgb at `at`. */
  private readRgb(at: number): RGB {
    const C = this.L.rgb;
    const b = this.mem.bytes();
    return { r: b[at + C.r], g: b[at + C.g], b: b[at + C.b] };
  }

  private setColor(option: number, hex: number): void {
    const ptr = this.scratch.at('rgb');
    this.writeRgb(ptr, hex);
    this.exports.ghostty_terminal_set(this.handle, option, ptr);
  }

  /** Apply ghostterm's config: the scrollback limit and terminfo name. */
  private applyConfig(config?: GhosttyTerminalConfig): void {
    this.setScrollbackLimit(config?.scrollbackLimit ?? 10000);
    this.setTerminfoName(config?.terminfoName ?? DEFAULT_TERMINFO_NAME);
  }

  /** The terminfo name reported for an XTGETTCAP query of "TN"; '' reports nothing. */
  private setTerminfoName(name: string): void {
    const bytes = new TextEncoder().encode(name);
    if (bytes.length > MAX_TERMINFO_NAME) throw new Error(`terminfo name too long: ${name}`);
    const str = this.scratch.at('terminfoString');
    const data = this.scratch.at('terminfoName');
    this.mem.bytes().set(bytes, data);
    const view = this.mem.view();
    view.setUint32(str + this.L.string.ptr, data, true);
    view.setUint32(str + this.L.string.len, bytes.length, true);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.TERMINFO_NAME, str);
  }

  /**
   * Lines of history to keep, at any time; 0 means no scrollback, as in
   * xterm.js. Lowering it prunes existing history.
   */
  setScrollbackLimit(lines: number): void {
    const ex = this.exports;
    // The library also caps history by bytes, 10,000 by default, which would
    // otherwise win, so that cap is lifted. A line limit alone can't turn
    // history off (a page of rows is always kept), but a byte limit of 0 does.
    const scrollback = Math.max(0, Math.floor(lines));
    const ptr = this.scratch.at('value');
    this.mem.view().setUint32(ptr, scrollback === 0 ? 0 : SIZE_MAX, true);
    ex.ghostty_terminal_set(this.handle, TerminalOpt.SCROLLBACK_MAX_BYTES, ptr);
    this.mem.view().setUint32(ptr, Math.min(scrollback, SIZE_MAX), true);
    ex.ghostty_terminal_set(this.handle, TerminalOpt.SCROLLBACK_MAX_LINES, ptr);
    this.changed();
    this.primary = null;
  }

  /**
   * Set the terminal's default colors, at any time (a theme change). Colors
   * are 0xRRGGBB; undefined restores the built-in default (white on black,
   * no cursor color). Palette entries override the built-in 256-color palette
   * by index. Programs can still change colors with OSC 4/10/11/12; those
   * overrides are kept.
   */
  setColors(colors: TerminalColors): void {
    const ex = this.exports;
    const set = (option: number, hex: number | undefined) => {
      if (hex === undefined) ex.ghostty_terminal_set(this.handle, option, 0);
      else this.setColor(option, hex);
    };
    // The render state copies the foreground and background only while both are set, so
    // unsetting one would leave the old colors on screen; the built-in defaults are set instead.
    this.setColor(TerminalOpt.COLOR_FOREGROUND, colors.foreground ?? DEFAULT_FOREGROUND);
    this.setColor(TerminalOpt.COLOR_BACKGROUND, colors.background ?? DEFAULT_BACKGROUND);
    set(TerminalOpt.COLOR_CURSOR, colors.cursor);

    // Start from the built-in palette, then apply the overrides.
    ex.ghostty_terminal_set(this.handle, TerminalOpt.COLOR_PALETTE, 0);
    if (colors.palette?.some((c) => c !== undefined)) {
      const ptr = this.scratch.at('palette');
      this.check(
        ex.ghostty_terminal_get(this.handle, TerminalData.COLOR_PALETTE_DEFAULT, ptr),
        'read default palette'
      );
      colors.palette.forEach((hex, i) => {
        if (hex !== undefined && i < 256) this.writeRgb(ptr + i * this.L.rgb.size, hex);
      });
      ex.ghostty_terminal_set(this.handle, TerminalOpt.COLOR_PALETTE, ptr);
    }

    // Every cell's resolved colors may have changed.
    this.colorsFresh = false;
    this.changed();
    this.dirty = DirtyState.FULL;
    this.rowDirty?.fill(1);
    this.rowStale?.fill(1);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    const ptr = this.exports.ghostty_wasm_alloc(bytes.length);
    if (!ptr) throw new Error('Failed to allocate write buffer (out of memory)');
    this.mem.bytes().set(bytes, ptr);
    this.exports.ghostty_terminal_vt_write(this.handle, ptr, bytes.length);
    this.changed();
    this.primary = null;
    this.exports.ghostty_wasm_free(ptr, bytes.length);
  }

  /** The OSC string writeCapturingOsc() is collecting, which may span writes. */
  private oscCapture: { bytes: number[]; overflow: boolean } | null = null;

  /** Whether writeCapturingOsc() is inside an OSC string, so the next write must use it too. */
  get capturingOsc(): boolean {
    return this.oscCapture !== null;
  }

  /**
   * Write like write(), passing each complete OSC string's payload (the bytes
   * between the introducer and the terminator) to `onOsc` before the
   * terminal acts on it. When `onOsc` returns true the string is cancelled
   * (CAN), so the terminal ignores it; otherwise it is processed as usual.
   *
   * libghostty's parser finds where each OSC starts (vt_write_until with
   * OSC_START), so introducers inside other strings and split across writes
   * are handled as it handles them. Inside the OSC the terminators are the
   * ones libghostty uses: BEL, ESC (of ESC \), and CAN or SUB, which cancel
   * it. Other C0 bytes are ignored there, as the parser ignores them.
   */
  writeCapturingOsc(data: string | Uint8Array, onOsc: (payload: Uint8Array) => boolean): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const len = bytes.length;
    if (len === 0) return;
    const ex = this.exports;
    const W = this.L.writeStop;
    // The data, then one byte for the CAN that cancels a handled string.
    const ptr = ex.ghostty_wasm_alloc(len + 1 + W.size);
    if (!ptr) throw new Error('Failed to allocate write buffer (out of memory)');
    const can = ptr + len;
    const stop = can + 1;
    this.mem.bytes().set(bytes, ptr);
    this.mem.bytes()[can] = 0x18;
    try {
      let pos = 0;
      while (pos < len) {
        const capture = this.oscCapture;
        if (capture) {
          let end = pos;
          while (end < len && !OSC_TERMINATORS.has(bytes[end])) end++;
          for (let i = pos; i < end; i++) {
            if (bytes[i] < 0x20) continue;
            if (capture.bytes.length >= OSC_PAYLOAD_LIMIT) capture.overflow = true;
            else capture.bytes.push(bytes[i]);
          }
          if (end > pos) ex.ghostty_terminal_vt_write(this.handle, ptr + pos, end - pos);
          pos = end;
          if (end === len) break;
          this.oscCapture = null;
          const terminator = bytes[end];
          // A cancelled string: libghostty drops it when it reads the CAN or SUB.
          if (terminator === 0x18 || terminator === 0x1a) continue;
          if (!capture.overflow && onOsc(Uint8Array.from(capture.bytes))) {
            ex.ghostty_terminal_vt_write(this.handle, can, 1);
            // A BEL ends the string alone. The ESC of ESC \ stays: at ground,
            // ESC \ does nothing, and any other byte after ESC starts a sequence.
            if (terminator === 0x07) pos++;
          }
          continue;
        }
        const v = this.mem.view();
        for (let i = 0; i < W.size; i += 4) v.setUint32(stop + i, 0, true);
        v.setUint32(stop, W.size, true); // sized struct: the size field comes first
        const result = ex.ghostty_terminal_vt_write_until(
          this.handle,
          ptr + pos,
          len - pos,
          WRITE_BOUNDARY_OSC_START,
          stop
        );
        const after = this.mem.view();
        const consumed = after.getUint32(stop + W.consumed, true);
        pos += consumed;
        if (result !== GHOSTTY_SUCCESS || consumed === 0) break;
        if (after.getUint32(stop + W.reached, true) & WRITE_BOUNDARY_OSC_START) {
          this.oscCapture = { bytes: [], overflow: false };
        }
      }
    } finally {
      ex.ghostty_wasm_free(ptr, len + 1 + W.size);
      this.changed();
    }
  }

  /**
   * The cursor shape and blink the user configured. Programs can change them
   * (DECSCUSR, mode 12); `CSI 0 q` returns to these. getCursor() reports
   * what is in effect.
   */
  setDefaultCursor(style: 'block' | 'underline' | 'bar', blink: boolean): void {
    const ptr = this.scratch.at('value');
    const value =
      style === 'bar'
        ? CursorStyle.BAR
        : style === 'underline'
          ? CursorStyle.UNDERLINE
          : CursorStyle.BLOCK;
    this.mem.view().setUint32(ptr, value, true);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.DEFAULT_CURSOR_STYLE, ptr);
    this.mem.view().setUint8(ptr, blink ? 1 : 0);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.DEFAULT_CURSOR_BLINK, ptr);
    this.changed();
  }

  /** Cell size in pixels, reported to programs (in-band resize, mode 2048). */
  private cellPx = { width: 0, height: 0 };

  /** Tell the terminal its cell size in pixels. */
  setCellPixelSize(width: number, height: number): void {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === this.cellPx.width && h === this.cellPx.height) return;
    this.cellPx = { width: w, height: h };
    this.exports.ghostty_terminal_resize(this.handle, this._cols, this._rows, w, h);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.exports.ghostty_terminal_resize(
      this.handle,
      cols,
      rows,
      this.cellPx.width,
      this.cellPx.height
    );
    this.changed();
    this.primary = null;
    this.atBottom = this.getViewportOffset() === 0;
    this.rowDirty = new Uint8Array(rows).fill(1);
    this.rowStale = new Uint8Array(rows).fill(1);
    this.dirty = DirtyState.FULL;
    this.initCellPool();
  }

  /** Release the terminal and everything it holds. Calling it again does nothing. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    const ex = this.exports;
    this.onFree?.();
    this.onFree = null;
    if (this.rowCellsSlot) {
      ex.ghostty_render_state_row_cells_free(this.mem.view().getUint32(this.rowCellsSlot, true));
      ex.ghostty_wasm_free_opaque(this.rowCellsSlot);
      this.rowCellsSlot = 0;
    }
    if (this.rowIterSlot) {
      ex.ghostty_render_state_row_iterator_free(this.mem.view().getUint32(this.rowIterSlot, true));
      ex.ghostty_wasm_free_opaque(this.rowIterSlot);
      this.rowIterSlot = 0;
    }
    if (this.renderState) {
      ex.ghostty_render_state_free(this.renderState);
      this.renderState = 0;
    }
    ex.ghostty_terminal_free(this.handle);
    if (this.answerbackBuf) {
      ex.ghostty_wasm_free(this.answerbackBuf, this.answerbackSize);
      this.answerbackBuf = 0;
    }
    this.scratch.free();
  }

  // ==========================================================================
  // RenderState API
  // ==========================================================================

  /**
   * Update render state from terminal.
   *
   * libghostty-vt only ever adds dirty state on update; it is cleared by
   * markClean(). So this is safe to call any number of times per frame.
   * Screen switches (normal <-> alternate) are reported as FULL.
   */
  update(): DirtyState {
    const ex = this.exports;
    // During a render hold the render state keeps the frame captured when the
    // hold began.
    if (this.isRenderHeld()) return this.dirty;
    ex.ghostty_render_state_update(this.renderState, this.handle);
    this.colorsFresh = false;
    this.pendingUpdate = false;

    const dirtyPtr = this.scratch.at('value');
    ex.ghostty_render_state_get(this.renderState, RenderData.DIRTY, dirtyPtr);
    const dirty = this.mem.view().getInt32(dirtyPtr, true) as DirtyState;
    if (dirty === DirtyState.NONE) return this.dirty;
    if (dirty > this.dirty) this.dirty = dirty;

    if (dirty === DirtyState.FULL) {
      this.rowDirty.fill(1);
      this.rowStale.fill(1);
      return this.dirty;
    }

    // Partial: record exactly which rows changed.
    const iter = this.rowIterator();
    const yPtr = this.scratch.at('value');
    while (ex.ghostty_render_state_row_iterator_next_dirty(iter, yPtr)) {
      const y = this.mem.view().getUint16(yPtr, true);
      if (y < this._rows) {
        this.rowDirty[y] = 1;
        this.rowStale[y] = 1;
      }
    }
    return this.dirty;
  }

  private rowIterator(): number {
    this.exports.ghostty_render_state_get(
      this.renderState,
      RenderData.ROW_ITERATOR,
      this.rowIterSlot
    );
    return this.mem.view().getUint32(this.rowIterSlot, true);
  }

  /**
   * Cursor state: shape, blink, visibility and viewport position from the
   * render state (updated first if the terminal changed), position in the
   * active area from the terminal.
   */
  getCursor(): RenderStateCursor {
    if (this.pendingUpdate) this.update();
    const ptr = this.scratch.at('cursor');
    const xPtr = this.scratch.at('cursorX');
    const yPtr = this.scratch.at('cursorY');
    const c = this.L.cursor;
    const view = this.mem.view();
    view.setUint32(ptr, c.size, true);
    this.exports.ghostty_render_state_get(this.renderState, RenderData.CURSOR, ptr);

    // x and y are in the active area; viewportX/Y place the cursor in the
    // (possibly scrolled) viewport, or are -1 when it is scrolled out of view.
    this.exports.ghostty_terminal_get(this.handle, TerminalData.CURSOR_X, xPtr);
    this.exports.ghostty_terminal_get(this.handle, TerminalData.CURSOR_Y, yPtr);
    const v = this.mem.view();
    const x = v.getUint16(xPtr, true);
    const y = v.getUint16(yPtr, true);
    const hasValue = v.getUint8(ptr + c.hasValue) !== 0;
    const style = v.getInt32(ptr + c.style, true);
    return {
      x,
      y,
      viewportX: hasValue ? v.getUint16(ptr + c.x, true) : -1,
      viewportY: hasValue ? v.getUint16(ptr + c.y, true) : -1,
      visible: v.getUint8(ptr + c.visible) !== 0,
      blinking: v.getUint8(ptr + c.blinking) !== 0,
      style:
        style === CursorStyle.BAR ? 'bar' : style === CursorStyle.UNDERLINE ? 'underline' : 'block',
    };
  }

  /** Refresh the default colors and palette used to resolve cell colors. */
  private loadColors(force = false): void {
    if (this.colorsFresh && !force) return;
    const ptr = this.scratch.at('colors');
    const c = this.L.colors;
    this.mem.view().setUint32(ptr, c.size, true);
    this.exports.ghostty_render_state_get(this.renderState, RenderData.COLORS, ptr);
    this.bgDefault = this.readRgb(ptr + c.bg);
    this.fgDefault = this.readRgb(ptr + c.fg);
    const palette = ptr + c.palette;
    this.palette.set(this.mem.bytes().subarray(palette, palette + this.palette.length));
    this.colorsFresh = true;
  }

  /**
   * Get default colors from render state
   */
  getColors(): RenderStateColors {
    if (this.pendingUpdate) this.update();
    // Forced so the cursor color below is read from a fresh copy in scratch.
    this.loadColors(true);
    const ptr = this.scratch.at('colors');
    const c = this.L.colors;
    const b = this.mem.bytes();
    const hasCursor = b[ptr + c.hasCursor] !== 0;
    return {
      background: { ...this.bgDefault },
      foreground: { ...this.fgDefault },
      cursor: hasCursor ? this.readRgb(ptr + c.cursor) : null,
    };
  }

  /**
   * Check if a specific row is dirty
   */
  isRowDirty(y: number): boolean {
    return this.dirty === DirtyState.FULL || this.rowDirty[y] === 1;
  }

  /**
   * Mark render state as clean (call after rendering)
   */
  markClean(): void {
    this.exports.ghostty_render_state_clean(this.renderState);
    this.dirty = DirtyState.NONE;
    this.rowDirty.fill(0);
  }

  /**
   * Full reset, as RIS (ESC c) does: screen, scrollback, modes and what the
   * program set. The handle, callbacks and configured defaults stay, so
   * objects holding this terminal remain valid.
   */
  reset(): void {
    this.exports.ghostty_terminal_reset(this.handle);
    this.primary = null;
    this.oscCapture = null;
    this.holdStarted = null;
    this.responses = [];
    this.atBottom = true;
    this.colorsFresh = false;
    this.changed();
    this.dirty = DirtyState.FULL;
    this.rowDirty.fill(1);
    this.rowStale.fill(1);
  }

  /**
   * Get all viewport cells. Returns a reusable cell array (zero allocation
   * after warmup); only rows that changed since they were last read are
   * fetched from WASM.
   */
  getViewport(): GhosttyCell[] {
    if (this.pendingUpdate) this.update();
    if (!this.rowStale.includes(1)) return this.cellPool;
    this.loadColors();

    const ex = this.exports;
    const iter = this.rowIterator();
    const viewPtr = this.scratch.at('cellsView');
    const cellsHandle = () => this.mem.view().getUint32(this.rowCellsSlot, true);
    let y = 0;
    while (y < this._rows && ex.ghostty_render_state_row_iterator_next(iter)) {
      if (this.rowStale[y]) {
        if (ex.ghostty_render_state_row_get(iter, RowData.CELLS_RAW, viewPtr) === GHOSTTY_SUCCESS) {
          // Row cells are only fetched (and the iterator only positioned on this
          // row) when a cell needs its style or grapheme cluster.
          let cellsReady = false;
          const rowCells = () => {
            if (!cellsReady) {
              ex.ghostty_render_state_row_get(iter, RowData.CELLS, this.rowCellsSlot);
              cellsReady = true;
            }
            return cellsHandle();
          };
          // The row's selected columns (inclusive), from the terminal's selection.
          const RS = this.L.rowSelection;
          const selPtr = this.scratch.at('rowSelection');
          this.mem.view().setUint32(selPtr, RS.size, true);
          const selected =
            ex.ghostty_render_state_row_get(iter, RowData.SELECTION, selPtr) === GHOSTTY_SUCCESS
              ? ([
                  this.mem.view().getUint16(selPtr + RS.startX, true),
                  this.mem.view().getUint16(selPtr + RS.endX, true),
                ] as const)
              : null;
          this.readRow(y, viewPtr, rowCells, selected);
        }
        this.rowStale[y] = 0;
      }
      y++;
    }
    return this.cellPool;
  }

  /** Decode one viewport row from its raw cells view into the cell pool. */
  private readRow(
    y: number,
    viewPtr: number,
    rowCells: () => number,
    selected: readonly [number, number] | null
  ): void {
    const ex = this.exports;
    const L = this.L;
    const view = this.mem.view();
    const cellsPtr = view.getUint32(viewPtr + L.cellsView.ptr, true);
    const len = Math.min(view.getUint32(viewPtr + L.cellsView.len, true), this._cols);
    const base = y * this._cols;
    const stylePtr = this.scratch.at('style');

    // Copy the raw row out first: style lookups below may grow memory.
    const cellSize = L.cellSize;
    const raw = this.mem.bytes().slice(cellsPtr, cellsPtr + len * cellSize);
    const rawView = new DataView(raw.buffer);

    for (let x = 0; x < this._cols; x++) {
      const cell = this.cellPool[base + x];
      if (x >= len) {
        this.setBlank(cell);
        continue;
      }
      const lo = rawView.getUint32(x * cellSize, true);
      const hi = rawView.getUint32(x * cellSize + 4, true);
      const styleId = readBits(lo, hi, L.cell.styleId);
      const tag = readBits(lo, hi, L.cell.contentTag);

      let graphemeLen = 0;
      let chars: string | undefined;
      let style: DataView | null = null;
      if (styleId !== 0 || tag === CellContent.CODEPOINT_GRAPHEME) {
        const cells = rowCells();
        ex.ghostty_render_state_row_cells_select(cells, x);
        if (styleId !== 0) {
          ex.ghostty_render_state_row_cells_get(cells, RowCellsData.STYLE, stylePtr);
          style = new DataView(this.mem.bytes().slice(stylePtr, stylePtr + L.style.size).buffer);
        }
        if (tag === CellContent.CODEPOINT_GRAPHEME) {
          const codepoints = this.rowCellGrapheme(cells);
          if (codepoints.length > 0) {
            chars = String.fromCodePoint(...codepoints);
            graphemeLen = codepoints.length - 1;
          }
        }
      }
      this.decodeCell(cell, lo, hi, style, graphemeLen);
      cell.chars = chars;
      cell.selected = selected !== null && x >= selected[0] && x <= selected[1];
      if (cell.hyperlink_id) {
        cell.hyperlink_id = this.linkId(this.hyperlinkAt(PointTag.VIEWPORT, x, y));
      }
    }
  }

  /**
   * The codepoints of the selected row cell's grapheme cluster, base codepoint
   * first, read into a GhosttyCodepointBuffer.
   */
  private rowCellGrapheme(cells: number): number[] {
    const ex = this.exports;
    const B = this.L.codepointBuffer;
    const desc = this.scratch.at('graphemeBuffer');
    /** Read into buf (cap codepoints); the codepoints, or a result code on failure. */
    const read = (buf: number, cap: number): number[] | number => {
      const view = this.mem.view();
      view.setUint32(desc + B.ptr, buf, true);
      view.setUint32(desc + B.cap, cap, true);
      view.setUint32(desc + B.len, 0, true);
      const result = ex.ghostty_render_state_row_cells_get(cells, RowCellsData.GRAPHEMES_BUF, desc);
      if (result !== GHOSTTY_SUCCESS) return result;
      const len = this.mem.view().getUint32(desc + B.len, true);
      return Array.from(new Uint32Array(this.mem.bytes().slice(buf, buf + len * 4).buffer));
    };

    const first = read(this.scratch.at('graphemes'), GRAPHEME_SCRATCH_SIZE / 4);
    if (typeof first !== 'number') return first;
    if (first !== GHOSTTY_OUT_OF_SPACE) return [];
    // Too long for the scratch area: size a buffer to fit.
    if (ex.ghostty_render_state_row_cells_get(cells, RowCellsData.GRAPHEMES_LEN, desc)) return [];
    const needed = this.mem.view().getUint32(desc, true);
    const big = ex.ghostty_wasm_alloc(needed * 4);
    try {
      const second = read(big, needed);
      return typeof second === 'number' ? [] : second;
    } finally {
      ex.ghostty_wasm_free(big, needed * 4);
    }
  }

  private setBlank(cell: GhosttyCell): void {
    cell.codepoint = 0;
    cell.fg_r = this.fgDefault.r;
    cell.fg_g = this.fgDefault.g;
    cell.fg_b = this.fgDefault.b;
    cell.bg_r = this.bgDefault.r;
    cell.bg_g = this.bgDefault.g;
    cell.bg_b = this.bgDefault.b;
    cell.flags = 0;
    cell.width = 1;
    cell.hyperlink_id = 0;
    cell.grapheme_len = 0;
    cell.chars = undefined;
    cell.underline_style = UnderlineStyle.NONE;
    cell.underline_color = undefined;
    cell.overline = false;
    cell.selected = false;
    cell.bg_default = true;
    cell.fg_default = true;
  }

  /**
   * Fill a GhosttyCell from a raw cell (as two 32-bit halves) and its style.
   * Colors are resolved against the current palette and default colors, the
   * same way Ghostty's own renderer does it; inverse is left to the renderer.
   */
  private decodeCell(
    cell: GhosttyCell,
    lo: number,
    hi: number,
    style: DataView | null,
    graphemeLen: number
  ): void {
    const L = this.L;
    const tag = readBits(lo, hi, L.cell.contentTag);
    const hasText = tag === CellContent.CODEPOINT || tag === CellContent.CODEPOINT_GRAPHEME;
    cell.codepoint = hasText ? readBits(lo, hi, L.cell.codepoint) : 0;

    let fg = this.fgDefault;
    let bg = this.bgDefault;
    let bgDefault = true;
    let fgDefault = true;
    let flags = 0;
    let underlineStyle = UnderlineStyle.NONE;
    let underlineColor: number | undefined;
    let overline = false;
    if (style) {
      underlineStyle = readBits(style.getUint16(L.style.flags, true), 0, L.styleFlags.underline);
      overline = readBits(style.getUint16(L.style.flags, true), 0, L.styleFlags.overline) !== 0;
      const ul = this.resolveStyleColor(style, L.style.underline);
      if (ul) underlineColor = (ul.r << 16) | (ul.g << 8) | ul.b;
      const styleFg = this.resolveStyleColor(style, L.style.fg);
      if (styleFg) {
        fg = styleFg;
        fgDefault = false;
      }
      const styleBg = this.resolveStyleColor(style, L.style.bg);
      if (styleBg) {
        bg = styleBg;
        bgDefault = false;
      }
      const f = style.getUint16(L.style.flags, true);
      const sf = L.styleFlags;
      if (readBits(f, 0, sf.bold)) flags |= CellFlags.BOLD;
      if (readBits(f, 0, sf.italic)) flags |= CellFlags.ITALIC;
      if (readBits(f, 0, sf.underline)) flags |= CellFlags.UNDERLINE;
      if (readBits(f, 0, sf.strikethrough)) flags |= CellFlags.STRIKETHROUGH;
      if (readBits(f, 0, sf.inverse)) flags |= CellFlags.INVERSE;
      if (readBits(f, 0, sf.invisible)) flags |= CellFlags.INVISIBLE;
      if (readBits(f, 0, sf.blink)) flags |= CellFlags.BLINK;
      if (readBits(f, 0, sf.faint)) flags |= CellFlags.FAINT;
    }
    if (tag === CellContent.BG_COLOR_PALETTE) {
      bg = this.paletteColor(readBits(lo, hi, L.cell.bgPalette));
      bgDefault = false;
    } else if (tag === CellContent.BG_COLOR_RGB) {
      bg = {
        r: readBits(lo, hi, L.cell.bgR),
        g: readBits(lo, hi, L.cell.bgG),
        b: readBits(lo, hi, L.cell.bgB),
      };
      bgDefault = false;
    }

    cell.fg_r = fg.r;
    cell.fg_g = fg.g;
    cell.fg_b = fg.b;
    cell.bg_r = bg.r;
    cell.bg_g = bg.g;
    cell.bg_b = bg.b;
    cell.bg_default = bgDefault;
    cell.fg_default = fgDefault;
    cell.flags = flags;
    const wide = readBits(lo, hi, L.cell.wide);
    cell.width = wide === CellWide.NARROW ? 1 : wide === CellWide.WIDE ? 2 : 0;
    cell.hyperlink_id = readBits(lo, hi, L.cell.hyperlink) ? 1 : 0;
    cell.grapheme_len = graphemeLen;
    cell.underline_style = underlineStyle;
    cell.underline_color = underlineColor;
    cell.overline = overline;
  }

  private paletteColor(index: number): RGB {
    const C = this.L.rgb;
    const p = this.palette;
    const at = index * C.size;
    return { r: p[at + C.r], g: p[at + C.g], b: p[at + C.b] };
  }

  /** Resolve a GhosttyStyleColor at `offset`; null means "use the default". */
  private resolveStyleColor(style: DataView, offset: number): RGB | null {
    const C = this.L.styleColor;
    const tag = style.getUint8(offset + C.tag);
    if (tag === StyleColorTag.PALETTE) return this.paletteColor(style.getUint8(offset + C.value));
    if (tag === StyleColorTag.RGB) {
      return {
        r: style.getUint8(offset + C.r),
        g: style.getUint8(offset + C.g),
        b: style.getUint8(offset + C.b),
      };
    }
    return null;
  }

  // ==========================================================================
  // Compatibility methods (delegate to render state)
  // ==========================================================================

  /**
   * A row of the active area (the screen without scrollback) as the terminal
   * holds it now, whatever the viewport is scrolled to and even while a
   * render hold (mode 2026) freezes what is displayed. Read from the grid,
   * like getScreenLine(); `selected` is always false. Returns new cells.
   */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    return this.readGridLine(PointTag.ACTIVE, y);
  }

  /**
   * A row of the viewport as it is displayed, which includes scrollback rows
   * when scrolled up (see setViewportOffset) and the held frame during a
   * render hold. Read from the render state. Returns a copy of the cells.
   */
  getViewportLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    const viewport = this.getViewport();
    const start = y * this._cols;
    return viewport.slice(start, start + this._cols).map((cell) => ({ ...cell }));
  }

  /**
   * Scroll libghostty's viewport to `offset` rows above the bottom of the
   * scrollback (0 = pinned to the active area, following new output).
   * The offset is clamped to the scrollback length.
   */
  setViewportOffset(offset: number): void {
    const { total, offset: top, len } = this.scrollbar();
    const maxOffset = Math.max(0, total - len);
    const target = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
    const current = maxOffset - top;
    if (target === current && this.atBottom === (target === 0)) return;

    if (target === 0) this.scrollViewport(ScrollViewport.BOTTOM, 0);
    else this.scrollViewport(ScrollViewport.ROW, maxOffset - target);
    this.atBottom = target === 0;
  }

  /** The terminal's GhosttyTerminalScrollbar: rows in total, top of the viewport, its height. */
  private scrollbar(): { total: number; offset: number; len: number } {
    const S = this.L.scrollbar;
    const ptr = this.scratch.at('scrollbar');
    this.exports.ghostty_terminal_get(this.handle, TerminalData.SCROLLBAR, ptr);
    const view = this.mem.view();
    return {
      total: Number(view.getBigUint64(ptr + S.total, true)),
      offset: Number(view.getBigUint64(ptr + S.offset, true)),
      len: Number(view.getBigUint64(ptr + S.len, true)),
    };
  }

  /**
   * Scroll libghostty's viewport (GhosttyTerminalScrollViewport). `value` is
   * the delta for DELTA and DELTA_PROMPT and the row for ROW.
   */
  private scrollViewport(tag: number, value: number): void {
    const S = this.L.scrollViewport;
    const ptr = this.scratch.zero('scrollViewport', this.mem.bytes());
    const view = this.mem.view();
    view.setInt32(ptr + S.tag, tag, true);
    if (tag === ScrollViewport.ROW) view.setUint32(ptr + S.row, value, true);
    else view.setInt32(ptr + S.delta, value, true);
    this.exports.ghostty_terminal_scroll_viewport(this.handle, ptr);
    this.changed();
  }

  private scrollBy(tag: number, amount: number): void {
    this.scrollViewport(tag, amount);
    this.atBottom = this.getViewportOffset() === 0;
  }

  /**
   * Scroll the viewport by `delta` shell prompts (negative = older), using the
   * prompt marks shell integration (OSC 133) leaves. Returns whether it moved.
   */
  scrollToPrompt(delta: number): boolean {
    if (delta === 0) return false;
    const before = this.getViewportOffset();
    this.scrollBy(ScrollViewport.DELTA_PROMPT, delta);
    if (this.getViewportOffset() === before && delta < 0) {
      // libghostty-vt 1.0 doesn't move back one prompt when a prompt is the
      // top row; starting one row higher finds the one before it.
      this.scrollBy(ScrollViewport.DELTA, -1);
      this.scrollBy(ScrollViewport.DELTA_PROMPT, delta);
    }
    const moved = this.getViewportOffset() !== before;
    if (!moved) this.setViewportOffset(before);
    return moved;
  }

  /** Rows the viewport is scrolled above the bottom (0 when pinned). */
  getViewportOffset(): number {
    const { total, offset, len } = this.scrollbar();
    return Math.max(0, total - len - offset);
  }

  /**
   * Check if a full redraw is needed (screen change, resize, etc.)
   * Note: This calls update() to ensure fresh state. Safe to call multiple times.
   */
  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  /** Mark render state as clean after rendering */
  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    const ptr = this.scratch.at('value');
    this.exports.ghostty_terminal_get(this.handle, TerminalData.ACTIVE_SCREEN, ptr);
    return this.mem.view().getInt32(ptr, true) === TerminalScreen.ALTERNATE;
  }

  hasBracketedPaste(): boolean {
    // Mode 2004 = bracketed paste (DEC mode)
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    // Mode 1004 = focus events (DEC mode)
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    const ptr = this.scratch.at('value');
    this.exports.ghostty_terminal_get(this.handle, TerminalData.MOUSE_TRACKING, ptr);
    return this.mem.view().getUint8(ptr) !== 0;
  }

  /**
   * Query arbitrary terminal mode by number
   * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    const ptr = this.scratch.at('value');
    const view = this.mem.view();
    view.setUint16(ptr, packMode(mode, isAnsi), true);
    view.setUint8(ptr + this.L.modeConfig.value, 0);
    const result = this.exports.ghostty_terminal_get(this.handle, TerminalData.MODE, ptr);
    if (result !== GHOSTTY_SUCCESS) return false;
    return this.mem.view().getUint8(ptr + this.L.modeConfig.value) !== 0;
  }

  // ==========================================================================
  // Grid access (scrollback, wrapping, graphemes, hyperlinks)
  // ==========================================================================

  /** Get dimensions - for compatibility */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Get number of scrollback lines (history, not including active screen) */
  getScrollbackLength(): number {
    const ptr = this.scratch.at('value');
    this.exports.ghostty_terminal_get(this.handle, TerminalData.SCROLLBACK_ROWS, ptr);
    return this.mem.view().getUint32(ptr, true);
  }

  /** @internal Write the grid reference for a viewport cell to refPtr. */
  viewportRef(col: number, row: number, refPtr: number): boolean {
    return this.gridRef(PointTag.VIEWPORT, col, row, refPtr);
  }

  /**
   * Resolve a grid point to a GhosttyGridRef written at `refPtr`.
   * Returns false if the point is outside the requested area.
   */
  private gridRef(tag: number, x: number, y: number, refPtr: number): boolean {
    const pointPtr = this.writePoint(tag, x, y);
    return (
      this.exports.ghostty_terminal_grid_ref(this.handle, pointPtr, refPtr) === GHOSTTY_SUCCESS
    );
  }

  /** Write a GhosttyPoint to the scratch area and return its address. */
  private writePoint(tag: number, x: number, y: number): number {
    const P = this.L.point;
    const pointPtr = this.scratch.at('point');
    const view = this.mem.view();
    for (let i = 0; i < P.size; i += 4) view.setUint32(pointPtr + i, 0, true);
    view.setInt32(pointPtr, tag, true);
    view.setUint16(pointPtr + P.value + P.x, x, true);
    view.setUint32(pointPtr + P.value + P.y, y, true);
    return pointPtr;
  }

  /**
   * Follow absolute screen row `row` (as in getScreenLine) as the terminal
   * changes, with a libghostty tracked grid reference: it moves with its
   * content as output scrolls, history is pruned and the screen reflows, and
   * loses its value when the row leaves the buffer. Returns null when the row
   * is outside the screen.
   */
  trackRow(row: number): TrackedRow | null {
    if (row < 0 || !Number.isInteger(row)) return null;
    const pointPtr = this.writePoint(PointTag.SCREEN, 0, row);
    const out = this.scratch.at('trackedRef');
    this.mem.view().setUint32(out, 0, true);
    if (
      this.exports.ghostty_terminal_grid_ref_track(this.handle, pointPtr, out) !== GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const ref = this.mem.view().getUint32(out, true);
    return ref ? new TrackedRow(this.exports, this.mem, this.L, ref) : null;
  }

  /**
   * Get a line from the scrollback buffer.
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (offset < 0 || offset >= this.getScrollbackLength()) return null;
    return this.readGridLine(PointTag.HISTORY, offset);
  }

  /**
   * Read one row of the terminal's grid cell by cell through grid references,
   * independent of the render state's (possibly held) frame.
   */
  private readGridLine(tag: number, row: number): GhosttyCell[] | null {
    // Only the default colors and palette come from the render state.
    if (this.pendingUpdate) this.update();
    this.loadColors();

    const ex = this.exports;
    const refPtr = this.scratch.at('ref');
    const rawPtr = this.scratch.at('refOut');
    const stylePtr = this.scratch.at('style');
    const L = this.L;
    const cells: GhosttyCell[] = [];

    for (let x = 0; x < this._cols; x++) {
      const cell = {} as GhosttyCell;
      if (
        !this.gridRef(tag, x, row, refPtr) ||
        ex.ghostty_grid_ref_cell(refPtr, rawPtr) !== GHOSTTY_SUCCESS
      ) {
        if (x === 0) return null;
        this.setBlank(cell);
        cells.push(cell);
        continue;
      }
      const view = this.mem.view();
      const lo = view.getUint32(rawPtr, true);
      const hi = view.getUint32(rawPtr + 4, true);

      let style: DataView | null = null;
      if (readBits(lo, hi, L.cell.styleId) !== 0) {
        if (ex.ghostty_grid_ref_style(refPtr, stylePtr) === GHOSTTY_SUCCESS) {
          style = new DataView(this.mem.bytes().slice(stylePtr, stylePtr + L.style.size).buffer);
        }
      }
      let codepoints: number[] | null = null;
      if (readBits(lo, hi, L.cell.contentTag) === CellContent.CODEPOINT_GRAPHEME) {
        codepoints = this.graphemeAt(tag, x, row);
      }
      const graphemeLen = codepoints ? Math.max(0, codepoints.length - 1) : 0;
      this.decodeCell(cell, lo, hi, style, graphemeLen);
      cell.selected = false;
      if (graphemeLen > 0) cell.chars = String.fromCodePoint(...codepoints!);
      if (cell.hyperlink_id) cell.hyperlink_id = this.linkId(this.hyperlinkAt(tag, x, row));
      cells.push(cell);
    }
    return cells;
  }

  /** Hyperlink IDs by URI, so cells of the same link share one ID. */
  private linkIds = new Map<string, number>();
  private nextLinkId = 1;

  /**
   * The ID for a hyperlink URI (0 for none). IDs are never reused. The map
   * is bounded: when it fills up it starts over, and the viewport is re-read
   * so its cells don't keep IDs a URI no longer has.
   */
  private linkId(uri: string | null): number {
    if (!uri) return 0;
    let id = this.linkIds.get(uri);
    if (id === undefined) {
      if (this.linkIds.size >= MAX_LINK_IDS) {
        this.linkIds.clear();
        this.rowStale.fill(1);
        this.rowDirty.fill(1);
        this.dirty = DirtyState.FULL;
      }
      id = this.nextLinkId++;
      this.linkIds.set(uri, id);
    }
    return id;
  }

  /**
   * A line of the screen by absolute row: 0 is the oldest scrollback row,
   * rows after the scrollback are the active area. Cells carry their full
   * grapheme cluster (`chars`) and a hyperlink ID that is the same for every
   * cell of one link.
   */
  getScreenLine(row: number): GhosttyCell[] | null {
    if (row < 0) return null;
    return this.readGridLine(PointTag.SCREEN, row);
  }

  /** Whether a screen row (absolute, as in getScreenLine) continues the previous one. */
  isScreenRowWrapped(row: number): boolean {
    return this.rowWraps(PointTag.SCREEN, row);
  }

  /** The hyperlink URI at a screen cell (absolute row), or null. */
  getScreenHyperlinkUri(row: number, col: number): string | null {
    return this.hyperlinkAt(PointTag.SCREEN, col, row);
  }

  private rowWraps(tag: number, row: number): boolean {
    const refPtr = this.scratch.at('ref');
    const rowPtr = this.scratch.at('refOut');
    const outPtr = this.scratch.at('rowFlag');
    if (!this.gridRef(tag, 0, row, refPtr)) return false;
    if (this.exports.ghostty_grid_ref_row(refPtr, rowPtr) !== GHOSTTY_SUCCESS) return false;
    const rowValue = this.mem.view().getBigUint64(rowPtr, true);
    if (
      this.exports.ghostty_row_get(rowValue, GridRowData.WRAP_CONTINUATION, outPtr) !==
      GHOSTTY_SUCCESS
    ) {
      return false;
    }
    return this.mem.view().getUint8(outPtr) !== 0;
  }

  /** Read a grid reference's hyperlink URI, or null if the cell has none. */
  private hyperlinkAt(tag: number, x: number, y: number): string | null {
    const ex = this.exports;
    const refPtr = this.scratch.at('ref');
    const lenPtr = this.scratch.at('refOut');
    if (!this.gridRef(tag, x, y, refPtr)) return null;
    const sizeResult = ex.ghostty_grid_ref_hyperlink_uri(refPtr, 0, 0, lenPtr);
    if (sizeResult !== GHOSTTY_OUT_OF_SPACE) return null;
    const len = this.mem.view().getUint32(lenPtr, true);
    if (len === 0) return null;
    const buf = ex.ghostty_wasm_alloc(len);
    try {
      if (ex.ghostty_grid_ref_hyperlink_uri(refPtr, buf, len, lenPtr) !== GHOSTTY_SUCCESS) {
        return null;
      }
      const written = this.mem.view().getUint32(lenPtr, true);
      return new TextDecoder().decode(this.mem.bytes().slice(buf, buf + written));
    } finally {
      ex.ghostty_wasm_free(buf, len);
    }
  }

  /**
   * Read pending responses from the terminal.
   * Returns the response string, or null if no responses pending.
   *
   * Responses are generated by escape sequences that require replies:
   * - DSR 6 (cursor position): Returns \x1b[row;colR
   * - DSR 5 (operating status): Returns \x1b[0n
   */
  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    const total = this.responses.reduce((n, r) => n + r.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const r of this.responses) {
      all.set(r, at);
      at += r.length;
    }
    this.responses = [];
    return new TextDecoder().decode(all);
  }

  // ==========================================================================
  // Selection (the terminal owns it and keeps it in step with the content)
  // ==========================================================================

  /** Whether the terminal has an active selection. */
  hasSelection(): boolean {
    return (
      this.exports.ghostty_terminal_get(
        this.handle,
        TerminalData.SELECTION,
        this.scratch.at('selection')
      ) === GHOSTTY_SUCCESS
    );
  }

  /** The active selection in absolute screen rows, start before end. */
  getSelectionRange(): SelectionRange | null {
    const sel = this.scratch.at('selection');
    if (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    return this.selectionRangeAt(sel);
  }

  /** @internal A GhosttySelection snapshot at `sel` as an absolute range. */
  selectionRangeAt(sel: number): SelectionRange | null {
    const ex = this.exports;
    const S = this.L.selection;
    const ordered = this.scratch.at('orderedSelection');
    if (
      ex.ghostty_terminal_selection_ordered(this.handle, sel, SelectionOrder.FORWARD, ordered) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const start = this.screenPoint(ordered + S.start);
    const end = this.screenPoint(ordered + S.end);
    if (!start || !end) return null;
    return {
      startCol: start.x,
      startRow: start.y,
      endCol: end.x,
      endRow: end.y,
      rectangle: this.mem.view().getUint8(ordered + S.rectangle) !== 0,
    };
  }

  private screenPoint(refPtr: number): { x: number; y: number } | null {
    const out = this.scratch.at('selectionPoint');
    if (
      this.exports.ghostty_terminal_point_from_grid_ref(
        this.handle,
        refPtr,
        PointTag.SCREEN,
        out
      ) !== GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const view = this.mem.view();
    return {
      x: view.getUint16(out + this.L.coordinate.x, true),
      y: view.getUint32(out + this.L.coordinate.y, true),
    };
  }

  /**
   * Select from (startCol, startRow) to (endCol, endRow), both included, in
   * absolute screen rows. Returns false if either end is outside the screen.
   */
  setSelectionRange(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
    rectangle = false
  ): boolean {
    const S = this.L.selection;
    const sel = this.scratch.at('newSelection');
    for (let i = 0; i < S.size; i++) this.mem.view().setUint8(sel + i, 0);
    if (
      !this.gridRef(PointTag.SCREEN, startCol, startRow, sel + S.start) ||
      !this.gridRef(PointTag.SCREEN, endCol, endRow, sel + S.end)
    ) {
      return false;
    }
    this.mem.view().setUint8(sel + S.rectangle, rectangle ? 1 : 0);
    return this.installSelection(sel);
  }

  /**
   * Clear as xterm.js's clear() does: the cursor's line becomes the top line, the rest of the
   * screen and the scrollback are erased with the default background, and the cursor keeps its
   * column. The program's scroll region, origin mode and pen are left as they were and don't
   * limit it. Nothing is sent to the program.
   */
  clearToCursorLine(): void {
    const { x, y } = this.getCursor();
    // What the program set up, as the sequences that restore it: the formatter appends them to
    // a row's content.
    const extras = FormatterExtras.SCROLLING_REGION | FormatterExtras.STYLE;
    const row = this.getScrollbackLength() + this._rows - 1;
    const content = this.formatScreen({ format: 'vt', extras: 0, fromRow: row, toRow: row });
    const withState = this.formatScreen({ format: 'vt', extras, fromRow: row, toRow: row });
    const restore = withState.startsWith(content) ? withState.slice(content.length) : '';
    const origin = this.getMode(6);
    const leftRight = this.getMode(69);

    // Full-screen margins (DECSTBM, and DECSLRM through mode 69) and the default pen. Then
    // scroll the cursor's line up to the top (SU), erase below it and drop the history (ED 3).
    let seq = `${leftRight ? '\x1b[?69l' : ''}\x1b[r\x1b[0m`;
    if (y > 0) seq += `\x1b[${y}S`;
    if (this._rows > 1) seq += '\x1b[2;1H\x1b[J';
    seq += `\x1b[3J${leftRight ? '\x1b[?69h' : ''}${restore}`;
    this.write(seq);
    // Restoring the margins homed the cursor; put it on the top line at its column even in
    // origin mode (which would keep it inside the region), as xterm.js does.
    if (origin) this.setMode(6, false, false, true);
    this.write(`\x1b[1;${x + 1}H`);
    if (origin) this.setMode(6, false, true, true);
  }

  /**
   * @internal Note that the terminal changed outside write() and friends, so
   * the next read refreshes the render state.
   */
  invalidate(): void {
    this.changed();
  }

  /** @internal Make the selection snapshot at ptr the terminal's selection. */
  installSelection(ptr: number): boolean {
    const ok =
      this.exports.ghostty_terminal_set(this.handle, TerminalOpt.SELECTION, ptr) ===
      GHOSTTY_SUCCESS;
    this.changed();
    return ok;
  }

  /**
   * Move the selection's moving end the way keyboard selection does in
   * Ghostty (Shift+arrows and friends). Returns false without a selection.
   */
  adjustSelection(how: SelectionAdjust): boolean {
    const ex = this.exports;
    const sel = this.scratch.at('newSelection');
    if (ex.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !== GHOSTTY_SUCCESS)
      return false;
    if (
      ex.ghostty_terminal_selection_adjust(this.handle, sel, SELECTION_ADJUST[how]) !==
      GHOSTTY_SUCCESS
    ) {
      return false;
    }
    return this.installSelection(sel);
  }

  clearSelection(): void {
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.SELECTION, 0);
    this.changed();
  }

  /** Select all selectable content, scrollback included. */
  selectAll(): boolean {
    const sel = this.scratch.at('newSelection');
    if (this.exports.ghostty_terminal_select_all(this.handle, sel) !== GHOSTTY_SUCCESS)
      return false;
    return this.installSelection(sel);
  }

  /**
   * The selected text as Ghostty copies it: plain text, soft-wrapped lines
   * joined and trailing spaces trimmed.
   */
  getSelectionText(): string {
    const sel = this.scratch.at('selection');
    if (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return '';
    }
    return this.format({ format: 'plain', unwrap: true, trim: true, selectionPtr: sel });
  }

  /**
   * Format a screen (scrollback included) with libghostty's formatter: plain
   * text, VT sequences that recreate it when written to another terminal, or
   * HTML. `screen: 'primary'` formats the normal screen even while the
   * alternate screen is active. `fromRow`/`toRow` (absolute rows of that
   * screen, both included) or `scrollback` (most recent history lines to keep)
   * limit the rows.
   */
  formatScreen(options: FormatScreenOptions): string {
    if (options.screen === 'primary' && this.isAlternateScreen()) {
      return this.readPrimary(() => this.formatActiveScreen(options));
    }
    return this.formatActiveScreen(options);
  }

  /** What primaryScreen() read, until the terminal changes (write, resize, reset). */
  private primary: PrimaryScreen | null = null;

  /**
   * The primary screen while the alternate screen is active (null otherwise), for
   * buffer.normal: its size, and its lines read on demand, a block at a time. Its cursor isn't
   * known: switching screens with mode 47 moves it, and 1049 keeps it as the saved cursor. Each
   * read switches screens and back (withPrimaryScreen) without visible effects: the render
   * state, its dirty state, the selection and the viewport stay as they were. Kept until the
   * terminal changes.
   */
  primaryScreen(): PrimaryScreen | null {
    if (!this.isAlternateScreen()) return null;
    if (this.primary) return this.primary;
    const lines = new Map<number, { cells: GhosttyCell[]; wrapped: boolean }>();
    const scrollback = this.readPrimary(() => this.getScrollbackLength());
    const length = scrollback + this._rows;
    const snapshot: PrimaryScreen = {
      scrollback,
      length,
      line: (row) => {
        if (row < 0 || row >= length) return null;
        if (!lines.has(row) && this.primary === snapshot) {
          const start = row - (row % PRIMARY_BLOCK_ROWS);
          this.readPrimary(() => {
            for (let y = start; y < Math.min(length, start + PRIMARY_BLOCK_ROWS); y++) {
              const cells = this.getScreenLine(y);
              if (cells) lines.set(y, { cells, wrapped: this.isScreenRowWrapped(y) });
            }
          });
        }
        return lines.get(row) ?? null;
      },
    };
    this.primary = snapshot;
    return snapshot;
  }

  /**
   * Run fn on the primary screen (withPrimaryScreen), leaving no trace: the render state isn't
   * refreshed from the primary screen, and the dirty state the switches cause is dropped (what
   * was dirty before is kept), unless a render hold keeps the render state as it is.
   */
  private readPrimary<T>(fn: () => T): T {
    if (this.pendingUpdate) this.update();
    this.loadColors();
    const primary = this.primary;
    try {
      return this.withPrimaryScreen(() => {
        this.pendingUpdate = false;
        return fn();
      });
    } finally {
      this.primary = primary;
      if (!this.isRenderHeld()) {
        this.exports.ghostty_render_state_update(this.renderState, this.handle);
        this.exports.ghostty_render_state_clean(this.renderState);
        this.pendingUpdate = false;
      }
    }
  }

  /**
   * Run fn with the primary screen active while the alternate screen is.
   * libghostty's formatter only reads the active screen, and grid references
   * only reach the active screen, so this switches with mode 47 (no clearing,
   * no cursor save) and back. The mode 47 flag and the selection, which a
   * switch clears, are put back afterwards.
   */
  private withPrimaryScreen<T>(fn: () => T): T {
    const selection = this.getSelectionRange();
    const mode47 = this.getMode(47);
    this.write('\x1b[?47l');
    try {
      return fn();
    } finally {
      this.write('\x1b[?47h');
      if (!mode47) this.setMode(47, false, false);
      if (selection) {
        const { startCol, startRow, endCol, endRow, rectangle } = selection;
        this.setSelectionRange(startCol, startRow, endCol, endRow, rectangle);
      }
      this.invalidate();
    }
  }

  private formatActiveScreen(options: FormatScreenOptions): string {
    if (options.onlySelection) {
      const sel = this.scratch.at('selection');
      if (
        this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !==
        GHOSTTY_SUCCESS
      ) {
        return '';
      }
      return this.format({ ...options, selectionPtr: sel });
    }
    const history = this.getScrollbackLength();
    const lastRow = history + this._rows - 1;
    let fromRow = options.fromRow ?? 0;
    if (options.fromRow === undefined && options.scrollback !== undefined) {
      fromRow = history - Math.max(0, Math.floor(options.scrollback));
    }
    fromRow = Math.max(0, fromRow);
    const toRow = Math.min(lastRow, options.toRow ?? lastRow);
    if (fromRow > toRow) return '';
    let selectionPtr: number | undefined;
    if (fromRow > 0 || toRow < lastRow) {
      // A selection over whole rows narrows the output.
      const S = this.L.selection;
      const sel = this.scratch.at('newSelection');
      for (let i = 0; i < S.size; i++) this.mem.view().setUint8(sel + i, 0);
      if (
        this.gridRef(PointTag.SCREEN, 0, fromRow, sel + S.start) &&
        this.gridRef(PointTag.SCREEN, this._cols - 1, toRow, sel + S.end)
      ) {
        selectionPtr = sel;
      }
    }
    return this.format({ ...options, selectionPtr });
  }

  private format(options: {
    format: 'plain' | 'vt' | 'html';
    extras?: number;
    unwrap?: boolean;
    trim?: boolean;
    selectionPtr?: number;
  }): string {
    const ex = this.exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    const created = ex.ghostty_formatter_terminal_new(0, slot, this.handle);
    const formatter = ex.ghostty_wasm_take_opaque(slot);
    ex.ghostty_wasm_free_opaque(slot);
    if (created !== GHOSTTY_SUCCESS) return '';

    const opt = this.scratch.at('formatterOption');
    try {
      const emit =
        options.format === 'vt'
          ? FormatterFormat.VT
          : options.format === 'html'
            ? FormatterFormat.HTML
            : FormatterFormat.PLAIN;
      this.mem.view().setUint32(opt, emit, true);
      ex.ghostty_formatter_set(formatter, FormatterOpt.EMIT, opt);
      this.mem.view().setUint8(opt, options.unwrap ? 1 : 0);
      ex.ghostty_formatter_set(formatter, FormatterOpt.UNWRAP, opt);
      this.mem.view().setUint8(opt, options.trim ? 1 : 0);
      ex.ghostty_formatter_set(formatter, FormatterOpt.TRIM, opt);
      if (options.extras !== undefined) {
        this.mem.view().setUint32(opt, options.extras, true);
        ex.ghostty_formatter_set(formatter, FormatterOpt.EXTRAS, opt);
      }
      if (options.selectionPtr !== undefined) {
        ex.ghostty_formatter_set(formatter, FormatterOpt.SELECTION, options.selectionPtr);
      }

      const outPtr = this.scratch.at('formatterOutPtr');
      const outLen = this.scratch.at('formatterOutLen');
      if (ex.ghostty_formatter_format_alloc(formatter, 0, outPtr, outLen) !== GHOSTTY_SUCCESS) {
        return '';
      }
      const v = this.mem.view();
      const ptr = v.getUint32(outPtr, true);
      const len = v.getUint32(outLen, true);
      const text = new TextDecoder().decode(this.mem.bytes().slice(ptr, ptr + len));
      ex.ghostty_free(0, ptr, len);
      return text;
    } finally {
      ex.ghostty_formatter_free(formatter);
    }
  }

  /** Create a search over this terminal's scrollback and screen. */
  createSearch(): TerminalSearch {
    return new TerminalSearch(this.exports, this.mem, this.L, this);
  }

  /** Create a selection gesture: Ghostty's click, double-click and drag rules. */
  createSelectionGesture(): SelectionGesture {
    return new SelectionGesture(this.exports, this.mem, this.L, this);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private initCellPool(): void {
    const total = this._cols * this._rows;
    if (this.cellPool.length < total) {
      for (let i = this.cellPool.length; i < total; i++) {
        this.cellPool.push({
          codepoint: 0,
          fg_r: 204,
          fg_g: 204,
          fg_b: 204,
          bg_r: 0,
          bg_g: 0,
          bg_b: 0,
          flags: 0,
          width: 1,
          hyperlink_id: 0,
          grapheme_len: 0,
        });
      }
    }
  }

  /** Read the grapheme codepoints at a grid point. */
  private graphemeAt(tag: number, x: number, y: number): number[] | null {
    const ex = this.exports;
    const refPtr = this.scratch.at('ref');
    const countPtr = this.scratch.at('refOut');
    if (!this.gridRef(tag, x, y, refPtr)) return null;
    const cap = GRAPHEME_SCRATCH_SIZE / 4;
    const buf = this.scratch.at('graphemes');
    let result = ex.ghostty_grid_ref_graphemes(refPtr, buf, cap, countPtr);
    if (result === GHOSTTY_SUCCESS) {
      const count = this.mem.view().getUint32(countPtr, true);
      return Array.from(new Uint32Array(this.mem.bytes().slice(buf, buf + count * 4).buffer));
    }
    if (result !== GHOSTTY_OUT_OF_SPACE) return null;
    const needed = this.mem.view().getUint32(countPtr, true);
    const big = ex.ghostty_wasm_alloc(needed * 4);
    try {
      result = ex.ghostty_grid_ref_graphemes(refPtr, big, needed, countPtr);
      if (result !== GHOSTTY_SUCCESS) return null;
      const count = this.mem.view().getUint32(countPtr, true);
      return Array.from(new Uint32Array(this.mem.bytes().slice(big, big + count * 4).buffer));
    } finally {
      ex.ghostty_wasm_free(big, needed * 4);
    }
  }
}

/**
 * A row followed by a libghostty tracked grid reference (see
 * GhosttyTerminal.trackRow). It stays usable after its terminal is freed: it
 * then has no value. Call free() when done with it.
 */
export class TrackedRow {
  private out: number;

  constructor(
    private exports: GhosttyWasmExports,
    private mem: Memory,
    private L: Layout,
    private ref: number
  ) {
    this.out = exports.ghostty_wasm_alloc(L.coordinate.size);
  }

  /** Whether the row is still in the buffer (cheaper than reading it). */
  get alive(): boolean {
    return this.ref !== 0 && this.exports.ghostty_tracked_grid_ref_has_value(this.ref) !== 0;
  }

  /** The row's absolute screen row now, or null when it left the buffer. */
  get row(): number | null {
    if (!this.ref) return null;
    if (
      this.exports.ghostty_tracked_grid_ref_point(this.ref, PointTag.SCREEN, this.out) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    return this.mem.view().getUint32(this.out + this.L.coordinate.y, true);
  }

  free(): void {
    if (!this.ref) return;
    this.exports.ghostty_tracked_grid_ref_free(this.ref);
    this.exports.ghostty_wasm_free(this.out, this.L.coordinate.size);
    this.ref = this.out = 0;
  }
}
