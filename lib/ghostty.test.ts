/**
 * Tests for the libghostty-vt bridge itself, against the official WASM module.
 *
 * These cover the parts of lib/ghostty.ts that talk to the C ABI directly:
 * write_pty replies, cell decoding, colors, grid access and key encoding.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { Ghostty, KeyEncoderOption, SelectionAutoscroll } from './ghostty';
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
      expect(term.getScreenHyperlinkUri(0, 1)).toBe('https://ghostty.org');
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
      expect(term.getGraphemeString(2, 0)).toBe('p');
      expect(term.getViewportGraphemeString(0, 5)).toBe('3');
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

  test('clipboard reads are denied (no response)', () => {
    const { term } = withEffects();
    try {
      term.write('\x1b]52;c;?\x07');
      const reply = term.readResponse();
      expect(reply === null || !reply.includes(btoa('x'))).toBe(true);
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
    const row = () => text(term.getLine(0)!.map((c) => c.codepoint)).trimEnd();
    try {
      term.write('old');
      expect(row()).toBe('old');
      term.write('\x1b[?2026h\x1b[2J\x1b[Hne');
      expect(row()).toBe('old'); // held: still the frame from before
      term.write('w\x1b[?2026l');
      expect(row()).toBe('new');
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
