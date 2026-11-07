import { expect, test } from '@playwright/test';
import { cellPoint, geometry, mouseToCell, openFixture, sent, write } from './helpers';

const readClipboard = () => navigator.clipboard.readText();

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFixture(page);
  await page.evaluate(() => navigator.clipboard.writeText('(empty)'));
});

test('Ctrl+V is a key for the program, not a paste', async ({ page }) => {
  await mouseToCell(page, 1, 1);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Control+v');
  expect(await sent(page)).toBe('\x16');
});

test('Cmd+C and Ctrl+Shift+C copy the selection and send nothing', async ({ page }) => {
  await write(page, 'hello world\r\nsecond line');
  await page.evaluate(() => window.term.select(0, 0, 5));
  await page.keyboard.press('Meta+c');
  await expect.poll(() => page.evaluate(readClipboard)).toBe('hello');

  await page.evaluate(() => window.term.select(6, 0, 5));
  await page.keyboard.press('Control+Shift+c');
  await expect.poll(() => page.evaluate(readClipboard)).toBe('world');
  expect(await sent(page)).toBe('');

  // Without a selection Ctrl+Shift+C goes to the program.
  await page.evaluate(() => window.term.clearSelection());
  await page.keyboard.press('Control+Shift+c');
  expect(await sent(page)).toBe('\x03');
});

test('selecting with the mouse copies the selection', async ({ page }) => {
  await write(page, 'first line\r\ncopy this text');
  const g = await geometry(page);
  const from = cellPoint(g, 0, 1, 0.2);
  const to = cellPoint(g, 8, 1, 0.8);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(readClipboard)).toBe('copy this');
  expect(await page.evaluate(() => window.term.getSelection())).toBe('copy this');
  expect(await sent(page)).toBe('');
});
