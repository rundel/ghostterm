import { beforeEach, describe, expect, test } from 'bun:test';
import type { GhosttyTerminal } from '../ghostty';
import { DEFAULT_THEME } from '../renderer';
import type { Terminal } from '../terminal';
import { drawnText, internals, paintedRects, render, terminalFixture } from '../test-helpers';
import { SearchAddon } from './search';

const fixture = terminalFixture();
let term: Terminal;
let wasm: GhosttyTerminal;
let search: SearchAddon;

beforeEach(() => {
  term = fixture.open({ cols: 30, rows: 4 }).term;
  wasm = internals(term).wasmTerm;
  search = new SearchAddon();
  term.loadAddon(search);
  for (let i = 0; i < 10; i++) term.write(`item ${i} Needle\r\n`);
  term.write('$ ');
});

/** Start row of the selection (an absolute row); fails without one. */
function selectedRow(): number {
  const range = term.wasmTerm?.getSelectionRange();
  if (!range) throw new Error('no selection');
  return range.startRow;
}

/** Columns painted in `color`, by viewport row. */
function paintedCells(color: string): Record<number, number[]> {
  const w = internals(term).renderer.charWidth;
  const h = internals(term).renderer.charHeight;
  const cells: Record<number, number[]> = {};
  for (const r of paintedRects(term, color)) {
    const row = r.y / h;
    cells[row] = [...(cells[row] ?? []), r.x / w];
  }
  return cells;
}

describe('SearchAddon', () => {
  test('findNext selects matches from newest to oldest, case-insensitively', () => {
    const results: { resultIndex: number; resultCount: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    expect(search.findNext('needle')).toBe(true);
    expect(term.getSelection()).toBe('Needle');
    // resultIndex counts from the top, as in xterm.js.
    expect(results.at(-1)).toEqual({ resultIndex: 9, resultCount: 10 });

    search.findNext('needle');
    expect(results.at(-1)).toEqual({ resultIndex: 8, resultCount: 10 });
    search.findPrevious('needle');
    expect(results.at(-1)).toEqual({ resultIndex: 9, resultCount: 10 });
  });

  test('findPrevious starts at the oldest match', () => {
    const results: { resultIndex: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    search.findPrevious('needle');
    expect(results.at(-1)?.resultIndex).toBe(0);
    expect(selectedRow()).toBe(0);
  });

  test('counts every match, not just those found before the first one is selected', () => {
    let lines = '';
    for (let i = 0; i < 5000; i++) lines += `more ${i} needle\r\n`;
    term.write(lines);
    const results: { resultIndex: number; resultCount: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    search.findNext('needle');
    expect(results.at(-1)).toEqual({ resultIndex: 5009, resultCount: 5010 });
  });

  test('scrolls the view to a match in scrollback', () => {
    for (let i = 0; i < 6; i++) search.findNext('needle');
    expect(term.getViewportY()).toBeGreaterThan(0);
    expect(term.getViewportY()).toBe(wasm.getViewportOffset());
    // The selected match ('item 4 Needle') is drawn on screen.
    const row = drawnText(term).find((t) => t.text === 'N' && t.col === 7);
    const rowText = drawnText(term)
      .filter((t) => t.row === row?.row)
      .map((t) => t.text)
      .join('');
    expect(rowText).toBe('item4Needle');
    expect(term.getSelection()).toBe('Needle');
    expect(selectedRow()).toBe(4);
  });

  test('no match', () => {
    const results: { resultIndex: number; resultCount: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    expect(search.findNext('absent')).toBe(false);
    expect(results.at(-1)).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  test('an empty term ends the search and reports no results', () => {
    search.findNext('needle', { decorations: { matchBackground: '#444400' } });
    const results: { resultIndex: number; resultCount: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    expect(search.findNext('')).toBe(false);
    expect(results).toEqual([{ resultIndex: -1, resultCount: 0 }]);
    expect(paintedRects(term, '#444400')).toEqual([]);
  });

  test('clearActiveDecoration() clears the selected match', () => {
    search.findNext('needle');
    expect(term.hasSelection()).toBe(true);
    search.clearActiveDecoration();
    expect(term.hasSelection()).toBe(false);
  });

  test('incremental search keeps the selected match while the term is resubmitted', () => {
    search.findNext('needle', { incremental: true });
    search.findNext('needle', { incremental: true });
    const results: { resultIndex: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    search.findNext('needle', { incremental: true });
    expect(results.at(-1)?.resultIndex).toBe(9);
  });

  test('incremental search keeps the selected match while the term grows', () => {
    search.findNext('item');
    search.findNext('item');
    search.findNext('item');
    const start = selectedRow();
    expect(term.getSelection()).toBe('item');

    search.findNext('item 7', { incremental: true });
    expect(term.getSelection()).toBe('item 7');
    expect(selectedRow()).toEqual(start);
  });

  test('incremental search moves on from a match that no longer matches', () => {
    search.findNext('item 5');
    const row5 = selectedRow();

    // findNext looks for the nearest older match, findPrevious the nearest newer one.
    search.findNext('item 4', { incremental: true });
    expect(term.getSelection()).toBe('item 4');
    expect(selectedRow()).toBe(row5 - 1);

    search.findPrevious('item 5');
    search.findPrevious('item 6', { incremental: true });
    expect(term.getSelection()).toBe('item 6');
    expect(selectedRow()).toBe(row5 + 1);

    // Without an older match, the nearest newer one.
    search.findNext('item 0');
    search.findNext('item 1', { incremental: true });
    expect(term.getSelection()).toBe('item 1');
  });

  test('decorations highlight every match on screen, the active one differently', () => {
    search.findNext('needle', {
      decorations: { matchBackground: '#444400', activeMatchBackground: '#ff8800' },
    });
    // Rows: item 7, item 8, item 9 (the active match), '$ '; 'Needle' is columns 7-12.
    const needle = [7, 8, 9, 10, 11, 12];
    expect(paintedCells('#444400')).toEqual({ 0: needle, 1: needle });
    expect(paintedCells('#ff8800')).toEqual({ 2: needle });

    search.clearDecorations();
    const calls = render(term);
    expect(paintedRects(calls, '#444400')).toEqual([]);
    expect(paintedRects(calls, '#ff8800')).toEqual([]);
  });

  test('keeps working after reset()', () => {
    search.findNext('needle');
    term.reset();
    term.write('fresh needle\r\n');
    expect(search.findNext('needle')).toBe(true);
    expect(term.getSelection()).toBe('needle');
  });
});

describe('SearchAddon active match', () => {
  test('the active match color wins over the selection, with normal text color', () => {
    search.findNext('needle', {
      decorations: { matchBackground: '#444400', activeMatchBackground: '#ff8800' },
    });
    expect(term.getSelection()).toBe('Needle');
    const calls = render(term);
    expect(paintedRects(calls, '#ff8800')).toHaveLength(6);
    expect(paintedRects(calls, DEFAULT_THEME.selectionBackground)).toEqual([]);
    // Text in the active match (row 2) keeps its normal color.
    const matchText = drawnText(term, calls).filter((t) => t.row === 2 && t.col >= 7);
    expect(matchText.map((t) => t.text).join('')).toBe('Needle');
    for (const t of matchText) expect(t.fillStyle).toBe('rgb(212, 212, 212)');
  });
});

describe('SearchAddon options', () => {
  /** Every result event while running `fn`. */
  function results(fn: () => void): { resultIndex: number; resultCount: number }[] {
    const seen: { resultIndex: number; resultCount: number }[] = [];
    const sub = search.onDidChangeResults((r) => seen.push(r));
    fn();
    sub.dispose();
    return seen;
  }

  test('caseSensitive matches letters in their case only', () => {
    expect(search.findNext('needle', { caseSensitive: true })).toBe(false);
    expect(
      results(() => expect(search.findNext('Needle', { caseSensitive: true })).toBe(true))
    ).toEqual([{ resultIndex: 9, resultCount: 10 }]);
    expect(term.getSelection()).toBe('Needle');
  });

  test('without caseSensitive the text search ignores case beyond ASCII', () => {
    term.write('\r\nÉcole école ÉCOLE');
    const [r] = results(() => search.findNext('école', { wholeWord: true }));
    expect(r).toEqual({ resultIndex: 2, resultCount: 3 });
    expect(term.getSelection()).toBe('ÉCOLE');
  });

  test('regex matches a regular expression', () => {
    const [r] = results(() => search.findNext('item [3-5] N', { regex: true }));
    expect(r).toEqual({ resultIndex: 2, resultCount: 3 });
    expect(term.getSelection()).toBe('item 5 N');
    search.findNext('item [3-5] N', { regex: true });
    expect(term.getSelection()).toBe('item 4 N');
  });

  test('an invalid regex finds nothing instead of throwing', () => {
    const [r] = results(() => expect(search.findNext('(', { regex: true })).toBe(false));
    expect(r).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  test('a regex skips empty matches', () => {
    const [r] = results(() => search.findNext('x*', { regex: true }));
    expect(r).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  test('wholeWord needs a non-word character or the line edge on both sides', () => {
    term.write('\r\ncat concat cat-dog cats');
    const [r] = results(() => search.findNext('cat', { wholeWord: true }));
    expect(r.resultCount).toBe(2);
    expect(term.getSelectionPosition()?.start.x).toBe(11);
    search.findNext('cat', { wholeWord: true });
    expect(term.getSelectionPosition()?.start.x).toBe(0);
  });

  test('matches map to the cells of wide characters', () => {
    term.write('\r\n日本 needle');
    search.findNext('need', { caseSensitive: true });
    expect(term.getSelection()).toBe('need');
    const pos = term.getSelectionPosition()!;
    // Each of 日 and 本 takes two cells; the end column is exclusive.
    expect([pos.start.x, pos.end.x]).toEqual([5, 9]);
  });

  test('a match can span soft-wrapped rows', () => {
    term.write(`\r\n${'x'.repeat(26)}wrapped`);
    search.findNext('wrapped', { caseSensitive: true });
    expect(term.getSelection()).toBe('wrapped');
    const pos = term.getSelectionPosition()!;
    expect(pos.end.y).toBe(pos.start.y + 1);
  });

  test('findNext and findPrevious step through the matches and wrap around', () => {
    const indexes = results(() => {
      for (let i = 0; i < 11; i++) search.findNext('Needle', { caseSensitive: true });
      search.findPrevious('Needle', { caseSensitive: true });
    }).map((r) => r.resultIndex);
    expect(indexes).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 0]);
    const [r] = results(() => {
      search.clearDecorations();
      search.findPrevious('Needle', { caseSensitive: true });
    }).slice(-1);
    expect(r.resultIndex).toBe(0);
    expect(selectedRow()).toBe(0);
  });

  test('scrolls to a match in scrollback', () => {
    search.findPrevious('item 0', { caseSensitive: true });
    expect(term.getViewportY()).toBe(term.buffer.active.baseY);
    expect(selectedRow()).toBe(0);
  });

  test('incremental search keeps or stays near the selected match', () => {
    const o = { caseSensitive: true, incremental: true };
    search.findNext('item 5', { caseSensitive: true });
    const row5 = selectedRow();
    search.findNext('item 5', o);
    expect(selectedRow()).toBe(row5);
    search.findNext('item 5 N', o);
    expect(selectedRow()).toBe(row5);
    search.findNext('item 4', o);
    expect(selectedRow()).toBe(row5 - 1);
    search.findPrevious('item 6', o);
    expect(selectedRow()).toBe(row5 + 1);
  });

  test('a later search finds output written since', () => {
    search.findNext('Needle', { caseSensitive: true });
    term.write('\r\nitem 10 Needle');
    const [r] = results(() => search.findPrevious('Needle', { caseSensitive: true }));
    expect(r.resultCount).toBe(11);
  });

  test('decorations highlight the matches on screen, the selected one differently', () => {
    search.findNext('Needle', {
      caseSensitive: true,
      decorations: { matchBackground: '#444400', activeMatchBackground: '#ff8800' },
    });
    const needle = [7, 8, 9, 10, 11, 12];
    expect(paintedCells('#444400')).toEqual({ 0: needle, 1: needle });
    expect(paintedCells('#ff8800')).toEqual({ 2: needle });
    search.clearDecorations();
    expect(paintedRects(term, '#444400')).toEqual([]);
  });

  test('switching back to a plain search uses libghostty again', () => {
    search.findNext('Needle', { regex: true });
    const [r] = results(() => search.findNext('needle'));
    expect(r).toEqual({ resultIndex: 9, resultCount: 10 });
    expect(term.getSelection()).toBe('Needle');
  });
});
