import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from '../terminal';
import { createIsolatedTerminal } from '../test-helpers';
import { SearchAddon } from './search';

let container: HTMLElement;
let term: Terminal;
let search: SearchAddon;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  term = await createIsolatedTerminal({ cols: 30, rows: 4 });
  term.open(container);
  search = new SearchAddon();
  term.loadAddon(search);
  for (let i = 0; i < 10; i++) term.write(`item ${i} Needle\r\n`);
  term.write('$ ');
});

afterEach(() => {
  term.dispose();
  container.remove();
});

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
    expect(results.at(-1)!.resultIndex).toBe(0);
    expect(term.wasmTerm!.getSelectionRange()!.startRow).toBe(0);
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
    expect(term.getViewportY()).toBe(term.wasmTerm!.getViewportOffset());
    // The selected match ('item 4 Needle') is on screen.
    const rows = Array.from({ length: 4 }, (_, y) =>
      term
        .wasmTerm!.getViewportLine(y)!
        .map((c) => String.fromCodePoint(c.codepoint || 32))
        .join('')
    );
    expect(rows.some((r) => r.startsWith('item 4 Needle'))).toBe(true);
  });

  test('no match', () => {
    const results: { resultIndex: number; resultCount: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    expect(search.findNext('absent')).toBe(false);
    expect(results.at(-1)).toEqual({ resultIndex: -1, resultCount: 0 });
  });

  test('incremental search keeps the selected match while the term is resubmitted', () => {
    search.findNext('needle', { incremental: true });
    search.findNext('needle', { incremental: true });
    const results: { resultIndex: number }[] = [];
    search.onDidChangeResults((r) => results.push(r));
    search.findNext('needle', { incremental: true });
    expect(results.at(-1)!.resultIndex).toBe(9);
  });

  test('incremental search keeps the selected match while the term grows', () => {
    search.findNext('item');
    search.findNext('item');
    search.findNext('item');
    const start = term.wasmTerm!.getSelectionRange()!.startRow;
    expect(term.getSelection()).toBe('item');

    search.findNext('item 7', { incremental: true });
    expect(term.getSelection()).toBe('item 7');
    expect(term.wasmTerm!.getSelectionRange()!.startRow).toEqual(start);
  });

  test('incremental search moves on from a match that no longer matches', () => {
    const row = () => term.wasmTerm!.getSelectionRange()!.startRow;
    search.findNext('item 5');
    const row5 = row();

    // findNext looks for the nearest older match, findPrevious the nearest newer one.
    search.findNext('item 4', { incremental: true });
    expect(term.getSelection()).toBe('item 4');
    expect(row()).toBe(row5 - 1);

    search.findPrevious('item 5');
    search.findPrevious('item 6', { incremental: true });
    expect(term.getSelection()).toBe('item 6');
    expect(row()).toBe(row5 + 1);

    // Without an older match, the nearest newer one.
    search.findNext('item 0');
    search.findNext('item 1', { incremental: true });
    expect(term.getSelection()).toBe('item 1');
  });

  test('warns once about the unsupported regex, wholeWord and caseSensitive options', () => {
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      search.findNext('needle', { regex: true, caseSensitive: true });
      search.findNext('needle', { wholeWord: true });
      search.findNext('needle');
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('regex, caseSensitive');
  });

  test('decorations highlight every match on screen, the active one differently', () => {
    search.findNext('needle', {
      decorations: { matchBackground: '#444400', activeMatchBackground: '#ff8800' },
    });
    const renderer = (term as any).renderer;
    renderer.render(term.wasmTerm, true, term.viewportY);
    const rows = renderer.highlightRows as Map<
      number,
      { start: number; end: number; color: string }[]
    >;
    const all = [...rows.values()].flat();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((r) => r.start === 7 && r.end === 12)).toBe(true);
    expect(all.filter((r) => r.color === '#ff8800')).toHaveLength(1);

    search.clearDecorations();
    renderer.render(term.wasmTerm, true, term.viewportY);
    expect(renderer.highlightRows.size).toBe(0);
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
    const renderer = (term as any).renderer;
    const ctx = renderer.ctx;
    const fills: { x: number; y: number; style: string }[] = [];
    const texts: { col: number; row: number; style: string }[] = [];
    const fillRect = ctx.fillRect;
    const fillText = ctx.fillText;
    ctx.fillRect = (x: number, y: number, w: number, h: number) => {
      fills.push({ x, y, style: String(ctx.fillStyle) });
      return fillRect.call(ctx, x, y, w, h);
    };
    ctx.fillText = (t: string, x: number, y: number) => {
      texts.push({
        col: Math.floor(x / renderer.charWidth),
        row: Math.floor(y / renderer.charHeight),
        style: String(ctx.fillStyle),
      });
      return fillText.call(ctx, t, x, y);
    };
    try {
      renderer.render(term.wasmTerm, true, term.viewportY);
    } finally {
      ctx.fillRect = fillRect;
      ctx.fillText = fillText;
    }
    const selection = renderer.theme.selectionBackground;
    expect(fills.some((f) => f.style === '#ff8800')).toBe(true);
    expect(fills.some((f) => f.style === selection)).toBe(false);
    // Text in the active match (row 2, columns 7-12) keeps its normal color.
    const matchText = texts.filter((t) => t.row === 2 && t.col >= 7 && t.col <= 12);
    expect(matchText.length).toBeGreaterThan(0);
    expect(matchText.some((t) => t.style === renderer.theme.selectionForeground)).toBe(false);
  });
});
