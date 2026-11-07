import { expect, test } from '@playwright/test';
import {
  cellPoint,
  clearSent,
  geometry,
  mouseToCell,
  nextFrame,
  openFixture,
  sent,
  write,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

test(
  'a drag reported to the program is clamped to the grid and released outside',
  { tag: '@cross' },
  async ({ page }) => {
    await write(page, '\x1b[?1002h\x1b[?1006h');
    const g = await geometry(page);
    await mouseToCell(page, 2, 3);
    await page.mouse.down();
    expect(await sent(page)).toBe('\x1b[<0;3;4M');

    // Past the right edge of the canvas, on the same row.
    const outside = cellPoint(g, g.cols + 10, 3);
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.up();
    expect(await sent(page)).toBe(`\x1b[<0;3;4M\x1b[<32;${g.cols};4M\x1b[<0;${g.cols};4m`);

    // With the button up, mode 1002 reports no motion.
    await clearSent(page);
    await mouseToCell(page, 5, 5);
    await page.mouse.move(outside.x, outside.y + 20);
    await nextFrame(page);
    expect(await sent(page)).toBe('');
  }
);

test(
  'the wheel on the alternate screen sends arrow keys, unless 1007 is off',
  { tag: '@cross' },
  async ({ page }) => {
    await write(page, '\x1b[?1049h');
    const g = await geometry(page);
    await mouseToCell(page, 5, 5);

    await page.mouse.wheel(0, 3 * g.cellHeight);
    await expect.poll(() => sent(page)).toBe('\x1b[B'.repeat(3));
    await clearSent(page);
    await page.mouse.wheel(0, -2 * g.cellHeight);
    await expect.poll(() => sent(page)).toBe('\x1b[A'.repeat(2));

    await clearSent(page);
    await write(page, '\x1b[?1007l');
    await page.mouse.wheel(0, 3 * g.cellHeight);
    await nextFrame(page);
    expect(await sent(page)).toBe('');
  }
);

test(
  'the wheel scrolls history and typing returns to the bottom for good',
  { tag: '@cross' },
  async ({ page }) => {
    await write(page, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n'));
    const g = await geometry(page);
    const viewportY = () => page.evaluate(() => window.term.buffer.active.viewportY);
    const baseY = await page.evaluate(() => window.term.buffer.active.baseY);
    expect(baseY).toBe(40);
    expect(await viewportY()).toBe(baseY);
    await mouseToCell(page, 5, 5);

    await page.mouse.wheel(0, -3 * g.cellHeight);
    await expect.poll(viewportY).toBe(baseY - 3);

    // Type while a smooth scroll is still running: the view goes to the bottom, and the
    // animation must not pull it back up when it would have finished.
    await page.mouse.wheel(0, -5 * g.cellHeight);
    await page.keyboard.press('a');
    expect(await sent(page)).toBe('a');
    const seen = await page.evaluate(async () => {
      const values: number[] = [];
      const end = performance.now() + 300; // three times smoothScrollDuration
      while (performance.now() < end) {
        await new Promise((r) => requestAnimationFrame(r));
        values.push(window.term.buffer.active.viewportY);
      }
      return [...new Set(values)];
    });
    expect(seen).toEqual([baseY]);
  }
);

test(
  'the wheel is reported once per notch or per cell of trackpad movement',
  {
    tag: '@cross',
  },
  async ({ page }) => {
    await write(page, '\x1b[?1000h\x1b[?1006h');
    const g = await geometry(page);
    await mouseToCell(page, 4, 2);

    // A mouse wheel notch: about 100 px.
    await page.mouse.wheel(0, 100);
    await expect.poll(() => sent(page)).toBe('\x1b[<65;5;3M');
    await clearSent(page);
    await page.mouse.wheel(0, -200);
    await expect.poll(() => sent(page)).toBe('\x1b[<64;5;3M'.repeat(2));

    // Trackpad movement adds up: one report per cell height.
    await clearSent(page);
    const step = g.cellHeight / 3;
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, step);
    await expect.poll(() => sent(page)).toBe('\x1b[<65;5;3M'.repeat(2));
  }
);

test(
  'a custom wheel handler returning false stops the report',
  {
    tag: '@cross',
  },
  async ({ page }) => {
    await write(page, '\x1b[?1000h\x1b[?1006h');
    await page.evaluate(() => window.term.attachCustomWheelEventHandler(() => false));
    await mouseToCell(page, 4, 2);
    await page.mouse.wheel(0, 100);
    await nextFrame(page);
    expect(await sent(page)).toBe('');
    await page.evaluate(() => window.term.attachCustomWheelEventHandler(() => true));
    await page.mouse.wheel(0, 100);
    await expect.poll(() => sent(page)).toBe('\x1b[<65;5;3M');
  }
);

test(
  'Shift+drag selects even while a program tracks the mouse',
  {
    tag: '@cross',
  },
  async ({ page }) => {
    await write(page, 'select me please\x1b[?1002h\x1b[?1006h');
    const g = await geometry(page);
    const from = cellPoint(g, 0, 0, 0.2);
    const to = cellPoint(g, 8, 0, 0.8);
    await page.keyboard.down('Shift');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    expect(await page.evaluate(() => window.term.getSelection())).toBe('select me');
    expect(await sent(page)).toBe('');

    // Without Shift the same press is the program's.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.up();
    expect(await sent(page)).toBe('\x1b[<0;1;1M\x1b[<0;1;1m');
  }
);

test('the pointer takes the shape a program asks for (OSC 22)', async ({ page }) => {
  const shape = () =>
    page.evaluate(() => window.term.element!.querySelector('canvas')!.style.cursor);
  expect(await shape()).toBe('text');
  await write(page, '\x1b]22;pointer\x1b\\');
  expect(await shape()).toBe('pointer');
  await write(page, '\x1b]22;crosshair\x1b\\');
  expect(await shape()).toBe('crosshair');
  // `default` is the arrow, not the text cursor.
  await write(page, '\x1b]22;default\x1b\\');
  expect(await shape()).toBe('default');
});
