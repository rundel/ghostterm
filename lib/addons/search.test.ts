import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
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

  test('warns once about the unsupported regex, wholeWord and caseSensitive options', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      search.findNext('needle', { regex: true, caseSensitive: true });
      search.findNext('needle', { wholeWord: true });
      search.findNext('needle');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('regex, caseSensitive');
    } finally {
      warn.mockRestore();
    }
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
