/**
 * Test fixtures and drawing helpers.
 *
 * `terminalFixture()` loads the module once per file and cleans up after every
 * test; `render()`, `drawnText()`, `paintedRects()` and `strokes()` read what
 * the recording canvas in happydom.ts saw.
 */

import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { DrawCall, RecordingContext } from '../happydom';
import { Ghostty, type GhosttyTerminal, type GhosttyTerminalConfig } from './ghostty';
import type { InputHandler } from './input-handler';
import type { ITerminalOptions } from './interfaces';
import type { CanvasRenderer } from './renderer';
import type { SelectionManager } from './selection-manager';
import { Terminal } from './terminal';

export type { DrawCall } from '../happydom';

/** An opened terminal, its container and the bytes it sent to the program. */
export interface OpenedTerminal {
  term: Terminal;
  container: HTMLElement;
  /** Every onData payload, in order. */
  sent: string[];
}

export interface TerminalFixture {
  /** The module loaded for this file. */
  readonly ghostty: Ghostty;
  /** A terminal that is not opened, disposed after the test. */
  create(options?: Omit<ITerminalOptions, 'ghostty'>): Terminal;
  /** A terminal opened in a container attached to the document, with onData collected. */
  open(options?: Omit<ITerminalOptions, 'ghostty'>): OpenedTerminal;
  /** A bridge-level terminal, freed after the test. */
  wasm(cols?: number, rows?: number, config?: GhosttyTerminalConfig): GhosttyTerminal;
  /** Register cleanup to run after the test (before terminals are disposed). */
  defer(cleanup: () => void): void;
}

/**
 * Load the module once for the enclosing describe (or file) and dispose
 * everything created through the fixture after each test. Fails a test that
 * leaves a bridge terminal of this module unfreed.
 */
export function terminalFixture(): TerminalFixture {
  let ghostty: Ghostty | undefined;
  const terminals: Terminal[] = [];
  const containers: HTMLElement[] = [];
  const wasmTerms: GhosttyTerminal[] = [];
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    ghostty = await Ghostty.load();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    for (const term of terminals.splice(0)) term.dispose();
    for (const container of containers.splice(0)) container.remove();
    for (const wasm of wasmTerms.splice(0)) wasm.free();
    const live = ghostty ? liveTerminals(ghostty) : 0;
    if (live > 0) throw new Error(`${live} GhosttyTerminal(s) left unfreed`);
  });

  afterAll(() => {
    ghostty = undefined;
  });

  const loaded = (): Ghostty => {
    if (!ghostty) throw new Error('terminalFixture() used outside a test');
    return ghostty;
  };

  return {
    get ghostty() {
      return loaded();
    },
    create(options = {}) {
      const term = new Terminal({ ...options, ghostty: loaded() });
      terminals.push(term);
      return term;
    },
    open(options = {}) {
      const term = this.create(options);
      const container = document.createElement('div');
      document.body.appendChild(container);
      containers.push(container);
      const sent: string[] = [];
      term.onData((data) => sent.push(data));
      term.open(container);
      return { term, container, sent };
    },
    wasm(cols, rows, config) {
      const term = loaded().createTerminal(cols, rows, config);
      wasmTerms.push(term);
      return term;
    },
    defer(cleanup) {
      cleanups.push(cleanup);
    },
  };
}

function liveTerminals(ghostty: Ghostty): number {
  return ghostty['terminals'].size;
}

/** The components of an opened terminal, for tests that drive them directly. */
export interface TerminalInternals {
  renderer: CanvasRenderer;
  inputHandler: InputHandler;
  selectionManager: SelectionManager;
  wasmTerm: GhosttyTerminal;
  canvas: HTMLCanvasElement;
  textarea: HTMLTextAreaElement;
  ctx: RecordingContext;
}

export function internals(term: Terminal): TerminalInternals {
  const { renderer, wasmTerm, textarea } = term;
  const inputHandler = term['inputHandler'];
  const selectionManager = term['selectionManager'];
  const canvas = term['canvas'];
  if (!renderer || !wasmTerm || !textarea || !inputHandler || !selectionManager || !canvas) {
    throw new Error('internals() needs an opened terminal');
  }
  const ctx = renderer['ctx'] as unknown as RecordingContext;
  return { renderer, inputHandler, selectionManager, wasmTerm, canvas, textarea, ctx };
}

/**
 * Draw one frame now (every row with `force`, else only what changed) and
 * return the drawing calls it made.
 */
export function render(term: Terminal, force = true): DrawCall[] {
  const { ctx } = internals(term);
  ctx.calls = [];
  term['renderFrame'](force);
  const calls = ctx.calls;
  ctx.calls = [];
  return calls;
}

export interface DrawnText {
  text: string;
  /** Cell the text was drawn in. */
  col: number;
  row: number;
  fillStyle: string;
  globalAlpha: number;
  font: string;
}

/** Text drawn by a full frame (or in `calls` recorded by render()), skipping blank cells. */
export function drawnText(term: Terminal, calls: DrawCall[] = render(term)): DrawnText[] {
  const { charWidth: w, charHeight: h } = internals(term).renderer;
  return calls
    .filter((c) => c.op === 'fillText' && String(c.args[0]).trim() !== '')
    .map((c) => ({
      text: String(c.args[0]),
      col: Math.round(Number(c.args[1]) / w),
      row: Math.floor(Number(c.args[2]) / h),
      fillStyle: c.fillStyle,
      globalAlpha: c.globalAlpha,
      font: c.font,
    }));
}

export interface PaintedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fillStyle: string;
}

/** Rectangles filled by a full frame (or in recorded calls), optionally of one color. */
export function paintedRects(source: Terminal | DrawCall[], color?: string): PaintedRect[] {
  const calls = Array.isArray(source) ? source : render(source);
  return calls
    .filter((c) => c.op === 'fillRect' && (color === undefined || c.fillStyle === color))
    .map((c) => {
      const [x, y, w, h] = c.args as number[];
      return { x, y, w, h, fillStyle: c.fillStyle };
    });
}

export interface StrokedPath {
  strokeStyle: string;
  lineDash: number[];
  /** Path operations since beginPath, e.g. ['moveTo', 0, 10]. */
  path: Array<[string, ...number[]]>;
}

/** Paths stroked by a full frame (or in recorded calls): underlines, strikethrough, overline. */
export function strokes(source: Terminal | DrawCall[]): StrokedPath[] {
  const calls = Array.isArray(source) ? source : render(source);
  const result: StrokedPath[] = [];
  let path: Array<[string, ...number[]]> = [];
  for (const c of calls) {
    if (c.op === 'beginPath') path = [];
    else if (c.op === 'moveTo' || c.op === 'lineTo' || c.op === 'quadraticCurveTo') {
      path.push([c.op, ...(c.args as number[])]);
    } else if (c.op === 'stroke') {
      result.push({ strokeStyle: c.strokeStyle, lineDash: c.lineDash, path });
    }
  }
  return result;
}

/** Text of active row `y` (trailing blanks trimmed). */
export function lineText(term: Terminal, y: number): string {
  return term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '';
}

/** Dispatch a keydown on `target` and return it (check defaultPrevented). */
export function keyDown(
  target: EventTarget,
  code: string,
  key: string,
  init: KeyboardEventInit = {}
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    code,
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** Mouse event at canvas offset (x, y) px; happy-dom needs offsetX/Y set by hand. */
export function mouseEvent(
  type: string,
  x: number,
  y: number,
  init: MouseEventInit = {}
): MouseEvent {
  const event = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'offsetX', { value: x });
  Object.defineProperty(event, 'offsetY', { value: y });
  return event;
}

/** Wheel event (happy-dom ignores clientX/Y on WheelEvent, so they are set by hand). */
export function wheelEvent(deltaY: number, init: WheelEventInit = {}, x = 0, y = 0): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
  for (const [k, v] of Object.entries({ clientX: x, clientY: y, offsetX: x, offsetY: y })) {
    Object.defineProperty(event, k, { value: v });
  }
  return event;
}

/**
 * Replace `obj[key]` for the rest of the test; restored by the returned
 * function, which `fixture.defer()` can run.
 */
export function stub<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): () => void {
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  const original = obj[key];
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  return () => {
    if (had)
      Object.defineProperty(obj, key, { value: original, configurable: true, writable: true });
    else Reflect.deleteProperty(obj, key);
  };
}

/** A terminal with its own module instance (prefer terminalFixture()). Not opened; dispose it. */
export async function createIsolatedTerminal(
  options: Omit<ITerminalOptions, 'ghostty'> = {}
): Promise<Terminal> {
  return new Terminal({ ...options, ghostty: await Ghostty.load() });
}
