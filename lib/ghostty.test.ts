/**
 * Tests for the libghostty-vt bridge itself, against the official WASM module.
 *
 * These cover the parts of lib/ghostty.ts that talk to the C ABI directly:
 * write_pty replies, cell decoding, colors, grid access and key encoding.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { Ghostty, KeyEncoderOption } from './ghostty';
import { Key, KeyAction, Mods } from './types';

let ghostty: Ghostty;

beforeAll(async () => {
  ghostty = await Ghostty.load();
});

const text = (codepoints: number[]) =>
  codepoints.map((cp) => (cp ? String.fromCodePoint(cp) : ' ')).join('');

describe('Ghostty module', () => {
  test('reports the libghostty-vt version from the type manifest', () => {
    expect(ghostty.version).toMatch(/^1\./);
  });
});

describe('terminal replies (write_pty)', () => {
  test('answers a cursor position report', () => {
    const term = ghostty.createTerminal(80, 24);
    try {
      term.write('abc\x1b[6n');
      expect(term.hasResponse()).toBe(true);
      expect(term.readResponse()).toBe('\x1b[1;4R');
      expect(term.readResponse()).toBeNull();
    } finally {
      term.free();
    }
  });

  test('answers primary device attributes with the library default', () => {
    const term = ghostty.createTerminal(80, 24);
    try {
      term.write('\x1b[c');
      expect(term.readResponse()).toBe('\x1b[?62;22c');
    } finally {
      term.free();
    }
  });

  test('routes replies to the terminal that produced them', () => {
    const a = ghostty.createTerminal(80, 24);
    const b = ghostty.createTerminal(80, 24);
    try {
      b.write('\r\n\r\n\x1b[6n');
      expect(a.readResponse()).toBeNull();
      expect(b.readResponse()).toBe('\x1b[3;1R');
    } finally {
      a.free();
      b.free();
    }
  });
});

describe('viewport cells', () => {
  test('decodes codepoints, colors and style flags', () => {
    const term = ghostty.createTerminal(20, 5);
    try {
      term.write('\x1b[1;38;2;10;20;30mA\x1b[0m\x1b[7;44mB\x1b[0m C');
      const row = term.getLine(0)!;
      expect(text(row.slice(0, 4).map((c) => c.codepoint))).toBe('AB C');

      expect([row[0].fg_r, row[0].fg_g, row[0].fg_b]).toEqual([10, 20, 30]);
      expect(row[0].flags & 1).toBe(1); // bold
      expect(row[1].flags & (1 << 4)).toBe(1 << 4); // inverse
      expect(row[3].flags).toBe(0);

      // Palette blue as background, default background elsewhere.
      const { background } = term.getColors();
      expect([row[1].bg_r, row[1].bg_g, row[1].bg_b]).not.toEqual([
        background.r,
        background.g,
        background.b,
      ]);
      expect([row[3].bg_r, row[3].bg_g, row[3].bg_b]).toEqual([
        background.r,
        background.g,
        background.b,
      ]);
    } finally {
      term.free();
    }
  });

  test('marks wide characters and their spacer cells', () => {
    const term = ghostty.createTerminal(20, 5);
    try {
      term.write('中x');
      const row = term.getLine(0)!;
      expect(row[0].codepoint).toBe('中'.codePointAt(0)!);
      expect(row[0].width).toBe(2);
      expect(row[1].width).toBe(0);
      expect(row[2].codepoint).toBe('x'.codePointAt(0)!);
      expect(row[2].width).toBe(1);
    } finally {
      term.free();
    }
  });

  test('keeps grapheme clusters together', () => {
    const term = ghostty.createTerminal(20, 5);
    const family = '👨‍👩‍👧';
    try {
      term.write(family);
      const row = term.getLine(0)!;
      expect(row[0].grapheme_len).toBeGreaterThan(0);
      expect(term.getGraphemeString(0, 0)).toBe(family);
    } finally {
      term.free();
    }
  });

  test('only re-reads rows that changed', () => {
    const term = ghostty.createTerminal(20, 5);
    try {
      term.write('one\r\ntwo');
      term.update();
      term.getViewport();
      term.markClean();

      term.write('\r\n\r\nfour');
      term.update();
      expect(term.isRowDirty(0)).toBe(false);
      expect(term.isRowDirty(3)).toBe(true);
      const cells = term.getViewport();
      expect(text(cells.slice(0, 3).map((c) => c.codepoint))).toBe('one');
      expect(text(cells.slice(60, 64).map((c) => c.codepoint))).toBe('four');
    } finally {
      term.free();
    }
  });
});

describe('theme configuration', () => {
  test('applies default colors and palette overrides', () => {
    const palette = new Array(16).fill(0);
    palette[1] = 0x112233;
    const term = ghostty.createTerminal(20, 5, {
      fgColor: 0xaabbcc,
      bgColor: 0x010203,
      palette,
    });
    try {
      term.write('\x1b[31mR\x1b[0mD');
      const row = term.getLine(0)!;
      expect([row[0].fg_r, row[0].fg_g, row[0].fg_b]).toEqual([0x11, 0x22, 0x33]);
      expect([row[1].fg_r, row[1].fg_g, row[1].fg_b]).toEqual([0xaa, 0xbb, 0xcc]);
      expect(term.getColors().background).toEqual({ r: 1, g: 2, b: 3 });
    } finally {
      term.free();
    }
  });
});

describe('grid access', () => {
  test('reads scrollback lines with their colors', () => {
    const term = ghostty.createTerminal(20, 3);
    try {
      term.write('\x1b[32mgreen\x1b[0m\r\n');
      for (let i = 0; i < 5; i++) term.write(`line ${i}\r\n`);
      expect(term.getScrollbackLength()).toBe(4);

      const first = term.getScrollbackLine(0)!;
      expect(text(first.slice(0, 5).map((c) => c.codepoint))).toBe('green');
      const fg = term.getColors().foreground;
      expect([first[0].fg_r, first[0].fg_g, first[0].fg_b]).not.toEqual([fg.r, fg.g, fg.b]);
      expect(term.getScrollbackLine(99)).toBeNull();
    } finally {
      term.free();
    }
  });

  test('finds OSC 8 hyperlinks in the viewport and scrollback', () => {
    const term = ghostty.createTerminal(30, 3);
    try {
      term.write('\x1b]8;;https://ghostty.org\x1b\\link\x1b]8;;\x1b\\ plain');
      expect(term.getLine(0)![0].hyperlink_id).toBeGreaterThan(0);
      expect(term.getHyperlinkUri(0, 0)).toBe('https://ghostty.org');
      expect(term.getHyperlinkUri(0, 6)).toBeNull();

      term.write('\r\n\r\n\r\n');
      expect(term.getScrollbackHyperlinkUri(0, 1)).toBe('https://ghostty.org');
    } finally {
      term.free();
    }
  });

  test('reports soft-wrapped continuation rows', () => {
    const term = ghostty.createTerminal(10, 5);
    try {
      term.write('0123456789abc\r\nnext');
      expect(term.isRowWrapped(0)).toBe(false);
      expect(term.isRowWrapped(1)).toBe(true);
      expect(term.isRowWrapped(2)).toBe(false);
    } finally {
      term.free();
    }
  });

  test('queries modes and the alternate screen', () => {
    const term = ghostty.createTerminal(20, 5);
    try {
      expect(term.hasBracketedPaste()).toBe(false);
      term.write('\x1b[?2004h\x1b[?1049h\x1b[?1000h');
      expect(term.hasBracketedPaste()).toBe(true);
      expect(term.isAlternateScreen()).toBe(true);
      expect(term.hasMouseTracking()).toBe(true);
      expect(term.getMode(20, true)).toBe(false); // ANSI linefeed mode
    } finally {
      term.free();
    }
  });
});

describe('key encoder', () => {
  const press = (key: Key, mods = Mods.NONE, utf8?: string) => ({
    action: KeyAction.PRESS,
    key,
    mods,
    utf8,
  });
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  test('encodes arrows in normal and application cursor mode', () => {
    const encoder = ghostty.createKeyEncoder();
    try {
      expect(decode(encoder.encode(press(Key.UP)))).toBe('\x1b[A');
      encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
      expect(decode(encoder.encode(press(Key.UP)))).toBe('\x1bOA');
    } finally {
      encoder.dispose();
    }
  });

  test('encodes control and function keys', () => {
    const encoder = ghostty.createKeyEncoder();
    try {
      expect(Array.from(encoder.encode(press(Key.A, Mods.CTRL, 'a')))).toEqual([0x01]);
      expect(decode(encoder.encode(press(Key.F1)))).toBe('\x1bOP');
      expect(decode(encoder.encode(press(Key.PAGE_UP)))).toBe('\x1b[5~');
    } finally {
      encoder.dispose();
    }
  });
});
