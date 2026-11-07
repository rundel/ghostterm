import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from '../terminal';
import { createIsolatedTerminal } from '../test-helpers';
import { SerializeAddon } from './serialize';

const containers: HTMLElement[] = [];
const terms: Terminal[] = [];

async function make(opts = {}) {
  const c = document.createElement('div');
  document.body.appendChild(c);
  const t = await createIsolatedTerminal({ cols: 30, rows: 4, ...opts });
  t.open(c);
  containers.push(c);
  terms.push(t);
  return t;
}

afterEach(() => {
  for (const t of terms.splice(0)) t.dispose();
  for (const c of containers.splice(0)) c.remove();
});

const text = (t: Terminal) => t.wasmTerm!.formatScreen({ format: 'plain', trim: true });

describe('SerializeAddon', () => {
  let term: Terminal;
  let serializer: SerializeAddon;

  beforeEach(async () => {
    term = await make();
    serializer = new SerializeAddon();
    term.loadAddon(serializer);
    for (let i = 0; i < 6; i++) term.write(`row ${i}\r\n`);
    term.write(
      '\x1b[1;32mgreen\x1b[0m \x1b]8;;https://ghostty.org\x1b\\link\x1b]8;;\x1b\\ \x1b[?2004h'
    );
  });

  test('round-trips text, scrollback, styles, links, cursor and modes', async () => {
    const restored = await make();
    restored.write(serializer.serialize());
    expect(text(restored)).toBe(text(term));
    expect(restored.wasmTerm!.getScrollbackLength()).toBe(term.wasmTerm!.getScrollbackLength());
    const cursor = term.wasmTerm!.getCursor();
    expect(restored.wasmTerm!.getCursor()).toMatchObject({ x: cursor.x, y: cursor.y });
    const cell = restored.wasmTerm!.getLine(term.rows - 1)![0];
    expect(cell.flags & 1).toBe(1); // bold
    expect(
      restored.wasmTerm!.getScreenHyperlinkUri(restored.wasmTerm!.getScrollbackLength() + 3, 6)
    ).toBe('https://ghostty.org');
    expect(restored.wasmTerm!.hasBracketedPaste()).toBe(true);
  });

  test('scrollback limit and excludeModes', async () => {
    const restored = await make();
    restored.write(serializer.serialize({ scrollback: 1, excludeModes: true }));
    expect(text(restored).startsWith('row 2')).toBe(true);
    expect(restored.wasmTerm!.hasBracketedPaste()).toBe(false);
  });

  test('range keeps only those lines', async () => {
    const restored = await make();
    restored.write(serializer.serialize({ range: { start: 3, end: 4 }, excludeModes: true }));
    expect(text(restored)).toBe('row 3\nrow 4');
  });

  describe('with the alternate screen active', () => {
    let normalText: string;
    let scrollback: number;

    beforeEach(() => {
      normalText = text(term);
      scrollback = term.wasmTerm!.getScrollbackLength();
      term.write('\x1b[?1049h\x1b[2;3Hfull screen app');
    });

    test('restores both screens, and leaving the alternate one shows the normal one', async () => {
      const altText = text(term);

      const restored = await make();
      restored.write(serializer.serialize());
      expect(restored.wasmTerm!.isAlternateScreen()).toBe(true);
      expect(text(restored)).toBe(altText);
      expect(restored.wasmTerm!.getCursor()).toMatchObject({ x: 17, y: 1 });

      restored.write('\x1b[?1049l');
      expect(restored.wasmTerm!.isAlternateScreen()).toBe(false);
      expect(text(restored)).toBe(normalText);
      expect(restored.wasmTerm!.getScrollbackLength()).toBe(scrollback);
      expect(restored.wasmTerm!.hasBracketedPaste()).toBe(true);
    });

    test('also without modes', async () => {
      const restored = await make();
      restored.write(serializer.serialize({ excludeModes: true }));
      expect(text(restored)).toBe(text(term));
      restored.write('\x1b[?1049l');
      expect(text(restored)).toBe(normalText);
    });

    test('scrollback and range limit the normal screen', async () => {
      const limited = await make();
      limited.write(serializer.serialize({ scrollback: 1, excludeAltBuffer: true }));
      expect(text(limited).startsWith('row 2')).toBe(true);

      const ranged = await make();
      ranged.write(serializer.serialize({ range: { start: 1, end: 2 }, excludeAltBuffer: true }));
      expect(text(ranged)).toBe('row 1\nrow 2');
    });

    test('excludeAltBuffer keeps only the normal screen', async () => {
      const restored = await make();
      restored.write(serializer.serialize({ excludeAltBuffer: true }));
      expect(restored.wasmTerm!.isAlternateScreen()).toBe(false);
      expect(text(restored)).toBe(normalText);
      expect(restored.wasmTerm!.hasBracketedPaste()).toBe(true);
    });

    test('leaves the terminal as it was', () => {
      term.select(2, 1, 4);
      const before = term.wasmTerm!.getSelectionRange();
      serializer.serialize();
      expect(term.wasmTerm!.isAlternateScreen()).toBe(true);
      expect(term.wasmTerm!.getMode(47)).toBe(false);
      expect(term.wasmTerm!.getMode(1049)).toBe(true);
      expect(term.wasmTerm!.getSelectionRange()).toEqual(before);
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
