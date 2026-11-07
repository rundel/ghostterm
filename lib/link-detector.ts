/**
 * Link detection
 *
 * The LinkDetector asks its providers for the links on a row, in order, so
 * earlier providers (OSC 8) take precedence over later ones (regex URLs).
 * Rows are scanned on every lookup, so a link is never stale after the screen
 * changes; a link found again with the same range and text is returned as the
 * same object, so hover state survives repeated lookups.
 */

import type { IBufferRange, ILink, ILinkProvider } from './interfaces';

/** URI schemes a link may open: anything else (javascript:, file:, ...) is ignored. */
const OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'ftp:']);

/** Whether a URI uses a scheme that links are allowed to open. */
export function isOpenableUri(uri: string): boolean {
  try {
    return OPENABLE_SCHEMES.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

/**
 * Open a link's URI in a new tab, for a Ctrl+click (Cmd+click on macOS), if its
 * scheme is one links may open.
 */
export function openLink(uri: string, event: MouseEvent): void {
  if (!(event.ctrlKey || event.metaKey) || !isOpenableUri(uri)) return;
  window.open(uri, '_blank', 'noopener,noreferrer');
}

/** Whether a buffer cell (absolute row) lies in a range; ranges may span rows. */
export function rangeContains(range: IBufferRange, col: number, row: number): boolean {
  const { start, end } = range;
  if (row < start.y || row > end.y) return false;
  if (row === start.y && col < start.x) return false;
  if (row === end.y && col > end.x) return false;
  return true;
}

export class LinkDetector {
  private providers: ILinkProvider[] = [];

  /** Links returned so far, by range and text, to keep their identity stable. */
  private known = new Map<string, ILink>();

  constructor(private terminal: ITerminalForLinkDetector) {}

  /**
   * Register a link provider
   */
  registerProvider(provider: ILinkProvider): void {
    this.providers.push(provider);
    this.invalidateCache();
  }

  /**
   * Get link at the specified buffer position
   * @param col Column (0-based)
   * @param row Absolute row in buffer (0-based)
   * @returns Link at position, or undefined if none
   */
  async getLinkAt(col: number, row: number): Promise<ILink | undefined> {
    return this.findLinkAt(col, row);
  }

  /**
   * The link at a buffer position. Synchronous when every provider answers
   * synchronously (the built-in ones do), so a click can act on it while the
   * browser still treats it as a user gesture; a promise otherwise.
   */
  findLinkAt(col: number, row: number): ILink | undefined | Promise<ILink | undefined> {
    const line = this.terminal.buffer.active.getLine(row);
    if (!line || col < 0 || col >= line.length) return undefined;

    const results: Array<ILink[] | undefined> = new Array(this.providers.length);
    let pending = this.providers.length;
    let finish: (() => void) | undefined;
    this.providers.forEach((provider, i) => {
      let answered = false;
      provider.provideLinks(row, (links) => {
        if (answered) return;
        answered = true;
        results[i] = links;
        pending--;
        if (pending === 0) finish?.();
      });
    });

    const pick = (): ILink | undefined => {
      for (const links of results) {
        const link = links?.find((l) => rangeContains(l.range, col, row));
        if (link) return this.canonical(link);
      }
      return undefined;
    };
    if (pending === 0) return pick();
    return new Promise((resolve) => {
      finish = () => resolve(pick());
    });
  }

  /** The link object previously returned for the same range and text, if any. */
  private canonical(link: ILink): ILink {
    const { start, end } = link.range;
    const key = `${start.x},${start.y}-${end.x},${end.y}:${link.text}`;
    const known = this.known.get(key);
    if (known) return known;
    if (this.known.size > 256) this.known.clear();
    this.known.set(key, link);
    return link;
  }

  /**
   * Forget the links returned so far. Called when the terminal content
   * changes; lookups always rescan, so this only resets link identity.
   */
  invalidateCache(): void {
    this.known.clear();
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.known.clear();
    for (const provider of this.providers) {
      provider.dispose?.();
    }
    this.providers = [];
  }
}

/**
 * Minimal terminal interface required by LinkDetector
 */
export interface ITerminalForLinkDetector {
  buffer: {
    active: {
      getLine(y: number): { length: number } | undefined;
    };
  };
}
