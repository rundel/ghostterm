/**
 * InputHandler - Converts browser input events to terminal input
 *
 * Handles, on the terminal's container element:
 * - Keyboard events, encoded by libghostty's key encoder following the
 *   program's keyboard modes (Kitty protocol, modifyOtherKeys, cursor keys)
 * - IME and dead-key composition, and text from mobile keyboards (beforeinput)
 * - Paste, encoded by libghostty (bracketed paste, unsafe-byte stripping)
 * - Focus reporting (mode 1004)
 * - Mouse reporting through libghostty's mouse encoder
 */

import {
  type Ghostty,
  type GhosttyTerminal,
  type KeyEncoder,
  MouseAction,
  MouseButton,
  type MouseEncoder,
  type SelectionAdjust,
} from './ghostty';
import type { IKeyEvent } from './interfaces';
import { Key, KeyAction, KeyEncoderOption, Mods } from './types';

/** Keys that extend a selection when Shift is held (Ghostty's defaults). */
const SELECTION_KEYS: Record<string, SelectionAdjust> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'page-up',
  PageDown: 'page-down',
};

/** GhosttyOptionAsAlt: Option acts as Alt on both sides. */
const OPTION_AS_ALT_TRUE = 1;

/**
 * Map KeyboardEvent.code values to USB HID Key enum values
 * Based on: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code
 */
const KEY_MAP: Record<string, Key> = {
  // Letters
  KeyA: Key.A,
  KeyB: Key.B,
  KeyC: Key.C,
  KeyD: Key.D,
  KeyE: Key.E,
  KeyF: Key.F,
  KeyG: Key.G,
  KeyH: Key.H,
  KeyI: Key.I,
  KeyJ: Key.J,
  KeyK: Key.K,
  KeyL: Key.L,
  KeyM: Key.M,
  KeyN: Key.N,
  KeyO: Key.O,
  KeyP: Key.P,
  KeyQ: Key.Q,
  KeyR: Key.R,
  KeyS: Key.S,
  KeyT: Key.T,
  KeyU: Key.U,
  KeyV: Key.V,
  KeyW: Key.W,
  KeyX: Key.X,
  KeyY: Key.Y,
  KeyZ: Key.Z,

  // Numbers
  Digit1: Key.ONE,
  Digit2: Key.TWO,
  Digit3: Key.THREE,
  Digit4: Key.FOUR,
  Digit5: Key.FIVE,
  Digit6: Key.SIX,
  Digit7: Key.SEVEN,
  Digit8: Key.EIGHT,
  Digit9: Key.NINE,
  Digit0: Key.ZERO,

  // Special keys
  Enter: Key.ENTER,
  Escape: Key.ESCAPE,
  Backspace: Key.BACKSPACE,
  Tab: Key.TAB,
  Space: Key.SPACE,

  // Punctuation
  Minus: Key.MINUS,
  Equal: Key.EQUAL,
  BracketLeft: Key.BRACKET_LEFT,
  BracketRight: Key.BRACKET_RIGHT,
  Backslash: Key.BACKSLASH,
  Semicolon: Key.SEMICOLON,
  Quote: Key.QUOTE,
  Backquote: Key.GRAVE,
  Comma: Key.COMMA,
  Period: Key.PERIOD,
  Slash: Key.SLASH,

  // Function keys
  CapsLock: Key.CAPS_LOCK,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,

  // Special function keys
  PrintScreen: Key.PRINT_SCREEN,
  ScrollLock: Key.SCROLL_LOCK,
  Pause: Key.PAUSE,
  Insert: Key.INSERT,
  Home: Key.HOME,
  PageUp: Key.PAGE_UP,
  Delete: Key.DELETE,
  End: Key.END,
  PageDown: Key.PAGE_DOWN,

  // Arrow keys
  ArrowRight: Key.RIGHT,
  ArrowLeft: Key.LEFT,
  ArrowDown: Key.DOWN,
  ArrowUp: Key.UP,

  // Keypad
  NumLock: Key.NUM_LOCK,
  NumpadDivide: Key.KP_DIVIDE,
  NumpadMultiply: Key.KP_MULTIPLY,
  NumpadSubtract: Key.KP_MINUS,
  NumpadAdd: Key.KP_PLUS,
  NumpadEnter: Key.KP_ENTER,
  Numpad1: Key.KP_1,
  Numpad2: Key.KP_2,
  Numpad3: Key.KP_3,
  Numpad4: Key.KP_4,
  Numpad5: Key.KP_5,
  Numpad6: Key.KP_6,
  Numpad7: Key.KP_7,
  Numpad8: Key.KP_8,
  Numpad9: Key.KP_9,
  Numpad0: Key.KP_0,
  NumpadDecimal: Key.KP_PERIOD,

  // International
  IntlBackslash: Key.INTL_BACKSLASH,
  ContextMenu: Key.CONTEXT_MENU,

  // Additional function keys
  F13: Key.F13,
  F14: Key.F14,
  F15: Key.F15,
  F16: Key.F16,
  F17: Key.F17,
  F18: Key.F18,
  F19: Key.F19,
  F20: Key.F20,
  F21: Key.F21,
  F22: Key.F22,
  F23: Key.F23,
  F24: Key.F24,
};

/**
 * Mouse tracking configuration
 */
export interface MouseTrackingConfig {
  /** Check if any mouse tracking mode is enabled */
  hasMouseTracking: () => boolean;
  /** Size of the cell grid in CSS pixels (defaults to the canvas size) */
  getScreenSize?: () => { width: number; height: number };
  /** Get cell dimensions for pixel to cell conversion */
  getCellDimensions: () => { width: number; height: number };
  /** Get canvas/container offset for accurate position calculation */
  getCanvasOffset: () => { left: number; top: number };
}

export interface InputHandlerOptions {
  /** The loaded module, for creating the key and mouse encoders. */
  ghostty: Ghostty;
  /** Element whose keyboard, focus, composition, paste and mouse events are handled. */
  container: HTMLElement;
  /**
   * The element that holds keyboard focus and receives text input (the hidden
   * textarea). Focus given to the container is passed on to it, so IME
   * composition always happens there.
   */
  inputElement?: HTMLElement;
  /**
   * The WASM terminal, looked up on every use (Terminal.reset() replaces it).
   * The key encoder follows its keyboard modes; paste, focus and mouse reports
   * are encoded for it.
   */
  getTerminal: () => GhosttyTerminal | undefined;
  /** Bytes for the pty. */
  onData: (data: string) => void;
  /** Called with the bytes a key press produced, just before they are sent. */
  onKey?: (keyEvent: IKeyEvent) => void;
  /** Runs first for every keydown and keyup; returning false stops processing. */
  customKeyEventHandler?: (event: KeyboardEvent) => boolean;
  /** Runs first for every wheel event reported to the program; returning false stops it. */
  customWheelEventHandler?: (event: WheelEvent) => boolean;
  /** Copy shortcut (Cmd+C, Ctrl+Shift+C): returns true if there was a selection to copy. */
  onCopy?: () => boolean;
  mouseConfig?: MouseTrackingConfig;
}

export class InputHandler {
  private encoder: KeyEncoder;
  private ghostty: Ghostty;
  private container: HTMLElement;
  private inputElement?: HTMLElement;
  private onDataCallback: (data: string) => void;
  private onKeyCallback?: (keyEvent: IKeyEvent) => void;
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  private getTerminal: () => GhosttyTerminal | undefined;
  /** Called after Shift+arrow keys moved the selection. */
  onSelectionAdjusted?: () => void;
  private onCopyCallback?: () => boolean;
  private mouseConfig?: MouseTrackingConfig;
  private listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions?]> = [];
  private isComposing = false;
  private isDisposed = false;
  /** Codes of keys whose press went to the key encoder: only these get a release. */
  private encodedKeys = new Set<string>();
  /** The custom key handler stopped the current key: drop the text it inserts. */
  private keySwallowed = false;
  private mouseButtonsPressed = 0; // Buttons held, as a bitmask of 1 << MouseButton
  /** Whether document-level listeners follow a mouse drag (a button is held). */
  private trackingDrag = false;
  private mouseEncoder: MouseEncoder | null = null;
  private lastPasteData: string | null = null;
  private lastPasteTime = 0;
  private lastPasteSource: 'paste' | 'beforeinput' | null = null;
  private lastCompositionData: string | null = null;
  private lastCompositionTime = 0;
  private lastBeforeInputData: string | null = null;
  private lastBeforeInputTime = 0;
  private static readonly BEFORE_INPUT_IGNORE_MS = 100;

  constructor(options: InputHandlerOptions) {
    this.ghostty = options.ghostty;
    this.encoder = options.ghostty.createKeyEncoder();
    this.container = options.container;
    this.inputElement = options.inputElement;
    this.onDataCallback = options.onData;
    this.onKeyCallback = options.onKey;
    this.customKeyEventHandler = options.customKeyEventHandler;
    this.customWheelEventHandler = options.customWheelEventHandler;
    this.onCopyCallback = options.onCopy;
    this.mouseConfig = options.mouseConfig;
    this.getTerminal = options.getTerminal;

    this.attach();
  }

  /**
   * Set custom key event handler (for runtime updates)
   */
  setCustomKeyEventHandler(handler: ((event: KeyboardEvent) => boolean) | undefined): void {
    this.customKeyEventHandler = handler;
  }

  /** Set the custom wheel event handler (for runtime updates). */
  setCustomWheelEventHandler(handler: ((event: WheelEvent) => boolean) | undefined): void {
    this.customWheelEventHandler = handler;
  }

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (e: E) => void,
    options?: AddEventListenerOptions
  ): void {
    const listener = handler.bind(this) as EventListener;
    target.addEventListener(type, listener, options);
    this.listeners.push([target, type, listener, options]);
  }

  private unlisten(target: EventTarget, type: string): void {
    this.listeners = this.listeners.filter(([t, ty, listener, options]) => {
      if (t !== target || ty !== type) return true;
      t.removeEventListener(ty, listener, options);
      return false;
    });
  }

  /**
   * Attach keyboard event listeners to container
   */
  private attach(): void {
    // Make container focusable so it can receive keyboard events (browser only)
    if (
      typeof this.container.hasAttribute === 'function' &&
      typeof this.container.setAttribute === 'function'
    ) {
      if (!this.container.hasAttribute('tabindex')) {
        this.container.setAttribute('tabindex', '0');
      }
      if (this.container.style) {
        this.container.style.outline = 'none';
      }
    }

    const c = this.container;
    this.listen(c, 'keydown', this.handleKeyDown);
    // Key releases are only sent when a program asks for them (Kitty keyboard
    // protocol); the encoder produces nothing for them otherwise.
    this.listen(c, 'keyup', this.handleKeyUp);
    this.listen<FocusEvent>(c, 'focusin', (e) => this.handleFocusChange(e, true));
    this.listen<FocusEvent>(c, 'focusout', (e) => this.handleFocusChange(e, false));
    this.listen(c, 'paste', this.handlePaste);
    if (this.inputElement && this.inputElement !== c) {
      this.listen(this.inputElement, 'paste', this.handlePaste);
    }
    if (this.inputElement) {
      this.listen(this.inputElement, 'beforeinput', this.handleBeforeInput);
    }
    this.listen(c, 'compositionstart', this.handleCompositionStart);
    this.listen(c, 'compositionend', this.handleCompositionEnd);
    this.listen(c, 'mousedown', this.handleMouseDown);
    this.listen(c, 'mouseup', this.handleMouseUp);
    this.listen(c, 'mousemove', this.handleMouseMove);
    this.listen(c, 'wheel', this.handleWheel, { passive: false });
  }

  /**
   * Map KeyboardEvent.code to USB HID Key enum value
   * @param code - KeyboardEvent.code value
   * @returns Key enum value or null if unmapped
   */
  private mapKeyCode(code: string): Key | null {
    return KEY_MAP[code] ?? null;
  }

  /**
   * Extract modifier flags from KeyboardEvent. CapsLock and NumLock are not
   * reported.
   */
  private extractModifiers(event: KeyboardEvent): Mods {
    let mods = Mods.NONE;
    if (event.shiftKey) mods |= Mods.SHIFT;
    if (event.ctrlKey) mods |= Mods.CTRL;
    if (event.altKey) mods |= Mods.ALT;
    if (event.metaKey) mods |= Mods.SUPER;
    return mods;
  }

  /**
   * The text a key produced in the current layout, before any Ctrl/Meta
   * transformation, or undefined for keys that produce no text (named keys
   * such as "Enter" or "ArrowUp", dead keys, control characters).
   */
  private keyText(event: KeyboardEvent): string | undefined {
    const key = event.key;
    if (!key) return undefined;
    // Named key values are ASCII words like "Enter", "F1" or "Dead".
    if (key.length > 1 && /^[A-Za-z][A-Za-z0-9]*$/.test(key)) return undefined;
    const cp = key.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0xf700 && cp <= 0xf8ff)) return undefined;
    return key;
  }

  /**
   * The codepoint the physical key produces without Shift, which the Kitty
   * keyboard protocol reports as the key's identity.
   */
  private unshiftedCodepoint(event: KeyboardEvent, text: string | undefined): number | undefined {
    const code = event.code;
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) + 32;
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    if (code === 'Space') return 0x20;
    if (text && !event.shiftKey && [...text].length === 1) return text.codePointAt(0);
    return undefined;
  }

  /**
   * Point the encoder at the terminal's current keyboard modes. Option keeps
   * acting as Alt/Meta, as it always has in ghostterm.
   */
  private syncEncoder(): void {
    const terminal = this.getTerminal();
    if (terminal) this.encoder.syncFromTerminal(terminal);
    this.encoder.setOption(KeyEncoderOption.MACOS_OPTION_AS_ALT, OPTION_AS_ALT_TRUE);
  }

  /**
   * Encode a key event with libghostty's key encoder.
   * @returns the bytes for the pty, '' when the event produces nothing, or
   *   null for a key with no mapping
   */
  private encodeKey(event: KeyboardEvent, action: KeyAction): string | null {
    const key = this.mapKeyCode(event.code);
    if (key === null) return null;

    // Cmd combinations carry no text: in legacy mode they produce nothing (so
    // browser shortcuts keep working); the Kitty protocol can still report them.
    const text = event.metaKey ? undefined : this.keyText(event);
    const unshifted = this.unshiftedCodepoint(event, this.keyText(event));
    let mods = this.extractModifiers(event);

    let consumedMods = Mods.NONE;
    if (text) {
      const unshiftedText = unshifted !== undefined ? String.fromCodePoint(unshifted) : undefined;
      const changedText = text !== unshiftedText;
      // AltGr (reported as Ctrl+Alt) produced a character: it is plain text,
      // as the OS would have delivered it to a native terminal.
      const altGraph = event.getModifierState?.('AltGraph') ?? false;
      if (altGraph || (event.ctrlKey && event.altKey && changedText)) {
        mods &= ~(Mods.CTRL | Mods.ALT);
      }
      // Shift that went into producing the text (capitals, symbols).
      if (event.shiftKey && changedText) consumedMods |= Mods.SHIFT;
    }

    this.syncEncoder();
    const encoded = this.encoder.encode({
      action,
      key,
      mods,
      consumedMods,
      utf8: text,
      unshiftedCodepoint: unshifted,
    });
    return new TextDecoder().decode(encoded);
  }

  /** Encode a press of a key that carries no text, following the terminal's modes. */
  private encodeNamedKey(key: Key, mods: Mods = Mods.NONE): string {
    this.syncEncoder();
    return new TextDecoder().decode(this.encoder.encode({ action: KeyAction.PRESS, key, mods }));
  }

  /**
   * Handle keydown event
   * @param event - KeyboardEvent
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (this.isDisposed) return;

    // As in xterm.js, the custom handler sees every key first; returning false
    // stops the terminal processing it.
    this.keySwallowed = false;
    if (this.customKeyEventHandler && this.customKeyEventHandler(event) === false) {
      this.keySwallowed = true;
      return;
    }

    // Ignore keydown events during composition
    // Note: Some browsers send keyCode 229 for all keys during composition
    if (this.isComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    // Paste shortcuts are the browser's: its paste event delivers the text.
    // Plain Ctrl+V is a key like any other (^V, quoted insert).
    if (event.code === 'KeyV' && (event.metaKey || (event.ctrlKey && event.shiftKey))) {
      return;
    }

    // Copy shortcuts copy the selection. Without one, Cmd+C stays the
    // browser's (other text on the page may be selected) and Ctrl+Shift+C goes
    // to the program.
    if (event.code === 'KeyC' && (event.metaKey || (event.ctrlKey && event.shiftKey))) {
      if (this.onCopyCallback?.()) {
        event.preventDefault();
        return;
      }
      if (event.metaKey) return;
    }

    // Shift+arrows (and Home/End/PageUp/PageDown) extend an existing
    // selection, as in Ghostty; without a selection they go to the program.
    const adjust = SELECTION_KEYS[event.code];
    if (adjust && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const terminal = this.getTerminal();
      if (terminal?.hasSelection() && terminal.adjustSelection(adjust)) {
        event.preventDefault();
        this.onSelectionAdjusted?.();
        return;
      }
    }

    // Dead keys start a composition; the composed text arrives through
    // composition or beforeinput events.
    if (event.key === 'Dead' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      return;
    }

    let data: string | null;
    try {
      data = this.encodeKey(event, event.repeat ? KeyAction.REPEAT : KeyAction.PRESS);
    } catch (error) {
      console.warn('Failed to encode key:', event.code, error);
      return;
    }

    if (data !== null) {
      this.encodedKeys.add(event.code);
    } else {
      // A key with no physical mapping (unusual layouts and devices): fall
      // back to the text it produced, if any.
      const text = this.keyText(event);
      if (!text || event.ctrlKey || event.metaKey) return;
      data = text;
    }

    if (data.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.onKeyCallback?.({ key: data, domEvent: event });
      this.onDataCallback(data);
    } else if (!event.metaKey) {
      // Nothing to send (e.g. a bare modifier). Keep the browser from acting on
      // it, except for Cmd shortcuts, which stay the browser's.
      event.preventDefault();
    }
  }

  /**
   * Send a key press (no text) through the key encoder, so it follows the
   * terminal's keyboard modes. Used for keys the terminal synthesizes, such
   * as arrows for wheel scrolling in full-screen apps.
   */
  sendKey(key: Key, mods: Mods = Mods.NONE): void {
    const data = this.encodeNamedKey(key, mods);
    if (data) this.onDataCallback(data);
  }

  /** Whether a program is receiving mouse reports for this event. */
  isReportingMouse(event: MouseEvent): boolean {
    return !this.isDisposed && !!this.mouseConfig?.hasMouseTracking() && !event.shiftKey;
  }

  /**
   * Handle keyup: send a release event when the program asked for them, for
   * keys whose press it was sent.
   */
  private handleKeyUp(event: KeyboardEvent): void {
    if (this.isDisposed) return;
    this.keySwallowed = false;
    const pressed = this.encodedKeys.delete(event.code);
    if (this.customKeyEventHandler && this.customKeyEventHandler(event) === false) return;
    if (!pressed || this.isComposing || event.isComposing) return;
    try {
      const data = this.encodeKey(event, KeyAction.RELEASE);
      if (data) this.onDataCallback(data);
    } catch (error) {
      console.warn('Failed to encode key release:', event.code, error);
    }
  }

  /**
   * Handle paste event from clipboard
   * @param event - ClipboardEvent
   */
  private handlePaste(event: ClipboardEvent): void {
    if (this.isDisposed) return;

    event.preventDefault();
    event.stopPropagation();

    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;

    if (this.shouldIgnorePasteEvent(text, 'paste')) {
      return;
    }

    this.emitPasteData(text);
    this.recordPasteData(text, 'paste');
  }

  /**
   * Handle beforeinput event (mobile/IME input)
   * @param event - InputEvent
   */
  private handleBeforeInput(event: InputEvent): void {
    if (this.isDisposed) return;

    if (this.isComposing || event.isComposing) {
      return;
    }

    const inputType = event.inputType;
    const data = event.data ?? '';
    let output: string | null = null;

    // Text from a key the custom key handler stopped.
    if (this.keySwallowed && inputType === 'insertText') {
      event.preventDefault();
      return;
    }

    switch (inputType) {
      case 'insertText':
      case 'insertReplacementText':
        output = data.length > 0 ? data.replace(/\n/g, '\r') : null;
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        output = '\r';
        break;
      case 'deleteContentBackward':
        output = this.encodeNamedKey(Key.BACKSPACE);
        break;
      case 'deleteContentForward':
        output = this.encodeNamedKey(Key.DELETE);
        break;
      case 'insertFromPaste':
        if (!data) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (this.shouldIgnorePasteEvent(data, 'beforeinput')) {
          return;
        }
        this.emitPasteData(data);
        this.recordPasteData(data, 'beforeinput');
        return;
      default:
        return;
    }

    if (!output) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (data && this.shouldIgnoreBeforeInputFromComposition(data)) {
      return;
    }

    this.onDataCallback(output);
    if (data) {
      this.recordBeforeInputData(data);
    }
  }

  /**
   * Handle compositionstart event
   */
  private handleCompositionStart(_event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.isComposing = true;
  }

  /**
   * Handle compositionend event: the composed text is sent.
   */
  private handleCompositionEnd(event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.isComposing = false;

    const data = event.data;
    if (!data) return;
    if (this.shouldIgnoreCompositionEnd(data)) return;
    this.onDataCallback(data);
    this.recordCompositionData(data);
  }

  // ==========================================================================
  // Mouse Event Handling (for terminal mouse tracking)
  // ==========================================================================

  /**
   * The mouse encoder, synced with the terminal's tracking mode and report
   * format and with the current geometry. Null when no program asked for
   * mouse reports, or Shift is held: like Ghostty, Shift+mouse is always the
   * terminal's own (for selecting text).
   */
  private prepareMouse(
    event: MouseEvent
  ): { encoder: MouseEncoder; width: number; height: number } | null {
    if (!this.mouseConfig?.hasMouseTracking() || event.shiftKey) return null;
    const terminal = this.getTerminal();
    if (!terminal) return null;

    this.mouseEncoder ??= this.ghostty.createMouseEncoder();
    const encoder = this.mouseEncoder;
    encoder.syncFromTerminal(terminal);

    const cell = this.mouseConfig.getCellDimensions();
    if (cell.width <= 0 || cell.height <= 0) return null;
    const screen = this.mouseConfig.getScreenSize?.() ?? {
      width: terminal.cols * cell.width,
      height: terminal.rows * cell.height,
    };
    encoder.setGeometry({
      screenWidth: screen.width,
      screenHeight: screen.height,
      cellWidth: cell.width,
      cellHeight: cell.height,
    });
    encoder.setAnyButtonPressed(this.mouseButtonsPressed !== 0);
    return { encoder, width: screen.width, height: screen.height };
  }

  private mouseMods(event: MouseEvent): number {
    let mods = Mods.NONE;
    if (event.shiftKey) mods |= Mods.SHIFT;
    if (event.ctrlKey) mods |= Mods.CTRL;
    if (event.altKey) mods |= Mods.ALT;
    if (event.metaKey) mods |= Mods.SUPER;
    return mods;
  }

  /** DOM MouseEvent.button (0 left, 1 middle, 2 right, 3/4 back/forward). */
  private static readonly DOM_BUTTONS: Record<number, MouseButton> = {
    0: MouseButton.LEFT,
    1: MouseButton.MIDDLE,
    2: MouseButton.RIGHT,
    3: 8 as MouseButton,
    4: 9 as MouseButton,
  };

  /**
   * Report a mouse event at the pointer, relative to the cell grid. A pointer
   * outside the grid (while dragging) is reported at the nearest edge cell, as
   * xterm.js does.
   */
  private reportMouse(event: MouseEvent, action: MouseAction, button: MouseButton | null): boolean {
    const prepared = this.prepareMouse(event);
    if (!prepared) return false;
    const offset = this.mouseConfig!.getCanvasOffset();
    const clamp = (v: number, size: number) => Math.max(0, Math.min(v, Math.max(0, size - 1)));
    const x = clamp(event.clientX - offset.left, prepared.width);
    const y = clamp(event.clientY - offset.top, prepared.height);
    const data = prepared.encoder.encode(action, button, this.mouseMods(event), x, y);
    if (data) this.onDataCallback(data);
    return data.length > 0;
  }

  /**
   * Handle mousedown event. While a button is held, motion and the release
   * are followed on the whole document, so a drag that leaves the terminal
   * still ends with a release.
   */
  private handleMouseDown(event: MouseEvent): void {
    if (this.isDisposed) return;
    const button = InputHandler.DOM_BUTTONS[event.button];
    if (button === undefined) return;
    if (!this.mouseConfig?.hasMouseTracking() || event.shiftKey) return;
    this.mouseButtonsPressed |= 1 << button;
    this.reportMouse(event, MouseAction.PRESS, button);
    this.startDragTracking();
  }

  private startDragTracking(): void {
    if (this.trackingDrag || typeof document === 'undefined') return;
    this.trackingDrag = true;
    this.listen(document, 'mousemove', this.handleDragMove);
    this.listen(document, 'mouseup', this.handleDragUp);
  }

  private stopDragTracking(): void {
    if (!this.trackingDrag) return;
    this.trackingDrag = false;
    this.unlisten(document, 'mousemove');
    this.unlisten(document, 'mouseup');
  }

  /** Handle mouseup on the terminal (no button held through a drag). */
  private handleMouseUp(event: MouseEvent): void {
    if (this.isDisposed || this.trackingDrag) return;
    this.releaseButton(event);
  }

  private releaseButton(event: MouseEvent): void {
    const button = InputHandler.DOM_BUTTONS[event.button];
    if (button === undefined) return;
    const wasPressed = (this.mouseButtonsPressed & (1 << button)) !== 0;
    this.mouseButtonsPressed &= ~(1 << button);
    if (this.mouseButtonsPressed === 0) this.stopDragTracking();
    if (!wasPressed) return;
    this.reportMouse(event, MouseAction.RELEASE, button);
  }

  /**
   * Handle mousemove on the terminal: the encoder decides, from the tracking
   * mode and whether a button is held, if motion is reported.
   */
  private handleMouseMove(event: MouseEvent): void {
    if (this.isDisposed || this.trackingDrag) return;
    this.reportMotion(event);
  }

  private handleDragMove(event: MouseEvent): void {
    if (!this.isDisposed) this.reportMotion(event);
  }

  private handleDragUp(event: MouseEvent): void {
    if (!this.isDisposed) this.releaseButton(event);
  }

  private reportMotion(event: MouseEvent): void {
    let held: MouseButton | null = null;
    for (const b of [MouseButton.LEFT, MouseButton.MIDDLE, MouseButton.RIGHT]) {
      if (this.mouseButtonsPressed & (1 << b)) {
        held = b;
        break;
      }
    }
    this.reportMouse(event, MouseAction.MOTION, held);
  }

  /** Trackpad scrolling not yet reported, in rows (fractional). */
  private wheelRemainder = { x: 0, y: 0 };

  /**
   * How many wheel reports a wheel event is worth. Like Ghostty, a mouse wheel
   * notch is one report and trackpad scrolling is one report per cell height.
   * The browser doesn't say which device it is, so large pixel deltas are
   * taken as notches (about 100px each) and small ones are accumulated.
   */
  private wheelSteps(event: WheelEvent, delta: number, axis: 'x' | 'y'): number {
    if (event.deltaMode === 1) {
      // DOM_DELTA_LINE: Firefox reports 3 lines per notch.
      return Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 3));
    }
    if (event.deltaMode === 2) return Math.sign(delta); // DOM_DELTA_PAGE
    if (Math.abs(delta) >= 50) {
      this.wheelRemainder[axis] = 0;
      return Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 100));
    }
    const cell = this.mouseConfig?.getCellDimensions();
    const size = axis === 'y' ? cell?.height : cell?.width;
    if (!size || size <= 0) return Math.sign(delta);
    this.wheelRemainder[axis] += delta / size;
    const steps = Math.trunc(this.wheelRemainder[axis]);
    this.wheelRemainder[axis] -= steps;
    return steps;
  }

  /**
   * Handle wheel event: reported as wheel-button presses to a program
   * tracking the mouse.
   */
  private handleWheel(event: WheelEvent): void {
    if (this.isDisposed || !this.isReportingMouse(event)) return;
    // As in xterm.js, a custom handler returning false stops all processing
    // (and the page may scroll).
    if (this.customWheelEventHandler && this.customWheelEventHandler(event) === false) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = horizontal ? event.deltaX : event.deltaY;
    // The program owns the wheel while it tracks the mouse; never also scroll
    // the page or the terminal, even for movement too small to report yet.
    event.preventDefault();
    if (delta === 0) return;
    const steps = this.wheelSteps(event, delta, horizontal ? 'x' : 'y');
    const button = horizontal
      ? steps < 0
        ? MouseButton.WHEEL_LEFT
        : MouseButton.WHEEL_RIGHT
      : steps < 0
        ? MouseButton.WHEEL_UP
        : MouseButton.WHEEL_DOWN;
    for (let i = 0; i < Math.min(Math.abs(steps), 10); i++) {
      this.reportMouse(event, MouseAction.PRESS, button);
    }
  }

  /**
   * Send pasted text. libghostty applies the terminal's paste modes (bracketed
   * paste, Kitty paste events) and makes the text safe to send.
   */
  private emitPasteData(text: string): void {
    const data = this.getTerminal()?.encodePaste(text);
    if (data) this.onDataCallback(data);
  }

  /**
   * Report focus changes to programs that asked for them (mode 1004). Focus
   * moving between elements inside the terminal doesn't count. Focus given to
   * the container itself is passed on to the input element.
   */
  private handleFocusChange(event: FocusEvent, focused: boolean): void {
    if (this.isDisposed) return;
    if (focused && event.target === this.container && this.inputElement) {
      this.inputElement.focus();
    }
    const other = event.relatedTarget as Node | null;
    if (other && typeof this.container.contains === 'function' && this.container.contains(other)) {
      return;
    }
    if (!focused) {
      // Keys released elsewhere never reach us, and a composition interrupted
      // by the focus change won't end here.
      this.isComposing = false;
      this.encodedKeys.clear();
    }
    const data = this.getTerminal()?.encodeFocus(focused);
    if (data) this.onDataCallback(data);
  }

  /**
   * Record paste data for beforeinput de-duplication
   */
  private recordPasteData(data: string, source: 'paste' | 'beforeinput'): void {
    this.lastPasteData = data;
    this.lastPasteTime = this.getNow();
    this.lastPasteSource = source;
  }

  /**
   * Check if beforeinput text should be ignored due to a recent composition end
   */
  private shouldIgnoreBeforeInputFromComposition(data: string): boolean {
    if (!this.lastCompositionData) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate =
      now - this.lastCompositionTime < InputHandler.BEFORE_INPUT_IGNORE_MS &&
      this.lastCompositionData === data;
    if (isDuplicate) {
      this.lastCompositionData = null;
    }
    return isDuplicate;
  }

  /**
   * Check if composition end should be ignored due to a recent beforeinput text
   */
  private shouldIgnoreCompositionEnd(data: string): boolean {
    if (!this.lastBeforeInputData) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate =
      now - this.lastBeforeInputTime < InputHandler.BEFORE_INPUT_IGNORE_MS &&
      this.lastBeforeInputData === data;
    if (isDuplicate) {
      this.lastBeforeInputData = null;
    }
    return isDuplicate;
  }

  /**
   * Record beforeinput text for composition de-duplication
   */
  private recordBeforeInputData(data: string): void {
    this.lastBeforeInputData = data;
    this.lastBeforeInputTime = this.getNow();
  }

  /**
   * Record composition end data for beforeinput de-duplication
   */
  private recordCompositionData(data: string): void {
    this.lastCompositionData = data;
    this.lastCompositionTime = this.getNow();
  }

  /**
   * Check if paste should be ignored due to a recent paste event from another source
   */
  private shouldIgnorePasteEvent(data: string, source: 'paste' | 'beforeinput'): boolean {
    if (!this.lastPasteData) {
      return false;
    }
    if (this.lastPasteSource === source) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate =
      now - this.lastPasteTime < InputHandler.BEFORE_INPUT_IGNORE_MS && this.lastPasteData === data;
    if (isDuplicate) {
      this.lastPasteData = null;
      this.lastPasteSource = null;
    }
    return isDuplicate;
  }

  /**
   * Get current time in milliseconds
   */
  private getNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /**
   * Dispose the InputHandler: remove event listeners and free the encoders.
   */
  dispose(): void {
    if (this.isDisposed) return;

    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    this.listeners = [];
    this.trackingDrag = false;

    this.encoder.dispose();
    this.mouseEncoder?.dispose();
    this.mouseEncoder = null;

    this.isDisposed = true;
  }

  /**
   * Check if handler is disposed
   */
  isActive(): boolean {
    return !this.isDisposed;
  }
}
