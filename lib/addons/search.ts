/**
 * SearchAddon - find text in the terminal's scrollback and screen
 *
 * Follows the API of @xterm/addon-search, on top of libghostty's search:
 * results stay correct while the program keeps writing, scrollback is
 * pruned or the terminal is resized, and switching to a full-screen app and
 * back doesn't restart the search.
 *
 * Differences from xterm.js:
 * - Matching is literal text, case-insensitive for ASCII letters only. The
 *   regex, wholeWord and caseSensitive options are not supported (a warning
 *   is logged the first time one is set).
 * - findNext() moves toward older content (up from the prompt), as Ghostty's
 *   own find does; findPrevious() moves toward newer content. resultIndex
 *   counts from the top as in xterm.js, so findNext() lowers it.
 *
 * @example
 * ```typescript
 * const search = new SearchAddon();
 * term.loadAddon(search);
 * search.onDidChangeResults(({ resultIndex, resultCount }) => ...);
 * search.findNext('error', { decorations: { matchBackground: '#665500' } });
 * ```
 */

import { EventEmitter } from '../event-emitter';
import type { GhosttyTerminal, SelectionRange, TerminalSearch } from '../ghostty';
import type { IAddonTerminal, IEvent, ITerminalAddon } from '../interfaces';
import type { HighlightRange } from '../renderer';

export interface ISearchDecorationOptions {
  /** Background of every match on screen. */
  matchBackground?: string;
  /** Background of the selected match. */
  activeMatchBackground?: string;
}

export interface ISearchOptions {
  /**
   * Highlight matches. Without decorations only the selected match is shown,
   * as the terminal's selection (as in xterm.js).
   */
  decorations?: ISearchDecorationOptions;
  /**
   * Search as the user types: if the selected match still matches the new
   * term it stays selected, otherwise the nearest match in the search
   * direction from it is selected, instead of moving on.
   */
  incremental?: boolean;
  /** Not supported by libghostty's search; ignored. */
  regex?: boolean;
  /** Not supported by libghostty's search; ignored. */
  wholeWord?: boolean;
  /** Not supported (ASCII letters always match either case); ignored. */
  caseSensitive?: boolean;
}

export interface ISearchResultChangeEvent {
  /** Index of the selected match counted from the top (0 = oldest), or -1 when none. */
  resultIndex: number;
  /** Number of matches. */
  resultCount: number;
}

const UNSUPPORTED_OPTIONS = ['regex', 'wholeWord', 'caseSensitive'] as const;

/** Whether position a comes before position b in reading order. */
function before(aRow: number, aCol: number, bRow: number, bCol: number): boolean {
  return aRow < bRow || (aRow === bRow && aCol < bCol);
}

export class SearchAddon implements ITerminalAddon {
  private terminal?: IAddonTerminal;
  private search?: TerminalSearch;
  /** The WASM terminal the search was made for (Terminal.reset() replaces it). */
  private searchTerm?: GhosttyTerminal;
  private decorations?: ISearchDecorationOptions;
  private resultsEmitter = new EventEmitter<ISearchResultChangeEvent>();
  private warnedUnsupported = false;

  /** Fires after each search with the selected match and the match count. */
  public readonly onDidChangeResults: IEvent<ISearchResultChangeEvent> = this.resultsEmitter.event;

  activate(terminal: IAddonTerminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.clearDecorations();
    this.dropSearch();
    this.resultsEmitter.dispose();
    this.terminal = undefined;
  }

  /** Select the next (older) match for `term`. Returns whether one was found. */
  findNext(term: string, options?: ISearchOptions): boolean {
    return this.find(term, options ?? {}, 'next');
  }

  /** Select the previous (newer) match for `term`. Returns whether one was found. */
  findPrevious(term: string, options?: ISearchOptions): boolean {
    return this.find(term, options ?? {}, 'previous');
  }

  /** Remove all match highlights and end the search. */
  clearDecorations(): void {
    this.setHighlights(undefined);
    this.search?.setNeedle('');
  }

  /** Remove the selected-match highlight (the terminal selection). */
  clearActiveDecoration(): void {
    this.terminal?.clearSelection();
  }

  private setHighlights(provider: (() => HighlightRange[]) | undefined): void {
    this.terminal?.setHighlightProvider(provider);
  }

  private dropSearch(): void {
    // A search may outlive its terminal; freeing it then releases only itself.
    this.search?.dispose();
    this.search = undefined;
    this.searchTerm = undefined;
  }

  /** The search for the current WASM terminal, made on first use. */
  private getSearch(): TerminalSearch | undefined {
    const wasmTerm = this.terminal?.wasmTerm;
    if (!wasmTerm) return undefined;
    if (this.searchTerm !== wasmTerm) {
      this.dropSearch();
      this.search = wasmTerm.createSearch();
      this.searchTerm = wasmTerm;
    }
    return this.search;
  }

  private find(text: string, options: ISearchOptions, direction: 'next' | 'previous'): boolean {
    const terminal = this.terminal;
    const search = this.getSearch();
    if (!terminal || !search) return false;
    if (!text) {
      this.clearDecorations();
      this.fireResults(search, false);
      return false;
    }

    this.warnUnsupported(options);
    const sameNeedle = search.getNeedle().toLowerCase() === text.toLowerCase();
    const previous = options.incremental && !sameNeedle ? search.selectedMatch() : null;
    search.setNeedle(text);
    // Counts and positions below need every match, not just those found so far.
    search.run();

    let found: boolean;
    if (options.incremental && sameNeedle && search.selectedIndex >= 0) {
      // The same term re-submitted while typing: keep the selected match.
      found = true;
    } else if (previous) {
      found = this.selectNear(search, previous.startRow, previous.startCol, direction);
    } else {
      found = direction === 'next' ? search.next() : search.previous();
    }

    if (found) {
      search.selectMatchAsSelection();
      // libghostty scrolled its viewport to the match; follow it.
      terminal.scrollToViewportOffset(terminal.wasmTerm!.getViewportOffset());
    }

    this.decorations = options.decorations;
    this.setHighlights(this.decorations ? () => this.highlights() : undefined);
    this.fireResults(search, found);
    return found;
  }

  /** Warn once about options libghostty's search can't honor. */
  private warnUnsupported(options: ISearchOptions): void {
    if (this.warnedUnsupported) return;
    const used = UNSUPPORTED_OPTIONS.filter((name) => options[name]);
    if (used.length === 0) return;
    this.warnedUnsupported = true;
    console.warn(
      `SearchAddon: ${used.join(', ')} not supported; matching is literal and ASCII case-insensitive.`
    );
  }

  /**
   * Select the match starting at (row, col), or else the nearest one from
   * there in the search direction (or, without one, in the other direction).
   * libghostty only steps through matches, newest first, so walk up from the
   * newest to the first match that does not start after (row, col).
   */
  private selectNear(
    search: TerminalSearch,
    row: number,
    col: number,
    direction: 'next' | 'previous'
  ): boolean {
    if (!search.next()) return false;
    const last = search.totalMatches - 1;
    let match = search.selectedMatch();
    while (
      match &&
      before(row, col, match.startRow, match.startCol) &&
      search.selectedIndex < last
    ) {
      search.next();
      match = search.selectedMatch();
    }
    if (
      match &&
      direction === 'previous' &&
      before(match.startRow, match.startCol, row, col) &&
      search.selectedIndex > 0
    ) {
      search.previous();
    }
    return true;
  }

  private fireResults(search: TerminalSearch, found: boolean): void {
    // libghostty numbers matches from the newest; xterm.js from the top.
    const count = search.totalMatches;
    const index = search.selectedIndex;
    this.resultsEmitter.fire({
      resultIndex: found && index >= 0 ? count - 1 - index : -1,
      resultCount: count,
    });
  }

  /** Match highlights in viewport rows, for the renderer. */
  private highlights(): HighlightRange[] {
    const terminal = this.terminal;
    const search = this.search;
    const wasmTerm = terminal?.wasmTerm;
    if (!terminal || !search || !wasmTerm || this.searchTerm !== wasmTerm) return [];

    const match = this.decorations?.matchBackground;
    const active = this.decorations?.activeMatchBackground ?? match;
    if (!match && !active) return [];

    const selected = search.selectedMatch();
    const top = wasmTerm.getScrollbackLength() - Math.max(0, Math.floor(terminal.getViewportY()));
    const out: HighlightRange[] = [];
    for (const m of search.viewportMatches()) {
      const isActive = selected !== null && sameRange(m, selected);
      const color = isActive ? active : match;
      if (!color) continue;
      for (let screenRow = m.startRow; screenRow <= m.endRow; screenRow++) {
        const row = screenRow - top;
        if (row < 0 || row >= terminal.rows) continue;
        out.push({
          row,
          start: screenRow === m.startRow ? m.startCol : 0,
          end: screenRow === m.endRow ? m.endCol : terminal.cols - 1,
          color,
          active: isActive,
        });
      }
    }
    return out;
  }
}

function sameRange(a: SelectionRange, b: SelectionRange): boolean {
  return (
    a.startRow === b.startRow &&
    a.startCol === b.startCol &&
    a.endRow === b.endRow &&
    a.endCol === b.endCol
  );
}
