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

  test('the palette is left alone unless asked for', () => {
    expect(serializer.serialize()).not.toContain('\x1b]4;');
    expect(serializer.serialize({ includePalette: true })).toContain('\x1b]4;1;');
  });

  test('HTML output, for the screen or just the selection', () => {
    const html = serializer.serializeAsHTML();
    expect(html).toContain('row 0');
    expect(html).toContain('green');
    term.select(0, term.rows - 1, 5);
    const sel = serializer.serializeAsHTML({ onlySelection: true, includeGlobalBackground: true });
    expect(sel).toContain('green');
    expect(sel).not.toContain('row 0');
    expect(sel.startsWith('<div style="background-color: rgb(')).toBe(true);
  });
});
