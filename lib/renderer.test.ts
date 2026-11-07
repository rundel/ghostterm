/**
 * Tests for Canvas Renderer
 *
 * There is no real drawing under happy-dom: drawing tests replace methods of
 * the renderer's 2D context and inspect the calls.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_THEME } from './renderer';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('CanvasRenderer', () => {
  describe('Default Theme', () => {
    test('has all required ANSI colors', () => {
      expect(DEFAULT_THEME.black).toBe('#000000');
      expect(DEFAULT_THEME.red).toBe('#cd3131');
      expect(DEFAULT_THEME.green).toBe('#0dbc79');
      expect(DEFAULT_THEME.yellow).toBe('#e5e510');
      expect(DEFAULT_THEME.blue).toBe('#2472c8');
      expect(DEFAULT_THEME.magenta).toBe('#bc3fbc');
      expect(DEFAULT_THEME.cyan).toBe('#11a8cd');
      expect(DEFAULT_THEME.white).toBe('#e5e5e5');
    });

    test('has all bright ANSI colors', () => {
      expect(DEFAULT_THEME.brightBlack).toBe('#666666');
      expect(DEFAULT_THEME.brightRed).toBe('#f14c4c');
      expect(DEFAULT_THEME.brightGreen).toBe('#23d18b');
      expect(DEFAULT_THEME.brightYellow).toBe('#f5f543');
      expect(DEFAULT_THEME.brightBlue).toBe('#3b8eea');
      expect(DEFAULT_THEME.brightMagenta).toBe('#d670d6');
      expect(DEFAULT_THEME.brightCyan).toBe('#29b8db');
      expect(DEFAULT_THEME.brightWhite).toBe('#ffffff');
    });

    test('has foreground and background colors', () => {
      expect(DEFAULT_THEME.foreground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.background).toBe('#1e1e1e');
    });

    test('has cursor colors', () => {
      expect(DEFAULT_THEME.cursor).toBe('#ffffff');
      expect(DEFAULT_THEME.cursorAccent).toBe('#1e1e1e');
    });

    test('has selection colors', () => {
      // Selection colors are now solid (not semi-transparent overlay)
      // Ghostty-style: selection bg = foreground color, selection fg = background color
      expect(DEFAULT_THEME.selectionBackground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.selectionForeground).toBe('#1e1e1e');
    });
  });

  describe('Theme Color Format', () => {
    test('all colors are valid hex strings', () => {
      const hexPattern = /^#[0-9a-f]{6}$/i;

      expect(DEFAULT_THEME.black).toMatch(hexPattern);
      expect(DEFAULT_THEME.foreground).toMatch(hexPattern);
      expect(DEFAULT_THEME.background).toMatch(hexPattern);
      expect(DEFAULT_THEME.cursor).toMatch(hexPattern);
    });
  });
});

describe('CanvasRenderer drawing', () => {
  let term: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 20, rows: 5 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  /** Render one frame, recording which rows were repainted and what was filled. */
  function frame(force = false) {
    const renderer = (term as any).renderer;
    const ctx = renderer.ctx;
    const rows = new Set<number>();
    const fills: Array<{ style: string; x: number; y: number; w: number; h: number }> = [];
    const orig = { clearRect: ctx.clearRect, fillRect: ctx.fillRect };
    ctx.clearRect = (x: number, y: number, w: number, _h: number) => {
      if (x === 0 && w === term.cols * renderer.charWidth) rows.add(y / renderer.charHeight);
    };
    ctx.fillRect = (x: number, y: number, w: number, h: number) => {
      fills.push({ style: String(ctx.fillStyle), x, y, w, h });
    };
    try {
      renderer.render(term.wasmTerm, force, term.viewportY, 0);
    } finally {
      Object.assign(ctx, orig);
    }
    return { rows, fills, cursorColor: renderer.cursorColor as string };
  }

  test('a fractional device pixel ratio does not resize the canvas every frame', () => {
    const renderer = (term as any).renderer;
    renderer.setDevicePixelRatio(1.25);
    const canvas: HTMLCanvasElement = renderer.getCanvas();
    const cssWidth = Number.parseFloat(canvas.style.width);
    expect(canvas.width).toBe(Math.round(cssWidth * 1.25));
    frame(true);
    let resizes = 0;
    const resize = renderer.resize;
    renderer.resize = (...args: unknown[]) => {
      resizes++;
      return resize.apply(renderer, args);
    };
    try {
      for (let i = 0; i < 3; i++) expect(frame().rows.size).toBe(0);
    } finally {
      renderer.resize = resize;
    }
    expect(resizes).toBe(0);
  });

  test('hiding the cursor repaints its row', () => {
    term.write('abc');
    const first = frame(true);
    expect(first.fills.some((f) => f.style === first.cursorColor)).toBe(true);
    term.write('\x1b[?25l');
    const next = frame();
    expect(next.rows.has(0)).toBe(true);
    expect(next.fills.some((f) => f.style === next.cursorColor)).toBe(false);
    // Nothing changed since: the row is left alone.
    expect(frame().rows.size).toBe(0);
  });

  test('changing the cursor shape or color without moving repaints its row', () => {
    term.write('abc');
    frame(true);
    term.write('\x1b[6 q');
    expect(frame().rows.has(0)).toBe(true);
    term.write('\x1b]12;#ff0000\x07');
    const recolored = frame();
    expect(recolored.rows.has(0)).toBe(true);
    expect(recolored.cursorColor).toBe('rgb(255, 0, 0)');
  });

  test('a block cursor on a wide character covers both cells', () => {
    term.write('漢\x1b[1G');
    const { fills, cursorColor } = frame(true);
    const renderer = (term as any).renderer;
    const cursor = fills.find((f) => f.style === cursorColor);
    expect(cursor?.w).toBe(2 * renderer.charWidth);
  });

  test('a theme change after the first frames repaints with the new colors', () => {
    term.write('x');
    frame(true);
    frame();
    term.options.theme = { background: '#ffffff', foreground: '#000000', cursor: '#ff0000' };
    // The option change redraws at once; check that frame's colors held.
    expect((term as any).renderer.background).toBe('#ffffff');
    const changed = frame(true);
    expect(changed.fills.some((f) => f.style === '#ffffff' && f.x === 0 && f.y === 0)).toBe(true);
    expect(changed.cursorColor).toBe('rgb(255, 0, 0)');

    term.options.theme = {};
    expect((term as any).renderer.background).toBe('#1e1e1e');
    const back = frame(true);
    expect(back.fills.some((f) => f.style === '#1e1e1e' && f.x === 0 && f.y === 0)).toBe(true);
    expect(back.cursorColor).toBe('rgb(255, 255, 255)');
  });

  test('cells with the default background use the color a program set (OSC 11)', () => {
    term.write('x');
    term.write('\x1b]11;#102030\x07');
    const { fills } = frame();
    expect(fills.some((f) => f.style === 'rgb(16, 32, 48)' && f.x === 0 && f.y === 0)).toBe(true);
  });
});
