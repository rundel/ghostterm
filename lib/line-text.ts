/**
 * The text of buffer rows with, for each UTF-16 unit, the cells it covers, so
 * a match found in the text maps back to cells: wide characters cover two
 * cells, and characters outside the BMP (two units) and grapheme clusters
 * (several) map every unit to their cell. Used by the URL link provider and
 * the SearchAddon's text search.
 */

import type { IBufferCellPosition } from './interfaces';

/** What line-text reads from a buffer line (IBufferLine has it). */
export interface ITextLine {
  length: number;
  isWrapped: boolean;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

export interface LineText {
  text: string;
  /** For each UTF-16 unit of text, the first cell of its character. */
  startCell: IBufferCellPosition[];
  /** For each UTF-16 unit of text, the last cell of its character. */
  endCell: IBufferCellPosition[];
}

/**
 * Join rows (consecutive absolute rows of one logical line) into text. Empty
 * cells are spaces; `trimRight` drops trailing ones of the last row.
 */
export function lineText(
  rows: ReadonlyArray<{ y: number; line: ITextLine }>,
  trimRight = false
): LineText {
  let text = '';
  const startCell: IBufferCellPosition[] = [];
  const endCell: IBufferCellPosition[] = [];
  for (const { y, line } of rows) {
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      // The second half of a wide character has no text of its own.
      if (cell && cell.getWidth() === 0) continue;
      const chars = cell?.getChars() || ' ';
      const width = Math.max(1, cell?.getWidth() ?? 1);
      for (let i = 0; i < chars.length; i++) {
        startCell.push({ x, y });
        endCell.push({ x: Math.min(x + width - 1, line.length - 1), y });
      }
      text += chars;
    }
  }
  if (trimRight) {
    const trimmed = text.trimEnd();
    startCell.length = trimmed.length;
    endCell.length = trimmed.length;
    text = trimmed;
  }
  return { text, startCell, endCell };
}
