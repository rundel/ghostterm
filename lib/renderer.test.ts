/**
 * CanvasRenderer: what a frame draws, read from the recording canvas
 * (happydom.ts): text and its attributes, decorations, the cursor, which rows
 * a frame repaints, colors, and link hover underlines.
 */

import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Terminal } from './terminal';
import {
  type DrawCall,
  drawnText,
  internals,
  mouseEvent,
  paintedRects,
  render,
  strokes,
  terminalFixture,
} from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;
let container: HTMLElement;

beforeEach(() => {
  ({ term, container } = fixture.open({ cols: 20, rows: 5 }));
});

const cell = () => {
  const { renderer } = internals(term);
  return { w: renderer.charWidth, h: renderer.charHeight };
};

/** Viewport rows a frame repainted (each repaint starts by clearing the whole row). */
function repaintedRows(calls: DrawCall[]): number[] {
  const { w, h } = cell();
  return calls
    .filter((c) => c.op === 'clearRect' && c.args[0] === 0 && c.args[2] === term.cols * w)
    .map((c) => Number(c.args[1]) / h);
}

const CURSOR = 'rgb(255, 255, 255)';

/** Rectangles painted in the cursor color, in cells. */
function cursorRects(calls: DrawCall[], color = CURSOR) {
  const { w, h } = cell();
  return paintedRects(calls, color).map((r) => ({ x: r.x / w, y: r.y / h, w: r.w, h: r.h }));
}

describe('text attributes', () => {
  test('text is drawn per cell in its foreground color, bold and italic in the font', () => {
    term.write('a\x1b[31mb\x1b[1mc\x1b[0;3md\x1b[0m\r\n');
    expect(drawnText(term).map((t) => [t.text, t.col, t.row, t.fillStyle, t.font])).toEqual([
      ['a', 0, 0, 'rgb(212, 212, 212)', '15px monospace'],
      ['b', 1, 0, 'rgb(205, 49, 49)', '15px monospace'],
      ['c', 2, 0, 'rgb(205, 49, 49)', 'bold 15px monospace'],
      ['d', 3, 0, 'rgb(212, 212, 212)', 'italic 15px monospace'],
    ]);
  });

  test('SGR 7 inverse swaps foreground and background', () => {
    term.write('\x1b[31;42;7mX\x1b[0m\x1b[7mY\x1b[0m\r\n');
    const calls = render(term);
    const { w } = cell();
    const bgs = paintedRects(calls).filter((r) => r.y === 0 && r.w === w);
    expect(bgs.map((r) => [r.x / w, r.fillStyle])).toEqual([
      [0, 'rgb(205, 49, 49)'],
      [1, 'rgb(212, 212, 212)'],
    ]);
    expect(drawnText(term, calls).map((t) => t.fillStyle)).toEqual([
      'rgb(13, 188, 121)',
      'rgb(30, 30, 30)',
    ]);
  });

  test('SGR 2 faint text is drawn at half alpha, and only that text', () => {
    term.write('\x1b[2mf\x1b[0mn\r\n');
    expect(drawnText(term).map((t) => [t.text, t.globalAlpha])).toEqual([
      ['f', 0.5],
      ['n', 1],
    ]);
  });

  test('SGR 8 invisible text is not drawn', () => {
    term.write('\x1b[8mhidden\x1b[0mv\r\n');
    expect(drawnText(term).map((t) => t.text)).toEqual(['v']);
  });

  test('wide characters and grapheme clusters are drawn whole, once', () => {
    term.write('漢👍🏽x\r\n');
    expect(drawnText(term).map((t) => [t.text, t.col])).toEqual([
      ['漢', 0],
      ['👍🏽', 2],
      ['x', 4],
    ]);
  });
});

describe('decorations', () => {
  /** Device pixel rows a horizontal line stroked at y covers (DPR 1 in these tests). */
  const rowsCovered = (y: number, width: number) => [y - width / 2, y + width / 2];

  test('SGR 9 strikethrough and SGR 53 overline are stroked across the cell on whole pixels', () => {
    const { w, h } = cell();
    term.write('\x1b[31;9ms\x1b[0m\x1b[53mo\x1b[0m\r\n');
    const strike = Math.round(h / 2 - 0.5) + 0.5;
    expect(strokes(term)).toEqual([
      {
        strokeStyle: 'rgb(205, 49, 49)',
        lineWidth: 1,
        lineDash: [],
        path: [
          ['moveTo', 0, strike],
          ['lineTo', w, strike],
        ],
      },
      {
        strokeStyle: 'rgb(212, 212, 212)',
        lineWidth: 1,
        lineDash: [],
        path: [
          ['moveTo', w, 0.5],
          ['lineTo', 2 * w, 0.5],
        ],
      },
    ]);
  });

  describe('underlines', () => {
    /** Top edge of the single underline: two pixels below the baseline. */
    const top = () => internals(term).renderer.getMetrics().baseline + 2;

    test('single underline in the text color, one whole pixel row below the baseline', () => {
      term.write('\x1b[4mu\x1b[0m\r\n');
      const [line] = strokes(term);
      expect(line).toEqual({
        strokeStyle: 'rgb(212, 212, 212)',
        lineWidth: 1,
        lineDash: [],
        path: [
          ['moveTo', 0, top() + 0.5],
          ['lineTo', cell().w, top() + 0.5],
        ],
      });
      expect(rowsCovered(top() + 0.5, line.lineWidth)).toEqual([top(), top() + 1]);
    });

    test('double underline is two lines with a gap, in the SGR 58 color, inside the cell', () => {
      const { w, h } = cell();
      term.write('\x1b[4:2;58:2::0:128:255mu\x1b[0m\r\n');
      const [line] = strokes(term);
      expect(line.strokeStyle).toBe('#0080ff');
      const [first, second] = [line.path[0][2], line.path[2][2]];
      expect(line.path).toEqual([
        ['moveTo', 0, first],
        ['lineTo', w, first],
        ['moveTo', 0, second],
        ['lineTo', w, second],
      ]);
      const [a0, a1] = rowsCovered(first, line.lineWidth);
      const [b0, b1] = rowsCovered(second, line.lineWidth);
      expect([a0 % 1, b0 % 1]).toEqual([0, 0]);
      expect(b0 - a1).toBe(line.lineWidth);
      expect(b1).toBeLessThanOrEqual(h);
    });

    test('curly underline is one wave per cell rising and falling two pixels, so neighbors join up', () => {
      const { w, h } = cell();
      term.write('\x1b[4:3;58;2;0;128;255mcu\x1b[0m\r\n');
      const drawn = strokes(term);
      expect(drawn.map((s) => s.strokeStyle)).toEqual(['#0080ff', '#0080ff']);
      const mid = drawn[1].path[0][2];
      expect(drawn[1].path).toEqual([
        ['moveTo', w, mid],
        ['quadraticCurveTo', w + w / 4, mid - 4, w + w / 2, mid],
        ['quadraticCurveTo', w + (3 * w) / 4, mid + 4, 2 * w, mid],
      ]);
      // The lowest point of the wave, with half the line width, stays in the cell.
      expect(mid + 2 + 0.5).toBeLessThanOrEqual(h);
      expect(mid).toBeGreaterThan(internals(term).renderer.getMetrics().baseline);
    });

    test.each([
      ['dotted', 4, [1, 2]],
      ['dashed', 5, [3, 2]],
    ])('%s underline is stroked with its dash pattern', (_name, style, dash) => {
      term.write(`\x1b[4:${style}mab\x1b[0m\r\n`);
      const calls = render(term);
      const drawn = strokes(calls);
      expect(drawn.map((s) => s.lineDash)).toEqual([dash, dash]);
      expect(drawn[1].path).toEqual([
        ['moveTo', cell().w, top() + 0.5],
        ['lineTo', 2 * cell().w, top() + 0.5],
      ]);
    });

    test('lines get thicker with the font and stay on whole device pixels at DPR 2', () => {
      term.options.fontSize = 32;
      internals(term).renderer.setDevicePixelRatio(2);
      term.write('\x1b[4mu\x1b[0m\x1b[4:2mu\x1b[0m\r\n');
      const [single, double] = strokes(term);
      // round(32 * 2 / 16) = 4 device pixels: 2 CSS px.
      expect(single.lineWidth).toBe(2);
      for (const y of [single.path[0][2], double.path[0][2], double.path[2][2]]) {
        expect(((y - 1) * 2) % 1).toBe(0);
      }
      expect(double.path[2][2] - double.path[0][2]).toBe(4);
    });
  });
});

describe('link hover underlines', () => {
  const LINK = '#4A90E2';

  /** Move the pointer over a cell of the terminal. */
  function hover(col: number, row: number): void {
    const { w, h } = cell();
    container.dispatchEvent(mouseEvent('mousemove', (col + 0.5) * w, (row + 0.5) * h));
  }

  /** Let the asynchronous link lookup a hover starts finish. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  /** Columns of row 0 underlined in the link color, once per stroke. */
  function underlined(): number[] {
    return strokes(term)
      .filter((s) => s.strokeStyle === LINK)
      .map((s) => s.path[0][1] / cell().w);
  }

  test('an OSC 8 hyperlink is underlined while hovered, and not after the pointer leaves', async () => {
    term.write('go \x1b]8;;https://example.com\x07here\x1b]8;;\x07 now\r\n');
    expect(underlined()).toEqual([]);
    hover(4, 0);
    await settle();
    expect(underlined()).toEqual([3, 4, 5, 6]);
    container.dispatchEvent(new MouseEvent('mouseleave'));
    expect(underlined()).toEqual([]);
  });

  test('a plain-text URL is underlined while hovered', async () => {
    term.write('see https://a.io ok\r\n');
    expect(underlined()).toEqual([]);
    hover(6, 0);
    await settle();
    expect(underlined()).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(container.style.cursor).toBe('pointer');
  });

  test('the underline goes when output replaces the link under a pointer that stays put', async () => {
    term.write('see https://a.io ok\r\n');
    hover(6, 0);
    await settle();
    expect(underlined()).toHaveLength(12);

    // A full-screen program takes over; the pointer never moves.
    term.write('\x1b[?1049h\x1b[Hplain text here');
    await settle();
    expect(underlined()).toEqual([]);
    expect(container.style.cursor).not.toBe('pointer');
  });

  test('the underline follows a hovered OSC 8 link when the pointer stays put and it moves away', async () => {
    term.write('\x1b]8;;https://example.com\x07here\x1b]8;;\x07\r\n');
    hover(1, 0);
    await settle();
    expect(underlined()).toEqual([0, 1, 2, 3]);

    term.write('\x1b[H\x1b[2Jnothing');
    await settle();
    expect(underlined()).toEqual([]);
  });
});

describe('cursor', () => {
  test.each([
    ['block', 'cursor fills the cell'],
    ['underline', 'cursor is a bar along the bottom'],
    ['bar', 'cursor is a bar at the left'],
  ] as const)('a %s %s, in the cursor color', (shape) => {
    term.options.cursorStyle = shape;
    term.write('ab');
    const { w, h } = cell();
    const [rect] = cursorRects(render(term));
    const expected = {
      block: { x: 2, y: 0, w, h },
      underline: { x: 2, y: (h - Math.max(2, Math.floor(h * 0.15))) / h, w, h: 2 },
      bar: { x: 2, y: 0, w: 2, h },
    }[shape];
    expect(rect).toEqual(expected);
  });

  test('the block cursor redraws the character under it in the accent color', () => {
    term.write('ab\x1b[D');
    const text = drawnText(term).filter((t) => t.col === 1);
    expect(text.map((t) => [t.text, t.fillStyle])).toEqual([
      ['b', 'rgb(212, 212, 212)'],
      ['b', '#1e1e1e'],
    ]);
  });

  test('programs can change the shape (DECSCUSR) and color (OSC 12)', () => {
    term.write('ab\x1b[5 q');
    expect(cursorRects(render(term))[0].w).toBe(2);
    term.write('\x1b]12;#ff0000\x07\x1b[0 q');
    const calls = render(term);
    expect(cursorRects(calls)).toEqual([]);
    expect(cursorRects(calls, 'rgb(255, 0, 0)')).toEqual([{ x: 2, y: 0, ...cell() }]);
  });

  test('moving to another row repaints the old row without it and draws it on the new', () => {
    term.write('abc');
    expect(cursorRects(render(term))).toEqual([{ x: 3, y: 0, ...cell() }]);
    term.write('\r\nx');
    const calls = render(term, false);
    expect(repaintedRows(calls)).toContain(0);
    expect(repaintedRows(calls)).toContain(1);
    expect(cursorRects(calls)).toEqual([{ x: 1, y: 1, ...cell() }]);
    expect(
      drawnText(term, calls)
        .filter((t) => t.row === 0)
        .map((t) => t.text)
    ).toEqual(['a', 'b', 'c']);
  });

  test('hiding the cursor repaints its row, and an unchanged frame repaints nothing', () => {
    term.write('abc');
    expect(cursorRects(render(term))).toHaveLength(1);
    term.write('\x1b[?25l');
    const next = render(term, false);
    expect(repaintedRows(next)).toContain(0);
    expect(cursorRects(next)).toEqual([]);
    expect(repaintedRows(render(term, false))).toEqual([]);
  });

  test('changing the cursor shape or color without moving repaints its row', () => {
    term.write('abc');
    render(term);
    term.write('\x1b[6 q');
    expect(repaintedRows(render(term, false))).toContain(0);
    term.write('\x1b]12;#ff0000\x07');
    const recolored = render(term, false);
    expect(repaintedRows(recolored)).toContain(0);
    expect(cursorRects(recolored, 'rgb(255, 0, 0)')).toHaveLength(1);
  });

  test('a block cursor on a wide character covers both cells', () => {
    term.write('漢\x1b[1G');
    expect(cursorRects(render(term))).toEqual([{ x: 0, y: 0, w: 2 * cell().w, h: cell().h }]);
  });

  test('the cursor is not drawn while scrolled up', () => {
    for (let i = 0; i < 10; i++) term.write(`${i}\r\n`);
    term.scrollLines(-2);
    expect(cursorRects(render(term))).toEqual([]);
  });

  test.each(['block', 'underline', 'bar'] as const)(
    'without focus a %s cursor is a hollow block, and focus restores it',
    (shape) => {
      term.options.cursorStyle = shape;
      term.write('ab\x1b[D');
      const { w, h } = cell();
      const focused = cursorRects(render(term));
      expect(focused).toHaveLength(1);

      // Blurring repaints the cursor's row at once with the outline: four one-pixel edges of
      // the cell and the character in its own color, not the accent.
      const { ctx } = internals(term);
      ctx.calls = [];
      term.blur();
      const calls = ctx.calls;
      expect(cursorRects(calls)).toEqual([
        { x: 1, y: 0, w, h: 1 },
        { x: 1, y: (h - 1) / h, w, h: 1 },
        { x: 1, y: 1 / h, w: 1, h: h - 2 },
        { x: 1 + (w - 1) / w, y: 1 / h, w: 1, h: h - 2 },
      ]);
      expect(drawnText(term, calls).map((t) => [t.text, t.fillStyle])).toEqual([
        ['a', 'rgb(212, 212, 212)'],
        ['b', 'rgb(212, 212, 212)'],
      ]);

      ctx.calls = [];
      term.focus();
      expect(cursorRects(ctx.calls)).toEqual(focused);
    }
  );

  test('without focus the cursor does not blink', () => {
    term.options.cursorBlink = true;
    term.blur();
    const { renderer } = internals(term);
    renderer['cursorVisible'] = false;
    expect(cursorRects(render(term))).toHaveLength(4);
  });
});

describe('colors', () => {
  /** Fill color of row 0's background (the full-width fill). */
  const rowBackground = (calls: DrawCall[]) =>
    paintedRects(calls).find((r) => r.x === 0 && r.y === 0 && r.w === term.cols * cell().w)
      ?.fillStyle;

  test('a theme change after the first frames redraws at once with the new colors', () => {
    term.write('x');
    render(term);
    render(term, false);
    const { ctx } = internals(term);
    /** The calls made while setting the theme. */
    const redraw = (theme: typeof term.options.theme) => {
      ctx.calls = [];
      term.options.theme = theme;
      return ctx.calls;
    };
    const changed = redraw({ background: '#ffffff', foreground: '#000000', cursor: '#ff0000' });
    expect(rowBackground(changed)).toBe('rgb(255, 255, 255)');
    expect(cursorRects(changed, 'rgb(255, 0, 0)')).toHaveLength(1);
    expect(drawnText(term, changed)[0].fillStyle).toBe('rgb(0, 0, 0)');

    const back = redraw({});
    expect(rowBackground(back)).toBe('rgb(30, 30, 30)');
    expect(cursorRects(back)).toHaveLength(1);
  });

  test('cells with the default background use the color a program set (OSC 11)', () => {
    term.write('x');
    render(term);
    term.write('\x1b]11;#102030\x07');
    expect(rowBackground(render(term, false))).toBe('rgb(16, 32, 48)');
  });

  test('without allowTransparency the background is drawn opaque', () => {
    for (const background of ['rgba(0, 0, 128, 0.5)', '#00008080', 'transparent']) {
      const { term: opaque } = fixture.open({ theme: { background } });
      opaque.write('x');
      const { ctx } = internals(opaque);
      // The context keeps alpha either way, so text keeps grayscale antialiasing.
      expect(ctx.attributes.alpha).toBeUndefined();
      const fills = paintedRects(render(opaque)).map((r) => r.fillStyle);
      const expected = background === 'transparent' ? 'rgb(0, 0, 0)' : 'rgb(0, 0, 128)';
      expect(fills).toContain(expected);
      expect(fills).not.toContain(background);
    }
  });

  test('with allowTransparency a background with alpha is drawn as given', () => {
    const background = 'rgba(0, 0, 128, 0.5)';
    const { term: clear } = fixture.open({ allowTransparency: true, theme: { background } });
    clear.write('x');
    const rows = paintedRects(render(clear)).filter((r) => r.x === 0 && r.w >= 20 * cell().w);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.fillStyle === background)).toBe(true);
  });
});

describe('canvas size', () => {
  test('a fractional device pixel ratio does not resize the canvas every frame', () => {
    const { renderer, canvas } = internals(term);
    renderer.setDevicePixelRatio(1.25);
    const cssWidth = Number.parseFloat(canvas.style.width);
    expect(canvas.width).toBe(Math.round(cssWidth * 1.25));
    render(term);
    const resize = spyOn(renderer, 'resize');
    try {
      for (let i = 0; i < 3; i++) expect(repaintedRows(render(term, false))).toEqual([]);
      expect(resize).not.toHaveBeenCalled();
    } finally {
      resize.mockRestore();
    }
  });
});
