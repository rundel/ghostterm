import { type Page, expect, test } from '@playwright/test';
import { cellPixels, colorsOf, frames, geometry, openFixture, viewportText } from './helpers';
import { THEME } from './theme';

/** Set the size of the fixture's flex frame (with `fit`). */
const setFrame = (page: Page, width: number, height: number) =>
  page.evaluate(
    ([w, h]) => {
      const frame = document.getElementById('frame')!;
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
    },
    [width, height]
  );

/** What FitAddon should arrive at for a frame size: the terminal has 10px padding. */
async function expectedFit(page: Page, width: number, height: number) {
  const g = await geometry(page);
  const contentWidth = width - 20;
  return {
    cols: Math.floor((contentWidth - 15) / g.cellWidth),
    rows: Math.floor((height - 20) / g.cellHeight),
    canvasWidth: contentWidth,
  };
}

const layout = () => {
  const term = window.term;
  const canvas = term['canvas']!;
  const element = term.element!;
  const thumb = term['scrollbarThumb']();
  return {
    cols: term.cols,
    rows: term.rows,
    canvasWidth: canvas.getBoundingClientRect().width,
    overflow:
      element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
    gridWidth: term.cols * term['renderer']!.charWidth,
    thumbX: thumb.x,
  };
};

test(
  'FitAddon fills a flex layout through repeated resizes',
  { tag: '@cross' },
  async ({ page }) => {
    await openFixture(page, { fit: true });
    for (const [width, height] of [
      [600, 300],
      [480, 260],
      [733, 341],
      [401, 199],
    ]) {
      await setFrame(page, width, height);
      const want = await expectedFit(page, width, height);
      await expect
        .poll(() => page.evaluate(layout))
        .toMatchObject({ cols: want.cols, rows: want.rows });
      const now = await page.evaluate(layout);
      expect(now.canvasWidth).toBe(want.canvasWidth);
      expect(now.overflow).toBe(false);
      // The scrollbar sits right of the last column, never over it.
      expect(now.thumbX).toBeGreaterThanOrEqual(now.gridWidth);
    }

    // Two resizes within the debounce interval: the last one wins.
    await setFrame(page, 520, 280);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
    await setFrame(page, 650, 230);
    const want = await expectedFit(page, 650, 230);
    await expect
      .poll(() => page.evaluate(layout))
      .toMatchObject({ cols: want.cols, rows: want.rows });
    // And a resize right after one made from outside FitAddon is not ignored.
    await page.evaluate(() => window.term.resize(20, 5));
    await setFrame(page, 600, 300);
    const back = await expectedFit(page, 600, 300);
    await expect
      .poll(() => page.evaluate(layout))
      .toMatchObject({ cols: back.cols, rows: back.rows });
  }
);

test('resizing during heavy output', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await openFixture(page, { fit: true });

  // A program flooding output while the window is resized, by FitAddon and directly.
  await page.evaluate(async () => {
    let n = 0;
    const chunk = () => {
      let out = '';
      for (let i = 0; i < 200; i++)
        out += `\x1b[3${n % 8}mline ${n++} ${'x'.repeat(n % 70)}\x1b[0m\r\n`;
      return out;
    };
    const timer = setInterval(() => window.term.write(chunk()), 4);
    const frame = document.getElementById('frame')!;
    for (let i = 0; i < 20; i++) {
      frame.style.width = `${300 + ((i * 97) % 500)}px`;
      frame.style.height = `${150 + ((i * 53) % 250)}px`;
      if (i % 3 === 0) window.term.resize(20 + i * 3, 5 + i);
      await new Promise((r) => setTimeout(r, 25));
    }
    clearInterval(timer);
  });
  await setFrame(page, 600, 300);
  const want = await expectedFit(page, 600, 300);
  expect(await page.evaluate(() => window.fit!.proposeDimensions())).toEqual({
    cols: want.cols,
    rows: want.rows,
  });
  await expect
    .poll(() => page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows })))
    .toEqual({ cols: want.cols, rows: want.rows });
  await page.evaluate(() => window.term.write('\x1b[2J\x1b[Hsentinel'));
  await frames(page, 2);
  expect((await viewportText(page))[0]).toBe('sentinel');
  expect(colorsOf(await cellPixels(page, 0, 0, 8)).length).toBeGreaterThan(1);
  expect(colorsOf(await cellPixels(page, 0, 1, 8))).toEqual([THEME.background]);
  expect(errors).toEqual([]);
});

test('writes and resizes are not held up when animation frames stop (a hidden tab)', async ({
  page,
}) => {
  await openFixture(page);
  const result = await page.evaluate(() => {
    // Background tabs stop running animation frame callbacks.
    window.requestAnimationFrame = () => 0;
    window.term.write('before\r\n');
    window.term.resize(30, 6);
    window.term.write('after resize');
    const buffer = window.term.buffer.active;
    return {
      cols: window.term.cols,
      rows: window.term.rows,
      line: buffer.getLine(buffer.baseY + 1)!.translateToString(true),
    };
  });
  expect(result).toEqual({ cols: 30, rows: 6, line: 'after resize' });
});
