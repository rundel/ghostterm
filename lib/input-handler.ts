/**
 * InputHandler - Converts browser keyboard events to terminal input
 *
 * Handles:
 * - Keyboard event listening on a container element
 * - Mapping KeyboardEvent.code to USB HID Key codes
 * - Extracting modifier keys (Ctrl, Alt, Shift, Meta)
 * - Encoding keys using Ghostty's KeyEncoder
 * - Emitting data for Terminal to send to PTY
 *
 * Limitations:
 * - Does not handle IME/composition events (CJK input) - to be added later
 * - Captures all keyboard input (preventDefault on everything)
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

/**
 * Map KeyboardEvent.code values to USB HID Key enum values
 * Based on: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code
 */
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
 * InputHandler class
 * Attaches keyboard event listeners to a container and converts
 * keyboard events to terminal input data
 */
/**
 * Mouse tracking configuration
 */
export interface MouseTrackingConfig {
  /** Check if any mouse tracking mode is enabled */
  hasMouseTracking: () => boolean;
  /**
   * @deprecated The report format now comes from the terminal's modes through
   * libghostty's mouse encoder; this is no longer called.
   */
  hasSgrMouseMode?: () => boolean;
  /** Size of the cell grid in CSS pixels (defaults to the canvas size) */
  getScreenSize?: () => { width: number; height: number };
  /** Get cell dimensions for pixel to cell conversion */
  getCellDimensions: () => { width: number; height: number };
  /** Get canvas/container offset for accurate position calculation */
  getCanvasOffset: () => { left: number; top: number };
}

export class InputHandler {
  private encoder: KeyEncoder;
  private ghostty: Ghostty;
  private container: HTMLElement;
  private inputElement?: HTMLElement;
  private onDataCallback: (data: string) => void;
  private onBellCallback: () => void;
  private onKeyCallback?: (keyEvent: IKeyEvent) => void;
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;
  private getModeCallback?: (mode: number) => boolean;
  private getTerminal?: () => GhosttyTerminal | undefined;
  /** Called after Shift+arrow keys moved the selection. */
  onSelectionAdjusted?: () => void;
  private keyupListener: ((e: KeyboardEvent) => void) | null = null;
  private focusInListener: ((e: FocusEvent) => void) | null = null;
  private focusOutListener: ((e: FocusEvent) => void) | null = null;
  private onCopyCallback?: () => boolean;
  private mouseConfig?: MouseTrackingConfig;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;
  private keypressListener: ((e: KeyboardEvent) => void) | null = null;
  private pasteListener: ((e: ClipboardEvent) => void) | null = null;
  private beforeInputListener: ((e: InputEvent) => void) | null = null;
  private compositionStartListener: ((e: CompositionEvent) => void) | null = null;
  private compositionUpdateListener: ((e: CompositionEvent) => void) | null = null;
  private compositionEndListener: ((e: CompositionEvent) => void) | null = null;
  private mousedownListener: ((e: MouseEvent) => void) | null = null;
  private mouseupListener: ((e: MouseEvent) => void) | null = null;
  private mousemoveListener: ((e: MouseEvent) => void) | null = null;
  private wheelListener: ((e: WheelEvent) => void) | null = null;
  private isComposing = false;
  private isDisposed = false;
  private mouseButtonsPressed = 0; // Buttons held, as a bitmask of 1 << MouseButton
  private mouseEncoder: MouseEncoder | null = null;
  private lastKeyDownData: string | null = null;
  private lastKeyDownTime = 0;
  private lastPasteData: string | null = null;
  private lastPasteTime = 0;
  private lastPasteSource: 'paste' | 'beforeinput' | null = null;
  private lastCompositionData: string | null = null;
  private lastCompositionTime = 0;
  private lastBeforeInputData: string | null = null;
  private lastBeforeInputTime = 0;
  private static readonly BEFORE_INPUT_IGNORE_MS = 100;

  /**
   * Create a new InputHandler
   * @param ghostty - Ghostty instance (for creating KeyEncoder)
   * @param container - DOM element to attach listeners to
   * @param onData - Callback for terminal data (escape sequences to send to PTY)
   * @param onBell - Callback for bell/beep event
   * @param onKey - Optional callback for raw key events
   * @param customKeyEventHandler - Optional custom key event handler
   * @param getMode - Optional callback to query terminal mode state (for application cursor mode)
   * @param onCopy - Optional callback to handle copy (Cmd+C/Ctrl+C with selection)
   * @param inputElement - Optional input element for beforeinput events
   * @param mouseConfig - Optional mouse tracking configuration
   * @param getTerminal - Optional accessor for the WASM terminal. When given,
   *   the key encoder follows all of the terminal's keyboard modes (Kitty
   *   keyboard protocol, modifyOtherKeys, keypad mode, ...); otherwise only
   *   cursor key mode is followed, through getMode.
   */
  constructor(
    ghostty: Ghostty,
    container: HTMLElement,
    onData: (data: string) => void,
    onBell: () => void,
    onKey?: (keyEvent: IKeyEvent) => void,
    customKeyEventHandler?: (event: KeyboardEvent) => boolean,
    getMode?: (mode: number) => boolean,
    onCopy?: () => boolean,
    inputElement?: HTMLElement,
    mouseConfig?: MouseTrackingConfig,
    getTerminal?: () => GhosttyTerminal | undefined
  ) {
    this.ghostty = ghostty;
    this.encoder = ghostty.createKeyEncoder();
    this.container = container;
    this.inputElement = inputElement;
    this.onDataCallback = onData;
    this.onBellCallback = onBell;
    this.onKeyCallback = onKey;
    this.customKeyEventHandler = customKeyEventHandler;
    this.getModeCallback = getMode;
    this.onCopyCallback = onCopy;
    this.mouseConfig = mouseConfig;
    this.getTerminal = getTerminal;

    // Attach event listeners
    this.attach();
  }

  /**
   * Set custom key event handler (for runtime updates)
   */
  setCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyEventHandler = handler;
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

      // Add visual focus indication (only if style exists - for browser environments)
      if (this.container.style) {
        this.container.style.outline = 'none'; // Remove default outline
      }
    }

    this.keydownListener = this.handleKeyDown.bind(this);
    this.container.addEventListener('keydown', this.keydownListener);

    // Key releases are only sent when a program asks for them (Kitty keyboard
    // protocol); the encoder produces nothing for them otherwise.
    this.keyupListener = this.handleKeyUp.bind(this);
    this.container.addEventListener('keyup', this.keyupListener);

    this.focusInListener = (e: FocusEvent) => this.handleFocusChange(e, true);
    this.focusOutListener = (e: FocusEvent) => this.handleFocusChange(e, false);
    this.container.addEventListener('focusin', this.focusInListener);
    this.container.addEventListener('focusout', this.focusOutListener);

    this.pasteListener = this.handlePaste.bind(this);
    this.container.addEventListener('paste', this.pasteListener);
    if (this.inputElement && this.inputElement !== this.container) {
      this.inputElement.addEventListener('paste', this.pasteListener);
    }

    if (this.inputElement) {
      this.beforeInputListener = this.handleBeforeInput.bind(this);
      this.inputElement.addEventListener('beforeinput', this.beforeInputListener);
    }

    this.compositionStartListener = this.handleCompositionStart.bind(this);
    this.container.addEventListener('compositionstart', this.compositionStartListener);

    this.compositionUpdateListener = this.handleCompositionUpdate.bind(this);
    this.container.addEventListener('compositionupdate', this.compositionUpdateListener);

    this.compositionEndListener = this.handleCompositionEnd.bind(this);
    this.container.addEventListener('compositionend', this.compositionEndListener);

    // Mouse event listeners (for terminal mouse tracking)
    this.mousedownListener = this.handleMouseDown.bind(this);
    this.container.addEventListener('mousedown', this.mousedownListener);

    this.mouseupListener = this.handleMouseUp.bind(this);
    this.container.addEventListener('mouseup', this.mouseupListener);

    this.mousemoveListener = this.handleMouseMove.bind(this);
    this.container.addEventListener('mousemove', this.mousemoveListener);

    this.wheelListener = this.handleWheel.bind(this);
    this.container.addEventListener('wheel', this.wheelListener, { passive: false });
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
   * Extract modifier flags from KeyboardEvent
   * @param event - KeyboardEvent
   * @returns Mods flags
   */
  private extractModifiers(event: KeyboardEvent): Mods {
    let mods = Mods.NONE;

    if (event.shiftKey) mods |= Mods.SHIFT;
    if (event.ctrlKey) mods |= Mods.CTRL;
    if (event.altKey) mods |= Mods.ALT;
    if (event.metaKey) mods |= Mods.SUPER;

    // Note: CapsLock and NumLock are not in KeyboardEvent modifiers
    // They would need to be tracked separately if needed
    // For now, we don't set CAPSLOCK or NUMLOCK flags

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
    const terminal = this.getTerminal?.();
    if (terminal) {
      this.encoder.syncFromTerminal(terminal);
    } else if (this.getModeCallback) {
      this.encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, this.getModeCallback(1));
    }
    this.encoder.setOption(KeyEncoderOption.MACOS_OPTION_AS_ALT, OPTION_AS_ALT_TRUE);
  }

  /**
   * Encode a key event with libghostty's key encoder.
   * @returns the bytes for the pty, or '' when the event produces nothing
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

  /**
   * Handle keydown event
   * @param event - KeyboardEvent
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (this.isDisposed) return;

    // Ignore keydown events during composition
    // Note: Some browsers send keyCode 229 for all keys during composition
    if (this.isComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    // Emit onKey event first (before any processing)
    if (this.onKeyCallback) {
      this.onKeyCallback({ key: event.key, domEvent: event });
    }

    // Check custom key event handler
    if (this.customKeyEventHandler) {
      const handled = this.customKeyEventHandler(event);
      if (handled) {
        // Custom handler consumed the event
        event.preventDefault();
        return;
      }
    }

    // Allow Ctrl+V and Cmd+V to trigger paste event (don't preventDefault)
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') {
      // Let the browser's native paste event fire
      return;
    }

    // Handle Cmd+C for copy (on Mac, Cmd+C should copy, not send interrupt)
    // Note: Ctrl+C on all platforms sends interrupt signal (0x03)
    if (event.metaKey && event.code === 'KeyC') {
      // Try to copy selection via callback
      // If there's a selection and copy succeeds, prevent default
      // If no selection, let it fall through (browser may have other text selected)
      if (this.onCopyCallback && this.onCopyCallback()) {
        event.preventDefault();
      }
      return;
    }

    // Shift+arrows (and Home/End/PageUp/PageDown) extend an existing
    // selection, as in Ghostty; without a selection they go to the program.
    const adjust = SELECTION_KEYS[event.code];
    if (adjust && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const terminal = this.getTerminal?.();
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
      // Encoding failed - log but don't crash
      console.warn('Failed to encode key:', event.code, error);
      return;
    }

    // A key with no physical mapping (unusual layouts and devices): fall back
    // to the text it produced, if any.
    if (data === null) {
      const text = this.keyText(event);
      if (!text || event.ctrlKey || event.metaKey) return;
      data = text;
    }

    if (data.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.onDataCallback(data);
      this.recordKeyDownData(data);
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
    this.syncEncoder();
    const data = new TextDecoder().decode(
      this.encoder.encode({ action: KeyAction.PRESS, key, mods })
    );
    if (data) this.onDataCallback(data);
  }

  /** Whether a program is receiving mouse reports for this event. */
  isReportingMouse(event: MouseEvent): boolean {
    return !this.isDisposed && !!this.mouseConfig?.hasMouseTracking() && !event.shiftKey;
  }

  /**
   * Handle keyup: send a release event when the program asked for them.
   */
  private handleKeyUp(event: KeyboardEvent): void {
    if (this.isDisposed || this.isComposing || event.isComposing) return;
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

    // Prevent default paste behavior
    event.preventDefault();
    event.stopPropagation();

    // Get clipboard data
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      console.warn('No clipboard data available');
      return;
    }

    // Get text from clipboard
    const text = clipboardData.getData('text/plain');
    if (!text) {
      console.warn('No text in clipboard');
      return;
    }

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
        output = '\x7F';
        break;
      case 'deleteContentForward':
        output = '\x1B[3~';
        break;
      case 'insertFromPaste':
        if (!data) {
          return;
        }
        if (this.shouldIgnorePasteEvent(data, 'beforeinput')) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.emitPasteData(data);
        this.recordPasteData(data, 'beforeinput');
        return;
      default:
        return;
    }

    if (!output) {
      return;
    }

    if (this.shouldIgnoreBeforeInput(output)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (data && this.shouldIgnoreBeforeInputFromComposition(data)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
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
   * Handle compositionupdate event
   */
  private handleCompositionUpdate(_event: CompositionEvent): void {
    if (this.isDisposed) return;
    // We could track the current composition string here if we wanted to
    // display it in a custom way, but for now we rely on the browser's
    // input method editor UI.
  }

  /**
   * Handle compositionend event
   */
  private handleCompositionEnd(event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.isComposing = false;

    const data = event.data;
    if (data && data.length > 0) {
      if (this.shouldIgnoreCompositionEnd(data)) {
        this.cleanupCompositionTextNodes();
        return;
      }
      this.onDataCallback(data);
      this.recordCompositionData(data);
    }

    this.cleanupCompositionTextNodes();
  }

  /**
   * Cleanup text nodes in container after composition
   */
  private cleanupCompositionTextNodes(): void {
    // Cleanup text nodes in container (fix for duplicate text display)
    // When the container is contenteditable, the browser might insert text nodes
    // upon composition end. We need to remove them to prevent duplicate display.
    if (this.container && this.container.childNodes) {
      for (let i = this.container.childNodes.length - 1; i >= 0; i--) {
        const node = this.container.childNodes[i];
        // Node.TEXT_NODE === 3
        if (node.nodeType === 3) {
          this.container.removeChild(node);
        }
      }
    }
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
  private prepareMouse(event: MouseEvent): MouseEncoder | null {
    if (!this.mouseConfig?.hasMouseTracking() || event.shiftKey) return null;
    const terminal = this.getTerminal?.();
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
    return encoder;
  }

  /** Pointer position relative to the cell grid, in CSS pixels. */
  private mousePosition(event: MouseEvent): { x: number; y: number } {
    const offset = this.mouseConfig!.getCanvasOffset();
    return { x: event.clientX - offset.left, y: event.clientY - offset.top };
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

  private reportMouse(event: MouseEvent, action: MouseAction, button: MouseButton | null): boolean {
    const encoder = this.prepareMouse(event);
    if (!encoder) return false;
    const { x, y } = this.mousePosition(event);
    const data = encoder.encode(action, button, this.mouseMods(event), x, y);
    if (data) this.onDataCallback(data);
    return data.length > 0;
  }

  /**
   * Handle mousedown event
   */
  private handleMouseDown(event: MouseEvent): void {
    if (this.isDisposed) return;
    const button = InputHandler.DOM_BUTTONS[event.button];
    if (button === undefined) return;
    if (!this.mouseConfig?.hasMouseTracking() || event.shiftKey) return;
    this.mouseButtonsPressed |= 1 << button;
    this.reportMouse(event, MouseAction.PRESS, button);
  }

  /**
   * Handle mouseup event
   */
  private handleMouseUp(event: MouseEvent): void {
    if (this.isDisposed) return;
    const button = InputHandler.DOM_BUTTONS[event.button];
    if (button === undefined) return;
    const wasPressed = (this.mouseButtonsPressed & (1 << button)) !== 0;
    this.mouseButtonsPressed &= ~(1 << button);
    if (!wasPressed) return;
    this.reportMouse(event, MouseAction.RELEASE, button);
  }

  /**
   * Handle mousemove event: the encoder decides, from the tracking mode and
   * whether a button is held, if motion is reported.
   */
  private handleMouseMove(event: MouseEvent): void {
    if (this.isDisposed) return;
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
   * Emit paste data with bracketed paste support
   */
  private emitPasteData(text: string): void {
    const terminal = this.getTerminal?.();
    if (terminal) {
      // libghostty applies the terminal's paste modes (bracketed paste, Kitty
      // paste events) and makes the text safe to send.
      const data = terminal.encodePaste(text);
      if (data) this.onDataCallback(data);
      return;
    }
    const hasBracketedPaste = this.getModeCallback?.(2004) ?? false;
    this.onDataCallback(hasBracketedPaste ? '\x1b[200~' + text + '\x1b[201~' : text);
  }

  /**
   * Report focus changes to programs that asked for them (mode 1004). Focus
   * moving between elements inside the terminal doesn't count.
   */
  private handleFocusChange(event: FocusEvent, focused: boolean): void {
    if (this.isDisposed) return;
    const other = event.relatedTarget as Node | null;
    if (other && typeof this.container.contains === 'function' && this.container.contains(other)) {
      return;
    }
    const data = this.getTerminal?.()?.encodeFocus(focused);
    if (data) this.onDataCallback(data);
  }

  /**
   * Record keydown data for beforeinput de-duplication
   */
  private recordKeyDownData(data: string): void {
    this.lastKeyDownData = data;
    this.lastKeyDownTime = this.getNow();
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
   * Check if beforeinput should be ignored due to a recent keydown
   */
  private shouldIgnoreBeforeInput(data: string): boolean {
    if (!this.lastKeyDownData) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate =
      now - this.lastKeyDownTime < InputHandler.BEFORE_INPUT_IGNORE_MS &&
      this.lastKeyDownData === data;
    this.lastKeyDownData = null;
    return isDuplicate;
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
   * Dispose the InputHandler and remove event listeners
   */
  dispose(): void {
    if (this.isDisposed) return;

    this.mouseEncoder?.dispose();
    this.mouseEncoder = null;

    if (this.keydownListener) {
      this.container.removeEventListener('keydown', this.keydownListener);
      this.keydownListener = null;
    }

    if (this.keyupListener) {
      this.container.removeEventListener('keyup', this.keyupListener);
      this.keyupListener = null;
    }
    if (this.focusInListener) {
      this.container.removeEventListener('focusin', this.focusInListener);
      this.focusInListener = null;
    }
    if (this.focusOutListener) {
      this.container.removeEventListener('focusout', this.focusOutListener);
      this.focusOutListener = null;
    }

    if (this.keypressListener) {
      this.container.removeEventListener('keypress', this.keypressListener);
      this.keypressListener = null;
    }

    if (this.pasteListener) {
      this.container.removeEventListener('paste', this.pasteListener);
      if (this.inputElement && this.inputElement !== this.container) {
        this.inputElement.removeEventListener('paste', this.pasteListener);
      }
      this.pasteListener = null;
    }

    if (this.beforeInputListener && this.inputElement) {
      this.inputElement.removeEventListener('beforeinput', this.beforeInputListener);
      this.beforeInputListener = null;
    }

    if (this.compositionStartListener) {
      this.container.removeEventListener('compositionstart', this.compositionStartListener);
      this.compositionStartListener = null;
    }

    if (this.compositionUpdateListener) {
      this.container.removeEventListener('compositionupdate', this.compositionUpdateListener);
      this.compositionUpdateListener = null;
    }

    if (this.compositionEndListener) {
      this.container.removeEventListener('compositionend', this.compositionEndListener);
      this.compositionEndListener = null;
    }

    if (this.mousedownListener) {
      this.container.removeEventListener('mousedown', this.mousedownListener);
      this.mousedownListener = null;
    }

    if (this.mouseupListener) {
      this.container.removeEventListener('mouseup', this.mouseupListener);
      this.mouseupListener = null;
    }

    if (this.mousemoveListener) {
      this.container.removeEventListener('mousemove', this.mousemoveListener);
      this.mousemoveListener = null;
    }

    if (this.wheelListener) {
      this.container.removeEventListener('wheel', this.wheelListener);
      this.wheelListener = null;
    }

    this.isDisposed = true;
  }

  /**
   * Check if handler is disposed
   */
  isActive(): boolean {
    return !this.isDisposed;
  }
}
