import { beforeEach, describe, expect, test } from 'bun:test';
import type { GhosttyTerminal } from '../ghostty';
import type { Terminal } from '../terminal';
import { drawnText, internals, terminalFixture } from '../test-helpers';
import { SerializeAddon } from './serialize';

const fixture = terminalFixture();

const make = () => fixture.open({ cols: 30, rows: 4 }).term;
const wasm = (t: Terminal): GhosttyTerminal => internals(t).wasmTerm;
const text = (t: Terminal) => wasm(t).formatScreen({ format: 'plain', trim: true });

describe('SerializeAddon', () => {
  let term: Terminal;
  let serializer: SerializeAddon;

  beforeEach(() => {
    term = make();
    serializer = new SerializeAddon();
    term.loadAddon(serializer);
    for (let i = 0; i < 6; i++) term.write(`row ${i}\r\n`);
    term.write(
      '\x1b[1;32mgreen\x1b[0m \x1b]8;;https://ghostty.org\x1b\\link\x1b]8;;\x1b\\ \x1b[?2004h'
    );
  });

  test('round-trips text, scrollback, styles, links, cursor and modes', () => {
    const restored = make();
    restored.write(serializer.serialize());
    expect(text(restored)).toBe(text(term));
    expect(text(restored)).toContain('row 5\ngreen link');
    expect(wasm(restored).getScrollbackLength()).toBe(wasm(term).getScrollbackLength());
    const cursor = wasm(term).getCursor();
    expect(wasm(restored).getCursor()).toMatchObject({ x: cursor.x, y: cursor.y });
    const buffer = restored.buffer.active;
    const green = buffer.getLine(buffer.baseY + term.rows - 1)?.getCell(0);
    expect(green?.isBold()).toBe(1);
    expect(green?.getFgColor()).toBe(0x0dbc79);
    // And it is drawn that way: bold green, then plain text.
    const lastRow = drawnText(restored).filter((t) => t.row === 3);
    expect(lastRow.map((t) => t.text).join('')).toBe('greenlink');
    for (const t of lastRow.slice(0, 5)) {
      expect([t.fillStyle, t.font.startsWith('bold ')]).toEqual(['rgb(13, 188, 121)', true]);
    }
    expect(lastRow[5].font.startsWith('bold ')).toBe(false);
    expect(wasm(restored).getScreenHyperlinkUri(wasm(restored).getScrollbackLength() + 3, 6)).toBe(
      'https://ghostty.org'
    );
    expect(wasm(restored).hasBracketedPaste()).toBe(true);
  });

  test('scrollback limit and excludeModes', () => {
    const restored = make();
    restored.write(serializer.serialize({ scrollback: 1, excludeModes: true }));
    expect(text(restored).startsWith('row 2')).toBe(true);
    expect(wasm(restored).hasBracketedPaste()).toBe(false);
  });

  test('range keeps only those lines', () => {
    const restored = make();
    restored.write(serializer.serialize({ range: { start: 3, end: 4 }, excludeModes: true }));
    expect(text(restored)).toBe('row 3\nrow 4');
  });

  describe('with the alternate screen active', () => {
    let normalText: string;
    let scrollback: number;

    beforeEach(() => {
      normalText = text(term);
      scrollback = wasm(term).getScrollbackLength();
      term.write('\x1b[?1049h\x1b[2;3Hfull screen app');
    });

    test('restores both screens, and leaving the alternate one shows the normal one', () => {
      const altText = text(term);

      const restored = make();
      restored.write(serializer.serialize());
      expect(wasm(restored).isAlternateScreen()).toBe(true);
      expect(text(restored)).toBe(altText);
      expect(wasm(restored).getCursor()).toMatchObject({ x: 17, y: 1 });

      restored.write('\x1b[?1049l');
      expect(wasm(restored).isAlternateScreen()).toBe(false);
      expect(text(restored)).toBe(normalText);
      expect(wasm(restored).getScrollbackLength()).toBe(scrollback);
      expect(wasm(restored).hasBracketedPaste()).toBe(true);
    });

    test('also without modes', () => {
      const restored = make();
      restored.write(serializer.serialize({ excludeModes: true }));
      expect(text(restored)).toBe(text(term));
      restored.write('\x1b[?1049l');
      expect(text(restored)).toBe(normalText);
    });

    test('scrollback and range limit the normal screen', () => {
      const limited = make();
      limited.write(serializer.serialize({ scrollback: 1, excludeAltBuffer: true }));
      expect(text(limited).startsWith('row 2')).toBe(true);

      const ranged = make();
      ranged.write(serializer.serialize({ range: { start: 1, end: 2 }, excludeAltBuffer: true }));
      expect(text(ranged)).toBe('row 1\nrow 2');
    });

    test('excludeAltBuffer keeps only the normal screen', () => {
      const restored = make();
      restored.write(serializer.serialize({ excludeAltBuffer: true }));
      expect(wasm(restored).isAlternateScreen()).toBe(false);
      expect(text(restored)).toBe(normalText);
      expect(wasm(restored).hasBracketedPaste()).toBe(true);
    });

    test('leaves the terminal as it was', () => {
      term.select(2, 1, 4);
      const before = wasm(term).getSelectionRange();
      serializer.serialize();
      expect(wasm(term).isAlternateScreen()).toBe(true);
      expect(wasm(term).getMode(47)).toBe(false);
      expect(wasm(term).getMode(1049)).toBe(true);
      expect(wasm(term).getSelectionRange()).toEqual(before);
      expect(term.getSelection()).toBe('full');
      term.write('\x1b[?1049l');
      expect(text(term)).toContain('row 5');
    });
  });

  test('the palette is left alone unless asked for', () => {
    expect(serializer.serialize()).not.toContain('\x1b]4;');
    expect(serializer.serialize({ includePalette: true })).toContain('\x1b]4;1;');
  });

  test('HTML output, for the screen or just the selection', () => {
    const html = serializer.serializeAsHTML();
    expect(html).toContain('row 0');
    expect(html).toContain('green');
    term.select(0, term.buffer.active.baseY + term.rows - 1, 5);
    const sel = serializer.serializeAsHTML({ onlySelection: true, includeGlobalBackground: true });
    expect(sel).toContain('green');
    expect(sel).not.toContain('row 0');
    expect(sel.startsWith('<div style="background-color: rgb(')).toBe(true);
  });
});
