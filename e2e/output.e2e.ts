import { expect, test } from '@playwright/test';
import { cellPixels, frames, geometry, openFixture, write } from './helpers';

const ESC = '\x1b';

test('synchronized output (2026) holds the frame until it ends', async ({ page }) => {
  await openFixture(page);
  await write(page, 'frame A');
  const g = await geometry(page);
  const frameA = await cellPixels(page, 0, 0, g.cols, 2);

  await write(page, `${ESC}[?2026h${ESC}[2J${ESC}[Hframe B, drawn in pieces`);
  await frames(page, 5);
  expect(await cellPixels(page, 0, 0, g.cols, 2)).toEqual(frameA);

  await write(page, `${ESC}[?2026l`);
  expect(await cellPixels(page, 0, 0, g.cols, 2)).not.toEqual(frameA);
  expect(
    await page.evaluate(() => window.term.buffer.active.getLine(0)!.translateToString(true))
  ).toBe('frame B, drawn in pieces');
});

test('a synchronized update that never ends is shown after about a second', async ({ page }) => {
  await openFixture(page);
  await write(page, 'frame A');
  const g = await geometry(page);
  const frameA = await cellPixels(page, 0, 0, g.cols, 2);

  const started = Date.now();
  await write(page, `${ESC}[?2026h${ESC}[2J${ESC}[Hframe B`);
  await expect
    .poll(
      async () => (await cellPixels(page, 0, 0, g.cols, 2)).data.join() !== frameA.data.join(),
      {
        timeout: 3000,
        intervals: [50],
      }
    )
    .toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});

test('echoed input is drawn at once, not on a later frame', async ({ page }) => {
  await openFixture(page);
  // A program echoing what it is sent, as a shell does, from inside the onData listener; the
  // canvas is read right after the echo is written, before any animation frame.
  await page.evaluate(() => {
    const canvas = window.term['canvas']!;
    const ctx = canvas.getContext('2d')!;
    const { charWidth, charHeight } = window.term['renderer']!;
    window.term.onData((data) => {
      const x = window.term.buffer.active.cursorX;
      window.term.write(data);
      const scale = canvas.width / Number.parseFloat(canvas.style.width);
      const px = ctx.getImageData(
        Math.round(x * charWidth * scale),
        0,
        Math.round(charWidth * scale),
        Math.round(charHeight * scale)
      ).data;
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] > 128 && px[i + 1] > 128) lit++;
      window.log.push(lit);
    });
  });
  await page.keyboard.type('MW');
  const lit = (await page.evaluate(() => window.log)) as number[];
  expect(lit).toHaveLength(2);
  for (const n of lit) expect(n).toBeGreaterThan(10);
});
