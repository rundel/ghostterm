/**
 * InputHandler: DOM keyboard, composition, beforeinput and paste events in,
 * bytes for the program out (encoded by libghostty, following the modes the
 * program set on the terminal).
 */

import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { GhosttyTerminal } from './ghostty';
import { InputHandler, type InputHandlerOptions } from './input-handler';
import { terminalFixture } from './test-helpers';

const fixture = terminalFixture();
let term: GhosttyTerminal;
let container: HTMLElement;
let input: HTMLTextAreaElement;
let sent: string[];

beforeEach(() => {
  term = fixture.wasm(80, 24);
  container = document.createElement('div');
  input = document.createElement('textarea');
  sent = [];
});

function makeHandler(options: Partial<InputHandlerOptions> = {}): InputHandler {
  const handler = new InputHandler({
    ghostty: fixture.ghostty,
    container,
    inputElement: input,
    getTerminal: () => term,
    onData: (data) => sent.push(data),
    ...options,
  });
  fixture.defer(() => handler.dispose());
  return handler;
}

interface Mods {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

function key(
  code: string,
  keyName: string,
  mods: Mods = {},
  type: 'keydown' | 'keyup' = 'keydown',
  extra: KeyboardEventInit = {}
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    code,
    key: keyName,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  container.dispatchEvent(event);
  return event;
}

function beforeInput(inputType: string, data: string | null): InputEvent {
  const event = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

function composition(type: 'compositionstart' | 'compositionend', data: string): void {
  // happy-dom's CompositionEvent drops `data`.
  const event = new CompositionEvent(type, { bubbles: true });
  Object.defineProperty(event, 'data', { value: data });
  container.dispatchEvent(event);
}

function paste(text: string | null, target: EventTarget = container): ClipboardEvent {
  let clipboardData: DataTransfer | null = null;
  if (text !== null) {
    clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
  }
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('key encoding', () => {
  // [code, key, mods, terminal setup, bytes]
  test.each<[string, string, Mods, string, string]>([
    ['KeyA', 'a', {}, '', 'a'],
    ['KeyZ', 'z', {}, '', 'z'],
    ['KeyA', 'A', { shift: true }, '', 'A'],
    ['Digit0', '0', {}, '', '0'],
    ['Digit9', '9', {}, '', '9'],
    ['Comma', ',', {}, '', ','],
    ['Period', '.', {}, '', '.'],
    ['Slash', '/', {}, '', '/'],
    ['Space', ' ', {}, '', ' '],
    ['KeyE', 'é', {}, '', 'é'],
    ['Semicolon', 'ö', {}, '', 'ö'],
    ['KeyA', 'a', { ctrl: true }, '', '\x01'],
    ['KeyC', 'c', { ctrl: true }, '', '\x03'],
    ['KeyD', 'd', { ctrl: true }, '', '\x04'],
    ['KeyV', 'v', { ctrl: true }, '', '\x16'],
    ['KeyZ', 'z', { ctrl: true }, '', '\x1a'],
    ['KeyA', 'A', { ctrl: true, shift: true }, '', '\x1b[97;6u'],
    ['KeyA', 'a', { alt: true }, '', '\x1ba'],
    ['KeyB', 'b', { alt: true }, '', '\x1bb'],
    // AltGr arrives as Ctrl+Alt with the composed character.
    ['KeyQ', '@', { ctrl: true, alt: true }, '', '@'],
    ['Enter', 'Enter', {}, '', '\r'],
    ['Tab', 'Tab', {}, '', '\t'],
    ['Tab', 'Tab', { shift: true }, '', '\x1b[Z'],
    ['Escape', 'Escape', {}, '', '\x1b'],
    ['Backspace', 'Backspace', {}, '', '\x7f'],
    ['ArrowUp', 'ArrowUp', {}, '', '\x1b[A'],
    ['ArrowDown', 'ArrowDown', {}, '', '\x1b[B'],
    ['ArrowRight', 'ArrowRight', {}, '', '\x1b[C'],
    ['ArrowLeft', 'ArrowLeft', {}, '', '\x1b[D'],
    ['ArrowUp', 'ArrowUp', {}, '\x1b[?1h', '\x1bOA'],
    ['ArrowDown', 'ArrowDown', {}, '\x1b[?1h', '\x1bOB'],
    ['ArrowRight', 'ArrowRight', {}, '\x1b[?1h', '\x1bOC'],
    ['ArrowLeft', 'ArrowLeft', {}, '\x1b[?1h', '\x1bOD'],
    ['Home', 'Home', {}, '', '\x1b[H'],
    ['End', 'End', {}, '', '\x1b[F'],
    ['PageUp', 'PageUp', {}, '', '\x1b[5~'],
    ['PageDown', 'PageDown', {}, '', '\x1b[6~'],
    ['Insert', 'Insert', {}, '', '\x1b[2~'],
    ['Delete', 'Delete', {}, '', '\x1b[3~'],
    ['F1', 'F1', {}, '', '\x1bOP'],
    ['F5', 'F5', {}, '', '\x1b[15~'],
    ['F12', 'F12', {}, '', '\x1b[24~'],
    // Like Ghostty, Shift+Enter is distinguishable from Enter even in legacy mode.
    ['Enter', 'Enter', { shift: true }, '', '\x1b[27;2;13~'],
    // modifyOtherKeys
    ['KeyA', 'A', { ctrl: true, shift: true }, '\x1b[>4;2m', '\x1b[27;6;65~'],
    // Kitty protocol, "disambiguate escape codes"
    ['Enter', 'Enter', { shift: true }, '\x1b[>1u', '\x1b[13;2u'],
    ['Escape', 'Escape', {}, '\x1b[>1u', '\x1b[27u'],
    ['KeyA', 'a', { ctrl: true }, '\x1b[>1u', '\x1b[97;5u'],
    ['KeyR', 'r', { meta: true }, '\x1b[>1u', '\x1b[114;9u'],
    ['Escape', 'Escape', {}, '\x1b[>1u\x1b[<u', '\x1b'],
  ])('%s %p %o after %j sends %j', (code, keyName, mods, setup, bytes) => {
    makeHandler();
    term.write(setup);
    const event = key(code, keyName, mods);
    expect(sent).toEqual([bytes]);
    expect(event.defaultPrevented).toBe(true);
  });

  test('keys that send nothing: unmapped, dead keys, bare Cmd shortcuts', () => {
    makeHandler();
    const events = [
      key('Unknown', 'Unknown'),
      key('KeyE', 'Dead'),
      key('KeyR', 'r', { meta: true }),
      key('KeyC', 'c', { meta: true }),
    ];
    expect(sent).toEqual([]);
    expect(events.slice(1).map((e) => e.defaultPrevented)).toEqual([false, false, false]);
  });

  test('key releases are sent only when the program asked for them', () => {
    makeHandler();
    key('KeyA', 'a');
    key('KeyA', 'a', {}, 'keyup');
    expect(sent).toEqual(['a']);
    term.write('\x1b[>3u'); // disambiguate + report event types
    key('KeyA', 'a');
    key('KeyA', 'a', {}, 'keyup');
    expect(sent).toEqual(['a', 'a', '\x1b[97;1:3u']);
  });

  test('no release for a key whose press was not sent to the program', () => {
    makeHandler();
    term.write('\x1b[>11u'); // report event types and all keys as escape codes
    // A paste shortcut, a dead key and a key released after focus arrived.
    key('KeyV', 'v', { meta: true });
    key('KeyV', 'v', { meta: true }, 'keyup');
    key('KeyE', 'Dead');
    key('KeyE', 'Dead', {}, 'keyup');
    key('KeyQ', 'q', {}, 'keyup');
    expect(sent).toEqual([]);

    // Shift+arrow that moved a selection.
    term.write('hello');
    term.setSelectionRange(0, 0, 1, 0);
    const adjusted = key('ArrowRight', 'ArrowRight', { shift: true });
    key('ArrowRight', 'ArrowRight', { shift: true }, 'keyup');
    expect(sent).toEqual([]);
    expect(adjusted.defaultPrevented).toBe(true);
  });

  test('onKey carries the bytes sent, and fires only when something is sent', () => {
    const keys: Array<{ key: string; code: string }> = [];
    makeHandler({
      onKey: (e) => keys.push({ key: e.key, code: e.domEvent.code }),
      customKeyEventHandler: (e) => e.code !== 'KeyZ',
    });
    key('Enter', 'Enter');
    key('KeyA', 'a', { ctrl: true });
    key('ArrowUp', 'ArrowUp');
    key('KeyZ', 'z');
    key('KeyR', 'r', { meta: true });
    expect(keys).toEqual([
      { key: '\r', code: 'Enter' },
      { key: '\x01', code: 'KeyA' },
      { key: '\x1b[A', code: 'ArrowUp' },
    ]);
    expect(sent).toEqual(['\r', '\x01', '\x1b[A']);
  });

  test('a disposed handler removes its listeners', () => {
    const handler = makeHandler();
    handler.dispose();
    handler.dispose();
    expect(handler.isActive()).toBe(false);
    key('KeyA', 'a');
    beforeInput('insertText', 'x');
    paste('y');
    expect(sent).toEqual([]);
  });
});

describe('custom key handler', () => {
  test('runs first, and only false stops the key', () => {
    let result: boolean | undefined = false;
    const handler = makeHandler();
    handler.setCustomKeyEventHandler(() => result as boolean);
    const down = key('KeyA', 'a');
    expect(sent).toEqual([]);
    expect(down.defaultPrevented).toBe(false);

    // As in xterm.js, true and undefined both proceed.
    result = true;
    key('KeyB', 'b');
    result = undefined;
    key('KeyC', 'c');
    expect(sent).toEqual(['b', 'c']);
  });

  test('also sees keyups and can stop them', () => {
    const types: string[] = [];
    let allowKeyup = false;
    makeHandler().setCustomKeyEventHandler((e) => {
      types.push(e.type);
      return e.type === 'keydown' || allowKeyup;
    });
    term.write('\x1b[>3u');
    key('KeyA', 'a');
    key('KeyA', 'a', {}, 'keyup');
    expect(types).toEqual(['keydown', 'keyup']);
    expect(sent).toEqual(['a']);

    allowKeyup = true;
    key('KeyA', 'a');
    key('KeyA', 'a', {}, 'keyup');
    expect(sent).toEqual(['a', 'a', '\x1b[97;1:3u']);
  });

  test('text from a key it stopped is not sent through beforeinput', () => {
    makeHandler({ customKeyEventHandler: (e) => e.code !== 'KeyX' });
    key('KeyX', 'x');
    const insert = beforeInput('insertText', 'x');
    expect(sent).toEqual([]);
    expect(insert.defaultPrevented).toBe(true);

    key('KeyX', 'x', {}, 'keyup');
    beforeInput('insertText', 'y');
    expect(sent).toEqual(['y']);
  });
});

describe('copy and paste shortcuts', () => {
  test('Cmd+V and Ctrl+Shift+V are left to the browser paste', () => {
    makeHandler();
    const cmd = key('KeyV', 'v', { meta: true });
    const ctrlShift = key('KeyV', 'V', { ctrl: true, shift: true });
    expect(sent).toEqual([]);
    expect([cmd.defaultPrevented, ctrlShift.defaultPrevented]).toEqual([false, false]);
  });

  test('Cmd+C and Ctrl+Shift+C copy a selection instead of sending a key', () => {
    let hasSelection = true;
    let copies = 0;
    makeHandler({
      onCopy: () => {
        copies++;
        return hasSelection;
      },
    });
    const cmd = key('KeyC', 'c', { meta: true });
    const ctrlShift = key('KeyC', 'C', { ctrl: true, shift: true });
    expect(copies).toBe(2);
    expect([cmd.defaultPrevented, ctrlShift.defaultPrevented]).toEqual([true, true]);
    expect(sent).toEqual([]);

    // Without a selection, Cmd+C is the browser's and Ctrl+Shift+C goes to
    // the program; plain Ctrl+C is always ^C.
    hasSelection = false;
    expect(key('KeyC', 'c', { meta: true }).defaultPrevented).toBe(false);
    key('KeyC', 'C', { ctrl: true, shift: true });
    key('KeyC', 'c', { ctrl: true });
    expect(sent).toEqual(['\x1b[99;6u', '\x03']);
  });
});

describe('composition', () => {
  test('only the committed text is sent; keydowns during composition are ignored', () => {
    makeHandler();
    composition('compositionstart', '');
    key('KeyN', 'n', {}, 'keydown', { isComposing: true });
    key('KeyB', 'b', {}, 'keydown', { keyCode: 229 } as KeyboardEventInit);
    key('KeyI', 'i');
    beforeInput('insertText', 'ni');
    expect(sent).toEqual([]);
    composition('compositionend', '你好');
    expect(sent).toEqual(['你好']);
  });

  test('a keydown reported as composing is ignored outside a composition too', () => {
    makeHandler();
    key('KeyA', 'a', {}, 'keydown', { keyCode: 229 } as KeyboardEventInit);
    expect(sent).toEqual([]);
  });

  test('the commit is sent once whether compositionend or beforeinput comes first', () => {
    makeHandler();
    composition('compositionend', '你好');
    beforeInput('insertText', '你好');
    expect(sent).toEqual(['你好']);

    sent = [];
    beforeInput('insertText', '世界');
    composition('compositionend', '世界');
    expect(sent).toEqual(['世界']);
  });
});

describe('beforeinput', () => {
  test('text, line breaks and replacement text are sent', () => {
    makeHandler();
    const text = beforeInput('insertText', 'a\nb');
    beforeInput('insertLineBreak', null);
    beforeInput('insertParagraph', null);
    beforeInput('insertReplacementText', 'word');
    expect(sent).toEqual(['a\rb', '\r', '\r', 'word']);
    expect(text.defaultPrevented).toBe(true);
  });

  test('empty text and other input types send nothing and are left alone', () => {
    makeHandler();
    const events = [beforeInput('insertText', ''), beforeInput('formatBold', null)];
    expect(sent).toEqual([]);
    expect(events.map((e) => e.defaultPrevented)).toEqual([false, false]);
  });

  test('mobile delete keys go through the key encoder', () => {
    makeHandler();
    beforeInput('deleteContentBackward', null);
    beforeInput('deleteContentForward', null);
    expect(sent).toEqual(['\x7f', '\x1b[3~']);

    sent = [];
    term.write('\x1b[>8u'); // Kitty: report all keys as escape codes
    beforeInput('deleteContentBackward', null);
    expect(sent).toEqual(['\x1b[127u']);
  });
});

describe('paste events', () => {
  test('a paste event sends the text, newlines as Enter', () => {
    makeHandler();
    const event = paste('Line 1\nLine 2\nLine 3');
    expect(sent).toEqual(['Line 1\rLine 2\rLine 3']);
    expect(event.defaultPrevented).toBe(true);
  });

  test('a paste on the input element is handled too', () => {
    makeHandler();
    paste('typed', input);
    expect(sent).toEqual(['typed']);
  });

  test('beforeinput insertFromPaste is sent, bracketed when the program asked', () => {
    makeHandler();
    beforeInput('insertFromPaste', 'plain');
    term.write('\x1b[?2004h');
    beforeInput('insertFromPaste', 'Bracketed paste');
    expect(sent).toEqual(['plain', '\x1b[200~Bracketed paste\x1b[201~']);
  });

  test('a paste reported both as paste and insertFromPaste is sent once, either order', () => {
    makeHandler();
    paste('Hello, World!');
    beforeInput('insertFromPaste', 'Hello, World!');
    expect(sent).toEqual(['Hello, World!']);

    sent = [];
    beforeInput('insertFromPaste', 'Again');
    paste('Again');
    expect(sent).toEqual(['Again']);
  });

  test('paste events with nothing to paste send nothing and do not warn', () => {
    makeHandler();
    const warn = spyOn(console, 'warn');
    try {
      paste(null);
      paste('');
      beforeInput('insertFromPaste', '');
      expect(sent).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
