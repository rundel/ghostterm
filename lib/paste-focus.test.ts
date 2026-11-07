/**
 * Paste and focus reporting through libghostty, end to end.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

let container: HTMLElement;
let term: Terminal;
let sent: string[];

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  term = await createIsolatedTerminal({ cols: 40, rows: 10 });
  term.open(container);
  sent = [];
  term.onData((d) => sent.push(d));
});

afterEach(() => {
  term.dispose();
  container.remove();
});

function clipboardPaste(text: string) {
  const textarea = (term as any).textarea as HTMLTextAreaElement;
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  textarea.dispatchEvent(e);
}

describe('paste', () => {
  test('without bracketed paste, newlines are sent as carriage returns', () => {
    term.paste('echo one\necho two');
    expect(sent).toEqual(['echo one\recho two']);
  });

  test('bracketed paste wraps the text and neutralizes an embedded end marker', () => {
    term.write('\x1b[?2004h');
    term.paste('a\nb\x1b[201~rm -rf ~');
    expect(sent).toEqual(['\x1b[200~a\nb [201~rm -rf ~\x1b[201~']);
  });

  test('clipboard paste events take the same path', () => {
    term.write('\x1b[?2004h');
    clipboardPaste('hello');
    expect(sent).toEqual(['\x1b[200~hello\x1b[201~']);
  });

  test('pasting does not leak into terminal replies', () => {
    term.paste('x');
    expect(term.wasmTerm!.readResponse()).toBeNull();
  });
});

describe('focus reporting', () => {
  test('reported only after the program asks (mode 1004)', () => {
    const textarea = (term as any).textarea as HTMLTextAreaElement;
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(sent).toEqual([]);

    term.write('\x1b[?1004h');
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(sent).toEqual(['\x1b[I', '\x1b[O']);
  });

  test('focus moving inside the terminal is not reported', () => {
    term.write('\x1b[?1004h');
    const textarea = (term as any).textarea as HTMLTextAreaElement;
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: container }));
    expect(sent).toEqual([]);
  });
});
