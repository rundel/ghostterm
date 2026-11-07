/**
 * SerializeAddon - save the terminal as text that recreates it, or as HTML
 *
 * Follows the API of @xterm/addon-serialize, on top of libghostty's formatter.
 * serialize() returns VT sequences: write them to a fresh terminal (of the
 * same size) to get the same screen back, scrollback, styles, hyperlinks,
 * cursor and modes included. That makes it suitable for restoring a session
 * after a page reload or reconnect. With the alternate screen active, the
 * normal screen and its scrollback come first, then the switch to the
 * alternate screen and its content, so leaving it later shows the normal
 * screen again.
 *
 * @example
 * ```typescript
 * const serializer = new SerializeAddon();
 * term.loadAddon(serializer);
 * const saved = serializer.serialize();
 * // later, in a new terminal of the same size:
 * newTerm.write(saved);
 * ```
 */

import { FormatterExtras } from '../ghostty';
import type { IAddonTerminal, IMarker, ITerminalAddon, ITerminalCore } from '../interfaces';

/**
 * Lines to serialize, both included: absolute buffer lines (0 = oldest
 * scrollback line) or markers on them (term.registerMarker()), as in
 * xterm.js. A range with a disposed marker serializes nothing.
 */
export interface ISerializeRange {
  start: IMarker | number;
  end: IMarker | number;
}

export interface ISerializeOptions {
  /** Only these lines of the normal screen; takes precedence over scrollback. */
  range?: ISerializeRange;
  /** Keep at most this many lines of scrollback (default: all). */
  scrollback?: number;
  /** Leave out terminal modes (cursor keys, bracketed paste, keyboard protocols, ...). */
  excludeModes?: boolean;
  /** Leave out the alternate screen when it is active, keeping only the normal screen. */
  excludeAltBuffer?: boolean;
  /**
   * Also restore the 256-color palette. Off by default, so the receiving
   * terminal keeps its own theme; on reproduces colors a program set with OSC 4.
   */
  includePalette?: boolean;
}

export interface IHTMLSerializeOptions {
  /** Keep at most this many lines of scrollback (default: all). */
  scrollback?: number;
  /** Only the selected text. */
  onlySelection?: boolean;
  /** Wrap the output in an element with the terminal's background color. */
  includeGlobalBackground?: boolean;
}

/** Mode sets that switch to the alternate screen (47, 1047, 1049). */
const ALT_SCREEN_MODES = /\x1b\[\?(?:47|1047|1049)h/g;

/** Everything the VT formatter can restore except the palette. */
const DEFAULT_EXTRAS = FormatterExtras.ALL & ~FormatterExtras.PALETTE;
const MODE_EXTRAS =
  FormatterExtras.MODES | FormatterExtras.KEYBOARD | FormatterExtras.KITTY_KEYBOARD;

export class SerializeAddon implements ITerminalAddon {
  private terminal?: IAddonTerminal;

  /** Called by Terminal.loadAddon; needs a ghostterm Terminal (it uses internal methods). */
  activate(terminal: ITerminalCore): void {
    this.terminal = terminal as IAddonTerminal;
  }

  dispose(): void {
    this.terminal = undefined;
  }

  /** VT sequences that recreate the terminal when written to a fresh one. */
  serialize(options: ISerializeOptions = {}): string {
    const wasmTerm = this.terminal?.wasmTerm;
    if (!wasmTerm) return '';
    let extras = DEFAULT_EXTRAS;
    if (options.excludeModes) extras &= ~MODE_EXTRAS;
    if (options.includePalette) extras |= FormatterExtras.PALETTE;
    const lineOf = (end: IMarker | number | undefined) =>
      typeof end === 'object' ? (end.isDisposed ? -1 : end.line) : end;
    const fromRow = lineOf(options.range?.start);
    const toRow = lineOf(options.range?.end);
    if (fromRow === -1 || toRow === -1) return '';
    const normal = wasmTerm.formatScreen({
      format: 'vt',
      screen: 'primary',
      extras,
      scrollback: options.scrollback,
      fromRow,
      toRow,
    });
    if (!wasmTerm.isAlternateScreen()) return normal;

    // The normal screen's modes are the terminal's, which include the switch
    // to the alternate screen; drop that here.
    const primary = normal.replace(ALT_SCREEN_MODES, '');
    if (options.excludeAltBuffer) return primary;
    const alt = wasmTerm.formatScreen({ format: 'vt', extras });
    // Without modes, the alternate screen part has no switch of its own.
    return primary + (options.excludeModes ? '\x1b[?1049h' : '') + alt;
  }

  /** The terminal (or its selection) as HTML with inline styles. */
  serializeAsHTML(options: IHTMLSerializeOptions = {}): string {
    const wasmTerm = this.terminal?.wasmTerm;
    if (!wasmTerm) return '';
    const html = wasmTerm.formatScreen({
      format: 'html',
      onlySelection: options.onlySelection,
      scrollback: options.scrollback,
    });
    if (!options.includeGlobalBackground) return html;
    const { r, g, b } = wasmTerm.getColors().background;
    return `<div style="background-color: rgb(${r}, ${g}, ${b})">${html}</div>`;
  }
}
