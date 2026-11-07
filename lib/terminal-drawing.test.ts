/**
 * What a Terminal draws for program output: selection,
 * cell backgrounds and the screen restored after the alternate screen.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { drawnText, internals, paintedRects, render, terminalFixture } from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;

beforeEach(() => {
  term = fixture.open({ cols: 40, rows: 10 }).term;
});

/** Colors of cell-sized fills on viewport row `row`, by column. */
function cellBackgrounds(row = 0): Map<number, string> {
  const { renderer } = internals(term);
  const w = renderer.charWidth;
  const h = renderer.charHeight;
  const painted = new Map<number, string>();
  for (const r of paintedRects(term)) {
    if (r.y === row * h && r.h === h && Math.abs(r.w - w) < 0.5) {
      painted.set(Math.round(r.x / w), r.fillStyle);
    }
  }
  return painted;
}

describe('selection', () => {
  test('selected cells are painted with the selection background', () => {
    term.write('select me please');
    term.select(7, 0, 2);
    const selected = [...cellBackgrounds()].filter(([, c]) => c === '#d4d4d4').map(([x]) => x);
    expect(selected).toEqual([7, 8]);
  });
});

describe('cell backgrounds', () => {
  test('an explicit black background is painted (on a light theme)', () => {
    term.options.theme = { background: '#fdf6e3', foreground: '#586e75', black: '#000000' };
    term.write('\x1b[40mX\x1b[0mY\x1b[48;2;0;0;0mZ\x1b[0m');
    const line = term.buffer.active.getLine(0);
    expect([0, 1, 2].map((x) => line?.getCell(x)?.isBgDefault())).toEqual([false, true, false]);
    const painted = cellBackgrounds();
    expect(painted.get(0)).toBe('rgb(0, 0, 0)');
    expect(painted.has(1)).toBe(false); // default: the theme background shows
    expect(painted.get(2)).toBe('rgb(0, 0, 0)');
  });

  test('default cells stay unpainted on a black theme too', () => {
    term.options.theme = { background: '#000000' };
    term.write('ab');
    const painted = cellBackgrounds();
    // (column 2 holds the cursor block)
    expect([painted.has(0), painted.has(1)]).toEqual([false, false]);
  });

  test('leaving a colored alternate screen restores default backgrounds', () => {
    const blue = 'rgb(36, 114, 200)'; // the theme's blue (#2472c8)
    term.write('MAIN\r\n');
    term.write('\x1b[?1049h\x1b[H\x1b[44m');
    for (let y = 0; y < term.rows; y++) term.write(' '.repeat(term.cols));
    expect(paintedRects(term, blue).length).toBeGreaterThan(0);

    term.write('\x1b[?1049l');
    const first = term.buffer.active.getLine(0)?.getCell(0);
    expect(first?.getChars()).toBe('M');
    expect(first?.isBgDefault()).toBe(true);
    expect(paintedRects(render(term), blue)).toEqual([]);
    expect(cellBackgrounds().size).toBe(0);
  });
});

describe('synchronized output', () => {
  test('the cursor stays with the held frame until the update ends', () => {
    const { renderer } = internals(term);
    const cursorAt = () =>
      paintedRects(term, 'rgb(255, 255, 255)')
        .filter((r) => r.h === renderer.charHeight)
        .map((r) => [Math.round(r.x / renderer.charWidth), Math.round(r.y / renderer.charHeight)]);
    term.write('ab');
    expect(cursorAt()).toEqual([[2, 0]]);
    term.write('\x1b[?2026h\x1b[2J\x1b[3;1Hlonger text');
    expect(cursorAt()).toEqual([[2, 0]]);
    term.write('\x1b[?2026l');
    expect(cursorAt()).toEqual([[11, 2]]);
  });
});

describe('refresh()', () => {
  test('redraws the rows on the next frame and reports them through onRender', () => {
    term.write('hello');
    render(term);
    // Nothing changed: an ordinary frame draws nothing.
    expect(drawnText(term, render(term, false))).toEqual([]);

    const rendered: Array<{ start: number; end: number }> = [];
    term.onRender((r) => rendered.push(r));
    term.refresh(0, 0);
    const text = drawnText(term, render(term, false));
    expect(text.map((t) => t.text).join('')).toBe('hello');
    expect(rendered).toEqual([{ start: 0, end: 9 }]);
    // Only once.
    expect(drawnText(term, render(term, false))).toEqual([]);
  });

  test('ignores rows outside the viewport', () => {
    term.write('hello');
    render(term);
    term.refresh(20, 30);
    expect(drawnText(term, render(term, false))).toEqual([]);
  });

  test('does nothing before open()', () => {
    expect(() => fixture.create().refresh(0, 1)).not.toThrow();
  });
});
