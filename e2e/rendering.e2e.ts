import fs from 'fs';
import { expect, test } from '@playwright/test';
import {
  cellPixels,
  columnsWithColor,
  countColor,
  geometry,
  nextFrame,
  openFixture,
  write,
} from './helpers';
import { THEME } from './theme';

/** Canvas backing size and CSS size. */
const canvasSize = () => {
  const canvas = window.term.element!.querySelector('canvas')!;
  return {
    width: canvas.width,
    height: canvas.height,
    cssWidth: Number.parseFloat(canvas.style.width),
    cssHeight: Number.parseFloat(canvas.style.height),
  };
};

test('the cursor follows DECSCUSR and DECTCEM', async ({ page }) => {
  await openFixture(page);
  const g = await geometry(page);
  const block = await cellPixels(page, 0, 0);
  expect(countColor(block, THEME.cursor)).toBe(block.width * block.height);

  // DECSCUSR 6: a steady bar at the left of the cell.
  await write(page, '\x1b[6 q');
  const bar = await cellPixels(page, 0, 0);
  const columns = columnsWithColor(bar, THEME.cursor);
  expect(columns.length).toBeGreaterThan(0);
  expect(columns[0]).toBe(0);
  expect(columns.length).toBeLessThanOrEqual(Math.ceil(g.cellWidth * g.scale * 0.3));
  expect(countColor(bar, THEME.background)).toBeGreaterThan(bar.width * bar.height * 0.6);

  // DECTCEM off: no cursor at all.
  await write(page, '\x1b[?25l');
  expect(countColor(await cellPixels(page, 0, 0), THEME.cursor)).toBe(0);
});

test(
  'without focus the cursor is a hollow block, and focus restores its shape',
  { tag: '@cross' },
  async ({ page }) => {
    await openFixture(page);
    await write(page, '\x1b[6 q');
    await page.locator('#before').focus();
    await nextFrame(page);
    const outline = await cellPixels(page, 0, 0);
    const { width: w, height: h } = outline;
    // Exactly the cell's edges, one CSS pixel wide (whole device pixels), with the background
    // inside.
    const t = Math.round((await geometry(page)).scale);
    const inside = (w - 2 * t) * (h - 2 * t);
    expect(countColor(outline, THEME.cursor)).toBe(w * h - inside);
    expect(columnsWithColor(outline, THEME.cursor)).toHaveLength(w);
    expect(countColor(outline, THEME.background)).toBe(inside);

    await page.evaluate(() => window.term.focus());
    await nextFrame(page);
    const bar = await cellPixels(page, 0, 0);
    expect(columnsWithColor(bar, THEME.cursor)[0]).toBe(0);
    expect(columnsWithColor(bar, THEME.cursor).length).toBeLessThan(w / 2);
    expect(countColor(bar, THEME.cursor)).toBe(columnsWithColor(bar, THEME.cursor).length * h);
  }
);

test.describe('at a fractional device pixel ratio', () => {
  test.use({ deviceScaleFactor: 1.25 });

  test('the canvas backing store is rounded, stable, and follows a ratio change', async ({
    page,
    browserName,
  }) => {
    await openFixture(page);
    const size = await page.evaluate(canvasSize);
    expect(size.width).toBe(Math.round(size.cssWidth * 1.25));
    expect(size.height).toBe(Math.round(size.cssHeight * 1.25));

    // Setting canvas.width (even to the same value) clears it and is an attribute change.
    const resizes = await page.evaluate(async () => {
      const canvas = window.term.element!.querySelector('canvas')!;
      let count = 0;
      const observer = new MutationObserver((records) => {
        count += records.length;
      });
      observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
      window.term.write('output while watching\r\n');
      for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
      observer.disconnect();
      return count;
    });
    expect(resizes).toBe(0);

    test.skip(browserName !== 'chromium', 'changes the ratio through the DevTools Protocol');
    const cdp = await page.context().newCDPSession(page);
    const viewport = page.viewportSize()!;
    // Emulation only re-evaluates media query listeners when the viewport changes too; a real
    // move to another screen fires the change by itself.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width - 1,
      height: viewport.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(2);
    await expect
      .poll(() => page.evaluate(canvasSize))
      .toEqual({ ...size, width: size.cssWidth * 2, height: size.cssHeight * 2 });
    // Still drawn: the cursor block covers its cell at the new ratio.
    await nextFrame(page);
    const cell = await cellPixels(page, 0, 1);
    expect(countColor(cell, THEME.cursor)).toBe(cell.width * cell.height);
  });
});

/** A wide proportional font, so its cells differ clearly from the monospace fallback's. */
const LATE_FONT = [
  '/System/Library/Fonts/Supplemental/Arial Black.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
].find((p) => fs.existsSync(p));

test('a web font that loads late is measured again', async ({ page }) => {
  test.skip(!LATE_FONT, 'no font file found to serve as a web font');
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/late-font.ttf', async (route) => {
    await held;
    await route.fulfill({ path: LATE_FONT, contentType: 'font/ttf' });
  });

  await openFixture(page, { fontFamily: '"Late Font", monospace' });
  await page.addStyleTag({
    content: `@font-face { font-family: "Late Font"; src: url(/late-font.ttf); }`,
  });
  const before = await page.evaluate(canvasSize);
  const cellBefore = (await geometry(page)).cellWidth;
  const loaded = page.evaluate(() => document.fonts.load('16px "Late Font"'));
  await nextFrame(page);
  expect(await page.evaluate(canvasSize)).toEqual(before);

  release();
  await loaded;
  await expect.poll(async () => (await geometry(page)).cellWidth).toBeGreaterThan(cellBefore);
  const after = await page.evaluate(canvasSize);
  const g = await geometry(page);
  expect(after.cssWidth).toBeGreaterThan(before.cssWidth);
  expect(after.cssWidth).toBe(g.cols * g.cellWidth + (before.cssWidth - g.cols * cellBefore));
  expect(after.cssHeight).toBe(g.rows * g.cellHeight);
});
