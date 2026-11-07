import { type Page, expect, test } from '@playwright/test';
import {
  canvasPixels,
  cellPixels,
  cellPoint,
  colorsOf,
  frames,
  geometry,
  mouseToCell,
  openFixture,
  sent,
  viewportText,
  write,
} from './helpers';
import { THEME } from './theme';

const lines = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `\r\nline ${from + i}`).join('');
const viewportY = () => window.term.buffer.active.viewportY;
const baseY = () => window.term.buffer.active.baseY;

/** The scrollbar gutter right of the grid, as drawn. */
async function gutterPixels(page: Page) {
  const g = await geometry(page);
  const width = await page.evaluate(() => Number.parseFloat(window.term['canvas']!.style.width));
  return canvasPixels(
    page,
    g.cols * g.cellWidth,
    0,
    width - g.cols * g.cellWidth,
    g.rows * g.cellHeight
  );
}

/** Where the scrollbar thumb is now, in page coordinates. */
async function thumb(page: Page) {
  const g = await geometry(page);
  const t = await page.evaluate(() => window.term['scrollbar']['host'].thumb());
  return {
    x: g.left + t.x + t.width / 2,
    top: g.top + t.y,
    bottom: g.top + t.y + t.height,
    trackTop: g.top + t.trackY,
  };
}

/** Values of viewportY seen on each frame for `ms`. */
const watchViewport = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const values: number[] = [];
    const end = performance.now() + ms;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      values.push(window.term.buffer.active.viewportY);
    }
    return [...new Set(values)];
  }, ms);

test(
  'a scrolled-up view keeps its content while output arrives',
  { tag: '@cross' },
  async ({ page }) => {
    await openFixture(page);
    await write(page, 'line 0' + lines(1, 300));
    const g = await geometry(page);
    await mouseToCell(page, 5, 5);
    await page.mouse.wheel(0, -10 * g.cellHeight);
    await expect.poll(() => page.evaluate(viewportY)).toBe((await page.evaluate(baseY)) - 10);
    // Let the scroll settle (and the scrollbar finish fading in) before taking the reference.
    await expect.poll(async () => (await watchViewport(page, 50)).length).toBe(1);
    const text = await viewportText(page);
    expect(text[0]).toBe('line 280');
    const grid = await cellPixels(page, 0, 0, g.cols, g.rows);

    for (let i = 0; i < 10; i++) await write(page, lines(300 + i * 5, 305 + i * 5));
    expect(await viewportText(page)).toEqual(text);
    expect(await cellPixels(page, 0, 0, g.cols, g.rows)).toEqual(grid);
    expect(await page.evaluate(baseY)).toBe(340);
  }
);

test('pruned history moves a scrolled-up view, which stays consistent', async ({ page }) => {
  await openFixture(page, { scrollback: 100 });
  await write(page, 'line 0' + lines(1, 300));
  const g = await geometry(page);
  await mouseToCell(page, 5, 5);
  await page.mouse.wheel(0, -50 * g.cellHeight);
  await expect.poll(async () => (await watchViewport(page, 50)).length).toBe(1);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  for (let i = 0; i < 20; i++) await write(page, lines(300 + i * 25, 325 + i * 25));
  const view = await page.evaluate(() => ({
    y: window.term.buffer.active.viewportY,
    base: window.term.buffer.active.baseY,
  }));
  expect(view.y).toBeGreaterThanOrEqual(0);
  expect(view.y).toBeLessThanOrEqual(view.base);
  // What is shown is a run of consecutive lines from the buffer.
  const text = await viewportText(page);
  const first = Number(text[0].split(' ')[1]);
  expect(text).toEqual(Array.from({ length: g.rows }, (_, i) => `line ${first + i}`));
  expect(errors).toEqual([]);
});

test('switching to the alternate screen while scrolled up shows it from the top', async ({
  page,
}) => {
  await openFixture(page);
  await write(page, 'line 0' + lines(1, 100));
  const g = await geometry(page);
  await mouseToCell(page, 5, 5);
  await page.mouse.wheel(0, -20 * g.cellHeight);
  await expect.poll(async () => (await watchViewport(page, 50)).length).toBe(1);
  expect(colorsOf(await gutterPixels(page)).length).toBeGreaterThan(1);

  await write(page, '\x1b[?1049h\x1b[HALT SCREEN');
  expect(await page.evaluate(() => window.term.buffer.active.type)).toBe('alternate');
  expect((await viewportText(page))[0]).toBe('ALT SCREEN');
  // No scrollback here: the gutter is plain background.
  await expect.poll(async () => colorsOf(await gutterPixels(page))).toEqual([THEME.background]);
});

test('the scrollbar: track clicks jump, the thumb drags, it fades out', async ({ page }) => {
  await openFixture(page);
  await write(page, 'line 0' + lines(1, 200));
  const base = await page.evaluate(baseY);

  // Shown after scrolling, then faded out entirely.
  await page.evaluate(() => window.term.scrollLines(-1));
  await expect.poll(async () => colorsOf(await gutterPixels(page)).length).toBeGreaterThan(1);
  await expect
    .poll(async () => colorsOf(await gutterPixels(page)), { timeout: 4000 })
    .toEqual([THEME.background]);

  // A click on the track above the thumb jumps there: near the top, the oldest lines.
  let t = await thumb(page);
  await page.mouse.click(t.x, t.trackTop + 2);
  await expect.poll(() => page.evaluate(viewportY)).toBeLessThan(5);
  expect(await page.evaluate(() => window.term.hasSelection())).toBe(false);

  // Drag the thumb down by half the track, letting go to the right of the terminal.
  t = await thumb(page);
  const g = await geometry(page);
  const grab = (t.top + t.bottom) / 2;
  await page.mouse.move(t.x, grab);
  await page.mouse.down();
  await page.mouse.move(t.x, grab + (g.rows * g.cellHeight) / 2, { steps: 4 });
  await page.mouse.move(t.x + 200, grab + (g.rows * g.cellHeight) / 2, { steps: 2 });
  await page.mouse.up();
  const dragged = await page.evaluate(viewportY);
  expect(dragged).toBeGreaterThan(base / 3);
  expect(dragged).toBeLessThan(base);
  // Released: moving the mouse no longer scrolls.
  await page.mouse.move(t.x, g.top + 2, { steps: 3 });
  await frames(page, 2);
  expect(await page.evaluate(viewportY)).toBe(dragged);
  expect(await page.evaluate(() => window.term.hasSelection())).toBe(false);
});

test('the last pixel column of the grid is a cell, not the scrollbar', async ({ page }) => {
  await openFixture(page);
  await write(page, 'line 0' + lines(1, 50) + '\x1b[?1000h\x1b[?1006h');
  const g = await geometry(page);
  const before = await page.evaluate(viewportY);
  const p = cellPoint(g, g.cols - 1, 3, 0.95);
  await page.mouse.click(p.x, p.y);
  expect(await sent(page)).toBe(`\x1b[<0;${g.cols};4M\x1b[<0;${g.cols};4m`);
  expect(await page.evaluate(viewportY)).toBe(before);
});

test('a jump cancels a running smooth scroll', { tag: '@cross' }, async ({ page }) => {
  await openFixture(page, { smoothScrollDuration: 200 });
  await write(page, 'line 0' + lines(1, 200));
  const g = await geometry(page);
  await mouseToCell(page, 5, 5);

  await page.mouse.wheel(0, -30 * g.cellHeight);
  await page.evaluate(() => window.term.scrollToLine(20));
  expect(await watchViewport(page, 400)).toEqual([20]);

  await page.mouse.wheel(0, -30 * g.cellHeight);
  await page.evaluate(() => window.term.scrollToBottom());
  expect(await watchViewport(page, 400)).toEqual([await page.evaluate(baseY)]);
});
