import { expect, test } from '@playwright/test';
import { mouseToCell, nextFrame, openFixture, sent } from './helpers';

test('IME composition happens in the textarea and the commit is sent once', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'drives the IME through the Chrome DevTools Protocol');
  await openFixture(page);
  await page.evaluate(() => {
    for (const type of ['compositionstart', 'compositionend']) {
      document.addEventListener(type, (e) => {
        window.log.push([type, (e.target as Element).tagName]);
      });
    }
  });
  await mouseToCell(page, 0, 0);
  await page.mouse.down();
  await page.mouse.up();

  const cdp = await page.context().newCDPSession(page);
  const compose = (text: string) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  await compose('n');
  await compose('に');
  await compose('にほん');
  await compose('日本');
  await nextFrame(page);
  expect(await sent(page)).toBe('');

  await cdp.send('Input.insertText', { text: '日本' });
  await nextFrame(page);
  expect(await sent(page)).toBe('日本');
  expect(await page.evaluate(() => window.log)).toEqual([
    ['compositionstart', 'TEXTAREA'],
    ['compositionend', 'TEXTAREA'],
  ]);
  expect(await page.evaluate(() => document.activeElement === window.term.textarea)).toBe(true);

  // Typing after the commit is not mixed up with it.
  await page.keyboard.type('x');
  expect(await sent(page)).toBe('日本x');
});

test('a composition interrupted by losing focus does not block typing', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'drives the IME through the Chrome DevTools Protocol');
  await openFixture(page);
  await mouseToCell(page, 0, 0);
  await page.mouse.down();
  await page.mouse.up();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });

  // Focus leaves mid-composition, then comes back with a click.
  await page.locator('#before').click();
  await mouseToCell(page, 3, 3);
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => document.activeElement === window.term.textarea)).toBe(true);
  const before = await sent(page);
  // Chrome commits the unfinished text when focus leaves: it is sent once.
  expect(before).toBe('に');

  await page.keyboard.type('a');
  expect(await page.evaluate(() => window.sent)).toEqual(['に', 'a']);
});
