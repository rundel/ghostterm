/**
 * Unit tests for InputHandler
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Ghostty } from './ghostty';
import type { GhosttyTerminal } from './ghostty';
import { InputHandler, type InputHandlerOptions } from './input-handler';
import { Key, KeyAction, Mods } from './types';

// Mock DOM types for testing
interface MockKeyboardEvent {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface MockClipboardEvent {
  type: string;
  clipboardData: {
    getData: (format: string) => string;
    setData: (format: string, data: string) => void;
  } | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}
interface MockInputEvent {
  type: string;
  inputType: string;
  data: string | null;
  isComposing?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface MockHTMLElement {
  addEventListener: (event: string, handler: (e: any) => void) => void;
  removeEventListener: (event: string, handler: (e: any) => void) => void;
  childNodes: Node[];
  removeChild: (node: Node) => Node;
  appendChild: (node: Node) => Node;
}

// Helper to create mock keyboard event
function createKeyEvent(
  code: string,
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}
): MockKeyboardEvent {
  return {
    code,
    key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
    repeat: false,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
  };
}

// Helper to create mock clipboard event
function createClipboardEvent(text: string | null): MockClipboardEvent {
  const data = new Map<string, string>();
  if (text !== null) {
    data.set('text/plain', text);
  }

  return {
    type: 'paste',
    clipboardData:
      text !== null
        ? {
            getData: (format: string) => data.get(format) || '',
            setData: (format: string, value: string) => {
              data.set(format, value);
            },
          }
        : null,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
  };
}

// Helper to create mock beforeinput event
function createBeforeInputEvent(inputType: string, data: string | null): MockInputEvent {
  return {
    type: 'beforeinput',
    inputType,
    data,
    isComposing: false,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
  };
}
interface MockCompositionEvent {
  type: string;
  data: string | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}

// Helper to create mock composition event
function createCompositionEvent(
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string | null
): MockCompositionEvent {
  return {
    type,
    data,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
  };
}
// Helper to create mock container
function createMockContainer(): MockHTMLElement & {
  _listeners: Map<string, ((e: any) => void)[]>;
  dispatchEvent: (event: any) => void;
} {
  const listeners = new Map<string, ((e: any) => void)[]>();

  return {
    _listeners: listeners,
    addEventListener(event: string, handler: (e: any) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    },
    removeEventListener(event: string, handler: (e: any) => void) {
      const handlers = listeners.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      }
    },
    dispatchEvent(event: any) {
      const handlers = listeners.get(event.type) || [];
      for (const handler of handlers) {
        handler(event);
      }
    },
    // Mock childNodes and removeChild for text node cleanup test
    childNodes: [] as Node[],
    removeChild(node: Node) {
      const index = this.childNodes.indexOf(node);
      if (index >= 0) {
        this.childNodes.splice(index, 1);
      }
      return node;
    },
    appendChild(node: Node) {
      this.childNodes.push(node);
      return node;
    },
  };
}

// Helper to simulate key event
function simulateKey(
  container: ReturnType<typeof createMockContainer>,
  event: MockKeyboardEvent
): void {
  const handlers = container._listeners.get('keydown') || [];
  for (const handler of handlers) {
    handler(event);
  }
}

describe('InputHandler', () => {
  let ghostty: Ghostty;
  let term: GhosttyTerminal;
  let container: ReturnType<typeof createMockContainer>;
  let dataReceived: string[];

  beforeEach(async () => {
    ghostty = await Ghostty.load();
    term = ghostty.createTerminal(80, 24);
    container = createMockContainer();
    dataReceived = [];
  });

  function makeHandler(options: Partial<InputHandlerOptions> = {}): InputHandler {
    return new InputHandler({
      ghostty,
      container: container as any,
      getTerminal: () => term,
      onData: (data) => dataReceived.push(data),
      ...options,
    });
  }

  describe('Constructor and Lifecycle', () => {
    test('dispose removes listeners and marks inactive', () => {
      const handler = makeHandler();

      handler.dispose();

      expect(handler.isActive()).toBe(false);
      for (const handlers of container._listeners.values()) expect(handlers).toEqual([]);
      simulateKey(container, createKeyEvent('KeyA', 'a'));
      expect(dataReceived).toEqual([]);
    });

    test('dispose is idempotent', () => {
      const handler = makeHandler();

      handler.dispose();
      handler.dispose(); // Second call should not throw

      expect(handler.isActive()).toBe(false);
    });
  });

  describe('Printable Characters', () => {
    test('encodes lowercase letters', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyA', 'a'));
      expect(dataReceived).toEqual(['a']);

      simulateKey(container, createKeyEvent('KeyZ', 'z'));
      expect(dataReceived).toEqual(['a', 'z']);
    });

    test('encodes uppercase letters (with shift)', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyA', 'A', { shift: true }));
      expect(dataReceived).toEqual(['A']);
    });

    test('encodes digits', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Digit0', '0'));
      simulateKey(container, createKeyEvent('Digit5', '5'));
      simulateKey(container, createKeyEvent('Digit9', '9'));

      expect(dataReceived).toEqual(['0', '5', '9']);
    });

    test('encodes punctuation', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Comma', ','));
      simulateKey(container, createKeyEvent('Period', '.'));
      simulateKey(container, createKeyEvent('Slash', '/'));

      expect(dataReceived).toEqual([',', '.', '/']);
    });

    test('encodes space', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Space', ' '));
      expect(dataReceived).toEqual([' ']);
    });
  });

  describe('IME Composition', () => {
    test('handles composition sequence', () => {
      makeHandler();

      // Start composition
      const startEvent = createCompositionEvent('compositionstart', '');
      container.dispatchEvent(startEvent);

      // Update composition (typing)
      const updateEvent1 = createCompositionEvent('compositionupdate', 'n');
      container.dispatchEvent(updateEvent1);

      // Keydown events during composition should be ignored
      const keyEvent1 = createKeyEvent('KeyN', 'n');
      Object.defineProperty(keyEvent1, 'isComposing', { value: true });
      simulateKey(container, keyEvent1);

      // Update composition (more typing)
      const updateEvent2 = createCompositionEvent('compositionupdate', 'ni');
      container.dispatchEvent(updateEvent2);

      // End composition (commit)
      const endEvent = createCompositionEvent('compositionend', '你好');
      container.dispatchEvent(endEvent);

      // Should only receive the final committed text
      expect(dataReceived).toEqual(['你好']);
    });

    test('ignores keydown during composition', () => {
      makeHandler();

      // Start composition
      container.dispatchEvent(createCompositionEvent('compositionstart', ''));

      // Simulate keydown with isComposing=true
      const keyEvent = createKeyEvent('KeyA', 'a');
      Object.defineProperty(keyEvent, 'isComposing', { value: true });
      simulateKey(container, keyEvent);

      // Simulate keydown with keyCode 229
      const keyEvent229 = createKeyEvent('KeyB', 'b');
      Object.defineProperty(keyEvent229, 'keyCode', { value: 229 });
      simulateKey(container, keyEvent229);

      // Should not receive any data
      expect(dataReceived.length).toBe(0);

      // End composition
      container.dispatchEvent(createCompositionEvent('compositionend', 'a'));
      expect(dataReceived).toEqual(['a']);
    });

    test('avoids duplicate commit when compositionend fires before beforeinput', () => {
      const inputElement = createMockContainer();
      makeHandler({ inputElement: inputElement as any });

      container.dispatchEvent(createCompositionEvent('compositionend', '你好'));
      inputElement.dispatchEvent(createBeforeInputEvent('insertText', '你好'));

      expect(dataReceived).toEqual(['你好']);
    });

    test('avoids duplicate commit when beforeinput fires before compositionend', () => {
      const inputElement = createMockContainer();
      makeHandler({ inputElement: inputElement as any });

      inputElement.dispatchEvent(createBeforeInputEvent('insertText', '你好'));
      container.dispatchEvent(createCompositionEvent('compositionend', '你好'));

      expect(dataReceived).toEqual(['你好']);
    });
  });

  describe('Control Characters', () => {
    test('encodes Ctrl+A', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyA', 'a', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+A should produce 0x01
      expect(dataReceived[0].charCodeAt(0)).toBe(0x01);
    });

    test('encodes Ctrl+C', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyC', 'c', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+C should produce 0x03
      expect(dataReceived[0].charCodeAt(0)).toBe(0x03);
    });

    test('encodes Ctrl+D', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyD', 'd', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+D should produce 0x04
      expect(dataReceived[0].charCodeAt(0)).toBe(0x04);
    });

    test('encodes Ctrl+Z', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyZ', 'z', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+Z should produce 0x1A (26)
      expect(dataReceived[0].charCodeAt(0)).toBe(0x1a);
    });

    test('Cmd+C allows copy (no data sent)', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyC', 'c', { meta: true }));

      // Cmd+C should NOT send data - it should allow copy operation
      // SelectionManager handles the actual copying
      expect(dataReceived.length).toBe(0);
    });
  });

  describe('Special Keys', () => {
    test('encodes Enter', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Enter', 'Enter'));

      expect(dataReceived.length).toBe(1);
      // Enter should produce \r (0x0D)
      expect(dataReceived[0]).toBe('\r');
    });

    test('encodes Tab', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Tab', 'Tab'));

      expect(dataReceived.length).toBe(1);
      // Tab should produce \t (0x09)
      expect(dataReceived[0]).toBe('\t');
    });

    test('encodes Escape', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Escape', 'Escape'));

      expect(dataReceived.length).toBe(1);
      // Escape should produce ESC (0x1B)
      expect(dataReceived[0].charCodeAt(0)).toBe(0x1b);
    });

    test('encodes Backspace', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Backspace', 'Backspace'));

      expect(dataReceived.length).toBe(1);
      // Backspace should produce 0x7F (DEL) or 0x08 (BS)
      const code = dataReceived[0].charCodeAt(0);
      expect(code === 0x7f || code === 0x08).toBe(true);
    });
  });

  describe('Arrow Keys', () => {
    test('encodes Up arrow', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp'));

      expect(dataReceived.length).toBe(1);
      // Arrow keys produce ESC[A, ESC[B, ESC[C, ESC[D or ESCOA, ESCOB, ESCOC, ESCOD
      expect(dataReceived[0]).toMatch(/\x1b(\[A|OA)/);
    });

    test('encodes Down arrow', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('ArrowDown', 'ArrowDown'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toMatch(/\x1b(\[B|OB)/);
    });

    test('encodes Left arrow', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('ArrowLeft', 'ArrowLeft'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toMatch(/\x1b(\[D|OD)/);
    });

    test('encodes Right arrow', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('ArrowRight', 'ArrowRight'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toMatch(/\x1b(\[C|OC)/);
    });

    test('sends CSI sequences in normal cursor mode (mode 1 off)', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp'));
      simulateKey(container, createKeyEvent('ArrowDown', 'ArrowDown'));
      simulateKey(container, createKeyEvent('ArrowLeft', 'ArrowLeft'));
      simulateKey(container, createKeyEvent('ArrowRight', 'ArrowRight'));

      expect(dataReceived.length).toBe(4);
      // Normal mode: CSI sequences (ESC[A, ESC[B, ESC[D, ESC[C)
      expect(dataReceived[0]).toBe('\x1b[A');
      expect(dataReceived[1]).toBe('\x1b[B');
      expect(dataReceived[2]).toBe('\x1b[D');
      expect(dataReceived[3]).toBe('\x1b[C');
    });

    test('sends SS3 sequences in application cursor mode (mode 1 on)', () => {
      makeHandler();
      term.write('\x1b[?1h');

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp'));
      simulateKey(container, createKeyEvent('ArrowDown', 'ArrowDown'));
      simulateKey(container, createKeyEvent('ArrowLeft', 'ArrowLeft'));
      simulateKey(container, createKeyEvent('ArrowRight', 'ArrowRight'));

      expect(dataReceived.length).toBe(4);
      // Application mode: SS3 sequences (ESCOA, ESCOB, ESCOD, ESCOC)
      expect(dataReceived[0]).toBe('\x1bOA');
      expect(dataReceived[1]).toBe('\x1bOB');
      expect(dataReceived[2]).toBe('\x1bOD');
      expect(dataReceived[3]).toBe('\x1bOC');
    });
  });

  describe('Function Keys', () => {
    test('encodes F1', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('F1', 'F1'));

      expect(dataReceived.length).toBe(1);
      // F1 produces ESC[11~ or ESCOP
      expect(dataReceived[0]).toMatch(/\x1b(\[11~|OP)/);
    });

    test('encodes F12', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('F12', 'F12'));

      expect(dataReceived.length).toBe(1);
      // F12 produces ESC[24~
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });
  });

  describe('Navigation Keys', () => {
    test('encodes Home', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Home', 'Home'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });

    test('encodes End', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('End', 'End'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });

    test('encodes PageUp', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('PageUp', 'PageUp'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });

    test('encodes PageDown', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('PageDown', 'PageDown'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });

    test('encodes Delete', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Delete', 'Delete'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });

    test('encodes Insert', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('Insert', 'Insert'));

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0].includes('\x1b')).toBe(true);
    });
  });

  describe('Event Prevention', () => {
    test('prevents default on printable characters', () => {
      makeHandler();

      const event = createKeyEvent('KeyA', 'a');
      simulateKey(container, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    test('prevents default on special keys', () => {
      makeHandler();

      const event = createKeyEvent('Enter', 'Enter');
      simulateKey(container, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    test('prevents default on Ctrl+keys', () => {
      makeHandler();

      const event = createKeyEvent('KeyC', 'c', { ctrl: true });
      simulateKey(container, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('Unknown Keys', () => {
    test('ignores unmapped keys', () => {
      makeHandler();

      // Simulate a key that's not in KEY_MAP
      simulateKey(container, createKeyEvent('Unknown', 'Unknown'));

      // Should not crash or produce output
      expect(dataReceived.length).toBe(0);
    });
  });

  describe('Modifier Combinations', () => {
    test('handles Ctrl+Shift combinations', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyA', 'A', { ctrl: true, shift: true }));

      expect(dataReceived.length).toBe(1);
      // Should still encode something
      expect(dataReceived[0].length).toBeGreaterThan(0);
    });

    test('handles Alt combinations', () => {
      makeHandler();

      simulateKey(container, createKeyEvent('KeyA', 'a', { alt: true }));

      expect(dataReceived.length).toBe(1);
      // Alt+A often produces ESC a or similar
      expect(dataReceived[0].length).toBeGreaterThan(0);
    });
  });

  describe('Clipboard Operations', () => {
    test('handles paste event', () => {
      makeHandler();

      const pasteText = 'Hello, World!';
      const pasteEvent = createClipboardEvent(pasteText);

      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('handles beforeinput insertFromPaste with data', () => {
      const inputElement = createMockContainer();
      makeHandler({ inputElement: inputElement as any });

      const pasteText = 'Hello, beforeinput!';
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);

      inputElement.dispatchEvent(beforeInputEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('uses bracketed paste for beforeinput insertFromPaste', () => {
      const inputElement = createMockContainer();
      makeHandler({ inputElement: inputElement as any });
      term.write('\x1b[?2004h');

      const pasteText = 'Bracketed paste';
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);

      inputElement.dispatchEvent(beforeInputEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(`\x1b[200~${pasteText}\x1b[201~`);
    });

    test('handles multi-line paste', () => {
      makeHandler();

      const pasteText = 'Line 1\nLine 2\nLine 3';
      const pasteEvent = createClipboardEvent(pasteText);

      container.dispatchEvent(pasteEvent);

      // Without bracketed paste, newlines are sent as Enter.
      expect(dataReceived).toEqual(['Line 1\rLine 2\rLine 3']);
    });

    test('ignores beforeinput insertFromPaste when paste already handled', () => {
      const inputElement = createMockContainer();
      makeHandler({ inputElement: inputElement as any });

      const pasteText = 'Hello, World!';
      const pasteEvent = createClipboardEvent(pasteText);
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);

      container.dispatchEvent(pasteEvent);
      inputElement.dispatchEvent(beforeInputEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('ignores paste when beforeinput insertFromPaste already handled', () => {
      const inputElement = createMockContainer();
      makeHandler({ inputElement: inputElement as any });

      const pasteText = 'Hello, World!';
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);
      const pasteEvent = createClipboardEvent(pasteText);

      inputElement.dispatchEvent(beforeInputEvent);
      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('Ctrl+V is sent to the program as ^V', () => {
      makeHandler();

      const event = createKeyEvent('KeyV', 'v', { ctrl: true });
      simulateKey(container, event);

      expect(dataReceived).toEqual(['\x16']);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    test('Cmd+V and Ctrl+Shift+V are left to the browser paste', () => {
      makeHandler();

      const cmd = createKeyEvent('KeyV', 'v', { meta: true });
      const ctrlShift = createKeyEvent('KeyV', 'V', { ctrl: true, shift: true });
      simulateKey(container, cmd);
      simulateKey(container, ctrlShift);

      expect(dataReceived).toEqual([]);
      expect(cmd.preventDefault).not.toHaveBeenCalled();
      expect(ctrlShift.preventDefault).not.toHaveBeenCalled();
    });

    test('Cmd+C and Ctrl+Shift+C copy a selection instead of sending a key', () => {
      let hasSelection = true;
      const onCopy = mock(() => hasSelection);
      makeHandler({ onCopy });

      const cmd = createKeyEvent('KeyC', 'c', { meta: true });
      simulateKey(container, cmd);
      const ctrlShift = createKeyEvent('KeyC', 'C', { ctrl: true, shift: true });
      simulateKey(container, ctrlShift);
      expect(onCopy).toHaveBeenCalledTimes(2);
      expect(cmd.preventDefault).toHaveBeenCalled();
      expect(ctrlShift.preventDefault).toHaveBeenCalled();
      expect(dataReceived).toEqual([]);

      // Without a selection, Cmd+C is the browser's and Ctrl+Shift+C goes to
      // the program; plain Ctrl+C is always ^C.
      hasSelection = false;
      simulateKey(container, createKeyEvent('KeyC', 'c', { meta: true }));
      simulateKey(container, createKeyEvent('KeyC', 'C', { ctrl: true, shift: true }));
      simulateKey(container, createKeyEvent('KeyC', 'c', { ctrl: true }));
      expect(dataReceived).toEqual(['\x1b[99;6u', '\x03']);
    });

    test('paste events with nothing to paste send nothing and do not warn', () => {
      makeHandler();
      const warn = mock(() => {});
      const original = console.warn;
      console.warn = warn;
      try {
        container.dispatchEvent(createClipboardEvent(null));
        container.dispatchEvent(createClipboardEvent(''));
      } finally {
        console.warn = original;
      }
      expect(dataReceived).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('InputHandler with the terminal driving the key encoder', () => {
  let ghostty: Ghostty;
  let container: ReturnType<typeof createMockContainer>;
  let sent: string[];
  let term: ReturnType<Ghostty['createTerminal']>;
  let handler: InputHandler;

  beforeEach(async () => {
    ghostty = await Ghostty.load();
    container = createMockContainer();
    sent = [];
    term = ghostty.createTerminal(80, 24);
    handler = new InputHandler({
      ghostty,
      container: container as any,
      getTerminal: () => term,
      onData: (data) => sent.push(data),
    });
  });

  function press(
    code: string,
    key: string,
    mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
    type: 'keydown' | 'keyup' = 'keydown'
  ) {
    const event = createKeyEvent(code, key, mods);
    for (const h of container._listeners.get(type) || []) h(event);
    return event;
  }

  const last = () => sent[sent.length - 1];

  test('legacy encoding for everyday keys', () => {
    press('KeyA', 'a');
    press('KeyA', 'A', { shift: true });
    press('Enter', 'Enter');
    press('Backspace', 'Backspace');
    press('Tab', 'Tab', { shift: true });
    press('Home', 'Home');
    press('F1', 'F1');
    press('F5', 'F5');
    press('KeyC', 'c', { ctrl: true });
    press('KeyB', 'b', { alt: true });
    expect(sent).toEqual([
      'a',
      'A',
      '\r',
      '\x7f',
      '\x1b[Z',
      '\x1b[H',
      '\x1bOP',
      '\x1b[15~',
      '\x03',
      '\x1bb',
    ]);
  });

  test('follows application cursor mode set by the program', () => {
    press('ArrowUp', 'ArrowUp');
    term.write('\x1b[?1h');
    press('ArrowUp', 'ArrowUp');
    expect(sent).toEqual(['\x1b[A', '\x1bOA']);
  });

  test('Shift+Enter is distinguishable, and Kitty protocol disambiguates Escape', () => {
    // Like Ghostty, Shift+Enter uses the xterm modifyOtherKeys form even in
    // legacy mode, so programs can tell it from Enter.
    press('Enter', 'Enter', { shift: true });
    press('Escape', 'Escape');
    expect(sent).toEqual(['\x1b[27;2;13~', '\x1b']);

    sent = [];
    term.write('\x1b[>1u'); // push "disambiguate escape codes"
    press('Enter', 'Enter', { shift: true });
    press('Escape', 'Escape');
    press('KeyA', 'a', { ctrl: true });
    expect(sent).toEqual(['\x1b[13;2u', '\x1b[27u', '\x1b[97;5u']);

    sent = [];
    term.write('\x1b[<u'); // pop
    press('Escape', 'Escape');
    expect(sent).toEqual(['\x1b']);
  });

  test('Kitty keyboard protocol: key releases only when requested', () => {
    press('KeyA', 'a');
    press('KeyA', 'a', {}, 'keyup');
    expect(sent).toEqual(['a']);
    term.write('\x1b[>3u'); // disambiguate + report event types
    press('KeyA', 'a');
    press('KeyA', 'a', {}, 'keyup');
    expect(sent.slice(1)).toEqual(['a', '\x1b[97;1:3u']);
  });

  test('no release for a key whose press was not sent to the program', () => {
    term.write('\x1b[>11u'); // report event types and all keys as escape codes
    // A paste shortcut, a dead key and a key released after focus arrived.
    press('KeyV', 'v', { meta: true });
    press('KeyV', 'v', { meta: true }, 'keyup');
    press('KeyE', 'Dead');
    press('KeyE', 'Dead', {}, 'keyup');
    press('KeyQ', 'q', {}, 'keyup');
    expect(sent).toEqual([]);

    // Shift+arrow that moved a selection.
    term.write('hello');
    term.setSelectionRange(0, 0, 1, 0);
    press('ArrowRight', 'ArrowRight', { shift: true });
    press('ArrowRight', 'ArrowRight', { shift: true }, 'keyup');
    expect(sent).toEqual([]);
  });

  test('the custom key handler runs first, and returning false stops the key', () => {
    let result: boolean | undefined = false;
    handler.setCustomKeyEventHandler(() => result as boolean);

    const down = press('KeyA', 'a');
    expect(sent).toEqual([]);
    expect(down.preventDefault).not.toHaveBeenCalled();

    // As in xterm.js, only false stops processing: true and undefined proceed.
    result = true;
    press('KeyB', 'b');
    result = undefined;
    press('KeyC', 'c');
    expect(sent).toEqual(['b', 'c']);
  });

  test('the custom key handler also sees keyups and can stop them', () => {
    const types: string[] = [];
    let allowKeyup = false;
    const event = (type: string, code: string, key: string) => {
      const e = createKeyEvent(code, key) as MockKeyboardEvent & { type: string };
      e.type = type;
      for (const h of container._listeners.get(type) || []) h(e);
    };
    handler.setCustomKeyEventHandler((e) => {
      types.push(e.type);
      return e.type === 'keydown' || allowKeyup;
    });
    term.write('\x1b[>3u');
    event('keydown', 'KeyA', 'a');
    event('keyup', 'KeyA', 'a');
    expect(types).toEqual(['keydown', 'keyup']);
    expect(sent).toEqual(['a']);

    allowKeyup = true;
    event('keydown', 'KeyA', 'a');
    event('keyup', 'KeyA', 'a');
    expect(sent).toEqual(['a', 'a', '\x1b[97;1:3u']);
  });

  test('text from a key the custom handler stopped is not sent through beforeinput', () => {
    const input = createMockContainer();
    sent = [];
    const h = new InputHandler({
      ghostty,
      container: container as any,
      inputElement: input as any,
      getTerminal: () => term,
      onData: (data) => sent.push(data),
      customKeyEventHandler: (e) => e.code !== 'KeyX',
    });
    handler.dispose();
    press('KeyX', 'x');
    const insert = createBeforeInputEvent('insertText', 'x');
    input.dispatchEvent(insert);
    expect(sent).toEqual([]);
    expect(insert.preventDefault).toHaveBeenCalled();

    press('KeyX', 'x', {}, 'keyup');
    input.dispatchEvent(createBeforeInputEvent('insertText', 'y'));
    expect(sent).toEqual(['y']);
    h.dispose();
  });

  test('onKey carries the bytes sent, and fires only when something is sent', () => {
    handler.dispose();
    const keys: Array<{ key: string; code: string }> = [];
    handler = new InputHandler({
      ghostty,
      container: container as any,
      getTerminal: () => term,
      onData: (data) => sent.push(data),
      onKey: (e) => keys.push({ key: e.key, code: e.domEvent.code }),
      customKeyEventHandler: (e) => e.code !== 'KeyZ',
    });
    press('Enter', 'Enter');
    press('KeyA', 'a', { ctrl: true });
    press('ArrowUp', 'ArrowUp');
    press('KeyZ', 'z');
    press('KeyR', 'r', { meta: true });
    expect(keys).toEqual([
      { key: '\r', code: 'Enter' },
      { key: '\x01', code: 'KeyA' },
      { key: '\x1b[A', code: 'ArrowUp' },
    ]);
    expect(sent).toEqual(['\r', '\x01', '\x1b[A']);
  });

  test('mobile delete keys go through the key encoder', () => {
    handler.dispose();
    const input = createMockContainer();
    handler = new InputHandler({
      ghostty,
      container: container as any,
      inputElement: input as any,
      getTerminal: () => term,
      onData: (data) => sent.push(data),
    });
    input.dispatchEvent(createBeforeInputEvent('deleteContentBackward', null));
    input.dispatchEvent(createBeforeInputEvent('deleteContentForward', null));
    expect(sent).toEqual(['\x7f', '\x1b[3~']);

    sent = [];
    term.write('\x1b[>8u'); // Kitty: report all keys as escape codes
    input.dispatchEvent(createBeforeInputEvent('deleteContentBackward', null));
    expect(sent).toEqual(['\x1b[127u']);
  });

  test('modifyOtherKeys reports Ctrl+Shift combinations', () => {
    term.write('\x1b[>4;2m');
    press('KeyA', 'A', { ctrl: true, shift: true });
    expect(last()).toBe('\x1b[27;6;65~');
  });

  test('AltGr characters are sent as text', () => {
    const event = createKeyEvent('KeyQ', '@', { ctrl: true, alt: true });
    for (const h of container._listeners.get('keydown') || []) h(event);
    expect(last()).toBe('@');
  });

  test('dead keys and bare Cmd shortcuts are left to the browser', () => {
    let prevented = false;
    const dead = createKeyEvent('KeyE', 'Dead');
    dead.preventDefault = () => {
      prevented = true;
    };
    for (const h of container._listeners.get('keydown') || []) h(dead);
    expect(sent).toEqual([]);
    expect(prevented).toBe(false);

    const reload = createKeyEvent('KeyR', 'r', { meta: true });
    reload.preventDefault = () => {
      prevented = true;
    };
    for (const h of container._listeners.get('keydown') || []) h(reload);
    expect(sent).toEqual([]);
    expect(prevented).toBe(false);
  });

  test('Cmd combinations reach programs using the Kitty protocol', () => {
    term.write('\x1b[>1u');
    press('KeyR', 'r', { meta: true });
    expect(last()).toBe('\x1b[114;9u');
  });

  test('non-ASCII text from the layout passes through', () => {
    press('KeyE', 'é');
    press('Semicolon', 'ö');
    expect(sent).toEqual(['é', 'ö']);
  });
});
