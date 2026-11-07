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
  theme?: 'light' | 'transparent';
  allowTransparency?: boolean;
  /** Put the terminal in a CSS-sized flex layout with a FitAddon (window.fit). */
  fit?: boolean;
}

/** Open e2e/fixture.html and wait for its terminal. */
export async function openFixture(page: Page, options: FixtureOptions = {}): Promise<void> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== false) query.set(key, value === true ? '' : String(value));
  }
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

/** Wait for `count` animation frames. */
export async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  }, count);
}

/** Write to the terminal and wait for the frame that draws it. */
export async function write(page: Page, data: string): Promise<void> {
  await page.evaluate((d) => new Promise<void>((r) => window.term.write(d, r)), data);
  await nextFrame(page);
}

/** The text of an absolute buffer row (0 = oldest scrollback row), trailing spaces trimmed. */
export async function lineText(page: Page, row: number): Promise<string> {
  return page.evaluate(
    (y) => window.term.buffer.active.getLine(y)?.translateToString(true) ?? '',
    row
  );
}

/** The text of every viewport row as displayed, trailing spaces trimmed. */
export async function viewportText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const buffer = window.term.buffer.active;
    return Array.from(
      { length: window.term.rows },
      (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? ''
    );
  });
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

/** Device pixels as RGBA bytes, rows of `width` pixels. */
export interface CellPixels {
  width: number;
  height: number;
  data: number[];
}

/**
 * The device pixels of a rectangle of the canvas given in CSS px (it may include the scrollbar
 * gutter), with the edges rounded the way the backing store is.
 */
export async function canvasPixels(
  page: Page,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<CellPixels> {
  return page.evaluate(
    ([x, y, width, height]) => {
      const canvas = window.term['canvas']!;
      const scale = canvas.width / Number.parseFloat(canvas.style.width);
      const x0 = Math.round(x * scale);
      const y0 = Math.round(y * scale);
      const x1 = Math.round((x + width) * scale);
      const y1 = Math.round((y + height) * scale);
      const image = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0);
      return { width: image.width, height: image.height, data: Array.from(image.data) };
    },
    [x, y, width, height]
  );
}

/** The device pixels of a block of viewport cells (one by default). */
export async function cellPixels(
  page: Page,
  col: number,
  row: number,
  cols = 1,
  rows = 1
): Promise<CellPixels> {
  const g = await geometry(page);
  return canvasPixels(
    page,
    col * g.cellWidth,
    row * g.cellHeight,
    cols * g.cellWidth,
    rows * g.cellHeight
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

/** How many pixels are fully transparent. */
export function countTransparent(px: CellPixels): number {
  let n = 0;
  for (let i = 3; i < px.data.length; i += 4) if (px.data[i] === 0) n++;
  return n;
}

/** The distinct colors in the pixels, as #rrggbb, most frequent first. */
export function colorsOf(px: CellPixels): string[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < px.data.length; i += 4) {
    const hex = `#${[px.data[i], px.data[i + 1], px.data[i + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
}

/**
 * Read the clipboard by pasting it into the page's #before input with the platform shortcut, then
 * give focus back to the terminal. Works in every browser, unlike navigator.clipboard.readText()
 * (WebKit refuses it without a user gesture).
 */
export async function readClipboard(page: Page): Promise<string> {
  const input = page.locator('#before');
  await input.fill('');
  await input.focus();
  await page.keyboard.press('ControlOrMeta+v');
  const text = await input.inputValue();
  await page.evaluate(() => window.term.textarea!.focus());
  return text;
}

/** Put text on the clipboard by copying it from the #before input; focus goes back to the terminal. */
export async function writeClipboard(page: Page, text: string): Promise<void> {
  const input = page.locator('#before');
  await input.fill(text);
  await input.selectText();
  await page.keyboard.press('ControlOrMeta+c');
  await input.fill('');
  await page.evaluate(() => window.term.textarea!.focus());
}
