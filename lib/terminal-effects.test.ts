/**
 * What programs can do to the terminal, through libghostty's callbacks and
 * modes: titles, bells, OSC requests, replies, modes, pointer shape, shell
 * integration, and the render and cursor events that follow output.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { internals, mouseEvent, nextFrame, strokes, stub, terminalFixture } from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;
let container: HTMLElement;
let sent: string[];

beforeEach(() => {
  ({ term, container, sent } = fixture.open({ cols: 40, rows: 10 }));
});

describe('titles and bells', () => {
  test('OSC 0 and OSC 2 set the title, with BEL or ST, once per change even across writes', () => {
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]0;first\x07\x1b]2;first\x07');
    term.write('\x1b]2;sec');
    term.write('ond\x1b\\');
    term.write('\x1b]2;Title with ST\x1b\\');
    expect(titles).toEqual(['first', 'second', 'Title with ST']);
  });

  test('onBell fires for BEL but not for a BEL ending an OSC sequence', () => {
    let bells = 0;
    term.onBell(() => bells++);
    term.write('\x1b]2;title\x07');
    expect(bells).toBe(0);
    term.write('\x07');
    expect(bells).toBe(1);
  });

  test('events keep working after reset()', () => {
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.reset();
    term.write('\x1b]2;after reset\x07');
    expect(titles).toEqual(['after reset']);
  });
});

describe('requests from the program', () => {
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
    const writes: Array<{ text: string; location: string }> = [];
    term.onClipboardWrite((w) => writes.push(w));
    term.write(`\x1b]52;c;${btoa('from the program')}\x07`);
    expect(writes).toEqual([{ text: 'from the program', location: 'standard' }]);
  });

  test('cell size queries report the renderer metrics', () => {
    term.write('\x1b[16t');
    const { renderer } = internals(term);
    expect(sent).toEqual([`\x1b[6;${renderer.charHeight};${renderer.charWidth}t`]);
  });

  test('programs can change the mouse pointer (OSC 22), and reset it', () => {
    const { canvas } = internals(term);
    expect(canvas.style.cursor).toBe('text');
    term.write('\x1b]22;pointer\x07');
    expect(canvas.style.cursor).toBe('pointer');
    expect(container.style.cursor).toBe('pointer');
    term.write('\x1b]22;crosshair\x1b\\');
    expect(canvas.style.cursor).toBe('crosshair');
    term.write('\x1b]22;\x07');
    expect(canvas.style.cursor).toBe('text');
  });
});

describe('modes', () => {
  test('getMode() reads DEC private and ANSI modes', () => {
    expect(term.getMode(25)).toBe(true); // cursor visible
    term.write('\x1b[?25l');
    expect(term.getMode(25)).toBe(false);
    expect(term.getMode(1049)).toBe(false);
    term.write('\x1b[?1049h');
    expect(term.getMode(1049)).toBe(true);
    expect(term.getMode(4, true)).toBe(false); // insert mode
    term.write('\x1b[4h');
    expect(term.getMode(4, true)).toBe(true);
    // Grapheme clustering (mode 2027) is on by default
    expect(term.getMode(2027)).toBe(true);
  });

  test('mode helpers follow the program, several at once', () => {
    expect([term.hasBracketedPaste(), term.hasFocusEvents(), term.hasMouseTracking()]).toEqual([
      false,
      false,
      false,
    ]);
    term.write('\x1b[?2004h\x1b[?1004h\x1b[?1000h');
    expect([term.hasBracketedPaste(), term.hasFocusEvents(), term.hasMouseTracking()]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test('buffer.onBufferChange fires when the program switches screens', () => {
    const types: string[] = [];
    term.buffer.onBufferChange((b) => types.push(b.type));
    term.write('\x1b[?1049h');
    term.write('vim');
    term.write('\x1b[?1049l');
    expect(types).toEqual(['alternate', 'normal']);
  });
});

describe('render loop events', () => {
  test('onRender reports the rows drawn, and nothing while nothing changes', async () => {
    await nextFrame();
    const ranges: Array<{ start: number; end: number }> = [];
    term.onRender((r) => ranges.push(r));
    await nextFrame();
    expect(ranges).toEqual([]);
    // Row 4 and its neighbors, and the cursor's old row 0
    term.write('\x1b[5;1Hhi');
    await nextFrame();
    expect(ranges).toEqual([{ start: 0, end: 5 }]);
    await nextFrame();
    expect(ranges).toHaveLength(1);
  });

  test('onCursorMove fires for moves along the line too', async () => {
    await nextFrame();
    let moves = 0;
    term.onCursorMove(() => moves++);
    term.write('abc');
    await nextFrame();
    expect(moves).toBe(1);
    await nextFrame();
    expect(moves).toBe(1);
  });
});

describe('links', () => {
  test('hovering a hyperlink shows a pointer and underlines it; leaving restores both', async () => {
    term.write('see \x1b]8;;https://example.com\x07here\x1b]8;;\x07 now');
    const { renderer, canvas } = internals(term);
    const hoverColor = '#4A90E2';
    // The OSC 8 underline and the hovered link range both stroke these cells.
    const underlinedCols = () => [
      ...new Set(
        strokes(term)
          .filter((s) => s.strokeStyle === hoverColor)
          .map((s) => Math.round(Number(s.path[0][1]) / renderer.charWidth))
      ),
    ];
    expect(underlinedCols()).toEqual([]);

    container.dispatchEvent(mouseEvent('mousemove', 5 * renderer.charWidth + 1, 1));
    await nextFrame();
    expect(canvas.style.cursor).toBe('pointer');
    expect(underlinedCols()).toEqual([4, 5, 6, 7]);

    container.dispatchEvent(new MouseEvent('mouseleave'));
    expect(canvas.style.cursor).toBe('text');
    expect(underlinedCols()).toEqual([]);
  });
});

describe('link hover throttling', () => {
  test('moves within the throttle interval are coalesced into the last one', async () => {
    const timers: Array<() => void> = [];
    fixture.defer(
      stub(window, 'setTimeout', ((fn: () => void) => {
        timers.push(fn);
        return 1;
      }) as unknown as typeof window.setTimeout)
    );
    term.write('see \x1b]8;;https://example.com\x07here\x1b]8;;\x07 now');
    const { renderer, canvas } = internals(term);
    const move = (col: number) =>
      container.dispatchEvent(mouseEvent('mousemove', col * renderer.charWidth + 1, 1));
    move(5);
    move(0); // throttled
    move(6); // replaces the throttled move
    await Promise.resolve();
    expect(canvas.style.cursor).toBe('pointer');
    expect(timers).toHaveLength(1);
    move(1);
    timers[0]();
    await Promise.resolve();
    expect(canvas.style.cursor).toBe('text');
  });
});

describe('shell integration navigation', () => {
  test('scrollToPrompt steps through prompts in both directions', () => {
    const { term: t } = fixture.open({ cols: 20, rows: 3 });
    for (let i = 0; i < 4; i++) {
      t.write(
        `\x1b]133;A\x07$ cmd ${i}\r\n\x1b]133;C\x07out ${i}a\r\nout ${i}b\r\n\x1b]133;D;0\x07`
      );
    }
    t.write('\x1b]133;A\x07$ ');
    const top = () => t.buffer.active.getLine(t.viewportRowToBufferRow(0))?.translateToString(true);
    const seen: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      expect(t.scrollToPrompt(-1)).toBe(true);
      seen.push(top());
    }
    expect(seen).toEqual(['$ cmd 3', '$ cmd 2', '$ cmd 1', '$ cmd 0']);
    expect(t.scrollToPrompt(-1)).toBe(false); // no older prompt
    expect(t.scrollToPrompt(1)).toBe(true);
    expect(top()).toBe('$ cmd 1');
    expect(t.viewportY).toBe(t.wasmTerm?.getViewportOffset() ?? -1);
  });
});
