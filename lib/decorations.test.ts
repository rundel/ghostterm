import { describe, expect, test } from 'bun:test';
import type { IDecoration } from './interfaces';
import type { Terminal } from './terminal';
import { drawnText, internals, paintedRects, render, terminalFixture } from './test-helpers';

const fixture = terminalFixture();

function lines(count: number, from = 0): string {
  let s = '';
  for (let i = from; i < from + count; i++) s += `line ${i}\r\n`;
  return s;
}

function cell(term: Terminal) {
  const { charWidth, charHeight } = internals(term).renderer;
  return { w: charWidth, h: charHeight };
}

function decorate(term: Terminal, options: Partial<Parameters<Terminal['registerDecoration']>[0]>) {
  const marker = term.registerMarker();
  const decoration = term.registerDecoration({ marker, ...options });
  if (!decoration) throw new Error('no decoration');
  return decoration;
}

describe('registerDecoration', () => {
  test('creates a positioned element when the line is rendered', () => {
    const { term, container } = fixture.open({ cols: 20, rows: 5 });
    term.write('a\r\nb\r\n  prompt');
    const decoration = decorate(term, { x: 2, width: 6, height: 2 });
    const rendered: HTMLElement[] = [];
    decoration.onRender((el) => rendered.push(el));
    expect(decoration.element).toBeUndefined();

    render(term);
    const el = decoration.element!;
    const { w, h } = cell(term);
    expect(rendered).toEqual([el]);
    expect(el.classList.contains('xterm-decoration')).toBe(true);
    expect(el.style.position).toBe('absolute');
    expect(el.style.top).toBe(`${2 * h}px`);
    expect(el.style.left).toBe(`${2 * w}px`);
    expect(el.style.width).toBe(`${Math.round(6 * w)}px`);
    expect(el.style.height).toBe(`${2 * h}px`);
    expect(el.style.display).toBe('block');
    // The element sits in a container next to the canvas that doesn't cover it.
    const box = el.parentElement!;
    expect(box.parentElement).toBe(container);
    expect(box.style.height).toBe('0px');
  });

  test('follows the line as output scrolls it and hides it once off screen', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('a\r\nb\r\nmarked');
    const decoration = decorate(term, {});
    render(term);
    const { h } = cell(term);
    expect(decoration.element!.style.top).toBe(`${2 * h}px`);

    term.write('\r\nc');
    render(term);
    expect(decoration.element!.style.top).toBe(`${2 * h}px`);
    term.write('\r\nd\r\ne');
    render(term);
    expect(decoration.element!.style.top).toBe(`${1 * h}px`);

    term.write('\r\nf\r\ng');
    render(term);
    expect(decoration.element!.style.display).toBe('none');

    // Scrolling back brings it into view again.
    term.scrollToTop();
    render(term);
    expect(decoration.element!.style.display).toBe('block');
    expect(decoration.element!.style.top).toBe(`${2 * h}px`);
  });

  test('anchor right counts x from the right edge', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const decoration = decorate(term, { anchor: 'right', x: 3 });
    render(term);
    expect(decoration.element!.style.right).toBe(`${3 * cell(term).w}px`);
    expect(decoration.element!.style.left).toBe('');
  });

  test('a layer: top decoration gets the top-layer class', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const decoration = decorate(term, { layer: 'top' });
    render(term);
    expect(decoration.element!.classList.contains('xterm-decoration-top-layer')).toBe(true);
  });

  test('returns undefined for a disposed marker', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const marker = term.registerMarker();
    marker.dispose();
    expect(term.registerDecoration({ marker })).toBeUndefined();
  });

  test('is disposed with its marker, removing its element', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const decoration = decorate(term, {});
    render(term);
    const el = decoration.element!;
    let disposed = 0;
    decoration.onDispose(() => disposed++);
    decoration.marker.dispose();
    expect(decoration.isDisposed).toBe(true);
    expect(disposed).toBe(1);
    expect(el.isConnected).toBe(false);
  });

  test('dispose() removes the element but keeps the marker', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const decoration = decorate(term, {});
    render(term);
    const el = decoration.element!;
    decoration.dispose();
    expect(el.isConnected).toBe(false);
    expect(decoration.marker.isDisposed).toBe(false);
  });

  test('is disposed when its line is cleared away', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write(lines(3));
    const decoration = decorate(term, {});
    term.reset();
    expect(decoration.isDisposed).toBe(true);
  });

  test('backgroundColor and foregroundColor color the cells under it', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('a\r\nabcdef');
    decorate(term, { x: 1, width: 3, backgroundColor: '#123456', foregroundColor: '#abcdef' });
    const { w, h } = cell(term);
    const calls = render(term);
    const cells = paintedRects(calls, '#123456').map((r) => [r.x / w, r.y / h]);
    expect(cells).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    const colored = drawnText(term, calls).filter((t) => t.fillStyle === '#abcdef');
    expect(colored.map((t) => t.text).join('')).toBe('bcd');
  });

  test('the last registered decoration wins where colors overlap', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('abcdef');
    decorate(term, { width: 4, backgroundColor: '#111111', foregroundColor: '#222222' });
    decorate(term, { x: 2, width: 4, backgroundColor: '#333333' });
    const { w } = cell(term);
    const calls = render(term);
    expect(paintedRects(calls, '#111111').map((r) => r.x / w)).toEqual([0, 1]);
    expect(paintedRects(calls, '#333333').map((r) => r.x / w)).toEqual([2, 3, 4, 5]);
    // The first one's text color still applies where the second sets only a background.
    const fg = drawnText(term, calls).filter((t) => t.fillStyle === '#222222');
    expect(fg.map((t) => t.text).join('')).toBe('abcd');
  });

  test('colors move with the line', () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    term.write('x\r\nmarked');
    decorate(term, { width: 2, backgroundColor: '#123456' });
    const { h } = cell(term);
    expect(paintedRects(term, '#123456').map((r) => r.y / h)).toEqual([1, 1]);
    term.write(`\r\n${lines(3)}`);
    expect(paintedRects(term, '#123456').map((r) => r.y / h)).toEqual([0, 0]);
    term.write('\r\nmore');
    expect(paintedRects(term, '#123456')).toEqual([]);
  });

  test("the normal screen's decorations are hidden on the alternate screen", () => {
    const { term } = fixture.open({ cols: 20, rows: 5 });
    const decoration = decorate(term, { backgroundColor: '#123456' });
    render(term);
    term.write('\x1b[?1049h');
    render(term);
    expect(decoration.element!.style.display).toBe('none');
    expect(paintedRects(term, '#123456')).toEqual([]);
    term.write('\x1b[?1049l');
    render(term);
    expect(decoration.element!.style.display).toBe('block');
  });

  test('dispose() of the terminal removes the elements', () => {
    const term = fixture.create({ cols: 20, rows: 5 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    fixture.defer(() => container.remove());
    term.open(container);
    const decoration: IDecoration = decorate(term, {});
    render(term);
    term.dispose();
    expect(decoration.isDisposed).toBe(true);
    expect(container.querySelector('.xterm-decoration')).toBeNull();
    expect(container.children.length).toBe(0);
  });
});
