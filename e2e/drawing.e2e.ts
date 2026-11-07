import { expect, test } from '@playwright/test';
import {
  canvasPixels,
  cellPixels,
  colorsOf,
  columnsWithColor,
  countColor,
  countTinted,
  countTransparent,
  frames,
  geometry,
  openFixture,
  rowsWithColor,
  write,
} from './helpers';
import { LIGHT_THEME, THEME } from './theme';

const ESC = '\x1b';

/** Output heavy in colors and SGR resets, like ghostty.test.ts's stress payload. */
function colorfulOutput(rows: number): string {
  let out = '';
  for (let row = 0; row < rows; row++) {
    out += `${ESC}[38;5;${(row * 17) % 256}mR${row}${ESC}[0m `;
    for (let i = 0; i < 12; i++) out += `${ESC}[48;5;${(row * 12 + i) % 256}m  ${ESC}[0m`;
    out += `${ESC}[48;2;${row % 256};80;160m tail ${ESC}[0m${ESC}[K\r\n`;
  }
  return out;
}

test('rows scrolled in after colorful output are clean', async ({ page }) => {
  await openFixture(page);
  for (let i = 0; i < 30; i++) await write(page, colorfulOutput(15));
  const g = await geometry(page);
  // Push everything off screen with empty lines: only the background may be left.
  await write(page, '\r\n'.repeat(g.rows));
  const rows = await cellPixels(page, 0, 0, g.cols, g.rows - 1);
  expect(colorsOf(rows)).toEqual([THEME.background]);
  // The cursor's row, right of the cursor.
  expect(colorsOf(await cellPixels(page, 1, g.rows - 1, g.cols - 1))).toEqual([THEME.background]);
});

test('the block cursor shows its character in the accent color, follows OSC 12, and covers a wide character', async ({
  page,
}) => {
  await openFixture(page);
  await write(page, 'M\b');
  const cell = await cellPixels(page, 0, 0);
  expect(countColor(cell, THEME.cursor)).toBeGreaterThan(cell.width * cell.height * 0.3);
  expect(countColor(cell, THEME.cursorAccent, 40)).toBeGreaterThan(5);
  expect(countColor(cell, THEME.foreground, 40)).toBe(0);

  await write(page, `${ESC}]12;#ff0000${ESC}\\`);
  const red = await cellPixels(page, 0, 0);
  expect(countColor(red, '#ff0000')).toBeGreaterThan(red.width * red.height * 0.3);
  expect(countColor(red, THEME.cursor)).toBe(0);

  await write(page, `${ESC}]112${ESC}\\\r\n日\b\b`);
  const wide = await cellPixels(page, 0, 1, 2);
  expect(columnsWithColor(wide, THEME.cursor)).toHaveLength(wide.width);
});

test('theme colors: changed after open, black backgrounds on a light theme, OSC 11', async ({
  page,
}) => {
  await openFixture(page, { theme: 'light' });
  await write(page, `${ESC}[40m    ${ESC}[0m`);
  const black = await cellPixels(page, 0, 0, 4);
  expect(colorsOf(black)).toEqual(['#000000']);
  expect(colorsOf(await cellPixels(page, 5, 0, 4))).toEqual([LIGHT_THEME.background]);

  await page.evaluate(() => {
    window.term.options.theme = { ...window.term.options.theme, background: '#0000aa' };
  });
  await frames(page, 2);
  expect(colorsOf(await cellPixels(page, 5, 2, 4))).toEqual(['#0000aa']);
  expect(colorsOf(black)).toEqual(['#000000']);

  await write(page, `${ESC}]11;#336699${ESC}\\`);
  expect(colorsOf(await cellPixels(page, 5, 2, 4))).toEqual(['#336699']);
  expect(colorsOf(await cellPixels(page, 0, 0, 4))).toEqual(['#000000']);
});

test('a transparent background stays transparent with allowTransparency', async ({ page }) => {
  await openFixture(page, { theme: 'transparent', allowTransparency: true });
  const g = await geometry(page);
  for (let i = 0; i < 20; i++) await write(page, `output line ${i}\r\n`);
  await write(page, `${ESC}[2J${ESC}[H`);
  await frames(page, 5);
  const px = await cellPixels(page, 1, 0, g.cols - 1, g.rows);
  expect(countTransparent(px)).toBe(px.width * px.height);
});

test('without allowTransparency a transparent background is drawn opaque', async ({ page }) => {
  await openFixture(page, { theme: 'transparent' });
  const g = await geometry(page);
  await write(page, 'output\r\n');
  // Right of the cursor, below the text.
  const px = await cellPixels(page, 1, 1, g.cols - 1, g.rows - 1);
  expect(countTransparent(px)).toBe(0);
  expect(colorsOf(px)).toEqual(['#000000']);
  // The scrollbar gutter too.
  const gutter = await canvasPixels(page, g.cols * g.cellWidth, 0, 10, g.rows * g.cellHeight);
  expect(countTransparent(gutter)).toBe(0);
});

test('underline styles, underline color and overline are drawn differently', async ({ page }) => {
  await openFixture(page);
  // Spaces, so only the decorations draw; underlines in red (SGR 58).
  const styles = ['4:1', '4:2', '4:3', '4:4', '4:5'];
  let line = '';
  for (const style of styles) line += `${ESC}[${style};58;2;255;0;0m      ${ESC}[0m  `;
  await write(page, `${line}\r\n${ESC}[53;31m      ${ESC}[0m`);

  const shapes = [];
  for (let i = 0; i < styles.length; i++) {
    const px = await cellPixels(page, i * 8, 0, 6);
    shapes.push({
      pixels: px.data.join(),
      rows: rowsWithColor(px, '#ff0000', 140).length,
      // Rows in the full color: lines on whole device pixels have no blurred edges.
      solidRows: rowsWithColor(px, '#ff0000'),
      cols: columnsWithColor(px, '#ff0000', 140).length,
      width: px.width,
    });
  }
  // Each style draws something of its own, in the underline color.
  expect(new Set(shapes.map((s) => s.pixels)).size).toBe(styles.length);
  const [single, double, curly, dotted, dashed] = shapes;
  expect(single.rows).toBeGreaterThan(0);
  expect(single.cols).toBe(single.width);
  expect(curly.cols).toBe(curly.width);

  // Crisp: single is one solid band of whole pixel rows and nothing else; double is two such
  // bands with a gap of background between them; curly rises and falls over several rows.
  const thick = Math.max(1, Math.round((await geometry(page)).scale));
  expect(single.solidRows).toHaveLength(thick);
  expect(single.rows).toBe(thick);
  expect(double.solidRows).toHaveLength(2 * thick);
  expect(double.rows).toBe(2 * thick);
  const gap = double.solidRows[thick] - double.solidRows[thick - 1] - 1;
  expect(gap).toBe(thick);
  expect(curly.rows).toBeGreaterThanOrEqual(4 * thick);
  // Double covers more rows than single; dotted and dashed leave gaps, dotted more of them.
  expect(double.rows).toBeGreaterThan(single.rows);
  expect(dotted.cols).toBeLessThan(dotted.width / 2);
  expect(dashed.cols).toBeLessThan(dashed.width);
  expect(dashed.cols).toBeGreaterThan(dotted.cols);

  // The overline: at the top of the cell, in the text color.
  const over = await cellPixels(page, 0, 1, 6);
  const overRows = rowsWithColor(over, '#cd3131', 60);
  expect(overRows.length).toBeGreaterThan(0);
  expect(overRows[overRows.length - 1]).toBeLessThan(over.height / 4);
  expect(countTinted(over, '#cd3131', 0.3)).toBeGreaterThan(0);
});
