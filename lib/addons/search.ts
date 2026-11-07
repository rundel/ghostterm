/**
 * SearchAddon - find text in the terminal's scrollback and screen
 *
 * Follows the API of @xterm/addon-search. Plain searches use libghostty's
 * search: literal text, case-insensitive for ASCII letters, with results that
 * stay correct while the program keeps writing, scrollback is pruned or the
 * terminal is resized. libghostty's search has no regular expressions, whole
 * words or case-sensitive matching, so a search with `regex`, `wholeWord` or
 * `caseSensitive` set runs over the buffer text instead (each logical line,
 * soft-wrapped rows joined), as xterm.js's addon does: its matches are found
 * when findNext()/findPrevious() is called, so output written afterwards is
 * searched by the next call.
 *
 * Differences from xterm.js:
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

import { BufferLine } from '../buffer';
import { EventEmitter } from '../event-emitter';
import type { GhosttyTerminal, SelectionRange, TerminalSearch } from '../ghostty';
import type { IAddonTerminal, IEvent, ITerminalAddon, ITerminalCore } from '../interfaces';
import { lineText } from '../line-text';
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
  /** The term is a JavaScript regular expression (an invalid one matches nothing). */
  regex?: boolean;
  /** Only matches with a non-word character (or the line's edge) on each side. */
  wholeWord?: boolean;
  /** Letters must match in case (otherwise any case matches, not just ASCII). */
  caseSensitive?: boolean;
}

export interface ISearchResultChangeEvent {
  /** Index of the selected match counted from the top (0 = oldest), or -1 when none. */
  resultIndex: number;
  /** Number of matches. */
  resultCount: number;
}

/** Characters that end a word for wholeWord, as in @xterm/addon-search. */
const NON_WORD_CHARACTERS = ' ~!@#$%^&*()+`-=[]{}|\\;:"\',./<>?';

/** Whether position a comes before position b in reading order. */
function before(aRow: number, aCol: number, bRow: number, bCol: number): boolean {
  return aRow < bRow || (aRow === bRow && aCol < bCol);
}

/** A search over the buffer text (regex, wholeWord or caseSensitive). */
interface TextSearch {
  /** The term and the options that decide what matches. */
  key: string;
  /** Every match, top to bottom, in absolute rows. */
  matches: SelectionRange[];
  /** Index of the selected match in `matches`, or -1. */
  selected: number;
}

export class SearchAddon implements ITerminalAddon {
  private terminal?: IAddonTerminal;
  private search?: TerminalSearch;
  private textSearch?: TextSearch;
  private decorations?: ISearchDecorationOptions;
  private resultsEmitter = new EventEmitter<ISearchResultChangeEvent>();

  /** Fires after each search with the selected match and the match count. */
  public readonly onDidChangeResults: IEvent<ISearchResultChangeEvent> = this.resultsEmitter.event;

  /** Called by Terminal.loadAddon; needs a ghostterm Terminal (it uses internal methods). */
  activate(terminal: ITerminalCore): void {
    this.terminal = terminal as IAddonTerminal;
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
    this.textSearch = undefined;
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
  }

  /** The terminal's libghostty search, made on first use (once the terminal is open). */
  private getSearch(): TerminalSearch | undefined {
    const wasmTerm = this.terminal?.wasmTerm;
    if (!wasmTerm) return undefined;
    this.search ??= wasmTerm.createSearch();
    return this.search;
  }

  private find(text: string, options: ISearchOptions, direction: 'next' | 'previous'): boolean {
    const terminal = this.terminal;
    const search = this.getSearch();
    if (!terminal || !search) return false;
    if (!text) {
      this.clearDecorations();
      this.fireResults(-1, 0);
      return false;
    }
    if (options.regex || options.wholeWord || options.caseSensitive) {
      search.setNeedle('');
      return this.findText(text, options, direction);
    }
    this.textSearch = undefined;

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
    // libghostty numbers matches from the newest; xterm.js from the top.
    const count = search.totalMatches;
    const index = search.selectedIndex;
    this.fireResults(found && index >= 0 ? count - 1 - index : -1, count);
    return found;
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

  /**
   * A search over the buffer text, with the libghostty search's stepping:
   * findNext() moves to the older match and findPrevious() to the newer one,
   * both wrapping around, and incremental searches keep or stay near the
   * selected match.
   */
  private findText(text: string, options: ISearchOptions, direction: 'next' | 'previous'): boolean {
    const terminal = this.terminal!;
    const wasmTerm = terminal.wasmTerm!;
    const key = JSON.stringify([
      options.caseSensitive ? text : text.toLowerCase(),
      !!options.regex,
      !!options.wholeWord,
      !!options.caseSensitive,
    ]);
    const prev = this.textSearch;
    const prevMatch = prev && prev.selected >= 0 ? prev.matches[prev.selected] : null;
    const matches = findMatches(wasmTerm, text, options);
    const count = matches.length;

    let selected = -1;
    if (count > 0) {
      const at = prevMatch ? matches.findIndex((m) => sameRange(m, prevMatch)) : -1;
      if (prevMatch && options.incremental) {
        // Keep the selected match if it still matches, else the nearest one.
        selected = prev!.key === key && at >= 0 ? at : nearest(matches, prevMatch, direction);
      } else if (prevMatch && prev!.key === key) {
        const from = at >= 0 ? at : nearest(matches, prevMatch, direction);
        selected =
          at < 0 ? from : direction === 'next' ? (from - 1 + count) % count : (from + 1) % count;
      } else {
        selected = direction === 'next' ? count - 1 : 0;
      }
    }
    this.textSearch = { key, matches, selected };

    if (selected >= 0) {
      const m = matches[selected];
      wasmTerm.setSelectionRange(m.startCol, m.startRow, m.endCol, m.endRow);
      this.scrollIntoView(m);
    }
    this.decorations = options.decorations;
    this.setHighlights(this.decorations ? () => this.highlights() : undefined);
    this.fireResults(selected, count);
    return selected >= 0;
  }

  /** Scroll so the match is on screen, centered when it was not. */
  private scrollIntoView(match: SelectionRange): void {
    const terminal = this.terminal!;
    const scrollback = terminal.wasmTerm!.getScrollbackLength();
    const top = scrollback - Math.max(0, Math.floor(terminal.getViewportY()));
    if (match.startRow >= top && match.endRow < top + terminal.rows) return;
    const newTop = match.startRow - Math.floor(terminal.rows / 2);
    terminal.scrollToViewportOffset(scrollback - Math.max(0, Math.min(scrollback, newTop)));
  }

  private fireResults(resultIndex: number, resultCount: number): void {
    this.resultsEmitter.fire({ resultIndex, resultCount });
  }

  /** Match highlights in viewport rows, for the renderer. */
  private highlights(): HighlightRange[] {
    const terminal = this.terminal;
    const wasmTerm = terminal?.wasmTerm;
    if (!terminal || !wasmTerm) return [];

    const match = this.decorations?.matchBackground;
    const active = this.decorations?.activeMatchBackground ?? match;
    if (!match && !active) return [];

    let onScreen: SelectionRange[];
    let selected: SelectionRange | null;
    const top = wasmTerm.getScrollbackLength() - Math.max(0, Math.floor(terminal.getViewportY()));
    const text = this.textSearch;
    if (text) {
      const bottom = top + terminal.rows - 1;
      onScreen = text.matches.filter((m) => m.endRow >= top && m.startRow <= bottom);
      selected = text.selected >= 0 ? text.matches[text.selected] : null;
    } else {
      const search = this.search;
      if (!search) return [];
      onScreen = search.viewportMatches();
      selected = search.selectedMatch();
    }

    const out: HighlightRange[] = [];
    for (const m of onScreen) {
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

/**
 * The match to select near `from` (no longer among the matches): the last one
 * not starting after it for findNext(), the first one not starting before it
 * for findPrevious(), and the nearest in the other direction without one.
 * The libghostty path's selectNear() picks the same match.
 */
function nearest(
  matches: SelectionRange[],
  from: SelectionRange,
  direction: 'next' | 'previous'
): number {
  let j = -1;
  for (let i = 0; i < matches.length; i++) {
    if (before(from.startRow, from.startCol, matches[i].startRow, matches[i].startCol)) break;
    j = i;
  }
  if (j < 0) return 0;
  const m = matches[j];
  const startsBefore = before(m.startRow, m.startCol, from.startRow, from.startCol);
  if (direction === 'previous' && startsBefore && j < matches.length - 1) return j + 1;
  return j;
}

/**
 * Every match of `term` in the active screen and its scrollback, top to
 * bottom, by the rules of @xterm/addon-search: each logical line is searched
 * on its own (with trailing blanks trimmed), a match may start at any column
 * after the previous match's start, and empty regex matches are skipped.
 */
function findMatches(
  wasmTerm: GhosttyTerminal,
  term: string,
  options: ISearchOptions
): SelectionRange[] {
  // Case-insensitive literals go through a regex too, so the text keeps its
  // length (lowercasing can change it) and indices stay those of the cells.
  let regex: RegExp | undefined;
  const source = options.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.regex || !options.caseSensitive) {
    try {
      regex = new RegExp(source, options.caseSensitive ? 'g' : 'gi');
    } catch {
      return [];
    }
  }
  const total = wasmTerm.getScrollbackLength() + wasmTerm.rows;
  const cols = wasmTerm.cols;
  const read = (y: number) => {
    const cells = wasmTerm.getScreenLine(y) ?? [];
    return { y, line: new BufferLine(cells, wasmTerm.isScreenRowWrapped(y), cols) };
  };

  const matches: SelectionRange[] = [];
  let y = 0;
  while (y < total) {
    const rows = [read(y++)];
    while (y < total && wasmTerm.isScreenRowWrapped(y)) rows.push(read(y++));
    const { text, startCell, endCell } = lineText(rows, true);
    if (!text) continue;

    for (let from = 0; from < text.length; ) {
      let index: number;
      let length: number;
      if (regex) {
        regex.lastIndex = from;
        const found = regex.exec(text);
        if (!found) break;
        index = found.index;
        length = found[0].length;
        if (length === 0) {
          from = index + 1;
          continue;
        }
      } else {
        index = text.indexOf(term, from);
        if (index < 0) break;
        length = term.length;
      }
      from = index + 1;
      if (options.wholeWord && !isWholeWord(text, index, length)) continue;
      const start = startCell[index];
      const end = endCell[index + length - 1];
      matches.push({
        startRow: start.y,
        startCol: start.x,
        endRow: end.y,
        endCol: end.x,
        rectangle: false,
      });
    }
  }
  return matches;
}

function isWholeWord(line: string, index: number, length: number): boolean {
  const boundary = (i: number) =>
    i < 0 || i >= line.length || NON_WORD_CHARACTERS.includes(line[i]);
  return boundary(index - 1) && boundary(index + length);
}
