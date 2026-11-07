import { expect, test } from '@playwright/test';
import {
  cellPixels,
  cellPoint,
  columnsWithColor,
  countColor,
  countTinted,
  geometry,
  nextFrame,
  openFixture,
  write,
} from './helpers';
import { THEME } from './theme';

test('the selection highlight covers complex scripts, wide characters and emoji', async ({
  page,
}) => {
  await openFixture(page);
  const text = 'ab कवि 日本 😀 cd';
  await write(page, text);
  // Columns as libghostty laid them out: where 日 starts, and where the text ends.
  const layout = await page.evaluate(() => {
    const line = window.term.buffer.active.getLine(0)!;
    let cjk = -1;
    let end = 0;
    for (let x = 0; x < window.term.cols; x++) {
      const cell = line.getCell(x)!;
      if (cell.getChars() === '日') cjk = x;
      if (cell.getChars()) end = x + Math.max(1, cell.getWidth());
    }
    return { cjk, end };
  });
  expect(layout.cjk).toBeGreaterThan(0);
  await page.evaluate((n) => window.term.select(0, 0, n), layout.end);
  await nextFrame(page);
  expect(await page.evaluate(() => window.term.getSelection())).toBe(text);

  // Every selected cell is highlighted, with no gaps after clusters or wide characters (where
  // the theme background would show), and nothing after the selection is.
  for (let x = 0; x < layout.end; x++) {
    const px = await cellPixels(page, x, 0);
    expect(countColor(px, THEME.selectionBackground), `column ${x}`).toBeGreaterThan(0);
    expect(countColor(px, THEME.background, 2), `column ${x}`).toBe(0);
  }
  expect(countColor(await cellPixels(page, layout.end, 0), THEME.selectionBackground)).toBe(0);
  // The CJK glyphs are drawn over it, in the selection foreground.
  const cjk = await cellPixels(page, layout.cjk, 0, 4);
  expect(countTinted(cjk, THEME.selectionForeground, 0.6)).toBeGreaterThan(20);
});

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${String(i).padStart(3, '0')}`).join('\r\n');
const selection = () => window.term.getSelection();
const position = () => window.term.getSelectionPosition();
const viewportY = () => window.term.buffer.active.viewportY;

test('dragging past the top or bottom autoscrolls and extends the selection', async ({ page }) => {
  await openFixture(page);
  await write(page, lines(200));
  const g = await geometry(page);
  const baseY = await page.evaluate(() => window.term.buffer.active.baseY);
  expect(baseY).toBe(190);

  // Press at the start of viewport row 5 (line 195), hold the pointer above the canvas.
  const anchor = cellPoint(g, 0, 5, 0.1);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down();
  await page.mouse.move(anchor.x, g.top - 40, { steps: 3 });
  await expect.poll(() => page.evaluate(viewportY)).toBeLessThanOrEqual(baseY - 15);
  await page.mouse.up();

  const top = await page.evaluate(viewportY);
  const start = (await page.evaluate(position))!.start;
  // The selection reaches the top row shown, in the scrollback, and every line from there to
  // the anchor, in order.
  expect(start.y).toBeLessThan(baseY);
  expect(Math.abs(start.y - top)).toBeLessThanOrEqual(1);
  const selected = (await page.evaluate(selection)).split('\n').map((l) => l.trimEnd());
  const expected = Array.from(
    { length: 195 - start.y },
    (_, i) => `line ${String(start.y + i).padStart(3, '0')}`
  );
  expect(selected.slice(0, expected.length)).toEqual(
    expected.map((l, i) => (i ? l : l.slice(start.x)))
  );

  // Down again, from a press in the middle of the scrolled view.
  await page.evaluate(() => window.term.clearSelection());
  const from = cellPoint(g, 0, 2, 0.1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const anchorRow = await page.evaluate(() => window.term.buffer.active.viewportY + 2);
  await page.mouse.move(from.x, g.top + g.rows * g.cellHeight + 40, { steps: 3 });
  await expect.poll(() => page.evaluate(viewportY)).toBeGreaterThanOrEqual(anchorRow + 5);
  await page.mouse.up();
  const down = (await page.evaluate(position))!;
  expect(down.start.y).toBe(anchorRow);
  const bottom = await page.evaluate(() => window.term.buffer.active.viewportY + 9);
  expect(Math.abs(down.end.y - bottom)).toBeLessThanOrEqual(1);
  expect((await page.evaluate(selection)).split('\n')[0]).toBe(
    `line ${String(anchorRow).padStart(3, '0')}`
  );
});

test('a selection stays on its text while output arrives', { tag: '@cross' }, async ({ page }) => {
  await openFixture(page);
  await write(page, lines(30));

  // At the bottom: new lines push the selected text up, the selection goes with it.
  await page.evaluate(() => window.term.selectLines(25, 26));
  expect(await page.evaluate(selection)).toBe('line 025\nline 026');
  await write(page, '\r\nmore output\r\nand more');
  expect(await page.evaluate(selection)).toBe('line 025\nline 026');

  // Scrolled up: the view and the selection both stay on the same text.
  await page.evaluate(() => window.term.scrollLines(-10));
  const top = await page.evaluate(viewportY);
  await page.evaluate(() =>
    window.term.selectLines(
      window.term.buffer.active.viewportY + 1,
      window.term.buffer.active.viewportY + 1
    )
  );
  const text = await page.evaluate(selection);
  for (let i = 0; i < 5; i++) await write(page, `\r\nscrolling output ${i}`);
  expect(await page.evaluate(viewportY)).toBe(top);
  expect(await page.evaluate(selection)).toBe(text);
});

test(
  'double click selects a path, triple click a wrapped line',
  { tag: '@cross' },
  async ({ page }) => {
    await openFixture(page, { cols: 20 });
    // 29 characters: soft-wrapped onto a second row.
    await write(page, 'echo /usr/local/bin/tool.sh x\r\nnext');
    const g = await geometry(page);
    const path = cellPoint(g, 10, 0);
    await page.mouse.dblclick(path.x, path.y);
    expect(await page.evaluate(selection)).toBe('/usr/local/bin/tool.sh');

    const p = cellPoint(g, 3, 1);
    await page.mouse.click(p.x, p.y, { clickCount: 3 });
    expect(await page.evaluate(selection)).toBe('echo /usr/local/bin/tool.sh x');
  }
);

test(
  'Alt+drag selects a block, Shift+arrows extend a selection',
  { tag: '@cross' },
  async ({ page }) => {
    await openFixture(page);
    await write(page, 'abcdefgh\r\nijklmnop\r\nqrstuvwx');
    const g = await geometry(page);
    const from = cellPoint(g, 2, 0, 0.2);
    const to = cellPoint(g, 4, 2, 0.8);
    await page.keyboard.down('Alt');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect(await page.evaluate(selection)).toBe('cde\nklm\nstu');
    // Drawn as a block: the middle row is highlighted only in the selected columns.
    await nextFrame(page);
    const row = await cellPixels(page, 0, 1, 8);
    const highlighted = columnsWithColor(row, THEME.selectionBackground);
    const cell = row.width / 8;
    expect(highlighted[0]).toBe(Math.round(2 * cell));
    expect(highlighted[highlighted.length - 1]).toBe(Math.round(5 * cell) - 1);

    await page.evaluate(() => window.term.select(0, 0, 3));
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    expect(await page.evaluate(selection)).toBe('abcde');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await page.evaluate(selection)).toBe('abcdefgh\nijklm');
    expect(await page.evaluate(() => window.sent)).toEqual([]);
  }
);
