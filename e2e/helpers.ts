// Helpers for the Playwright specs: opening the fixture page, cell geometry, pixel reads and
// pointer positions in cells.

import type { Page } from '@playwright/test';

export interface FixtureOptions {
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  smoothScrollDuration?: number;
}

/** Open e2e/fixture.html and wait for its terminal. */
export async function openFixture(page: Page, options: FixtureOptions = {}): Promise<void> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) query.set(key, String(value));
  await page.goto(`/e2e/fixture.html?${query}`);
  await page.evaluate(() => window.ready);
  // open() focuses the textarea again from a zero timeout; let that run before the spec starts.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
}

/** Let the render loop draw at least one frame after everything done so far. */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
}

/** Write to the terminal and wait for the frame that draws it. */
export async function write(page: Page, data: string): Promise<void> {
  await page.evaluate((d) => new Promise<void>((r) => window.term.write(d, r)), data);
  await nextFrame(page);
}

/** Everything the terminal has sent, joined. */
export async function sent(page: Page): Promise<string> {
  return page.evaluate(() => window.sent.join(''));
}

export async function clearSent(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.sent.length = 0;
  });
}

export interface Geometry {
  /** Canvas position in the page (CSS px). */
  left: number;
  top: number;
  /** Cell size in CSS px. */
  cellWidth: number;
  cellHeight: number;
  /** Device pixels per CSS px in the canvas backing store. */
  scale: number;
  cols: number;
  rows: number;
}

export async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const term = window.term;
    const canvas = term['canvas']!;
    const rect = canvas.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      cellWidth: term['renderer']!.charWidth,
      cellHeight: term['renderer']!.charHeight,
      scale: canvas.width / Number.parseFloat(canvas.style.width),
      cols: term.cols,
      rows: term.rows,
    };
  });
}

/** Page coordinates (CSS px) of a point in a cell, by default its center. */
export function cellPoint(g: Geometry, col: number, row: number, fx = 0.5, fy = 0.5) {
  return { x: g.left + (col + fx) * g.cellWidth, y: g.top + (row + fy) * g.cellHeight };
}

/** Move the mouse to the center of a viewport cell. */
export async function mouseToCell(page: Page, col: number, row: number): Promise<void> {
  const p = cellPoint(await geometry(page), col, row);
  await page.mouse.move(p.x, p.y);
}

/** The device pixels of a block of viewport cells (one by default) as RGBA bytes, rows of `width` pixels. */
export interface CellPixels {
  width: number;
  height: number;
  data: number[];
}

export async function cellPixels(
  page: Page,
  col: number,
  row: number,
  cols = 1,
  rows = 1
): Promise<CellPixels> {
  return page.evaluate(
    ([col, row, cols, rows]) => {
      const term = window.term;
      const canvas = term['canvas']!;
      const scale = canvas.width / Number.parseFloat(canvas.style.width);
      const { charWidth, charHeight } = term['renderer']!;
      const x0 = Math.round(col * charWidth * scale);
      const y0 = Math.round(row * charHeight * scale);
      const x1 = Math.round((col + cols) * charWidth * scale);
      const y1 = Math.round((row + rows) * charHeight * scale);
      const image = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0);
      return { width: image.width, height: image.height, data: Array.from(image.data) };
    },
    [col, row, cols, rows]
  );
}

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Whether a pixel matches a color within a per-channel tolerance. */
function matches(px: CellPixels, i: number, rgb: [number, number, number], tolerance: number) {
  const d = px.data;
  return (
    Math.abs(d[i] - rgb[0]) <= tolerance &&
    Math.abs(d[i + 1] - rgb[1]) <= tolerance &&
    Math.abs(d[i + 2] - rgb[2]) <= tolerance
  );
}

/** How many pixels of the cell have the color. */
export function countColor(px: CellPixels, hex: string, tolerance = 8): number {
  const rgb = parseHex(hex);
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4) if (matches(px, i, rgb, tolerance)) n++;
  return n;
}

/**
 * How many pixels of the cell show the color drawn over a black background at any coverage of at
 * least `minAlpha`, as antialiased lines are: each pixel is the color scaled by one factor.
 */
export function countTinted(px: CellPixels, hex: string, minAlpha = 0.3, tolerance = 12): number {
  const rgb = parseHex(hex);
  const max = Math.max(...rgb);
  const strongest = rgb.indexOf(max);
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    const alpha = px.data[i + strongest] / max;
    if (alpha < minAlpha) continue;
    const scaled: [number, number, number] = [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha];
    if (matches(px, i, scaled, tolerance)) n++;
  }
  return n;
}

/** Which pixel columns (0 = left edge of the cell) contain the color. */
export function columnsWithColor(px: CellPixels, hex: string, tolerance = 8): number[] {
  const rgb = parseHex(hex);
  const cols: number[] = [];
  for (let x = 0; x < px.width; x++) {
    for (let y = 0; y < px.height; y++) {
      if (matches(px, (y * px.width + x) * 4, rgb, tolerance)) {
        cols.push(x);
        break;
      }
    }
  }
  return cols;
}

/** Which pixel rows (0 = top of the cell) contain the color. */
export function rowsWithColor(px: CellPixels, hex: string, tolerance = 8): number[] {
  const rgb = parseHex(hex);
  const rows: number[] = [];
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (matches(px, (y * px.width + x) * 4, rgb, tolerance)) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}
