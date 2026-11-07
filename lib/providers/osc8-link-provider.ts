/**
 * OSC 8 Hyperlink Provider
 *
 * Detects hyperlinks created with OSC 8 escape sequences
 * (\x1b]8;;URL\x07TEXT\x1b]8;;\x07). libghostty keeps the link on each cell;
 * every cell of one URI carries the same hyperlink ID, so a link is a run of
 * cells with one ID. A link that soft-wraps continues onto the next row, and
 * is reported as one range spanning those rows.
 */

import { openLink } from '../link-detector';
import type { ILink, ILinkProvider } from '../types';

export class OSC8LinkProvider implements ILinkProvider {
  constructor(private terminal: ITerminalForOSC8Provider) {}

  /**
   * Provide the OSC 8 links that touch the given row (absolute buffer row).
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const rows = new Map<number, OSC8Line | undefined>();
    const getLine = (row: number) => {
      if (!rows.has(row)) rows.set(row, this.terminal.buffer.active.getLine(row));
      return rows.get(row);
    };
    const buffer = { getLine };
    const line = getLine(y);
    const wasmTerm = this.terminal.wasmTerm;
    if (!line || !wasmTerm) {
      callback(undefined);
      return;
    }
    const idAt = (row: number, col: number) => getLine(row)?.getCell(col)?.getHyperlinkId() ?? 0;

    const links: ILink[] = [];
    let x = 0;
    while (x < line.length) {
      const id = line.getCell(x)?.getHyperlinkId() ?? 0;
      if (id === 0) {
        x++;
        continue;
      }
      let endX = x;
      while (endX + 1 < line.length && idAt(y, endX + 1) === id) endX++;

      // Follow the link back and forward across soft-wrapped rows.
      let start = { x, y };
      while (start.x === 0 && buffer.getLine(start.y)?.isWrapped) {
        const prev = buffer.getLine(start.y - 1);
        if (!prev || idAt(start.y - 1, prev.length - 1) !== id) break;
        let px = prev.length - 1;
        while (px > 0 && idAt(start.y - 1, px - 1) === id) px--;
        start = { x: px, y: start.y - 1 };
      }
      let end = { x: endX, y };
      while (end.x === line.length - 1) {
        const next = buffer.getLine(end.y + 1);
        if (!next?.isWrapped || idAt(end.y + 1, 0) !== id) break;
        let nx = 0;
        while (nx + 1 < next.length && idAt(end.y + 1, nx + 1) === id) nx++;
        end = { x: nx, y: end.y + 1 };
      }

      const uri = wasmTerm.getScreenHyperlinkUri(y, x);
      if (uri) {
        links.push({
          text: uri,
          range: { start, end },
          activate: (event) => openLink(uri, event),
        });
      }
      x = endX + 1;
    }

    callback(links.length > 0 ? links : undefined);
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by OSC8LinkProvider
 */
interface OSC8Line {
  length: number;
  isWrapped: boolean;
  getCell(x: number): { getHyperlinkId(): number } | undefined;
}

export interface ITerminalForOSC8Provider {
  buffer: {
    active: {
      getLine(y: number): OSC8Line | undefined;
    };
  };
  wasmTerm?: {
    /** Hyperlink URI at an absolute buffer row (scrollback first), or null. */
    getScreenHyperlinkUri(row: number, col: number): string | null;
  };
}
