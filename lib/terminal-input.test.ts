/**
 * Input through the Terminal API: paste(), input(), disableStdin, focus and
 * focus reporting, onKey, the custom key handler and keyboard selection.
 * Bytes sent to the program are what is asserted.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { IKeyEvent } from './interfaces';
import type { Terminal } from './terminal';
import { internals, keyDown, terminalFixture } from './test-helpers';

const fixture = terminalFixture();
let term: Terminal;
let container: HTMLElement;
let sent: string[];

beforeEach(() => {
  ({ term, container, sent } = fixture.open({ cols: 40, rows: 10 }));
});

const textarea = () => internals(term).textarea;

function clipboardPaste(text: string) {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  textarea().dispatchEvent(e);
}

describe('paste()', () => {
  test('sends the text, with newlines as carriage returns without bracketed paste', () => {
    term.paste('hello world');
    term.paste('echo one\necho two');
    expect(sent).toEqual(['hello world', 'echo one\recho two']);
  });

  test('bracketed paste wraps the text and neutralizes an embedded end marker', () => {
    expect(term.hasBracketedPaste()).toBe(false);
    term.write('\x1b[?2004h');
    expect(term.hasBracketedPaste()).toBe(true);
    term.paste('a\nb\x1b[201~rm -rf ~');
    expect(sent).toEqual(['\x1b[200~a\nb [201~rm -rf ~\x1b[201~']);
    term.write('\x1b[?2004l');
    term.paste('plain');
    expect(sent.at(-1)).toBe('plain');
  });

  test('clipboard paste events take the same path', () => {
    term.write('\x1b[?2004h');
    clipboardPaste('hello');
    expect(sent).toEqual(['\x1b[200~hello\x1b[201~']);
  });

  test('pasting does not leak into terminal replies', () => {
    term.paste('x');
    expect(internals(term).wasmTerm.readResponse()).toBeNull();
  });
});

describe('input()', () => {
  test('as user input it is sent to the program, not written', () => {
    term.input('user input', true);
    expect(sent).toEqual(['user input']);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('');
  });

  test('otherwise it is written to the screen without being sent', () => {
    term.input('test data');
    expect(sent).toEqual([]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('test data');
    expect(term.buffer.active.cursorX).toBe(9);
  });
});

describe('disableStdin', () => {
  const pressA = () => keyDown(container, 'KeyA', 'a', { keyCode: 65 });

  test('blocks paste, user input and key presses, and can be toggled at runtime', () => {
    pressA();
    term.paste('first');
    expect(sent).toEqual(['a', 'first']);

    term.options.disableStdin = true;
    pressA();
    term.paste('blocked');
    term.input('blocked', true);
    clipboardPaste('blocked');
    expect(sent).toEqual(['a', 'first']);

    term.options.disableStdin = false;
    pressA();
    term.paste('second');
    expect(sent).toEqual(['a', 'first', 'a', 'second']);
  });

  test('applies from the constructor option', () => {
    const t = fixture.open({ disableStdin: true });
    t.term.paste('x');
    t.term.input('x', true);
    keyDown(t.container, 'KeyA', 'a');
    expect(t.sent).toEqual([]);
  });

  test('programmatic input() is dropped too', () => {
    term.options.disableStdin = true;
    term.input('shown');
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('');
  });
});

describe('focus', () => {
  test('focus() focuses the input textarea and blur() takes focus away', () => {
    term.focus();
    expect(document.activeElement).toBe(textarea());
    term.blur();
    expect(document.activeElement).not.toBe(textarea());
    expect(document.activeElement).not.toBe(container);
  });

  test('focus is reported only after the program asks (mode 1004)', () => {
    expect(term.hasFocusEvents()).toBe(false);
    textarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(sent).toEqual([]);

    term.write('\x1b[?1004h');
    expect(term.hasFocusEvents()).toBe(true);
    textarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(sent).toEqual(['\x1b[I', '\x1b[O']);
  });

  test('focus moving inside the terminal is not reported', () => {
    term.write('\x1b[?1004h');
    textarea().dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: container })
    );
    expect(sent).toEqual([]);
  });

  test('a composition interrupted by losing focus does not block typing', () => {
    textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    textarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    keyDown(textarea(), 'KeyA', 'a');
    expect(sent).toEqual(['a']);
  });
});

describe('keys', () => {
  test('onKey reports the bytes of each key press with its DOM event', () => {
    const keys: IKeyEvent[] = [];
    term.onKey((e) => keys.push(e));
    const a = keyDown(container, 'KeyA', 'a');
    const enter = keyDown(container, 'Enter', 'Enter');
    expect(keys).toEqual([
      { key: 'a', domEvent: a },
      { key: '\r', domEvent: enter },
    ]);
    expect(sent).toEqual(['a', '\r']);
  });

  test('a key without a physical code sends the text it produced', () => {
    const keys: IKeyEvent[] = [];
    term.onKey((e) => keys.push(e));
    const e = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    container.dispatchEvent(e);
    expect(keys).toEqual([{ key: 'a', domEvent: e }]);
    expect(sent).toEqual(['a']);
  });

  test('a custom key handler returning false stops the key reaching the program', () => {
    const seen: string[] = [];
    term.attachCustomKeyEventHandler((e) => {
      seen.push(e.key);
      return e.key !== 'b';
    });
    keyDown(container, 'KeyA', 'a');
    keyDown(container, 'KeyB', 'b');
    expect(seen).toEqual(['a', 'b']);
    expect(sent).toEqual(['a']);
  });

  test('a custom key handler attached before open() applies once opened', () => {
    const t = fixture.create();
    t.attachCustomKeyEventHandler(() => false);
    const c = document.createElement('div');
    document.body.appendChild(c);
    fixture.defer(() => c.remove());
    const data: string[] = [];
    t.onData((d) => data.push(d));
    t.open(c);
    keyDown(c, 'KeyA', 'a');
    expect(data).toEqual([]);
  });
});

describe('keyboard selection', () => {
  test('Shift+arrows extend an existing selection instead of reaching the program', () => {
    term.write('hello world');
    term.select(0, 0, 5);
    let changes = 0;
    term.onSelectionChange(() => changes++);
    keyDown(container, 'ArrowRight', 'ArrowRight', { shiftKey: true });
    keyDown(container, 'ArrowRight', 'ArrowRight', { shiftKey: true });
    expect(term.getSelection()).toBe('hello w');
    expect(changes).toBe(2);
    expect(sent).toEqual([]);
  });

  test('without a selection, Shift+arrows go to the program', () => {
    keyDown(container, 'ArrowRight', 'ArrowRight', { shiftKey: true });
    expect(sent).toEqual(['\x1b[1;2C']);
  });
});
