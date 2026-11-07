/**
 * Terminal events driven by libghostty's callbacks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

let container: HTMLElement;
let term: Terminal;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  term = await createIsolatedTerminal({ cols: 40, rows: 10 });
  term.open(container);
});

afterEach(() => {
  term.dispose();
  container.remove();
});

describe('Terminal events from libghostty', () => {
  test('onTitleChange fires once per change, even across writes', () => {
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]0;first\x07\x1b]2;first\x07');
    term.write('\x1b]2;sec');
    term.write('ond\x1b\\');
    expect(titles).toEqual(['first', 'second']);
  });

  test('onBell fires for BEL but not for a BEL ending an OSC sequence', () => {
    let bells = 0;
    term.onBell(() => bells++);
    term.write('\x1b]2;title\x07');
    expect(bells).toBe(0);
    term.write('\x07');
    expect(bells).toBe(1);
  });

  test('working directory, notifications, progress and shell integration', () => {
    const log: unknown[] = [];
    term.onWorkingDirectoryChange((d) => log.push(['cwd', d]));
    term.onNotification((n) => log.push(['notify', n.title, n.body]));
    term.onProgress((p) => log.push(['progress', p.state, p.progress]));
    term.onSemanticPrompt((e) => log.push(['prompt', e.kind]));
    term.write('\x1b]7;file://host/home/me\x07');
    term.write('\x1b]777;notify;Done;All tests passed\x07');
    term.write('\x1b]9;4;1;75\x07');
    term.write('\x1b]133;A\x07');
    expect(log).toEqual([
      ['cwd', 'file://host/home/me'],
      ['notify', 'Done', 'All tests passed'],
      ['progress', 'set', 75],
      ['prompt', 'prompt-start'],
    ]);
  });

  test('OSC 52 clipboard writes', () => {
    const writes: string[] = [];
    term.onClipboardWrite(({ text }) => writes.push(text));
    term.write(`\x1b]52;c;${btoa('from the program')}\x07`);
    expect(writes).toEqual(['from the program']);
  });

  test('events keep working after reset()', () => {
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.reset();
    term.write('\x1b]2;after reset\x07');
    expect(titles).toEqual(['after reset']);
  });

  test('color scheme queries are answered from the theme', async () => {
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    term.write('\x1b[?996n');
    expect(replies).toEqual(['\x1b[?997;1n']); // default theme is dark

    const light = await createIsolatedTerminal({ theme: { background: '#fafafa' } });
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    light.open(c2);
    const lightReplies: string[] = [];
    light.onData((d) => lightReplies.push(d));
    light.write('\x1b[?996n');
    expect(lightReplies).toEqual(['\x1b[?997;2n']);
    light.dispose();
    c2.remove();
  });

  test('cell size queries report the renderer metrics', () => {
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    term.write('\x1b[16t');
    const m = (term as any).renderer.getMetrics();
    expect(replies).toEqual([`\x1b[6;${Math.round(m.height)};${Math.round(m.width)}t`]);
  });

  test('buffer.onBufferChange fires when the program switches screens', () => {
    const types: string[] = [];
    term.buffer.onBufferChange((b) => types.push(b.type));
    term.write('\x1b[?1049h');
    term.write('vim');
    term.write('\x1b[?1049l');
    expect(types).toEqual(['alternate', 'normal']);
  });

  test('onRender reports the rows drawn', async () => {
    const ranges: Array<{ start: number; end: number }> = [];
    term.onRender((r) => ranges.push(r));
    await new Promise((r) => setTimeout(r, 40));
    ranges.length = 0;
    term.write('\x1b[5;1Hhi');
    await new Promise((r) => setTimeout(r, 40));
    expect(ranges.length).toBeGreaterThan(0);
    const { start, end } = ranges[0];
    expect(start).toBeLessThanOrEqual(4);
    expect(end).toBeGreaterThanOrEqual(4);
    // Nothing changes: no more renders reported
    ranges.length = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(ranges).toEqual([]);
  });

  test('onCursorMove fires for moves along the line too', async () => {
    await new Promise((r) => setTimeout(r, 40));
    let moves = 0;
    term.onCursorMove(() => moves++);
    term.write('abc');
    await new Promise((r) => setTimeout(r, 40));
    expect(moves).toBe(1);
  });
});

describe('link hover', () => {
  test('hovering a link shows a pointer and underlines it; leaving restores both', async () => {
    term.write('see \x1b]8;;https://example.com\x07here\x1b]8;;\x07 now');
    const renderer = (term as any).renderer;
    const canvas: HTMLCanvasElement = renderer.getCanvas();
    const at = (col: number) =>
      new MouseEvent('mousemove', {
        clientX: col * renderer.charWidth + 1,
        clientY: 1,
        bubbles: true,
      });
    container.dispatchEvent(at(5));
    await new Promise((r) => setTimeout(r, 30));
    expect(canvas.style.cursor).toBe('pointer');
    expect(renderer.getHoveredHyperlinkId()).toBeGreaterThan(0);

    container.dispatchEvent(new MouseEvent('mouseleave'));
    expect(canvas.style.cursor).toBe('text');
    expect(renderer.getHoveredHyperlinkId()).toBe(0);
  });
});

describe('theme', () => {
  const firstCell = (t: Terminal) => t.wasmTerm!.getLine(0)![0];

  test('a pure black background is honored (0x000000 is a real color)', async () => {
    const t = await createIsolatedTerminal({
      theme: { background: '#000000', foreground: '#ffffff' },
    });
    const c = document.createElement('div');
    document.body.appendChild(c);
    t.open(c);
    try {
      t.write('x');
      expect(t.wasmTerm!.getColors().background).toEqual({ r: 0, g: 0, b: 0 });
      expect(t.wasmTerm!.getColors().foreground).toEqual({ r: 255, g: 255, b: 255 });
    } finally {
      t.dispose();
      c.remove();
    }
  });

  test('changing the theme after open() recolors existing text', () => {
    term.write('\x1b[31mred\x1b[0m plain');
    term.options.theme = { background: '#fdf6e3', foreground: '#657b83', red: '#dc322f' };
    const line = term.wasmTerm!.getLine(0)!;
    expect([line[0].fg_r, line[0].fg_g, line[0].fg_b]).toEqual([0xdc, 0x32, 0x2f]);
    expect([line[4].fg_r, line[4].fg_g, line[4].fg_b]).toEqual([0x65, 0x7b, 0x83]);
    expect([line[4].bg_r, line[4].bg_g, line[4].bg_b]).toEqual([0xfd, 0xf6, 0xe3]);

    // Back to the defaults
    term.options.theme = {};
    expect(firstCell(term).fg_r).not.toBe(0xdc);
  });

  test('programs asking for the colors get the defaults even without a theme', () => {
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    term.write('\x1b]10;?\x07\x1b]11;?\x07');
    expect(replies.join('')).toBe('\x1b]10;rgb:d4d4/d4d4/d4d4\x07\x1b]11;rgb:1e1e/1e1e/1e1e\x07');
    // The default background is dark
    replies.length = 0;
    term.write('\x1b[?996n');
    expect(replies).toEqual(['\x1b[?997;1n']);
  });

  test('the color scheme answer follows a theme change', () => {
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    term.options.theme = { background: '#ffffff' };
    term.write('\x1b[?996n');
    expect(replies).toEqual(['\x1b[?997;2n']);
  });
});

describe('cursor', () => {
  /** Render one frame and capture how the cursor was drawn. */
  function drawnCursor() {
    const renderer = (term as any).renderer;
    renderer.render(term.wasmTerm, true, term.viewportY);
    return {
      shape: renderer.cursorShape,
      color: renderer.cursorColor,
      blink: renderer.blinkActive,
    };
  }

  test('the configured style is the default', async () => {
    const t = await createIsolatedTerminal({ cursorStyle: 'bar', cursorBlink: true });
    const c = document.createElement('div');
    document.body.appendChild(c);
    t.open(c);
    try {
      expect(t.wasmTerm!.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    } finally {
      t.dispose();
      c.remove();
    }
  });

  test('programs can change shape and blink (DECSCUSR), and reset to the default', () => {
    expect(drawnCursor()).toMatchObject({ shape: 'block', blink: false });
    term.write('\x1b[5 q'); // blinking bar, as vim uses in insert mode
    expect(drawnCursor()).toMatchObject({ shape: 'bar', blink: true });
    term.write('\x1b[0 q');
    expect(drawnCursor()).toMatchObject({ shape: 'block', blink: false });
  });

  test('changing the option still applies while no program overrides it', () => {
    term.options.cursorStyle = 'underline';
    expect(drawnCursor().shape).toBe('underline');
  });

  test('programs can set the cursor color (OSC 12)', () => {
    term.write('\x1b]12;#ff8800\x07');
    expect(drawnCursor().color).toBe('rgb(255, 136, 0)');
  });
});

describe('underline drawing', () => {
  test('each style is drawn in the underline color', () => {
    term.write('\x1b[4:3;58;2;0;128;255mcurly\x1b[0m \x1b[4:4mdots\x1b[0m');
    const renderer = (term as any).renderer;
    const ctx = renderer.ctx;
    const strokes: string[] = [];
    const dashes: number[][] = [];
    let curves = 0;
    const orig = { stroke: ctx.stroke, setLineDash: ctx.setLineDash, quad: ctx.quadraticCurveTo };
    ctx.stroke = () => strokes.push(String(ctx.strokeStyle));
    ctx.setLineDash = (d: number[]) => dashes.push(d);
    ctx.quadraticCurveTo = () => curves++;
    try {
      renderer.render(term.wasmTerm, true, 0);
    } finally {
      Object.assign(ctx, {
        stroke: orig.stroke,
        setLineDash: orig.setLineDash,
        quadraticCurveTo: orig.quad,
      });
    }
    expect(strokes).toContain('#0080ff');
    expect(curves).toBeGreaterThanOrEqual(10); // 5 curly cells, 2 curves each
    expect(dashes).toContainEqual([1, 2]);
  });
});

describe('selection drawing', () => {
  test('selected cells are painted with the selection background', () => {
    term.write('select me please');
    (term as any).selectionManager.select(7, 0, 2);
    const renderer = (term as any).renderer;
    const ctx = renderer.ctx;
    const selectionColor = renderer.theme.selectionBackground;
    const painted: number[] = [];
    const fillRect = ctx.fillRect;
    ctx.fillRect = (x: number, y: number, w: number, h: number) => {
      if (ctx.fillStyle === selectionColor && y === 0)
        painted.push(Math.round(x / renderer.charWidth));
      return fillRect.call(ctx, x, y, w, h);
    };
    try {
      renderer.render(term.wasmTerm, true, 0);
    } finally {
      ctx.fillRect = fillRect;
    }
    expect(painted).toEqual([7, 8]);
  });
});

describe('pointer shape (OSC 22)', () => {
  test('programs can change the mouse pointer, and reset it', () => {
    const canvas: HTMLCanvasElement = (term as any).renderer.getCanvas();
    expect(canvas.style.cursor).toBe('text');
    term.write('\x1b]22;pointer\x07');
    expect(canvas.style.cursor).toBe('pointer');
    term.write('\x1b]22;crosshair\x1b\\');
    expect(canvas.style.cursor).toBe('crosshair');
    term.write('\x1b]22;\x07');
    expect(canvas.style.cursor).toBe('text');
  });
});

describe('shell integration navigation', () => {
  test('scrollToPrompt steps through prompts in both directions', async () => {
    const t = await createIsolatedTerminal({ cols: 20, rows: 3 });
    const c = document.createElement('div');
    document.body.appendChild(c);
    t.open(c);
    try {
      for (let i = 0; i < 4; i++) {
        t.write(
          `\x1b]133;A\x07$ cmd ${i}\r\n\x1b]133;C\x07out ${i}a\r\nout ${i}b\r\n\x1b]133;D;0\x07`
        );
      }
      t.write('\x1b]133;A\x07$ ');
      const top = () =>
        t
          .wasmTerm!.getViewportLine(0)!
          .map((x) => String.fromCodePoint(x.codepoint || 32))
          .join('')
          .trimEnd();
      const seen: string[] = [];
      for (let i = 0; i < 4; i++) {
        expect(t.scrollToPrompt(-1)).toBe(true);
        seen.push(top());
      }
      expect(seen).toEqual(['$ cmd 3', '$ cmd 2', '$ cmd 1', '$ cmd 0']);
      expect(t.scrollToPrompt(-1)).toBe(false); // no older prompt
      expect(t.scrollToPrompt(1)).toBe(true);
      expect(top()).toBe('$ cmd 1');
      expect(t.viewportY).toBe(t.wasmTerm!.getViewportOffset());
    } finally {
      t.dispose();
      c.remove();
    }
  });
});

describe('keyboard selection', () => {
  function key(code: string, shift = true) {
    const e = new KeyboardEvent('keydown', {
      code,
      key: code,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(e);
    return e;
  }

  test('Shift+arrows extend an existing selection', () => {
    term.write('hello world');
    term.select(0, 0, 5);
    let changes = 0;
    term.onSelectionChange(() => changes++);
    const sent: string[] = [];
    term.onData((d) => sent.push(d));

    key('ArrowRight');
    key('ArrowRight');
    expect(term.getSelection()).toBe('hello w');
    expect(changes).toBe(2);
    expect(sent).toEqual([]);
  });

  test('without a selection, Shift+arrows go to the program', () => {
    const sent: string[] = [];
    term.onData((d) => sent.push(d));
    key('ArrowRight');
    expect(sent).toEqual(['\x1b[1;2C']);
  });
});

describe('cell backgrounds', () => {
  /** Colors painted for row 0's cell backgrounds, by column. */
  function paintedBackgrounds(t: Terminal): Map<number, string> {
    const renderer = (t as any).renderer;
    const ctx = renderer.ctx;
    const painted = new Map<number, string>();
    const fillRect = ctx.fillRect;
    const w = renderer.charWidth;
    ctx.fillRect = (x: number, y: number, width: number, h: number) => {
      // Cell-sized fills on row 0 (skip the full-row clear)
      if (y === 0 && Math.abs(width - w) < 0.5)
        painted.set(Math.round(x / w), String(ctx.fillStyle));
      return fillRect.call(ctx, x, y, width, h);
    };
    try {
      renderer.render(t.wasmTerm, true, 0);
    } finally {
      ctx.fillRect = fillRect;
    }
    return painted;
  }

  test('an explicit black background is painted (on a light theme)', () => {
    term.options.theme = { background: '#fdf6e3', foreground: '#586e75', black: '#000000' };
    term.write('\x1b[40mX\x1b[0mY\x1b[48;2;0;0;0mZ\x1b[0m');
    const line = term.wasmTerm!.getLine(0)!;
    expect([line[0].bg_default, line[1].bg_default, line[2].bg_default]).toEqual([
      false,
      true,
      false,
    ]);
    const painted = paintedBackgrounds(term);
    expect(painted.get(0)).toBe('rgb(0, 0, 0)');
    expect(painted.has(1)).toBe(false); // default: the theme background shows
    expect(painted.get(2)).toBe('rgb(0, 0, 0)');
  });

  test('default cells stay unpainted on a black theme too', () => {
    term.options.theme = { background: '#000000' };
    term.write('ab');
    const painted = paintedBackgrounds(term);
    // (column 2 holds the cursor block)
    expect([painted.has(0), painted.has(1)]).toEqual([false, false]);
  });
});
