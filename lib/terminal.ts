/**
 * Terminal - Main terminal emulator class
 *
 * Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.
 *
 * Usage:
 * ```typescript
 * import { init, Terminal } from 'ghostterm';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { BufferNamespace } from './buffer';
import { EventEmitter } from './event-emitter';
import type {
  ClipboardLocation,
  Ghostty,
  GhosttyTerminal,
  GhosttyTerminalConfig,
  ProgramStatus,
  ProgressReport,
  SemanticPromptEvent,
  TerminalColors,
  TerminalNotification,
} from './ghostty';
import { getGhostty } from './index';
import { InputHandler, type MouseTrackingConfig } from './input-handler';
import type {
  IBufferNamespace,
  IBufferRange,
  IDisposable,
  IEvent,
  IKeyEvent,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
  IUnicodeVersionProvider,
} from './interfaces';
import { LinkDetector } from './link-detector';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { CanvasRenderer, DEFAULT_THEME, parseCssColor } from './renderer';
import { SelectionManager } from './selection-manager';
import type { ILink, ILinkProvider } from './types';
import { Key } from './types';

// ============================================================================
// Terminal Class
// ============================================================================

export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;

  // Unicode API (xterm.js compatibility)
  public readonly unicode: IUnicodeVersionProvider = {
    get activeVersion(): string {
      return '15.1'; // Ghostty supports Unicode 15.1
    },
  };

  // Options (public for xterm.js compatibility)
  public readonly options!: Required<ITerminalOptions>;

  // Components (created on open())
  private ghostty?: Ghostty;
  public wasmTerm?: GhosttyTerminal; // Made public for link providers
  public renderer?: CanvasRenderer; // Made public for FitAddon
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private canvas?: HTMLCanvasElement;

  // Link detection system
  private linkDetector?: LinkDetector;
  private currentHoveredLink?: ILink;
  private mouseMoveThrottleTimeout?: number;
  private pendingMouseMove?: MouseEvent;

  // Event emitters
  private dataEmitter = new EventEmitter<string>();
  private resizeEmitter = new EventEmitter<{ cols: number; rows: number }>();
  private bellEmitter = new EventEmitter<void>();
  private selectionChangeEmitter = new EventEmitter<void>();
  private keyEmitter = new EventEmitter<IKeyEvent>();
  private titleChangeEmitter = new EventEmitter<string>();
  private scrollEmitter = new EventEmitter<number>();
  private renderEmitter = new EventEmitter<{ start: number; end: number }>();
  private cursorMoveEmitter = new EventEmitter<void>();
  private workingDirectoryEmitter = new EventEmitter<string>();
  private clipboardWriteEmitter = new EventEmitter<{ text: string; location: ClipboardLocation }>();
  private notificationEmitter = new EventEmitter<TerminalNotification>();
  private progressEmitter = new EventEmitter<ProgressReport>();
  private programStatusEmitter = new EventEmitter<ProgramStatus>();
  private semanticPromptEmitter = new EventEmitter<SemanticPromptEvent>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  public readonly onBell: IEvent<void> = this.bellEmitter.event;
  public readonly onSelectionChange: IEvent<void> = this.selectionChangeEmitter.event;
  public readonly onKey: IEvent<IKeyEvent> = this.keyEmitter.event;
  public readonly onTitleChange: IEvent<string> = this.titleChangeEmitter.event;
  public readonly onScroll: IEvent<number> = this.scrollEmitter.event;
  public readonly onRender: IEvent<{ start: number; end: number }> = this.renderEmitter.event;
  public readonly onCursorMove: IEvent<void> = this.cursorMoveEmitter.event;

  // Requests from the running program, reported by libghostty
  /** The program reported its working directory (OSC 7), as a file:// URL. */
  public readonly onWorkingDirectoryChange: IEvent<string> = this.workingDirectoryEmitter.event;
  /** The program wrote text to the clipboard (OSC 52). */
  public readonly onClipboardWrite: IEvent<{ text: string; location: ClipboardLocation }> =
    this.clipboardWriteEmitter.event;
  /** The program asked for a desktop notification (OSC 9 / OSC 777). */
  public readonly onNotification: IEvent<TerminalNotification> = this.notificationEmitter.event;
  /** The program reported progress (OSC 9;4). */
  public readonly onProgress: IEvent<ProgressReport> = this.progressEmitter.event;
  /** The program reported its status (OSC 7501), e.g. an agent waiting for input. */
  public readonly onProgramStatus: IEvent<ProgramStatus> = this.programStatusEmitter.event;
  /** Shell integration: prompt, input, output and command-end markers (OSC 133). */
  public readonly onSemanticPrompt: IEvent<SemanticPromptEvent> = this.semanticPromptEmitter.event;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private writeQueue: Uint8Array[] = [];
  private awaitingEcho = false;

  // Addons
  private addons: ITerminalAddon[] = [];

  // Custom event handlers
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;

  // Title tracking
  private currentTitle: string = '';

  /**
   * Rows the view is scrolled above the bottom (0 = following output). May be
   * fractional during smooth scrolling. Change it through
   * scrollToViewportOffset() or smoothScrollTo().
   */
  public viewportY: number = 0;
  /** Where a smooth scroll is heading (equal to viewportY when none runs). */
  private targetViewportY: number = 0;
  private scrollAnimationFrame?: number;
  /** The top line last reported by onScroll. */
  private lastScrollTop = 0;
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  private lastCursorY: number = 0; // Track cursor position for onCursorMove

  // Scrollbar interaction state
  private isDraggingScrollbar: boolean = false;
  private scrollbarDragStart: number | null = null;
  private scrollbarDragStartViewportY: number = 0;

  // Scrollbar visibility/auto-hide state
  private scrollbarFade = { from: 0, to: 0, start: 0 };
  private scrollbarHideTimeout?: number;
  private readonly SCROLLBAR_HIDE_DELAY_MS = 1500; // Hide after 1.5 seconds
  private readonly SCROLLBAR_FADE_DURATION_MS = 200; // 200ms fade animation

  constructor(options: ITerminalOptions = {}) {
    // Use provided Ghostty instance (for test isolation) or get module-level instance
    this.ghostty = options.ghostty ?? getGhostty();

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: options.theme ?? {},
      scrollback: options.scrollback ?? 10000,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      allowTransparency: options.allowTransparency ?? false,
      convertEol: options.convertEol ?? false,
      disableStdin: options.disableStdin ?? false,
      smoothScrollDuration: options.smoothScrollDuration ?? 100, // Default: 100ms smooth scroll
    };

    // Wrap in Proxy to intercept runtime changes (xterm.js compatibility)
    (this.options as any) = new Proxy(baseOptions, {
      set: (target: any, prop: string, value: any) => {
        const oldValue = target[prop];
        target[prop] = value;

        // Apply runtime changes if terminal is open
        if (this.isOpen) {
          this.handleOptionChange(prop, value, oldValue);
        }

        return true;
      },
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
  }

  // ==========================================================================
  // Option Change Handling (for mutable options)
  // ==========================================================================

  /**
   * Handle runtime option changes (called when options are modified after terminal is open)
   * This enables xterm.js compatibility where options can be changed at runtime
   */
  private handleOptionChange(key: string, newValue: any, oldValue: any): void {
    if (newValue === oldValue) return;

    switch (key) {
      case 'disableStdin':
        // Input handler already checks this.options.disableStdin dynamically
        // No action needed
        break;

      case 'cursorBlink':
      case 'cursorStyle':
        // libghostty keeps these as the defaults a program can override.
        this.wasmTerm?.setDefaultCursor(this.options.cursorStyle, this.options.cursorBlink);
        if (this.renderer) {
          this.renderer.setCursorStyle(this.options.cursorStyle);
          this.renderer.setCursorBlink(this.options.cursorBlink);
        }
        break;

      case 'theme':
        // libghostty re-resolves every cell's colors; the renderer picks up
        // the selection, cursor and background colors.
        this.wasmTerm?.setColors(this.themeColors());
        if (this.renderer && this.wasmTerm) {
          this.renderer.setTheme(this.options.theme);
          this.renderer.render(this.wasmTerm, true, this.viewportY, this.scrollbarOpacity);
        }
        break;

      case 'fontSize':
        if (this.renderer) {
          this.renderer.setFontSize(this.options.fontSize);
          this.handleFontChange();
        }
        break;

      case 'fontFamily':
        if (this.renderer) {
          this.renderer.setFontFamily(this.options.fontFamily);
          this.handleFontChange();
        }
        break;

      case 'cols':
      case 'rows':
        // Redirect to resize method
        this.resize(this.options.cols, this.options.rows);
        break;
    }
  }

  /**
   * Handle font changes (fontSize or fontFamily)
   * Updates canvas size to match new font metrics and forces a full re-render
   */
  private handleFontChange(): void {
    if (!this.renderer || !this.wasmTerm || !this.canvas) return;

    // Clear any active selection since pixel positions have changed
    if (this.selectionManager) {
      this.selectionManager.clearSelection();
    }

    // Resize canvas to the new font metrics. renderer.resize() sizes the
    // canvas for the device pixel ratio and the scrollbar gutter.
    this.renderer.resize(this.cols, this.rows);
    this.syncCellPixelSize();

    // Force full re-render with new font
    this.renderer.render(this.wasmTerm, true, this.viewportY, this.scrollbarOpacity);
  }

  /**
   * Convert terminal options to WASM terminal config. Colors are applied
   * separately (themeColors), so they can change after open().
   */
  private buildWasmConfig(): GhosttyTerminalConfig | undefined {
    return { scrollbackLimit: this.options.scrollback };
  }

  /**
   * The theme as libghostty default colors, with DEFAULT_THEME for unset
   * entries, so libghostty and the renderer agree and programs asking for the
   * colors (OSC 10/11/4) get an answer. A background that isn't an RGB color
   * ('transparent') counts as black, as the renderer assumes.
   */
  private themeColors(): TerminalColors {
    const theme = { ...DEFAULT_THEME, ...this.options.theme };
    const color = (c?: string) => parseCssColor(c);
    return {
      foreground: color(theme.foreground),
      background: color(theme.background) ?? 0,
      cursor: color(theme.cursor),
      // Order: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones
      palette: [
        theme.black,
        theme.red,
        theme.green,
        theme.yellow,
        theme.blue,
        theme.magenta,
        theme.cyan,
        theme.white,
        theme.brightBlack,
        theme.brightRed,
        theme.brightGreen,
        theme.brightYellow,
        theme.brightBlue,
        theme.brightMagenta,
        theme.brightCyan,
        theme.brightWhite,
      ].map(color),
    };
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Open terminal in a parent element
   *
   * Initializes all components and starts rendering.
   * Requires a pre-loaded Ghostty instance passed to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) {
      throw new Error('Terminal is already open');
    }
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }

    // Store parent element
    this.element = parent;
    this.isOpen = true;

    try {
      // Make parent focusable if it isn't already
      if (!parent.hasAttribute('tabindex')) {
        parent.setAttribute('tabindex', '0');
      }

      // Mark as contenteditable so browser extensions (Vimium, etc.) recognize
      // this as an input element and don't intercept keyboard events.
      parent.setAttribute('contenteditable', 'true');
      // Prevent actual content editing - we handle input ourselves
      parent.addEventListener('beforeinput', (e) => {
        if (e.target === parent) {
          e.preventDefault();
        }
      });

      // Add accessibility attributes for screen readers and extensions
      parent.setAttribute('role', 'textbox');
      parent.setAttribute('aria-label', 'Terminal input');
      parent.setAttribute('aria-multiline', 'true');

      // Create WASM terminal with current dimensions and config
      const config = this.buildWasmConfig();
      this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
      this.connectEffects(this.wasmTerm);

      // Create canvas element
      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.cursor = 'text';

      parent.appendChild(this.canvas);

      // Create hidden textarea for keyboard input (must be inside parent for event bubbling)
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('autocorrect', 'off');
      this.textarea.setAttribute('autocapitalize', 'off');
      this.textarea.setAttribute('spellcheck', 'false');
      this.textarea.setAttribute('tabindex', '0'); // Allow focus for mobile keyboard
      this.textarea.setAttribute('aria-label', 'Terminal input');
      // Use clip-path to completely hide the textarea and its caret
      this.textarea.style.position = 'absolute';
      this.textarea.style.left = '0';
      this.textarea.style.top = '0';
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.padding = '0';
      this.textarea.style.border = 'none';
      this.textarea.style.margin = '0';
      this.textarea.style.opacity = '0';
      this.textarea.style.clipPath = 'inset(50%)'; // Clip everything including caret
      this.textarea.style.overflow = 'hidden';
      this.textarea.style.whiteSpace = 'nowrap';
      this.textarea.style.resize = 'none';
      parent.appendChild(this.textarea);

      // Focus textarea on interaction - preventDefault before focus
      const textarea = this.textarea;
      // Desktop: mousedown
      this.canvas.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });
      // Mobile: touchend with preventDefault to suppress iOS caret
      this.canvas.addEventListener('touchend', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });

      // Create renderer
      this.renderer = new CanvasRenderer(this.canvas, {
        fontSize: this.options.fontSize,
        fontFamily: this.options.fontFamily,
        cursorStyle: this.options.cursorStyle,
        cursorBlink: this.options.cursorBlink,
        theme: this.options.theme,
      });

      // Size canvas to terminal dimensions (use renderer.resize for proper DPI scaling)
      this.renderer.resize(this.cols, this.rows);

      // Create mouse tracking configuration
      const canvas = this.canvas;
      const renderer = this.renderer;
      const wasmTerm = this.wasmTerm;
      const mouseConfig: MouseTrackingConfig = {
        // this.wasmTerm, not a captured reference: reset() replaces it.
        hasMouseTracking: () => this.wasmTerm?.hasMouseTracking() ?? false,
        getScreenSize: () => ({
          width: this.cols * renderer.charWidth,
          height: this.rows * renderer.charHeight,
        }),
        getCellDimensions: () => ({
          width: renderer.charWidth,
          height: renderer.charHeight,
        }),
        getCanvasOffset: () => {
          const rect = canvas.getBoundingClientRect();
          return { left: rect.left, top: rect.top };
        },
      };

      // Create input handler
      this.inputHandler = new InputHandler({
        ghostty: this.ghostty!,
        container: parent,
        inputElement: this.textarea,
        getTerminal: () => this.wasmTerm,
        onData: (data: string) => {
          // Check if stdin is disabled
          if (this.options.disableStdin) {
            return;
          }
          // Clear selection when user types
          this.selectionManager?.clearSelection();
          // The user's own input returns to the bottom (xterm.js scrollOnUserInput);
          // output alone leaves a scrolled-up view where it is.
          if (this.viewportY !== 0) this.scrollToBottom();
          this.awaitingEcho = true;
          // Input handler fires data events
          this.dataEmitter.fire(data);
        },
        onKey: (keyEvent: IKeyEvent) => this.keyEmitter.fire(keyEvent),
        customKeyEventHandler: this.customKeyEventHandler,
        // Copy shortcuts: returns true if there was a selection to copy
        onCopy: () => this.copySelection(),
        mouseConfig,
      });

      this.syncCellPixelSize();

      // Shift+arrow selection changes come from the input handler
      this.inputHandler.onSelectionAdjusted = () => this.selectionChangeEmitter.fire();

      // Create selection manager (pass textarea for context menu positioning)
      this.selectionManager = new SelectionManager(
        this,
        this.renderer,
        this.wasmTerm,
        this.textarea
      );

      // Forward selection change events
      this.selectionManager.onSelectionChange(() => {
        this.selectionChangeEmitter.fire();
      });

      // Initialize link detection system
      this.linkDetector = new LinkDetector(this);

      // Register link providers
      // OSC8 first (explicit hyperlinks take precedence)
      this.linkDetector.registerProvider(new OSC8LinkProvider(this));
      // URL regex second (fallback for plain text URLs)
      this.linkDetector.registerProvider(new UrlRegexProvider(this));

      // Setup mouse event handling for links and scrollbar
      // Use capture phase to intercept scrollbar clicks before SelectionManager
      parent.addEventListener('mousedown', this.handleMouseDown, { capture: true });
      parent.addEventListener('mousemove', this.handleMouseMove);
      parent.addEventListener('mouseleave', this.handleMouseLeave);
      parent.addEventListener('click', this.handleClick);

      // Setup document-level mouseup for scrollbar drag (so drag works even outside canvas)
      document.addEventListener('mouseup', this.handleMouseUp);

      // Setup wheel event handling for scrolling (Phase 2)
      // Use capture phase to ensure we get the event before browser scrolling
      parent.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });

      // Render initial blank screen (force full redraw)
      this.renderer.render(this.wasmTerm, true, this.viewportY, this.scrollbarOpacity);

      // Start render loop
      this.startRenderLoop();

      // Focus input (auto-focus so user can start typing immediately)
      this.focus();
    } catch (error) {
      // Clean up on error
      this.isOpen = false;
      this.cleanupComponents();
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * Write data to terminal
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertOpen();

    // Handle convertEol option
    if (this.options.convertEol && typeof data === 'string') {
      data = data.replace(/\n/g, '\r\n');
    }

    this.writeInternal(data, callback);
  }

  /**
   * Internal write implementation (extracted from write())
   */
  private writeInternal(data: string | Uint8Array, callback?: () => void): void {
    // Note: We intentionally do NOT clear selection on write - most modern terminals
    // preserve selection when new data arrives. Selection is cleared by user actions
    // like clicking or typing, not by incoming data.

    // When scrolled up, libghostty keeps its viewport on the same content as
    // output pushes rows into history. Point it at what is displayed first so
    // we can follow it afterwards.
    const scrolledOffset = Math.max(0, Math.floor(this.viewportY));
    if (scrolledOffset > 0) this.wasmTerm!.setViewportOffset(scrolledOffset);

    // Write directly to WASM terminal (handles VT parsing internally)
    this.wasmTerm!.write(data);
    if (scrolledOffset > 0) this.followScrolledContent(scrolledOffset);
    // New lines move the top line when following output (as in xterm.js).
    this.fireScrollIfMoved();

    // Process any responses generated by the terminal (e.g., DSR cursor position)
    // These need to be sent back to the PTY via onData
    this.processTerminalResponses();

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    // The program may have asked for another pointer shape (OSC 22); a hovered
    // link keeps its pointer.
    if (this.canvas && !this.currentHoveredLink) {
      const shape = this.pointerShape();
      if (this.canvas.style.cursor !== shape) {
        this.canvas.style.cursor = shape;
        if (this.element) this.element.style.cursor = shape;
      }
    }

    // Call callback if provided
    if (callback) {
      // Queue callback after next render
      requestAnimationFrame(callback);
    }

    if (this.awaitingEcho) {
      this.awaitingEcho = false;
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this.scrollbarOpacity);
      }
    }

    // Render will happen on next animation frame
  }

  /**
   * Write data with newline
   */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') {
      this.write(data + '\r\n', callback);
    } else {
      // Append \r\n to Uint8Array
      const newData = new Uint8Array(data.length + 2);
      newData.set(data);
      newData[data.length] = 0x0d; // \r
      newData[data.length + 1] = 0x0a; // \n
      this.write(newData, callback);
    }
  }

  /**
   * Paste text into terminal (triggers bracketed paste if supported)
   */
  paste(data: string): void {
    this.assertOpen();

    // Don't paste if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    this.awaitingEcho = true;

    // libghostty applies the paste modes (bracketed paste, Kitty paste events)
    // and makes the text safe to send.
    const encoded = this.wasmTerm!.encodePaste(data);
    if (encoded) this.dataEmitter.fire(encoded);
  }

  /**
   * Input data into terminal (as if typed by user)
   *
   * @param data - Data to input
   * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
   */
  input(data: string, wasUserInput: boolean = false): void {
    this.assertOpen();

    // Don't input if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    if (wasUserInput) {
      this.awaitingEcho = true;
      // Trigger onData event as if user typed it
      this.dataEmitter.fire(data);
    } else {
      // Just write to terminal without triggering onData
      this.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resize(cols: number, rows: number): void {
    this.assertOpen();

    if (cols === this.cols && rows === this.rows) {
      return; // No change
    }

    // Cancel render loop before resize to prevent accessing detached TypedArray
    // views while WASM reallocates buffers. We restart it after resize completes.
    // This avoids the background-tab regression of using an isResizing flag
    // cleared via requestAnimationFrame (rAF is throttled/paused in background tabs).
    this.cancelRenderLoop();

    try {
      // Update dimensions
      this.cols = cols;
      this.rows = rows;

      // Resize WASM terminal (may reallocate buffers, invalidating TypedArray views)
      this.wasmTerm!.resize(cols, rows);

      // Resize renderer (sizes the canvas for the device pixel ratio and gutter)
      this.renderer!.resize(cols, rows);

      // Fire resize event
      this.resizeEmitter.fire({ cols, rows });

      // Force full render
      this.renderer!.render(this.wasmTerm!, true, this.viewportY, this.scrollbarOpacity);
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }

    // Flush any writes that were queued during resize, then restart render loop
    this.flushWriteQueue();
    this.startRenderLoop();
  }

  /**
   * Clear terminal screen
   */
  clear(): void {
    this.assertOpen();
    // Send ANSI clear screen and cursor home sequences
    this.wasmTerm!.write('\x1b[2J\x1b[H');
  }

  /**
   * Reset terminal state
   */
  reset(): void {
    this.assertOpen();

    // Free old WASM terminal and create new one
    if (this.wasmTerm) {
      this.wasmTerm.free();
    }
    const config = this.buildWasmConfig();
    this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
    this.connectEffects(this.wasmTerm);
    this.syncCellPixelSize();

    // Clear renderer
    this.renderer!.clear();

    // Reset title
    this.currentTitle = '';
  }

  /**
   * Focus terminal input
   */
  focus(): void {
    if (this.isOpen && this.element) {
      // Focus immediately for immediate keyboard/wheel event handling
      this.element.focus();

      // Also schedule a delayed focus as backup to ensure it sticks
      // (some browsers may need this if DOM isn't fully settled)
      setTimeout(() => {
        this.element?.focus();
      }, 0);
    }
  }

  /**
   * Blur terminal (remove focus)
   */
  blur(): void {
    if (this.isOpen && this.element) {
      this.element.blur();
    }
  }

  /**
   * Load an addon
   */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  // ==========================================================================
  // Selection API (xterm.js compatible)
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  public getSelection(): string {
    return this.selectionManager?.getSelection() || '';
  }

  /**
   * Check if there's an active selection
   */
  public hasSelection(): boolean {
    return this.selectionManager?.hasSelection() || false;
  }

  /**
   * Clear the current selection
   */
  public clearSelection(): void {
    this.selectionManager?.clearSelection();
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  public copySelection(): boolean {
    return this.selectionManager?.copySelection() || false;
  }

  /**
   * Select all text in the terminal
   */
  public selectAll(): void {
    this.selectionManager?.selectAll();
  }

  /**
   * Select text at specific column and row with length
   */
  public select(column: number, row: number, length: number): void {
    this.selectionManager?.select(column, row, length);
  }

  /**
   * Select entire lines from start to end
   */
  public selectLines(start: number, end: number): void {
    this.selectionManager?.selectLines(start, end);
  }

  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  /**
   * Get selection position as buffer range
   */
  public getSelectionPosition(): IBufferRange | undefined {
    return this.selectionManager?.getSelectionPosition();
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

  /**
   * Attach a custom keyboard event handler, run before the terminal processes
   * each keydown and keyup. As in xterm.js, it returns whether the terminal
   * should process the event: returning false stops it (nothing is sent and
   * onKey does not fire), so the handler can take over the key. The handler
   * may call preventDefault itself.
   */
  public attachCustomKeyEventHandler(
    customKeyEventHandler: (event: KeyboardEvent) => boolean
  ): void {
    this.customKeyEventHandler = customKeyEventHandler;
    // Update input handler if already created
    if (this.inputHandler) {
      this.inputHandler.setCustomKeyEventHandler(customKeyEventHandler);
    }
  }

  /**
   * Attach a custom wheel event handler (Phase 2)
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.customWheelEventHandler = customWheelEventHandler;
  }

  // ==========================================================================
  // Link Detection Methods
  // ==========================================================================

  /**
   * Register a custom link provider
   * Multiple providers can be registered to detect different types of links
   *
   * @example
   * ```typescript
   * term.registerLinkProvider({
   *   provideLinks(y, callback) {
   *     // Detect URLs, file paths, etc.
   *     callback(detectedLinks);
   *   }
   * });
   * ```
   */
  public registerLinkProvider(provider: ILinkProvider): void {
    if (!this.linkDetector) {
      throw new Error('Terminal must be opened before registering link providers');
    }
    this.linkDetector.registerProvider(provider);
  }

  // ==========================================================================
  // Scrolling
  // ==========================================================================

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }
    // Relative to where a running smooth scroll is heading.
    this.scrollToViewportOffset(Math.round(this.targetViewportY) - amount);
  }

  /**
   * Scroll viewport by a number of pages
   * @param amount Number of pages to scroll (positive = down, negative = up)
   */
  public scrollPages(amount: number): void {
    this.scrollLines(amount * this.rows);
  }

  /**
   * Scroll viewport to the top of the scrollback buffer
   */
  public scrollToTop(): void {
    this.scrollToViewportOffset(this.getScrollbackLength());
  }

  /**
   * Scroll viewport to the bottom (current output)
   */
  public scrollToBottom(): void {
    this.scrollToViewportOffset(0);
  }

  /**
   * Scroll so that buffer line `line` is the top of the viewport (xterm.js
   * semantics: 0 is the oldest scrollback line, `buffer.active.baseY` the
   * bottom). Clamped to the buffer.
   */
  public scrollToLine(line: number): void {
    this.scrollToViewportOffset(this.getScrollbackLength() - line);
  }

  /**
   * Scroll by `delta` shell prompts (negative = older, positive = newer).
   * Needs shell integration (OSC 133 prompt marks). Returns whether it moved.
   */
  public scrollToPrompt(delta: number): boolean {
    if (!this.wasmTerm) return false;
    this.wasmTerm.setViewportOffset(Math.max(0, Math.floor(this.viewportY)));
    if (!this.wasmTerm.scrollToPrompt(delta)) return false;
    this.scrollToViewportOffset(this.wasmTerm.getViewportOffset());
    return true;
  }

  /**
   * @internal Scroll to `offset` rows above the bottom (0 = following output),
   * at once. Every scroll that isn't animated goes through here: it stops a
   * running smooth scroll, so that can't pull the view back.
   */
  public scrollToViewportOffset(offset: number): void {
    const scrollbackLength = this.getScrollbackLength();
    const target = Math.max(0, Math.min(scrollbackLength, offset));
    this.cancelScrollAnimation();
    this.targetViewportY = target;
    if (target === this.viewportY) return;
    this.viewportY = target;
    this.fireScrollIfMoved();
    if (scrollbackLength > 0) this.showScrollbar();
  }

  /** The buffer line at the top of the viewport (xterm.js `buffer.active.viewportY`). */
  private topLine(): number {
    return Math.max(0, this.getScrollbackLength() - Math.max(0, Math.floor(this.viewportY)));
  }

  /** Fire onScroll (with the top line, as xterm.js does) when it changed. */
  private fireScrollIfMoved(): void {
    const top = this.topLine();
    if (top === this.lastScrollTop) return;
    this.lastScrollTop = top;
    this.scrollEmitter.fire(top);
  }

  private cancelScrollAnimation(): void {
    if (this.scrollAnimationFrame !== undefined) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }
  }

  /**
   * After output arrived while scrolled up, move ghostterm's offset by as
   * many rows as libghostty's viewport moved, so the same content stays on
   * screen. libghostty clamps the viewport when history is pruned under it.
   */
  private followScrolledContent(before: number): void {
    const after = this.wasmTerm!.getViewportOffset();
    const delta = after - before;
    if (delta === 0) return;
    this.viewportY = Math.max(0, this.viewportY + delta);
    this.targetViewportY = Math.max(0, this.targetViewportY + delta);
  }

  /**
   * Smoothly scroll to a target viewport position
   * @param targetY Target viewport Y position (in lines, can be fractional)
   */
  private smoothScrollTo(targetY: number): void {
    if (!this.wasmTerm) return;

    // If smooth scrolling is disabled (duration = 0), jump immediately
    const duration = this.options.smoothScrollDuration ?? 100;
    if (duration === 0) {
      this.scrollToViewportOffset(targetY);
      return;
    }

    // Update the target; a running animation continues toward it, which
    // avoids choppy restarts during continuous scrolling.
    this.targetViewportY = Math.max(0, Math.min(this.getScrollbackLength(), targetY));
    if (this.scrollAnimationFrame === undefined) this.animateScroll();
  }

  /**
   * Animation loop for smooth scrolling
   * Uses asymptotic approach - moves a fraction of remaining distance each frame
   */
  private animateScroll = (): void => {
    this.scrollAnimationFrame = undefined;
    if (!this.wasmTerm) return;

    const duration = this.options.smoothScrollDuration ?? 100;
    const distance = this.targetViewportY - this.viewportY;

    if (Math.abs(distance) < 0.01) {
      // Close enough: snap to the target, animation complete
      this.viewportY = this.targetViewportY;
    } else {
      // Move a fraction of the remaining distance each frame (ease-out over
      // about `duration` ms at 60fps)
      const framesForDuration = (duration / 1000) * 60;
      const moveRatio = 1 - (1 / framesForDuration) ** 2;
      this.viewportY += distance * moveRatio;
      this.scrollAnimationFrame = requestAnimationFrame(this.animateScroll);
    }

    this.fireScrollIfMoved();
    if (this.getScrollbackLength() > 0) this.showScrollbar();
  };

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    // Stop render loop and clear write queue
    this.cancelRenderLoop();
    this.writeQueue.length = 0;

    this.cancelScrollAnimation();

    // Clear mouse move throttle timeout
    if (this.mouseMoveThrottleTimeout) {
      clearTimeout(this.mouseMoveThrottleTimeout);
      this.mouseMoveThrottleTimeout = undefined;
    }
    this.pendingMouseMove = undefined;

    // Dispose addons
    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons = [];

    // Clean up components
    this.cleanupComponents();

    // Dispose event emitters
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.bellEmitter.dispose();
    this.selectionChangeEmitter.dispose();
    this.keyEmitter.dispose();
    this.titleChangeEmitter.dispose();
    this.scrollEmitter.dispose();
    this.renderEmitter.dispose();
    this.cursorMoveEmitter.dispose();
    this.workingDirectoryEmitter.dispose();
    this.clipboardWriteEmitter.dispose();
    this.notificationEmitter.dispose();
    this.progressEmitter.dispose();
    this.programStatusEmitter.dispose();
    this.semanticPromptEmitter.dispose();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Cancel the render loop
   */
  private cancelRenderLoop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /**
   * Flush any writes that were queued during resize
   */
  private flushWriteQueue(): void {
    while (this.writeQueue.length > 0) {
      const data = this.writeQueue.shift()!;
      this.wasmTerm!.write(data);
    }
  }

  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    if (this.animationFrameId) return; // already running
    const loop = () => {
      if (!this.isDisposed && this.isOpen) {
        // Render using WASM's native dirty tracking
        // The render() method:
        // 1. Calls update() once to sync state and check dirty flags
        // 2. Only redraws dirty rows when forceAll=false
        // 3. Always calls clearDirty() at the end
        this.renderer!.render(this.wasmTerm!, false, this.viewportY, this.scrollbarOpacity);

        // Check for cursor movement (Phase 2: onCursorMove event)
        // Note: getCursor() reads from already-updated render state (from render() above)
        const cursor = this.wasmTerm!.getCursor();
        if (cursor.y !== this.lastCursorY) {
          this.lastCursorY = cursor.y;
          this.cursorMoveEmitter.fire();
        }

        // Note: onRender event is intentionally not fired in the render loop
        // to avoid performance issues. For now, consumers can use requestAnimationFrame
        // if they need frame-by-frame updates.

        this.animationFrameId = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  /** Rows of history above the active area. */
  public getScrollbackLength(): number {
    if (!this.wasmTerm) return 0;
    return this.wasmTerm.getScrollbackLength();
  }

  /**
   * Clean up components (called on dispose or error)
   */
  private cleanupComponents(): void {
    // Dispose selection manager
    if (this.selectionManager) {
      this.selectionManager.dispose();
      this.selectionManager = undefined;
    }

    // Dispose input handler
    if (this.inputHandler) {
      this.inputHandler.dispose();
      this.inputHandler = undefined;
    }

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    // Remove canvas from DOM
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = undefined;
    }

    // Remove textarea from DOM
    if (this.textarea && this.textarea.parentNode) {
      this.textarea.parentNode.removeChild(this.textarea);
      this.textarea = undefined;
    }

    // Remove event listeners
    if (this.element) {
      this.element.removeEventListener('wheel', this.handleWheel, { capture: true });
      this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.element.removeEventListener('mousemove', this.handleMouseMove);
      this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      this.element.removeEventListener('click', this.handleClick);

      // Remove contenteditable and accessibility attributes added in open()
      this.element.removeAttribute('contenteditable');
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('aria-multiline');
    }

    // Remove document-level listeners (only if opened)
    if (this.isOpen && typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleMouseUp);
    }

    // Clean up scrollbar timers
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // Dispose link detector
    if (this.linkDetector) {
      this.linkDetector.dispose();
      this.linkDetector = undefined;
    }

    // Free WASM terminal
    if (this.wasmTerm) {
      this.wasmTerm.free();
      this.wasmTerm = undefined;
    }

    // Clear references
    this.ghostty = undefined;
    this.element = undefined;
    this.textarea = undefined;
  }

  /**
   * Assert terminal is open (throw if not)
   */
  private assertOpen(): void {
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }
    if (!this.isOpen) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
  }

  /**
   * Handle mouse move for link hover detection and scrollbar dragging
   * Throttled to avoid blocking scroll events (except when dragging scrollbar)
   */
  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    // If dragging scrollbar, handle immediately without throttling
    if (this.isDraggingScrollbar) {
      this.processScrollbarDrag(e);
      return;
    }

    if (!this.linkDetector) return;

    // Throttle to ~60fps (16ms) to avoid blocking scroll/other events
    if (this.mouseMoveThrottleTimeout) {
      this.pendingMouseMove = e;
      return;
    }

    this.processMouseMove(e);

    this.mouseMoveThrottleTimeout = window.setTimeout(() => {
      this.mouseMoveThrottleTimeout = undefined;
      if (this.pendingMouseMove) {
        const pending = this.pendingMouseMove;
        this.pendingMouseMove = undefined;
        this.processMouseMove(pending);
      }
    }, 16);
  };

  /**
   * Process mouse move for link detection (internal, called by throttled handler)
   */
  private processMouseMove(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Convert mouse coordinates to terminal cell position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const y = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);

    // Get hyperlink_id directly from the cell at this position
    // Must account for viewportY (scrollback position)
    const viewportRow = y; // Row in the viewport (0 to rows-1)
    let hyperlinkId = 0;

    // The viewport row as displayed (libghostty's viewport follows the scroll).
    const line = this.wasmTerm.getViewportLine(viewportRow);

    if (line && x >= 0 && x < line.length) {
      hyperlinkId = line[x].hyperlink_id;
    }

    // Update renderer for underline rendering
    const previousHyperlinkId = this.renderer.getHoveredHyperlinkId();
    if (hyperlinkId !== previousHyperlinkId) {
      this.renderer.setHoveredHyperlinkId(hyperlinkId);

      // The 60fps render loop will pick up the change automatically
      // No need to force a render - this keeps performance smooth
    }

    // Check if there's a link at this position (for click handling and cursor)
    const bufferRow = this.viewportRowToBufferRow(viewportRow);

    // Make async call non-blocking - don't await
    this.linkDetector
      .getLinkAt(x, bufferRow)
      .then((link) => {
        // Update hover state for cursor changes and click handling
        if (link !== this.currentHoveredLink) {
          // Notify old link we're leaving
          this.currentHoveredLink?.hover?.(false);

          // Update current link
          this.currentHoveredLink = link;

          // Notify new link we're entering
          link?.hover?.(true);

          // Update cursor style on both container and canvas
          const cursorStyle = link ? 'pointer' : this.pointerShape();
          if (this.element) {
            this.element.style.cursor = cursorStyle;
          }
          if (this.canvas) {
            this.canvas.style.cursor = cursorStyle;
          }

          // Update renderer for underline (for regex URLs without hyperlink_id)
          if (this.renderer) {
            if (link) {
              const startViewportY = this.bufferRowToViewportRow(link.range.start.y);
              const endViewportY = this.bufferRowToViewportRow(link.range.end.y);

              // Only show underline if link is visible in viewport
              if (startViewportY < this.rows && endViewportY >= 0) {
                this.renderer.setHoveredLinkRange({
                  startX: link.range.start.x,
                  startY: Math.max(0, startViewportY),
                  endX: link.range.end.x,
                  endY: Math.min(this.rows - 1, endViewportY),
                });
              } else {
                this.renderer.setHoveredLinkRange(null);
              }
            } else {
              this.renderer.setHoveredLinkRange(null);
            }
          }
        }
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  /**
   * Handle mouse leave to clear link hover
   */
  private handleMouseLeave = (): void => {
    // Clear hyperlink underline
    if (this.renderer && this.wasmTerm) {
      const previousHyperlinkId = this.renderer.getHoveredHyperlinkId();
      if (previousHyperlinkId > 0) {
        this.renderer.setHoveredHyperlinkId(0);

        // The 60fps render loop will pick up the change automatically
      }
      // Clear regex link underline
      this.renderer.setHoveredLinkRange(null);
    }

    if (this.currentHoveredLink) {
      // Notify link we're leaving
      this.currentHoveredLink.hover?.(false);

      // Clear hovered link
      this.currentHoveredLink = undefined;

      // Reset cursor
      if (this.element) {
        this.element.style.cursor = this.pointerShape();
        if (this.canvas) {
          this.canvas.style.cursor = this.pointerShape();
        }
      }
    }
  };

  /**
   * Handle mouse click for link activation
   */
  private handleClick = (e: MouseEvent): void => {
    // The link is looked up at click time rather than taken from the hover
    // state (which is throttled). The built-in providers answer synchronously,
    // so the link opens within the click's user gesture and the default action
    // can still be prevented; only custom asynchronous providers resolve later.
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const y = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);
    const found = this.linkDetector.findLinkAt(x, this.viewportRowToBufferRow(y));
    if (found instanceof Promise) {
      found.then((link) => link?.activate(e)).catch(() => {});
      return;
    }
    if (!found) return;
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    found.activate(e);
  };

  /**
   * Handle wheel events for scrolling (Phase 2)
   */
  private handleWheel = (e: WheelEvent): void => {
    // A program tracking the mouse gets the wheel as mouse reports. This
    // listener runs in the capture phase, so it must let the event through to
    // the InputHandler, which reports it (and prevents the page scrolling).
    if (this.inputHandler?.isReportingMouse(e)) {
      return;
    }

    // Always prevent default browser scrolling
    e.preventDefault();
    e.stopPropagation();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      return;
    }

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application
      // Applications like vim handle scrolling internally
      // Standard: ~3 arrow presses per wheel "click"
      const direction = e.deltaY > 0 ? 'down' : 'up';
      const count = Math.min(Math.abs(Math.round(e.deltaY / 33)), 5); // Cap at 5

      // Encoded by libghostty, so application cursor mode (ESC O A) is honored.
      const key = direction === 'up' ? Key.UP : Key.DOWN;
      for (let i = 0; i < count; i++) {
        this.inputHandler?.sendKey(key);
      }
    } else {
      // Normal screen: scroll viewport through history with smooth scrolling
      // Handle different deltaMode values for better trackpad/mouse support
      let deltaLines: number;

      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Pixel mode (trackpads): convert pixels to lines
        // Use actual line height from renderer for accurate conversion
        const lineHeight = this.renderer?.getMetrics()?.height ?? 20;
        deltaLines = e.deltaY / lineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Line mode (some mice): use directly
        deltaLines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Page mode (rare): convert pages to lines
        deltaLines = e.deltaY * this.rows;
      } else {
        // Fallback: assume pixel mode with legacy divisor
        deltaLines = e.deltaY / 33;
      }

      // Use smooth scrolling for any amount (no rounding needed)
      if (deltaLines !== 0) {
        // Calculate target position
        // deltaY > 0 = scroll down (decrease viewportY)
        // deltaY < 0 = scroll up (increase viewportY)
        const targetY = this.viewportY - deltaLines;
        this.smoothScrollTo(targetY);
      }
    }
  };

  /** The scrollbar as drawn now, in CSS px relative to the canvas. */
  private scrollbarThumb() {
    return this.renderer!.getScrollbarThumb(this.viewportY, this.getScrollbackLength(), this.rows);
  }

  /**
   * Handle mouse down for scrollbar interaction
   */
  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return; // No scrollbar if no scrollback

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const bar = this.scrollbarThumb();
    if (mouseX < bar.x || mouseX > bar.x + bar.width) return;

    // Keep the click from starting a text selection
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation(); // Stop SelectionManager from seeing this event

    if (mouseY >= bar.y && mouseY <= bar.y + bar.height) {
      // Start dragging the thumb
      this.isDraggingScrollbar = true;
      this.scrollbarDragStart = mouseY;
      this.scrollbarDragStartViewportY = this.viewportY;
      this.canvas.style.userSelect = 'none';
      this.canvas.style.webkitUserSelect = 'none';
      this.showScrollbar();
    } else {
      // Click on the track: jump there (top = oldest line, bottom = newest)
      const fraction = 1 - (mouseY - bar.trackY) / bar.trackHeight;
      this.scrollToViewportOffset(Math.round(fraction * scrollbackLength));
    }
  };

  /**
   * Handle mouse up for scrollbar drag
   */
  private handleMouseUp = (): void => {
    if (!this.isDraggingScrollbar) return;
    this.isDraggingScrollbar = false;
    this.scrollbarDragStart = null;

    // Restore text selection
    if (this.canvas) {
      this.canvas.style.userSelect = '';
      this.canvas.style.webkitUserSelect = '';
    }

    // Start the auto-hide timer again
    if (this.getScrollbackLength() > 0) this.showScrollbar();
  };

  /**
   * Process scrollbar drag movement
   */
  private processScrollbarDrag(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || this.scrollbarDragStart === null) return;

    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const deltaY = e.clientY - rect.top - this.scrollbarDragStart;
    const bar = this.scrollbarThumb();
    const travel = bar.trackHeight - bar.height;
    if (travel <= 0) return;

    // The thumb moving down scrolls toward the bottom (a smaller offset).
    const rows = Math.round((-deltaY / travel) * scrollbackLength);
    this.scrollToViewportOffset(this.scrollbarDragStartViewportY + rows);
  }

  /**
   * The scrollbar's opacity now: it fades between `from` and `to` over
   * SCROLLBAR_FADE_DURATION_MS from `start`. The render loop reads it every
   * frame, so fading needs no animation loop of its own.
   */
  private get scrollbarOpacity(): number {
    const { from, to, start } = this.scrollbarFade;
    const progress = Math.min(1, (performance.now() - start) / this.SCROLLBAR_FADE_DURATION_MS);
    return from + (to - from) * Math.max(0, progress);
  }

  private fadeScrollbar(to: number): void {
    if (this.scrollbarFade.to === to) return;
    this.scrollbarFade = { from: this.scrollbarOpacity, to, start: performance.now() };
  }

  /**
   * Show scrollbar with fade-in and schedule auto-hide
   */
  private showScrollbar(): void {
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }
    this.fadeScrollbar(1);

    // Schedule auto-hide (unless dragging)
    if (!this.isDraggingScrollbar) {
      this.scrollbarHideTimeout = window.setTimeout(() => {
        this.hideScrollbar();
      }, this.SCROLLBAR_HIDE_DELAY_MS);
    }
  }

  /**
   * Hide scrollbar with fade-out
   */
  private hideScrollbar(): void {
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }
    this.fadeScrollbar(0);
  }

  /**
   * Process any pending terminal responses and emit them via onData.
   *
   * This handles escape sequences that require the terminal to send a response
   * back to the PTY, such as:
   * - DSR 6 (cursor position): Shell sends \x1b[6n, terminal responds with \x1b[row;colR
   * - DSR 5 (operating status): Shell sends \x1b[5n, terminal responds with \x1b[0n
   *
   * Without this, shells like nushell that rely on cursor position queries
   * will hang waiting for a response that never comes.
   *
   * Note: We loop to read all pending responses, not just one. This is important
   * when multiple queries are processed in a single write() call (e.g., when
   * buffered data is written all at once during terminal initialization).
   */
  private processTerminalResponses(): void {
    if (!this.wasmTerm) return;

    // Read all pending responses from the WASM terminal
    // Multiple responses can be queued if a single write() contained multiple queries
    while (true) {
      const response = this.wasmTerm.readResponse();
      if (response === null) break;
      // Send response back to the PTY via onData
      // This is the same path as user keyboard input
      this.dataEmitter.fire(response);
    }
  }

  /**
   * Route what the running program asks of the terminal (bell, title,
   * clipboard, notifications, ...) from libghostty to this Terminal's events.
   */
  private connectEffects(wasmTerm: GhosttyTerminal): void {
    wasmTerm.setColors(this.themeColors());
    wasmTerm.setDefaultCursor(this.options.cursorStyle, this.options.cursorBlink);
    wasmTerm.setEffects({
      bell: () => this.bellEmitter.fire(),
      titleChanged: (title) => {
        if (title !== this.currentTitle) {
          this.currentTitle = title;
          this.titleChangeEmitter.fire(title);
        }
      },
      pwdChanged: (pwd) => this.workingDirectoryEmitter.fire(pwd),
      clipboardWrite: ({ location, contents }) => {
        const plain = contents.find((c) => c.mime.startsWith('text/plain')) ?? contents[0];
        const text = plain ? new TextDecoder().decode(plain.data) : '';
        this.clipboardWriteEmitter.fire({ text, location });
        if (this.options.allowClipboardWrite === false) return false;
        if (location === 'standard' && typeof navigator !== 'undefined' && navigator.clipboard) {
          // Browsers may refuse writes without a recent user gesture.
          navigator.clipboard.writeText(text).catch(() => {});
        }
        return true;
      },
      notification: (n) => this.notificationEmitter.fire(n),
      progress: (p) => this.progressEmitter.fire(p),
      programStatus: (st) => this.programStatusEmitter.fire(st),
      semanticPrompt: (e) => this.semanticPromptEmitter.fire(e),
      colorScheme: () => this.colorScheme(),
      cellSize: () => {
        const m = this.renderer?.getMetrics();
        return m ? { width: m.width, height: m.height } : null;
      },
    });
  }

  /**
   * Viewport row to absolute buffer row (0 = oldest scrollback line), using
   * the floored scroll offset the renderer draws with.
   */
  private viewportRowToBufferRow(viewportRow: number): number {
    const offset = Math.max(0, Math.floor(this.getViewportY()));
    return this.wasmTerm!.getScrollbackLength() - offset + viewportRow;
  }

  /** Absolute buffer row to viewport row (may be outside 0..rows-1). */
  private bufferRowToViewportRow(bufferRow: number): number {
    const offset = Math.max(0, Math.floor(this.getViewportY()));
    return bufferRow - this.wasmTerm!.getScrollbackLength() + offset;
  }

  /** The pointer over the text: the program's choice (OSC 22), else a text cursor. */
  private pointerShape(): string {
    return this.wasmTerm?.getMouseShape() ?? 'text';
  }

  /** Give libghostty the renderer's cell size in pixels. */
  private syncCellPixelSize(): void {
    const m = this.renderer?.getMetrics();
    if (m && this.wasmTerm) this.wasmTerm.setCellPixelSize(m.width, m.height);
  }

  /** Light or dark, from the default background's luminance (the one libghostty has). */
  private colorScheme(): 'light' | 'dark' {
    const bg = this.themeColors().background ?? 0;
    const [r, g, b] = [16, 8, 0].map((shift) => ((bg >> shift) & 0xff) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark';
  }

  // ============================================================================
  // Terminal Modes
  // ============================================================================

  /**
   * Query terminal mode state
   *
   * @param mode Mode number (e.g., 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   * @returns true if mode is enabled
   */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    this.assertOpen();
    return this.wasmTerm!.getMode(mode, isAnsi);
  }

  /**
   * Check if bracketed paste mode is enabled
   */
  public hasBracketedPaste(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasBracketedPaste();
  }

  /**
   * Check if focus event reporting is enabled
   */
  public hasFocusEvents(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasFocusEvents();
  }

  /**
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}
