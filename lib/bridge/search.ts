/**
 * libghostty-vt's search over the scrollback and screen.
 */

import type { GhosttyWasmExports } from '../types';
import { GHOSTTY_SUCCESS, type SelectionRange } from './abi-constants';
import type { Layout } from './layout';
import { type Memory, Scratch } from './memory';
import type { GhosttyTerminal } from './terminal';

/** @internal GhosttySearchOption. */
export const SearchOpt = { NEEDLE: 1 } as const;
/** @internal GhosttySearchData. */
export const SearchData = {
  STATUS: 1,
  TOTAL_MATCHES: 3,
  SELECTED_INDEX: 4,
  SELECTED_MATCH: 5,
  VIEWPORT_MATCHES: 7,
} as const;

/**
 * A search for literal text over a terminal's scrollback and screen, using
 * libghostty's search. Matching is byte-exact except that ASCII letters
 * compare case-insensitively. Results stay valid as the terminal changes
 * (new output, pruning, resize). "Next" moves toward older content.
 */
export class TerminalSearch {
  private search = 0;
  private scratch: Scratch<'needle' | 'value' | 'selection' | 'matches'>;
  private needle = '';

  constructor(
    private exports: GhosttyWasmExports,
    private mem: Memory,
    private L: Layout,
    private term: GhosttyTerminal
  ) {
    const ex = exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      if (ex.ghostty_search_new(0, slot, term.handle) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create search');
      }
      this.search = ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    this.scratch = new Scratch(ex, {
      needle: L.string.size,
      value: 8,
      selection: L.selection.size,
      matches: L.selectionBuffer.size,
    });
  }

  /** Set what to search for; '' clears the search. Same text keeps results. */
  setNeedle(text: string): void {
    const ex = this.exports;
    this.needle = text;
    if (!text) {
      ex.ghostty_search_set(this.search, SearchOpt.NEEDLE, 0);
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const ptr = ex.ghostty_wasm_alloc(bytes.length);
    this.mem.bytes().set(bytes, ptr);
    const str = this.scratch.at('needle');
    const view = this.mem.view();
    view.setUint32(str, ptr, true);
    view.setUint32(str + 4, bytes.length, true);
    ex.ghostty_search_set(this.search, SearchOpt.NEEDLE, str);
    ex.ghostty_wasm_free(ptr, bytes.length);
  }

  getNeedle(): string {
    return this.needle;
  }

  /** Bring the search up to date with the terminal (blocking). */
  run(): void {
    if (this.needle) this.exports.ghostty_search_run(this.search);
  }

  /** Select the next (older) match. Returns false when there is none. */
  next(): boolean {
    if (!this.needle) return false;
    // Selecting a match can scroll the viewport.
    this.term.invalidate();
    return this.exports.ghostty_search_select_next(this.search) === GHOSTTY_SUCCESS;
  }

  /** Select the previous (newer) match. Returns false when there is none. */
  previous(): boolean {
    if (!this.needle) return false;
    this.term.invalidate();
    return this.exports.ghostty_search_select_prev(this.search) === GHOSTTY_SUCCESS;
  }

  private getU32(data: number): number | null {
    const out = this.scratch.at('value');
    if (this.exports.ghostty_search_get(this.search, data, out) !== GHOSTTY_SUCCESS) return null;
    return this.mem.view().getUint32(out, true);
  }

  /** Matches found so far on the active screen. */
  get totalMatches(): number {
    return this.getU32(SearchData.TOTAL_MATCHES) ?? 0;
  }

  /** Index of the selected match, 0 being the newest; -1 when none. */
  get selectedIndex(): number {
    return this.getU32(SearchData.SELECTED_INDEX) ?? -1;
  }

  /** The selected match in absolute screen rows, or null. */
  selectedMatch(): SelectionRange | null {
    const sel = this.scratch.at('selection');
    if (
      this.exports.ghostty_search_get(this.search, SearchData.SELECTED_MATCH, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    return this.term.selectionRangeAt(sel);
  }

  /** Make the selected match the terminal's selection. */
  selectMatchAsSelection(): boolean {
    const sel = this.scratch.at('selection');
    if (
      this.exports.ghostty_search_get(this.search, SearchData.SELECTED_MATCH, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return false;
    }
    return this.term.installSelection(sel);
  }

  /**
   * Matches on and around the viewport, in absolute screen rows, for drawing
   * highlights. Reflects the terminal as of the last feed, so this feeds first.
   */
  viewportMatches(): SelectionRange[] {
    const ex = this.exports;
    if (!this.needle) return [];
    ex.ghostty_search_feed(this.search);
    // A first call with no buffer reports how many matches there are.
    const B = this.L.selectionBuffer;
    const selectionSize = this.L.selection.size;
    const buf = this.scratch.at('matches');
    this.mem.bytes().fill(0, buf, buf + B.size);
    ex.ghostty_search_get(this.search, SearchData.VIEWPORT_MATCHES, buf);
    const count = this.mem.view().getUint32(buf + B.len, true);
    if (count === 0) return [];
    const bytes = count * selectionSize;
    const arr = ex.ghostty_wasm_alloc(bytes);
    try {
      const v = this.mem.view();
      v.setUint32(buf + B.ptr, arr, true);
      v.setUint32(buf + B.cap, count, true);
      if (
        ex.ghostty_search_get(this.search, SearchData.VIEWPORT_MATCHES, buf) !== GHOSTTY_SUCCESS
      ) {
        return [];
      }
      const written = this.mem.view().getUint32(buf + B.len, true);
      const out: SelectionRange[] = [];
      for (let i = 0; i < Math.min(written, count); i++) {
        const range = this.term.selectionRangeAt(arr + i * selectionSize);
        if (range) out.push(range);
      }
      return out;
    } finally {
      ex.ghostty_wasm_free(arr, bytes);
    }
  }

  dispose(): void {
    if (this.search) this.exports.ghostty_search_free(this.search);
    this.scratch.free();
    this.search = 0;
  }
}
