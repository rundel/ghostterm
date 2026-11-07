import { expect, test } from '@playwright/test';
import {
  cellPixels,
  cellPoint,
  countTinted,
  geometry,
  mouseToCell,
  openFixture,
  write,
} from './helpers';
import { LINK_COLOR } from './theme';

const pointer = () => window.term.element!.querySelector('canvas')!.style.cursor;

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

test('a hovered URL is underlined, until output replaces it under the pointer', async ({
  page,
}) => {
  const url = 'https://example.com/path';
  await write(page, `\x1b[2;1Hsee ${url} here`);
  const underline = () =>
    cellPixels(page, 4, 1, url.length).then((px) => countTinted(px, LINK_COLOR));
  expect(await underline()).toBe(0);

  await mouseToCell(page, 10, 1);
  await expect.poll(() => page.evaluate(pointer)).toBe('pointer');
  await expect.poll(underline).toBeGreaterThan(url.length * (await geometry(page)).cellWidth * 0.8);

  // The same row rewritten without a link, the pointer not moving.
  await write(page, '\x1b[2;1H\x1b[2Kno link on this row anymore');
  await expect.poll(() => page.evaluate(pointer)).toBe('text');
  await expect.poll(underline).toBe(0);
});

test('Ctrl/Cmd+click opens an OSC 8 link, but not a javascript: one', async ({ page }) => {
  await page.evaluate(() => {
    window.open = (url?: string | URL) => {
      window.log.push(String(url));
      return null;
    };
  });
  await write(
    page,
    '\x1b]8;;https://example.com/osc\x07docs\x1b]8;;\x07 and ' +
      '\x1b]8;;javascript:alert(1)\x07trap\x1b]8;;\x07'
  );
  const g = await geometry(page);
  const opened = () => page.evaluate(() => window.log);
  const modClick = async (p: { x: number; y: number }) => {
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('ControlOrMeta');
  };

  const docs = cellPoint(g, 1, 0);
  await page.mouse.click(docs.x, docs.y);
  expect(await opened()).toEqual([]);
  await modClick(docs);
  expect(await opened()).toEqual(['https://example.com/osc']);

  await mouseToCell(page, 10, 0);
  // It is a link (it gets the pointer), so the click below does reach it.
  await expect.poll(() => page.evaluate(pointer)).toBe('pointer');
  const trap = cellPoint(g, 10, 0);
  await modClick(trap);
  expect(await opened()).toEqual(['https://example.com/osc']);
});
