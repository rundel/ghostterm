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

import { FormatterExtras, type GhosttyTerminal } from '../ghostty';
import type { ITerminalAddon, ITerminalCore } from '../interfaces';

export interface ISerializeOptions {
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

/** What the addon uses from the Terminal. */
interface SerializableTerminal extends ITerminalCore {
  wasmTerm?: GhosttyTerminal;
}

/** Mode setter GhosttyTerminal keeps private; see withNormalScreen(). */
interface ModeSetter {
  setMode(mode: number, ansi: boolean, value: boolean): void;
}

/** Mode sets that switch to the alternate screen (47, 1047, 1049). */
const ALT_SCREEN_MODES = /\x1b\[\?(?:47|1047|1049)h/g;

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
    const fromRow = this.fromRow(wasmTerm, options.scrollback);
    if (!wasmTerm.isAlternateScreen()) {
      return wasmTerm.formatScreen({ format: 'vt', extras, fromRow });
    }

    // libghostty's formatter only reads the active screen, so look at the
    // normal screen by switching to it and back. Its modes are the terminal's,
    // which include the switch to the alternate screen; drop that here.
    const alt = wasmTerm.formatScreen({ format: 'vt', extras });
    const normal = withNormalScreen(wasmTerm, () =>
      wasmTerm.formatScreen({ format: 'vt', extras, fromRow })
    ).replace(ALT_SCREEN_MODES, '');
    if (options.excludeAltBuffer) return normal;
    // Without modes, the alternate screen part has no switch of its own.
    return normal + (options.excludeModes ? '\x1b[?1049h' : '') + alt;
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

/**
 * Run fn with the normal screen active while the alternate screen is.
 * Mode 47 switches screens without clearing or saving the cursor; afterwards
 * the mode 47 flag and the selection (cleared by a switch) are put back.
 */
function withNormalScreen<T>(wasmTerm: GhosttyTerminal, fn: () => T): T {
  const selection = wasmTerm.getSelectionRange();
  const mode47 = wasmTerm.getMode(47);
  wasmTerm.write('\x1b[?47l');
  try {
    return fn();
  } finally {
    wasmTerm.write('\x1b[?47h');
    if (!mode47) (wasmTerm as unknown as ModeSetter).setMode(47, false, false);
    if (selection) {
      const { startCol, startRow, endCol, endRow, rectangle } = selection;
      wasmTerm.setSelectionRange(startCol, startRow, endCol, endRow, rectangle);
    }
  }
}
