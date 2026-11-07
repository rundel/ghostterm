import { expect, test } from '@playwright/test';
import { cellPoint, geometry, openFixture, sent } from './helpers';

/** Whether the hidden textarea has focus. */
const textareaFocused = () => document.activeElement === window.term.textarea;

/** Text in the terminal's element outside the textarea (anything the browser edited in). */
const strayText = () => {
  const parent = window.term.element!;
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  let text = '';
  while (walker.nextNode()) text += walker.currentNode.textContent;
  return { text, children: Array.from(parent.children, (c) => c.tagName) };
};

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

test(
  'clicking the canvas focuses the textarea and typing sends the text',
  { tag: '@cross' },
  async ({ page }) => {
    await page.locator('#before').focus();
    const p = cellPoint(await geometry(page), 5, 2);
    await page.mouse.click(p.x, p.y);
    expect(await page.evaluate(textareaFocused)).toBe(true);

    await page.keyboard.type('ls -la');
    await page.keyboard.press('Enter');
    expect(await sent(page)).toBe('ls -la\r');
  }
);

test(
  'Tab or a click on the padding reaches the textarea, not the editable parent',
  { tag: '@cross' },
  async ({ page }) => {
    await page.locator('#before').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(textareaFocused)).toBe(true);
    await page.keyboard.type('ab');
    await page.keyboard.press('Enter');

    // The parent's padding is outside the canvas: the parent itself gets the click.
    await page.locator('#before').focus();
    const box = (await page.locator('#terminal').boundingBox())!;
    await page.mouse.click(box.x + 3, box.y + 3);
    expect(await page.evaluate(textareaFocused)).toBe(true);
    await page.keyboard.type('cd');

    // Focus given to the parent from script is passed on too.
    await page.locator('#before').focus();
    await page.evaluate(() => window.term.element!.focus());
    expect(await page.evaluate(textareaFocused)).toBe(true);
    await page.keyboard.type('e');

    expect(await sent(page)).toBe('ab\rcde');
    expect(await page.evaluate(strayText)).toEqual({ text: '', children: ['CANVAS', 'TEXTAREA'] });
  }
);

test('text dropped onto the terminal is neither sent nor inserted', async ({ page }) => {
  // Watch the browser's own editing of the parent: it asks with a beforeinput first.
  await page.evaluate(() => {
    document.addEventListener('beforeinput', (e) => {
      window.log.push({ type: e.inputType, prevented: e.defaultPrevented });
    });
  });

  // A real drag from another page (CDP), dropped on the terminal's padding and on the canvas.
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('#terminal').boundingBox())!;
  const p = cellPoint(await geometry(page), 3, 3);
  const data = {
    items: [{ mimeType: 'text/plain', data: 'rm -rf /' }],
    dragOperationsMask: 1,
  };
  for (const [x, y] of [
    [box.x + 4, box.y + 4],
    [p.x, p.y],
  ]) {
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
    }
  }

  const inputs = await page.evaluate(() => window.log);
  expect(inputs.length).toBe(2);
  for (const input of inputs) expect(input).toEqual({ type: 'insertFromDrop', prevented: true });
  expect(await sent(page)).toBe('');
  expect(await page.evaluate(strayText)).toEqual({ text: '', children: ['CANVAS', 'TEXTAREA'] });
});
