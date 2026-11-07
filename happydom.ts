/**
 * Browser-like environment for tests and the benchmark, preloaded by Bun for tests (bunfig.toml).
 *
 * - Registers happy-dom's globals (window, document, HTMLElement, ...).
 * - Replaces the 2D canvas context, which happy-dom lacks, with one that records
 *   every drawing call; lib/test-helpers.ts reads the record (drawnText, paintedRects).
 *
 * The checks run after each test are in test-cleanup.ts, which only the test runner loads.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

/** One drawing call with the context state it was made in. */
export interface DrawCall {
  op: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  font: string;
  lineWidth: number;
  lineDash: number[];
}

/** Keeps the record bounded while a render loop runs during long async tests. */
const MAX_CALLS = 200_000;

/** The subset of CanvasRenderingContext2D the renderer uses, recording each call. */
export class RecordingContext {
  calls: DrawCall[] = [];
  fillStyle = '#000000';
  strokeStyle = '#000000';
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  lineWidth = 1;
  lineDashOffset = 0;
  private lineDash: number[] = [];
  private stack: Array<Record<string, unknown>> = [];

  /** The attributes passed to getContext() when the context was created. */
  attributes: Record<string, unknown> = {};

  constructor(readonly canvas: HTMLCanvasElement) {}

  private record(op: string, args: unknown[]): void {
    if (this.calls.length >= MAX_CALLS) this.calls.splice(0, MAX_CALLS / 2);
    this.calls.push({
      op,
      args,
      fillStyle: String(this.fillStyle),
      strokeStyle: String(this.strokeStyle),
      globalAlpha: this.globalAlpha,
      font: this.font,
      lineWidth: this.lineWidth,
      lineDash: [...this.lineDash],
    });
  }

  /** Width 8 px per UTF-16 unit; ascent and descent follow the font size. */
  measureText(text: string): TextMetrics {
    const size = Number.parseFloat(/(\d+(\.\d+)?)px/.exec(this.font)?.[1] ?? '10');
    return {
      width: text.length * 8,
      actualBoundingBoxAscent: size * 0.8,
      actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 8,
      fontBoundingBoxAscent: size * 0.8,
      fontBoundingBoxDescent: size * 0.2,
    } as TextMetrics;
  }

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      lineDashOffset: this.lineDashOffset,
      lineDash: this.lineDash,
    });
    this.record('save', []);
  }

  restore(): void {
    const state = this.stack.pop();
    if (state) Object.assign(this, state);
    this.record('restore', []);
  }

  setLineDash(segments: number[]): void {
    this.lineDash = [...segments];
    this.record('setLineDash', [segments]);
  }

  getLineDash(): number[] {
    return [...this.lineDash];
  }
}

for (const op of [
  'fillRect',
  'clearRect',
  'fillText',
  'beginPath',
  'moveTo',
  'lineTo',
  'quadraticCurveTo',
  'rect',
  'clip',
  'stroke',
  'setTransform',
]) {
  Object.defineProperty(RecordingContext.prototype, op, {
    writable: true,
    value(this: RecordingContext, ...args: unknown[]) {
      (this as unknown as { record(op: string, args: unknown[]): void }).record(op, args);
    },
  });
}

const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>();
const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  contextType: string,
  options?: unknown
) {
  if (contextType !== '2d') return originalGetContext.call(this, contextType, options);
  let ctx = contexts.get(this);
  if (!ctx) {
    ctx = new RecordingContext(this);
    ctx.attributes = { ...(options as Record<string, unknown> | undefined) };
    contexts.set(this, ctx);
  }
  return ctx as unknown as CanvasRenderingContext2D;
} as typeof HTMLCanvasElement.prototype.getContext;
