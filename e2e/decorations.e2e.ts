import { type Page, expect, test } from '@playwright/test';
import { frames, geometry, openFixture, write } from './helpers';

const lines = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `\r\nline ${from + i}`).join('');

/** Register a decoration on the cursor line, kept in window.log[0]. */
async function decorate(page: Page, options: { x?: number; width?: number } = {}) {
  await page.evaluate((o) => {
    const marker = window.term.registerMarker();
    const decoration = window.term.registerDecoration({ marker, ...o })!;
    decoration.onRender((el) => {
      el.style.background = 'rgba(255, 0, 0, 0.5)';
    });
    window.log[0] = decoration;
  }, options);
}

/** The decoration element's box in page coordinates, or null while it is hidden. */
async function box(page: Page) {
  return page.evaluate(() => {
    const el = (window.log[0] as { element?: HTMLElement }).element;
    if (!el || getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

test('a decoration element sits over its cells and follows its line while scrolling', async ({
  page,
}) => {
  await openFixture(page, { cols: 40, rows: 10, smoothScrollDuration: 0 });
  await write(page, `first${lines(0, 3)}\r\nmarked`);
  await decorate(page, { x: 2, width: 5 });
  await frames(page, 2);
  const g = await geometry(page);

  const at = (row: number) => ({
    left: g.left + 2 * g.cellWidth,
    top: g.top + row * g.cellHeight,
  });
  let b = await box(page);
  expect(b).not.toBeNull();
  expect(b!.left).toBeCloseTo(at(4).left, 0);
  expect(b!.top).toBeCloseTo(at(4).top, 0);
  expect(b!.width).toBeCloseTo(Math.round(5 * g.cellWidth), 0);
  expect(b!.height).toBeCloseTo(g.cellHeight, 0);

  // Output pushes the line up.
  await write(page, lines(3, 10));
  await frames(page, 2);
  b = await box(page);
  expect(b!.top).toBeCloseTo(at(2).top, 0);

  // Off the top: hidden.
  await write(page, lines(10, 15));
  await frames(page, 2);
  expect(await box(page)).toBeNull();

  // Scrolling the history back shows it again, where its line is drawn.
  await page.evaluate(() => window.term.scrollLines(-6));
  await frames(page, 2);
  b = await box(page);
  expect(b!.top).toBeCloseTo(at(3).top, 0);
  const row = await page.evaluate(() => {
    const term = window.term;
    const marker = (window.log[0] as { marker: { line: number } }).marker;
    return marker.line - term.buffer.active.viewportY;
  });
  expect(row).toBe(3);

  // Away from the element, the pointer is over the canvas: the container doesn't cover it.
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName,
    [g.left + 20 * g.cellWidth, g.top + 5 * g.cellHeight]
  );
  expect(hit).toBe('CANVAS');
});
