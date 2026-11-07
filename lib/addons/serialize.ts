/**
 * SerializeAddon - save the terminal as text that recreates it, or as HTML
 *
 * Follows the API of @xterm/addon-serialize, on top of libghostty's formatter.
 * serialize() returns VT sequences: write them to a fresh terminal (of the
 * same size) to get the same screen back, scrollback, styles, hyperlinks,
 * cursor and modes included. That makes it suitable for restoring a session
 * after a page reload or reconnect.
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

import { FormatterExtras, type GhosttyTerminal } from '../ghostty';
import type { ITerminalAddon, ITerminalCore } from '../interfaces';

export interface ISerializeOptions {
  /** Keep at most this many lines of scrollback (default: all). */
  scrollback?: number;
  /** Leave out terminal modes (cursor keys, bracketed paste, keyboard protocols, ...). */
  excludeModes?: boolean;
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

/** What the addon uses from the Terminal. */
interface SerializableTerminal extends ITerminalCore {
  wasmTerm?: GhosttyTerminal;
  options?: { theme?: { background?: string } };
}

/** Everything the VT formatter can restore except the palette. */
const DEFAULT_EXTRAS = FormatterExtras.ALL & ~FormatterExtras.PALETTE;
const MODE_EXTRAS =
  FormatterExtras.MODES | FormatterExtras.KEYBOARD | FormatterExtras.KITTY_KEYBOARD;

export class SerializeAddon implements ITerminalAddon {
  private terminal?: SerializableTerminal;

  activate(terminal: ITerminalCore): void {
    this.terminal = terminal as SerializableTerminal;
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
    return wasmTerm.formatScreen({
      format: 'vt',
      extras,
      fromRow: this.fromRow(wasmTerm, options.scrollback),
    });
  }

  /** The terminal (or its selection) as HTML with inline styles. */
  serializeAsHTML(options: IHTMLSerializeOptions = {}): string {
    const wasmTerm = this.terminal?.wasmTerm;
    if (!wasmTerm) return '';
    const html = wasmTerm.formatScreen({
      format: 'html',
      onlySelection: options.onlySelection,
      fromRow: options.onlySelection ? undefined : this.fromRow(wasmTerm, options.scrollback),
    });
    if (!options.includeGlobalBackground) return html;
    const { r, g, b } = wasmTerm.getColors().background;
    return `<div style="background-color: rgb(${r}, ${g}, ${b})">${html}</div>`;
  }

  /** First absolute row to include for a scrollback limit. */
  private fromRow(wasmTerm: GhosttyTerminal, scrollback?: number): number | undefined {
    if (scrollback === undefined) return undefined;
    const history = wasmTerm.getScrollbackLength();
    return Math.max(0, history - Math.max(0, scrollback));
  }
}
