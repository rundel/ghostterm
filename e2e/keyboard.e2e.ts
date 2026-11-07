import { type Page, expect, test } from '@playwright/test';
import { clearSent, mouseToCell, openFixture, sent, write } from './helpers';

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

/** Bytes sent for one key press (with modifiers, Playwright syntax). */
async function press(page: Page, key: string): Promise<string> {
  await clearSent(page);
  await page.keyboard.press(key);
  return sent(page);
}

test('keys and modifiers send what a terminal sends', { tag: '@cross' }, async ({ page }) => {
  const expected: Record<string, string> = {
    Enter: '\r',
    'Shift+Enter': '\x1b[27;2;13~',
    Tab: '\t',
    'Shift+Tab': '\x1b[Z',
    Backspace: '\x7f',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    'Shift+ArrowRight': '\x1b[1;2C',
    F5: '\x1b[15~',
    'Control+a': '\x01',
    // Option/Alt acts as Meta (an ESC prefix), on macOS too.
    'Alt+a': '\x1ba',
    'Alt+Shift+b': '\x1bb',
    'Control+Alt+f': '\x1b\x06',
  };
  const actual: Record<string, string> = {};
  for (const key of Object.keys(expected)) actual[key] = await press(page, key);
  expect(actual).toEqual(expected);
});

test('cursor keys follow application mode (DECCKM)', { tag: '@cross' }, async ({ page }) => {
  await write(page, '\x1b[?1h');
  expect(await press(page, 'ArrowUp')).toBe('\x1bOA');
  expect(await press(page, 'ArrowLeft')).toBe('\x1bOD');
  await write(page, '\x1b[?1l');
  expect(await press(page, 'ArrowUp')).toBe('\x1b[A');
});

test(
  'key releases are sent only when the program asks (Kitty protocol)',
  { tag: '@cross' },
  async ({ page }) => {
    const pressAndRelease = async () => {
      await clearSent(page);
      await page.keyboard.down('a');
      const down = await sent(page);
      await page.keyboard.up('a');
      return [down, (await sent(page)).slice(down.length)];
    };
    expect(await pressAndRelease()).toEqual(['a', '']);
    // Disambiguate only: still no releases.
    await write(page, '\x1b[>1u');
    expect(await pressAndRelease()).toEqual(['a', '']);
    // Report event types: the release comes as an escape code.
    await write(page, '\x1b[<u\x1b[>3u');
    expect(await pressAndRelease()).toEqual(['a', '\x1b[97;1:3u']);
    // Shortcuts the terminal handles itself leave no stray release.
    await page.evaluate(() => window.term.select(0, 0, 1));
    await clearSent(page);
    await page.keyboard.press('Meta+c');
    expect(await sent(page)).toBe('');
  }
);

test('a dead key composes one character', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'drives the key and IME events through CDP');
  await mouseToCell(page, 0, 0);
  await page.mouse.down();
  await page.mouse.up();
  const cdp = await page.context().newCDPSession(page);
  // Option+E then E on a US Mac layout, as Chrome delivers it.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Dead',
    code: 'KeyE',
    windowsVirtualKeyCode: 229,
    modifiers: 1,
  });
  await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Dead',
    code: 'KeyE',
    windowsVirtualKeyCode: 229,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'e',
    code: 'KeyE',
    windowsVirtualKeyCode: 229,
  });
  await cdp.send('Input.insertText', { text: 'é' });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'e',
    code: 'KeyE',
    windowsVirtualKeyCode: 69,
  });
  expect(await page.evaluate(() => window.sent)).toEqual(['é']);
});
