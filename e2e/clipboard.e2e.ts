import { expect, test } from '@playwright/test';
import {
  cellPoint,
  geometry,
  mouseToCell,
  openFixture,
  readClipboard,
  sent,
  write,
  writeClipboard,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await openFixture(page);
  await writeClipboard(page, 'sentinel');
});

test('Ctrl+V is a key for the program, not a paste', { tag: '@cross' }, async ({ page }) => {
  await mouseToCell(page, 1, 1);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Control+v');
  expect(await sent(page)).toBe('\x16');
});

test(
  'Cmd+C and Ctrl+Shift+C copy the selection and send nothing',
  { tag: '@cross' },
  async ({ page }) => {
    await write(page, 'hello world\r\nsecond line');
    await page.evaluate(() => window.term.select(0, 0, 5));
    await page.keyboard.press('Meta+c');
    await expect.poll(() => readClipboard(page)).toBe('hello');

    await page.evaluate(() => window.term.select(6, 0, 5));
    await page.keyboard.press('Control+Shift+c');
    await expect.poll(() => readClipboard(page)).toBe('world');
    expect(await sent(page)).toBe('');

    // Without a selection Ctrl+Shift+C goes to the program.
    await page.evaluate(() => window.term.clearSelection());
    await page.keyboard.press('Control+Shift+c');
    expect(await sent(page)).toBe('\x03');
  }
);

test('selecting with the mouse copies the selection', { tag: '@cross' }, async ({ page }) => {
  await write(page, 'first line\r\ncopy this text');
  const g = await geometry(page);
  const from = cellPoint(g, 0, 1, 0.2);
  const to = cellPoint(g, 8, 1, 0.8);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.term.getSelection())).toBe('copy this');
  await expect.poll(() => readClipboard(page)).toBe('copy this');
  expect(await sent(page)).toBe('');
});

test('a click without a drag leaves the clipboard alone', { tag: '@cross' }, async ({ page }) => {
  await write(page, 'some text under the pointer');
  // Every way the terminal copies starts synchronously in the mouseup handler.
  await page.evaluate(() => {
    const record = (name: string) => () => {
      window.log.push(name);
      return Promise.resolve();
    };
    navigator.clipboard.write = record('write');
    navigator.clipboard.writeText = record('writeText');
    const execCommand = document.execCommand.bind(document);
    document.execCommand = (command: string, ...rest) => {
      window.log.push(command);
      return execCommand(command, ...rest);
    };
  });
  await mouseToCell(page, 2, 0);
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => window.term.hasSelection())).toBe(false);
  expect(await page.evaluate(() => window.log)).toEqual([]);

  // The spies see a copy: a drag does make one.
  await page.mouse.down();
  await mouseToCell(page, 6, 0);
  await page.mouse.up();
  expect((await page.evaluate(() => window.log)).length).toBeGreaterThan(0);
});

test(
  'a click outside clears the selection, a drag ending outside keeps it',
  {
    tag: '@cross',
  },
  async ({ page }) => {
    await write(page, 'drag across these words');
    const g = await geometry(page);
    const hasSelection = () => page.evaluate(() => window.term.hasSelection());

    // A drag that ends below the terminal, past its padding.
    const from = cellPoint(g, 0, 0, 0.2);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 4 * g.cellWidth, from.y, { steps: 2 });
    await page.mouse.move(from.x + 4 * g.cellWidth, g.top + g.rows * g.cellHeight + 40, {
      steps: 2,
    });
    await page.mouse.up();
    expect(await hasSelection()).toBe(true);

    // A click on the page outside the terminal.
    await page.mouse.click(g.left + 20, g.top + g.rows * g.cellHeight + 40);
    expect(await hasSelection()).toBe(false);
  }
);

test(
  'the context menu opens on the selected text, and its paste is sent once',
  {
    tag: '@cross',
  },
  async ({ page }) => {
    await writeClipboard(page, 'pasted');
    await write(page, 'menu target text');
    await page.evaluate(() => window.term.select(0, 0, 4));
    const g = await geometry(page);
    const p = cellPoint(g, 6, 0);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down({ button: 'right' });

    // The hidden textarea is under the pointer, holding the selection, selected and focused.
    const ta = await page.evaluate(() => {
      const ta = window.term.textarea!;
      const r = ta.getBoundingClientRect();
      return {
        focused: document.activeElement === ta,
        value: ta.value,
        selected: ta.value.slice(ta.selectionStart, ta.selectionEnd),
        center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        clipPath: ta.style.clipPath,
      };
    });
    expect(ta).toMatchObject({ focused: true, value: 'menu', selected: 'menu', clipPath: 'none' });
    expect(Math.abs(ta.center.x - p.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(ta.center.y - p.y)).toBeLessThanOrEqual(2);
    await page.mouse.up({ button: 'right' });
    // The selection survives the right click.
    expect(await page.evaluate(() => window.term.getSelection())).toBe('menu');

    // Paste while the textarea is under the pointer (what the menu's Paste does), with the
    // terminal's paste shortcut (plain Ctrl+V is a key for the program, so elsewhere it is
    // Ctrl+Shift+V).
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+Shift+v');
    await expect.poll(() => sent(page)).toBe('pasted');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    expect(await page.evaluate(() => window.sent)).toEqual(['pasted']);
  }
);
