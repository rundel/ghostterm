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
 *   regex, wholeWord and caseSensitive options are not supported.
 * - findNext() moves toward older content (up from the prompt), as Ghostty's
 *   own find does; findPrevious() moves toward newer content.
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
import type { IEvent, ITerminalAddon, ITerminalCore } from '../interfaces';
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
   * Search as the user types: repeating the same term keeps the selected
   * match instead of moving on.
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
  /** Index of the selected match (0 = newest), or -1 when none. */
  resultIndex: number;
  /** Number of matches. */
  resultCount: number;
}

/** What the addon uses from the Terminal. */
interface SearchableTerminal extends ITerminalCore {
  wasmTerm?: GhosttyTerminal;
  getViewportY(): number;
  scrollToLine(line: number): void;
  clearSelection(): void;
}

export class SearchAddon implements ITerminalAddon {
  private terminal?: SearchableTerminal;
  private search?: TerminalSearch;
  /** The WASM terminal the search was made for (Terminal.reset() replaces it). */
  private searchTerm?: GhosttyTerminal;
  private decorations?: ISearchDecorationOptions;
  private resultsEmitter = new EventEmitter<ISearchResultChangeEvent>();

  /** Fires after each search with the selected match and the match count. */
  public readonly onDidChangeResults: IEvent<ISearchResultChangeEvent> = this.resultsEmitter.event;

  activate(terminal: ITerminalCore): void {
    this.terminal = terminal as SearchableTerminal;
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

  private renderer(): { setHighlightProvider(p?: () => HighlightRange[]): void } | undefined {
    return (this.terminal as any)?.renderer;
  }

  private setHighlights(provider: (() => HighlightRange[]) | undefined): void {
    this.renderer()?.setHighlightProvider(provider);
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

    const sameNeedle = search.getNeedle().toLowerCase() === text.toLowerCase();
    search.setNeedle(text);

    // Incremental search re-submits the same term while typing: keep the
    // selected match rather than moving on.
    let found: boolean;
    if (options.incremental && sameNeedle && search.selectedIndex >= 0) {
      found = true;
    } else {
      found = direction === 'next' ? search.next() : search.previous();
    }

    if (found) {
      search.selectMatchAsSelection();
      // libghostty scrolled its viewport to the match; follow it.
      terminal.scrollToLine(terminal.wasmTerm!.getViewportOffset());
    }

    this.decorations = options.decorations;
    this.setHighlights(this.decorations ? () => this.highlights() : undefined);
    this.fireResults(search, found);
    return found;
  }

  private fireResults(search: TerminalSearch, found: boolean): void {
    this.resultsEmitter.fire({
      resultIndex: found ? search.selectedIndex : -1,
      resultCount: search.totalMatches,
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
