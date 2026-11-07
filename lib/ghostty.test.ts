/**
 * Tests for the libghostty-vt bridge itself, against the official WASM module.
 *
 * These cover the parts of lib/ghostty.ts that talk to the C ABI directly:
 * write_pty replies, cell decoding, colors, grid access and key encoding.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AbiLayout } from './abi';
import { FormatterExtras, Ghostty, KeyEncoderOption, SelectionAutoscroll } from './ghostty';
import { createIsolatedTerminal } from './test-helpers';
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

  test('matches the libghostty-vt version recorded in package.json and pinned for download', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const pinned = readFileSync('scripts/fetch-wasm.sh', 'utf8').match(/^VERSION="(.+)"$/m)?.[1];
    expect(pkg['libghostty-vt']).toBe(pinned);
    expect(ghostty.version).toBe(pinned);
  });

  test('loads the size-optimized build by default', () => {
    expect(ghostty.optimizeMode).toBe('release-small');
  });

  test('loads the speed-optimized build from a URL and runs a terminal on it', async () => {
    const fast = await Ghostty.load(new URL('../ghostty-vt-fast.wasm', import.meta.url));
    expect(fast.optimizeMode).toBe('release-fast');
    expect(fast.version).toBe(ghostty.version);

    const term = fast.createTerminal(20, 2);
    try {
      term.write('hello');
      expect(text(term.getLine(0)!.map((c) => c.codepoint)).trimEnd()).toBe('hello');
    } finally {
      term.free();
    }
  });
});

describe('freeing', () => {
  test('freeing a terminal twice leaves the allocator intact', () => {
    const term = ghostty.createTerminal(20, 3);
    term.free();
    term.free();
    const a = ghostty.createTerminal(20, 3);
    const b = ghostty.createTerminal(20, 3);
    try {
      expect(a.handle).not.toBe(b.handle);
      a.write('a');
      b.write('b');
      expect(a.getLine(0)![0].codepoint).toBe(0x61);
      expect(b.getLine(0)![0].codepoint).toBe(0x62);
    } finally {
      a.free();
      b.free();
    }
  });

  test('encoders, gestures and searches can be disposed twice', () => {
    const keys = ghostty.createKeyEncoder();
    const mouse = ghostty.createMouseEncoder();
    const term = ghostty.createTerminal(20, 3);
    const gesture = term.createSelectionGesture();
    const search = term.createSearch();
    for (const d of [keys, mouse, gesture, search]) {
      d.dispose();
      d.dispose();
    }
    term.free();
    const a = ghostty.createKeyEncoder();
    const b = ghostty.createKeyEncoder();
    try {
      a.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
      expect(
        new TextDecoder().decode(a.encode({ action: KeyAction.PRESS, key: Key.UP, mods: 0 }))
      ).toBe('\x1bOA');
      expect(
        new TextDecoder().decode(b.encode({ action: KeyAction.PRESS, key: Key.UP, mods: 0 }))
      ).toBe('\x1b[A');
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('terminal replies (write_pty)', () => {
  test('answers a cursor position report', () => {
    const term = ghostty.createTerminal(80, 24);
    try {
      term.write('abc\x1b[6n');
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
      expect(row[0].chars).toBe(family);
    } finally {
      term.free();
    }
  });

  test('viewport cells carry their full grapheme cluster', () => {
    const term = ghostty.createTerminal(20, 3);
    const family = '👨‍👩‍👧';
    try {
      term.write(`a${family}b`);
      const cells = term.getViewport();
      expect(cells[0].chars).toBeUndefined();
      expect(cells[1].chars).toBe(family);
      expect(cells[1].grapheme_len).toBe([...family].length - 1);
      expect(cells[3].chars).toBeUndefined();
      expect(cells[3].codepoint).toBe(0x62);

      // A pooled cell that no longer holds a cluster drops its chars.
      term.write('\x1b[H  ');
      expect(term.getViewport()[1].chars).toBeUndefined();
    } finally {
      term.free();
    }
  });

  test('reads grapheme clusters longer than 16 codepoints', () => {
    const term = ghostty.createTerminal(20, 3);
    // e followed by 30 combining marks: one cluster of 31 codepoints.
    const cluster = `e${'́'.repeat(30)}`;
    try {
      term.write(`${cluster}x`);
      expect(term.getViewport()[0].chars).toBe(cluster);
      expect(term.getViewport()[0].grapheme_len).toBe(30);
      expect(term.getScreenLine(0)![0].chars).toBe(cluster);
      expect(term.getLine(0)![0].chars).toBe(cluster);
    } finally {
      term.free();
    }
  });

  test('the renderer draws whole clusters, scrolled or not', async () => {
    const term = await createIsolatedTerminal({ cols: 20, rows: 3 });
    term.open(document.createElement('div'));
    const family = '👨‍👩‍👧';
    try {
      term.write(`${family}\r\n\r\n\r\n\r\nend`);
      const renderer = (term as any).renderer;
      const drawn: string[] = [];
      const fillText = renderer.ctx.fillText;
      renderer.ctx.fillText = (s: string) => drawn.push(s);
      try {
        renderer.render(term.wasmTerm, true, 0);
        expect(drawn).not.toContain(family);
        renderer.render(term.wasmTerm, true, 2); // the cluster's row scrolled into view
        expect(drawn).toContain(family);
      } finally {
        renderer.ctx.fillText = fillText;
      }
    } finally {
      term.dispose();
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
  const fg = (c: { fg_r: number; fg_g: number; fg_b: number }) => [c.fg_r, c.fg_g, c.fg_b];

  test('applies default colors and palette overrides', () => {
    const palette: (number | undefined)[] = [];
    palette[1] = 0x112233;
    const term = ghostty.createTerminal(20, 5);
    try {
      term.setColors({ foreground: 0xaabbcc, background: 0x010203, cursor: 0x445566, palette });
      term.write('\x1b[31mR\x1b[0mD\x1b[32mG');
      const row = term.getLine(0)!;
      expect(fg(row[0])).toEqual([0x11, 0x22, 0x33]);
      expect(fg(row[1])).toEqual([0xaa, 0xbb, 0xcc]);
      expect(term.getColors()).toEqual({
        background: { r: 1, g: 2, b: 3 },
        foreground: { r: 0xaa, g: 0xbb, b: 0xcc },
        cursor: { r: 0x44, g: 0x55, b: 0x66 },
      });

      // Unset palette entries keep the built-in palette; no palette restores it.
      const builtinGreen = fg(row[2]);
      term.setColors({});
      term.write('\r\n');
      const reset = term.getLine(0)!;
      expect(fg(reset[0])).not.toEqual([0x11, 0x22, 0x33]);
      expect(fg(reset[2])).toEqual(builtinGreen);
    } finally {
      term.free();
    }
  });

  test('theme changes apply to cells already drawn', () => {
    const term = ghostty.createTerminal(20, 5);
    try {
      term.write('\x1b[34mB');
      term.getViewport();
      term.markClean();
      term.setColors({ palette: [undefined, undefined, undefined, undefined, 0x0000aa] });
      expect(term.isRowDirty(0)).toBe(true);
      expect(fg(term.getViewport()[0])).toEqual([0, 0, 0xaa]);
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

  test('a scrollback limit of 0 keeps no history', () => {
    const term = ghostty.createTerminal(20, 3, { scrollbackLimit: 0 });
    try {
      for (let i = 0; i < 2000; i++) term.write(`line ${i}\r\n`);
      expect(term.getScrollbackLength()).toBe(0);
      expect(text(term.getLine(0)!.map((c) => c.codepoint)).trimEnd()).toBe('line 1998');
    } finally {
      term.free();
    }
  });

  test('the scrollback limit counts lines, not bytes', () => {
    const term = ghostty.createTerminal(80, 3, { scrollbackLimit: 5000 });
    try {
      // Far more than libghostty's default 10,000-byte history cap.
      for (let i = 0; i < 3000; i++) term.write(`${'x'.repeat(70)} ${i}\r\n`);
      expect(term.getScrollbackLength()).toBeGreaterThan(2900);
    } finally {
      term.free();
    }
  });

  test('finds OSC 8 hyperlinks in the viewport and scrollback', () => {
    const term = ghostty.createTerminal(30, 3);
    try {
      term.write('\x1b]8;;https://ghostty.org\x1b\\link\x1b]8;;\x1b\\ plain');
      expect(term.getLine(0)![0].hyperlink_id).toBeGreaterThan(0);
      expect(term.getScreenHyperlinkUri(0, 0)).toBe('https://ghostty.org');
      expect(term.getScreenHyperlinkUri(0, 6)).toBeNull();

      term.write('\r\n\r\n\r\n');
      expect(term.getScreenHyperlinkUri(0, 1)).toBe('https://ghostty.org');
    } finally {
      term.free();
    }
  });

  test('cells of one link share an ID; IDs are never reused and the table is bounded', () => {
    const term = ghostty.createTerminal(40, 3);
    const link = (uri: string, label: string) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
    try {
      term.write(`${link('https://a.example', 'aa')} ${link('https://b.example', 'bb')}`);
      const row = term.getLine(0)!;
      expect(row[0].hyperlink_id).toBe(row[1].hyperlink_id);
      expect(row[3].hyperlink_id).not.toBe(row[0].hyperlink_id);
      expect(row[2].hyperlink_id).toBe(0);

      const seen = new Set<number>();
      for (let i = 0; i < 5000; i++) {
        term.write(`\x1b[H${link(`https://example.com/${i}`, 'x')}`);
        const id = term.getLine(0)![0].hyperlink_id;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      expect((term as any).linkIds.size).toBeLessThanOrEqual(4096);
    } finally {
      term.free();
    }
  });

  test('reports soft-wrapped continuation rows', () => {
    const term = ghostty.createTerminal(10, 5);
    try {
      term.write('0123456789abc\r\nnext');
      expect(term.isScreenRowWrapped(0)).toBe(false);
      expect(term.isScreenRowWrapped(1)).toBe(true);
      expect(term.isScreenRowWrapped(2)).toBe(false);
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

describe('library-owned viewport', () => {
  const rowText = (cells: { codepoint: number }[] | null) =>
    cells ? text(cells.map((c) => c.codepoint)).trimEnd() : null;

  function filled() {
    const term = ghostty.createTerminal(20, 3);
    for (let i = 0; i < 10; i++) term.write(`line ${i}\r\n`);
    term.write('prompt');
    return term;
  }

  test('shows scrollback rows in the viewport when scrolled', () => {
    const term = filled();
    try {
      // Active area: "line 8", "line 9", "prompt"; 8 rows of history.
      expect(term.getScrollbackLength()).toBe(8);
      expect(rowText(term.getViewportLine(0))).toBe('line 8');

      term.setViewportOffset(2);
      expect(term.getViewportOffset()).toBe(2);
      expect(rowText(term.getViewportLine(0))).toBe('line 6');
      expect(rowText(term.getViewportLine(2))).toBe('line 8');

      term.setViewportOffset(0);
      expect(rowText(term.getViewportLine(2))).toBe('prompt');
    } finally {
      term.free();
    }
  });

  test('clamps the offset to the scrollback length', () => {
    const term = filled();
    try {
      term.setViewportOffset(1000);
      expect(term.getViewportOffset()).toBe(8);
      expect(rowText(term.getViewportLine(0))).toBe('line 0');
    } finally {
      term.free();
    }
  });

  test('active-area accessors ignore the scroll position', () => {
    const term = filled();
    try {
      term.setViewportOffset(5);
      expect(rowText(term.getLine(2))).toBe('prompt');
      const cursor = term.getCursor();
      expect([cursor.x, cursor.y]).toEqual([6, 2]);
      expect(cursor.viewportY).toBe(-1); // scrolled out of view
      expect(term.getLine(2)![0].codepoint).toBe(0x70);
      expect(term.getViewportLine(0)![5].codepoint).toBe(0x33);
    } finally {
      term.free();
    }
  });

  test('getLine reads the same cells pinned and scrolled', () => {
    const term = filled();
    const family = '👨‍👩‍👧';
    try {
      term.write(
        `\r\n\x1b[1;31mred\x1b[0m \x1b]8;;https://ghostty.org\x1b\\link\x1b]8;;\x1b\\ ${family}`
      );
      const pinned = term.getLine(2)!;
      term.setViewportOffset(4);
      const scrolled = term.getLine(2)!;
      expect(scrolled).toEqual(pinned);
      expect(pinned[0].flags & 1).toBe(1); // bold
      expect(pinned[4].hyperlink_id).toBeGreaterThan(0);
      expect(pinned[9].chars).toBe(family);

      // At the bottom it is what the viewport shows, apart from the selection flag.
      term.setViewportOffset(0);
      const shown = term.getViewportLine(2)!.map(({ selected: _, ...c }) => c);
      expect(shown).toEqual(pinned.map(({ selected: _, ...c }) => c));
    } finally {
      term.free();
    }
  });

  test('reading lines and the cursor only refreshes the render state after a change', () => {
    const term = filled();
    try {
      term.getViewport();
      let updates = 0;
      const update = term.update.bind(term);
      term.update = () => {
        updates++;
        return update();
      };
      term.getViewportLine(0);
      term.getCursor();
      term.getLine(1);
      expect(updates).toBe(0);
      term.write('x');
      term.getViewportLine(0);
      term.getCursor();
      expect(updates).toBe(1);
    } finally {
      term.free();
    }
  });

  test('scrolling marks the whole viewport for redraw', () => {
    const term = filled();
    try {
      term.update();
      term.getViewport();
      term.markClean();
      term.setViewportOffset(1);
      term.update();
      for (let y = 0; y < 3; y++) expect(term.isRowDirty(y)).toBe(true);
    } finally {
      term.free();
    }
  });

  test('new output while pinned keeps following the bottom', () => {
    const term = filled();
    try {
      term.setViewportOffset(0);
      term.write('\r\nmore');
      expect(term.getViewportOffset()).toBe(0);
      expect(rowText(term.getViewportLine(2))).toBe('more');
    } finally {
      term.free();
    }
  });
});

describe('library selection', () => {
  const geometry = { columns: 40, cellWidth: 10, screenHeight: 100 };

  test('selects absolute ranges and copies them as Ghostty does', () => {
    const term = ghostty.createTerminal(40, 5);
    try {
      term.write('alpha beta   \r\ngamma\r\n');
      expect(term.hasSelection()).toBe(false);
      expect(term.setSelectionRange(6, 0, 4, 1)).toBe(true);
      expect(term.getSelectionRange()).toEqual({
        startCol: 6,
        startRow: 0,
        endCol: 4,
        endRow: 1,
        rectangle: false,
      });
      expect(term.getSelectionText()).toBe('beta\ngamma');
      term.clearSelection();
      expect(term.hasSelection()).toBe(false);
      expect(term.getSelectionText()).toBe('');
    } finally {
      term.free();
    }
  });

  test('orders backward selections', () => {
    const term = ghostty.createTerminal(40, 5);
    try {
      term.write('hello world');
      term.setSelectionRange(10, 0, 6, 0);
      const range = term.getSelectionRange()!;
      expect([range.startCol, range.endCol]).toEqual([6, 10]);
      expect(term.getSelectionText()).toBe('world');
    } finally {
      term.free();
    }
  });

  test('joins soft-wrapped lines when copying', () => {
    const term = ghostty.createTerminal(10, 5);
    try {
      term.write('0123456789abcdef');
      term.setSelectionRange(0, 0, 5, 1);
      expect(term.getSelectionText()).toBe('0123456789abcdef');
    } finally {
      term.free();
    }
  });

  test('selectAll covers scrollback', () => {
    const term = ghostty.createTerminal(20, 3);
    try {
      for (let i = 0; i < 6; i++) term.write(`row ${i}\r\n`);
      expect(term.selectAll()).toBe(true);
      expect(term.getSelectionText()).toBe('row 0\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5');
    } finally {
      term.free();
    }
  });

  test('selection follows content into scrollback', () => {
    const term = ghostty.createTerminal(20, 3);
    try {
      term.write('keep me\r\n');
      term.setSelectionRange(0, 0, 3, 0);
      for (let i = 0; i < 5; i++) term.write(`row ${i}\r\n`);
      expect(term.getSelectionText()).toBe('keep');
      expect(term.getSelectionRange()!.startRow).toBe(0);
    } finally {
      term.free();
    }
  });

  test('gesture: drag selects cells, a plain click selects nothing', () => {
    const term = ghostty.createTerminal(40, 5);
    const gesture = term.createSelectionGesture();
    try {
      term.write('hello world');
      expect(gesture.press(0, 0, 2, 5, 1000)).toBe(false);
      gesture.release();
      expect(term.hasSelection()).toBe(false);

      gesture.press(0, 0, 2, 5, 5000);
      gesture.drag(4, 0, 48, 5, geometry);
      gesture.release();
      expect(term.getSelectionText()).toBe('hello');
    } finally {
      gesture.dispose();
      term.free();
    }
  });

  test('gesture: double-click selects a word, triple-click a line', () => {
    const term = ghostty.createTerminal(40, 5);
    const gesture = term.createSelectionGesture();
    try {
      term.write('cat /tmp/some-file.txt now');
      const click = (t: number) => {
        gesture.press(8, 0, 85, 5, t);
        gesture.release();
      };
      click(1000);
      click(1100);
      expect(term.getSelectionText()).toBe('/tmp/some-file.txt');
      click(1200);
      expect(term.getSelectionText()).toBe('cat /tmp/some-file.txt now');
    } finally {
      gesture.dispose();
      term.free();
    }
  });

  test('gesture: reset cancels the click sequence', () => {
    const term = ghostty.createTerminal(40, 5);
    const gesture = term.createSelectionGesture();
    try {
      term.write('cat /tmp/some-file.txt now');
      const click = (t: number) => {
        gesture.press(8, 0, 85, 5, t);
        gesture.release();
      };
      click(1000);
      gesture.reset();
      click(1100); // a first click again, not a double-click
      expect(term.hasSelection()).toBe(false);
      click(1200);
      expect(term.getSelectionText()).toBe('/tmp/some-file.txt');
    } finally {
      gesture.dispose();
      term.free();
    }
  });

  test('gesture: dragging above the top asks to autoscroll and extends upward', () => {
    const term = ghostty.createTerminal(40, 5);
    const gesture = term.createSelectionGesture();
    try {
      for (let i = 0; i < 20; i++) term.write(`row ${i}\r\n`);
      term.write('last');
      gesture.press(2, 4, 25, 45, 1000);
      gesture.drag(0, 0, 5, -10, geometry);
      expect(gesture.autoscroll()).toBe(SelectionAutoscroll.UP);
      const before = term.getViewportOffset();
      expect(gesture.autoscrollTick(0, 0, 5, -10, geometry)).toBe(true);
      expect(term.getViewportOffset()).toBe(before + 1);
      expect(term.getSelectionText().startsWith('row 15')).toBe(true);
      gesture.release();
    } finally {
      gesture.dispose();
      term.free();
    }
  });
});

describe('terminal effects (library callbacks)', () => {
  function withEffects() {
    const term = ghostty.createTerminal(40, 5);
    const log: unknown[] = [];
    term.setEffects({
      bell: () => log.push('bell'),
      titleChanged: (t) => log.push(['title', t]),
      pwdChanged: (p) => log.push(['pwd', p]),
      clipboardWrite: (req) => {
        log.push([
          'clip',
          req.location,
          req.contents.map((c) => [c.mime, new TextDecoder().decode(c.data)]),
        ]);
        return true;
      },
      notification: (n) => log.push(['notify', n.title, n.body]),
      progress: (p) => log.push(['progress', p.state, p.progress]),
      semanticPrompt: (e) => log.push(['prompt', e.kind, e.exitCode]),
      colorScheme: () => 'dark',
      cellSize: () => ({ width: 9, height: 18 }),
    });
    return { term, log };
  }

  test('bell, title and working directory', () => {
    const { term, log } = withEffects();
    try {
      term.write('a\x07b');
      term.write('\x1b]2;my title\x07');
      term.write('\x1b]0;split ');
      term.write('across writes\x1b\\');
      term.write('\x1b]7;file://host/tmp/work\x07');
      expect(log).toEqual([
        'bell',
        ['title', 'my title'],
        ['title', 'split across writes'],
        ['pwd', 'file://host/tmp/work'],
      ]);
      expect(term.getTitle()).toBe('split across writes');
    } finally {
      term.free();
    }
  });

  test('a BEL ending an OSC sequence is not a bell', () => {
    const { term, log } = withEffects();
    try {
      term.write('\x1b]2;title\x07');
      expect(log.includes('bell')).toBe(false);
    } finally {
      term.free();
    }
  });

  test('OSC 52 clipboard writes', () => {
    const { term, log } = withEffects();
    try {
      term.write(`\x1b]52;c;${btoa('copied text')}\x07`);
      expect(log).toEqual([['clip', 'standard', [['text/plain', 'copied text']]]]);
    } finally {
      term.free();
    }
  });

  test('a denied OSC 52 clipboard write is reported and answered', () => {
    const term = ghostty.createTerminal(40, 5);
    const requests: string[] = [];
    term.setEffects({
      clipboardWrite: (req) => {
        requests.push(new TextDecoder().decode(req.contents[0].data));
        return false;
      },
    });
    try {
      term.write(`\x1b]52;c;${btoa('first')}\x07`);
      term.write(`\x1b]52;p;${btoa('second')}\x07ok`);
      // Each write reached the handler; denying sends nothing to the program.
      expect(requests).toEqual(['first', 'second']);
      expect(term.readResponse()).toBeNull();
      expect(text(term.getLine(0)!.map((c) => c.codepoint)).trimEnd()).toBe('ok');
    } finally {
      term.free();
    }
  });

  test('program status reports (OSC 7501)', () => {
    const term = ghostty.createTerminal(40, 5);
    const reports: unknown[] = [];
    term.setEffects({ programStatus: (s) => reports.push(s) });
    try {
      const title = btoa('Build');
      const msg = btoa('Allow rm?');
      term.write(
        `\x1b]7501;state=blocked:kind=permission:id=job-1:app=make:progress=42:title=${title}:msg=${msg}\x07`
      );
      term.write('\x1b]7501;state=working\x1b\\');
      term.write('\x1b]7501;state=clear\x07');
      expect(reports).toEqual([
        {
          state: 'blocked',
          kind: 'permission',
          progress: 42,
          id: 'job-1',
          app: 'make',
          title: 'Build',
          message: 'Allow rm?',
        },
        { state: 'working', kind: 'none', progress: null, id: '', app: '', title: '', message: '' },
        { state: 'clear', kind: 'none', progress: null, id: '', app: '', title: '', message: '' },
      ]);
    } finally {
      term.free();
    }
  });

  test('a full reset (RIS) is reported', () => {
    const term = ghostty.createTerminal(40, 5);
    let resets = 0;
    term.setEffects({ reset: () => resets++ });
    try {
      term.write('text\x1b[?2004h');
      expect(resets).toBe(0);
      term.write('\x1bc');
      expect(resets).toBe(1);
      expect(term.hasBracketedPaste()).toBe(false);
      expect(text(term.getLine(0)!.map((c) => c.codepoint)).trimEnd()).toBe('');
    } finally {
      term.free();
    }
  });

  test('the pointer shape a program asks for (OSC 22)', () => {
    const term = ghostty.createTerminal(40, 5);
    try {
      expect(term.getMouseShape()).toBe('text');
      term.write('\x1b]22;pointer\x07');
      expect(term.getMouseShape()).toBe('pointer');
      term.write('\x1b]22;nwse-resize\x1b\\');
      expect(term.getMouseShape()).toBe('nwse-resize');
      term.write('\x1b]22;default\x07'); // the arrow
      expect(term.getMouseShape()).toBe('default');
      term.write('\x1b]22;\x07');
      expect(term.getMouseShape()).toBe('text');
    } finally {
      term.free();
    }
  });

  test('clipboard reads are denied (no response)', () => {
    const { term } = withEffects();
    try {
      term.write('\x1b]52;c;?\x07');
      expect(term.readResponse()).toBeNull();
    } finally {
      term.free();
    }
  });

  test('notifications and progress reports', () => {
    const { term, log } = withEffects();
    try {
      term.write('\x1b]777;notify;Build;finished\x07');
      term.write('\x1b]9;4;1;42\x07');
      term.write('\x1b]9;4;0\x07');
      expect(log).toEqual([
        ['notify', 'Build', 'finished'],
        ['progress', 'set', 42],
        ['progress', 'remove', null],
      ]);
    } finally {
      term.free();
    }
  });

  test('shell integration prompts (OSC 133)', () => {
    const { term, log } = withEffects();
    try {
      term.write('\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07out\r\n\x1b]133;D;3\x07');
      expect(log).toEqual([
        ['prompt', 'prompt-start', null],
        ['prompt', 'input-start', null],
        ['prompt', 'output-start', null],
        ['prompt', 'command-end', 3],
      ]);
    } finally {
      term.free();
    }
  });

  test('color scheme and size queries are answered', () => {
    const { term } = withEffects();
    try {
      term.write('\x1b[?996n');
      expect(term.readResponse()).toBe('\x1b[?997;1n');
      term.write('\x1b[16t');
      expect(term.readResponse()).toBe('\x1b[6;18;9t');
      term.write('\x1b[14t');
      expect(term.readResponse()).toBe('\x1b[4;90;360t');
    } finally {
      term.free();
    }
  });

  test('synchronized output keeps the last finished frame on screen', () => {
    const term = ghostty.createTerminal(20, 3);
    const shown = () => text(term.getViewportLine(0)!.map((c) => c.codepoint)).trimEnd();
    const live = () => text(term.getLine(0)!.map((c) => c.codepoint)).trimEnd();
    try {
      term.write('old');
      expect(shown()).toBe('old');
      term.write('\x1b[?2026h\x1b[2J\x1b[Hne');
      expect(shown()).toBe('old'); // held: still the frame from before
      expect(live()).toBe('ne'); // the grid itself is not held
      term.write('w\x1b[?2026l');
      expect(shown()).toBe('new');
      expect(live()).toBe('new');
    } finally {
      term.free();
    }
  });
});

describe('underline styles and overline', () => {
  test('decodes SGR 4:x styles, underline color (SGR 58) and overline (SGR 53)', () => {
    const term = ghostty.createTerminal(40, 3);
    try {
      term.write('\x1b[4mA\x1b[0m\x1b[4:2mB\x1b[0m\x1b[4:3;58;2;255;0;0mC\x1b[0m');
      term.write('\x1b[4:4mD\x1b[0m\x1b[4:5mE\x1b[0m\x1b[53mF\x1b[0mG');
      const row = term.getLine(0)!;
      expect(row.slice(0, 7).map((c) => c.underline_style)).toEqual([1, 2, 3, 4, 5, 0, 0]);
      expect(row[2].underline_color).toBe(0xff0000);
      expect(row[0].underline_color).toBeUndefined();
      expect(row[5].overline).toBe(true);
      expect(row[6].overline).toBe(false);
      expect(row[2].flags & 4).toBe(4); // still flagged as underlined
    } finally {
      term.free();
    }
  });
});

describe('formatting the screen', () => {
  test('fromRow starts the output at that absolute row', () => {
    const term = ghostty.createTerminal(20, 3);
    try {
      for (let i = 0; i < 6; i++) term.write(`row ${i}\r\n`);
      term.write('last');
      // Rows 0-3 are scrollback, 4-6 the active area.
      expect(term.formatScreen({ format: 'plain', trim: true })).toBe(
        'row 0\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5\nlast'
      );
      expect(term.formatScreen({ format: 'plain', trim: true, fromRow: 4 })).toBe(
        'row 4\nrow 5\nlast'
      );
      expect(term.formatScreen({ format: 'plain', trim: true, fromRow: 6 })).toBe('last');
    } finally {
      term.free();
    }
  });

  test('VT extras restore the terminal state they name', () => {
    const term = ghostty.createTerminal(20, 3);
    try {
      term.write('\x1b]4;1;rgb:12/34/56\x07\x1b[?2004hhi');
      const plain = term.formatScreen({ format: 'vt', extras: FormatterExtras.NONE });
      const palette = term.formatScreen({ format: 'vt', extras: FormatterExtras.PALETTE });
      const modes = term.formatScreen({ format: 'vt', extras: FormatterExtras.MODES });
      expect(plain).not.toContain('\x1b]4;');
      expect(plain).not.toContain('\x1b[?2004h');
      expect(palette).toContain('\x1b]4;1;rgb:12/34/56');
      expect(modes).toContain('\x1b[?2004h');

      // Written to a fresh terminal, the output recreates the state.
      const copy = ghostty.createTerminal(20, 3);
      try {
        copy.write(term.formatScreen({ format: 'vt', extras: FormatterExtras.ALL }));
        expect(copy.hasBracketedPaste()).toBe(true);
        copy.write('\x1b[31mX');
        const x = copy.getLine(0)![2];
        expect([x.fg_r, x.fg_g, x.fg_b]).toEqual([0x12, 0x34, 0x56]);
      } finally {
        copy.free();
      }
    } finally {
      term.free();
    }
  });
});

describe('AbiLayout', () => {
  const manifest = (types: Record<string, unknown>, abi = {}) =>
    JSON.stringify({
      abi: { pointer_size: 4, usize_size: 4, endian: 'little', ...abi },
      library_version: '9.9.9',
      types,
    });
  const layout = new AbiLayout(
    manifest({
      S: { kind: 'struct', size: 8, fields: { a: { offset: 4, size: 4, type: 'u32' } } },
      Unsized: { kind: 'opaque' },
      P: {
        kind: 'packed',
        size: 8,
        bits: {
          tag: { lsb: 0, width: 2 },
          content: { lsb: 2, width: 30, arms: { X: { bits: { v: { lsb: 3, width: 5 } } } } },
        },
      },
    })
  );

  test('reads sizes, offsets and bit positions', () => {
    expect(layout.version).toBe('9.9.9');
    expect(layout.size('S')).toBe(8);
    expect(layout.offset('S', 'a')).toBe(4);
    expect(layout.bits('P', 'tag')).toEqual({ lsb: 0, width: 2 });
    expect(layout.unionBits('P', 'content', 'X', 'v')).toEqual({ lsb: 5, width: 5 });
  });

  test('throws on anything the manifest does not describe', () => {
    expect(() => layout.size('Missing')).toThrow('has no type Missing');
    expect(() => layout.size('Unsized')).toThrow('type Unsized has no size');
    expect(() => layout.offset('S', 'b')).toThrow('struct S has no field b');
    expect(() => layout.offset('Missing', 'a')).toThrow('has no type Missing');
    expect(() => layout.bits('P', 'nope')).toThrow('packed type P has no field nope');
    expect(() => layout.unionBits('P', 'content', 'Y', 'v')).toThrow('has no content.Y.v');
    expect(() => layout.unionBits('P', 'content', 'X', 'w')).toThrow('has no content.X.w');
    expect(() => layout.unionBits('P', 'tag', 'X', 'v')).toThrow('has no tag.X.v');
  });

  test('rejects modules built for another ABI', () => {
    expect(() => new AbiLayout(manifest({}, { pointer_size: 8 }))).toThrow(
      'Unsupported libghostty-vt ABI: pointer size 8, little endian'
    );
    expect(() => new AbiLayout(manifest({}, { endian: 'big' }))).toThrow('big endian');
  });
});
