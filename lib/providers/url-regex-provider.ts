/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs (http, https, ftp and mailto, the schemes a link may
 * open) by regex. Soft-wrapped rows are joined first, so a URL that wraps is
 * one link spanning those rows. Ranges are in cells: wide characters and
 * characters outside the BMP map to the cells they occupy.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { IBufferCellPosition, ILink, ILinkProvider } from '../interfaces';
import { openLink } from '../link-detector';

export class UrlRegexProvider implements ILinkProvider {
  /** A scheme followed by characters that may appear in a URL. */
  private static readonly URL_REGEX =
    /(?:https?:\/\/|ftp:\/\/|mailto:)[\w\-.~:/?#@!$&*+,;=%()'[\]]+/gi;

  /** Punctuation that ends a sentence rather than the URL. */
  private static readonly TRAILING = /[.,;:!?'\]]$/;

  /** Longest run of wrapped rows joined into one line, in each direction. */
  private static readonly MAX_WRAPPED_ROWS = 32;

  constructor(private terminal: ITerminalForUrlProvider) {}

  /**
   * Provide the URLs that touch the given row (absolute buffer row).
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buffer = this.terminal.buffer.active;
    const first = buffer.getLine(y);
    if (!first) {
      callback(undefined);
      return;
    }

    // The logical line: rows joined across soft wraps.
    const rows: Array<{ y: number; line: IBufferLineForUrlProvider }> = [{ y, line: first }];
    let top = first;
    for (let i = 0; i < UrlRegexProvider.MAX_WRAPPED_ROWS && top.isWrapped; i++) {
      const prev = buffer.getLine(rows[0].y - 1);
      if (!prev) break;
      rows.unshift({ y: rows[0].y - 1, line: prev });
      top = prev;
    }
    for (let i = 0; i < UrlRegexProvider.MAX_WRAPPED_ROWS; i++) {
      const next = buffer.getLine(rows[rows.length - 1].y + 1);
      if (!next?.isWrapped) break;
      rows.push({ y: rows[rows.length - 1].y + 1, line: next });
    }

    // The text, and for each UTF-16 unit the first and last cell it covers.
    let text = '';
    const startCell: IBufferCellPosition[] = [];
    const endCell: IBufferCellPosition[] = [];
    for (const { y: row, line } of rows) {
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        // The second half of a wide character has no text of its own.
        if (cell && cell.getWidth() === 0) continue;
        const chars = cell?.getChars() || ' ';
        const width = Math.max(1, cell?.getWidth() ?? 1);
        for (let i = 0; i < chars.length; i++) {
          startCell.push({ x, y: row });
          endCell.push({ x: Math.min(x + width - 1, line.length - 1), y: row });
        }
        text += chars;
      }
    }

    const links: ILink[] = [];
    const regex = new RegExp(UrlRegexProvider.URL_REGEX);
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      const url = UrlRegexProvider.trim(match[0]);
      // Skip a bare scheme (e.g. just "http://").
      if (!/^[a-z]+:(\/\/)?[^/]/i.test(url)) continue;
      const start = startCell[match.index];
      const end = endCell[match.index + url.length - 1];
      if (end.y < y || start.y > y) continue;
      links.push({
        text: url,
        range: { start, end },
        activate: (event) => openLink(url, event),
      });
    }

    callback(links.length > 0 ? links : undefined);
  }

  /**
   * Drop trailing punctuation that belongs to the surrounding text: sentence
   * punctuation, and closing parentheses that open nowhere in the URL (so
   * "(see https://x.org/a)" loses its ")" but ".../Foo_(bar)" keeps it).
   */
  private static trim(url: string): string {
    for (;;) {
      if (UrlRegexProvider.TRAILING.test(url)) {
        url = url.slice(0, -1);
      } else if (url.endsWith(')')) {
        const open = url.split('(').length - 1;
        const close = url.split(')').length - 1;
        if (close <= open) return url;
        url = url.slice(0, -1);
      } else {
        return url;
      }
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export interface ITerminalForUrlProvider {
  buffer: {
    active: {
      getLine(y: number): IBufferLineForUrlProvider | undefined;
    };
  };
}

/**
 * Minimal buffer line interface for URL detection
 */
interface IBufferLineForUrlProvider {
  length: number;
  isWrapped: boolean;
  getCell(x: number):
    | {
        getChars(): string;
        getWidth(): number;
      }
    | undefined;
}
