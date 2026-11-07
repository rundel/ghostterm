import { describe, expect, test } from 'bun:test';
import { terminalFixture } from './test-helpers';

const fixture = terminalFixture();

function lines(count: number, from = 0): string {
  let s = '';
  for (let i = from; i < from + count; i++) s += `line ${i}\r\n`;
  return s;
}

describe('registerMarker', () => {
  test('marks the cursor line, offset by cursorYOffset', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('a\r\nb\r\nc');
    expect(term.registerMarker().line).toBe(2);
    expect(term.registerMarker(-2).line).toBe(0);
    expect(term.registerMarker(1).line).toBe(3);
    expect(term.markers.length).toBe(3);
  });

  test('counts scrollback in the line', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write(lines(10));
    // 11 rows written (the cursor sits on the 11th), 5 on screen.
    expect(term.buffer.active.baseY).toBe(6);
    const marker = term.registerMarker();
    expect(marker.line).toBe(10);
    expect(term.buffer.active.getLine(marker.line - 1)?.translateToString(true)).toBe('line 9');
  });

  test('follows its content as output pushes it into scrollback', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('first\r\nsecond');
    const marker = term.registerMarker();
    term.write(`\r\n${lines(20)}`);
    expect(term.buffer.active.baseY).toBeGreaterThan(marker.line);
    expect(term.buffer.active.getLine(marker.line)?.translateToString(true)).toBe('second');
  });

  test('moves up as history is pruned and is disposed with its line', () => {
    // Wide rows, so a page holds few of them and pruning one keeps most of the history.
    const { term } = fixture.open({ cols: 200, rows: 5, scrollback: 1000 });
    term.write(lines(50));
    const early = term.registerMarker(-45); // 'line 5'
    expect(term.buffer.active.getLine(early.line)?.translateToString(true)).toBe('line 5');
    let disposed = 0;
    early.onDispose(() => disposed++);

    // libghostty prunes a page of history at a time, so write well past the limit.
    term.write(lines(6000, 50));
    expect(early.isDisposed).toBe(true);
    expect(early.line).toBe(-1);
    expect(disposed).toBe(1);
    expect(term.markers).not.toContain(early);

    // A marker that survives a prune moves up with its content.
    term.write('marked\r\n');
    const late = term.registerMarker(-1);
    const before = late.line;
    for (let i = 0; i < 100 && late.line === before; i++) term.write(lines(20));
    expect(late.isDisposed).toBe(false);
    expect(late.line).toBeLessThan(before);
    expect(term.buffer.active.getLine(late.line)?.translateToString(true)).toBe('marked');
  });

  test('stays on its line when the screen reflows', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('x'.repeat(30) + '\r\nafter');
    const marker = term.registerMarker();
    expect(marker.line).toBe(2);
    term.resize(40, 5);
    // The wrapped line became one row.
    expect(marker.line).toBe(1);
    expect(term.buffer.active.getLine(marker.line)?.translateToString(true)).toBe('after');
  });

  test('a line outside the buffer gives a disposed marker', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const marker = term.registerMarker(-1);
    expect(marker.isDisposed).toBe(true);
    expect(marker.line).toBe(-1);
    expect(term.markers.length).toBe(0);
  });

  test('dispose() fires onDispose once and removes the marker', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const marker = term.registerMarker();
    let fired = 0;
    marker.onDispose(() => fired++);
    marker.dispose();
    marker.dispose();
    expect(fired).toBe(1);
    expect(marker.isDisposed).toBe(true);
    expect(term.markers.length).toBe(0);
  });

  test('ids are unique', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const a = term.registerMarker();
    const b = term.registerMarker();
    expect(a.id).not.toBe(b.id);
  });

  test('reset(), RIS and clear() dispose every marker, as in xterm.js', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write(lines(10));
    const a = term.registerMarker(-3);
    term.reset();
    expect(a.isDisposed).toBe(true);

    term.write(lines(10));
    const b = term.registerMarker(-3);
    term.write('\x1bc');
    expect(b.isDisposed).toBe(true);

    term.write(lines(10));
    const c = term.registerMarker();
    term.clear();
    expect(c.isDisposed).toBe(true);
    expect(term.markers.length).toBe(0);

    // Markers made after clear() work.
    term.write('x\r\ny');
    expect(term.registerMarker().line).toBe(1);
  });

  test('ED 3 disposes markers in the history it drops', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write(lines(10));
    const inHistory = term.registerMarker(-8);
    const onScreen = term.registerMarker();
    term.write('\x1b[3J');
    expect(inHistory.isDisposed).toBe(true);
    expect(onScreen.isDisposed).toBe(false);
    expect(onScreen.line).toBe(4);
  });

  test("leaving the alternate screen disposes its markers but not the normal screen's", () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write(lines(3));
    const normal = term.registerMarker(-1);
    term.write('\x1b[?1049h\x1b[3;1H');
    const alt = term.registerMarker();
    expect(alt.line).toBe(2);
    // The normal screen's marker keeps its line while the alternate screen is shown.
    expect(normal.line).toBe(2);
    term.write('\x1b[?1049l');
    expect(alt.isDisposed).toBe(true);
    expect(normal.isDisposed).toBe(false);
    expect(term.buffer.active.getLine(normal.line)?.translateToString(true)).toBe('line 2');
  });

  test('dispose() of the terminal disposes its markers', () => {
    const term = fixture.create({ cols: 20, rows: 5 });
    term.open(document.createElement('div'));
    const marker = term.registerMarker();
    term.dispose();
    expect(marker.isDisposed).toBe(true);
  });

  test('works before open(), and throws once disposed', () => {
    const term = fixture.create({ cols: 20, rows: 5 });
    term.write('a\r\nb');
    const marker = term.registerMarker();
    expect(marker.line).toBe(1);
    term.dispose();
    expect(() => term.registerMarker()).toThrow('disposed');
  });
});
