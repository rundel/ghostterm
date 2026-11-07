/**
 * C ABI constants of libghostty-vt (enum values are part of its ABI promise) and the payload types
 * of the effects a terminal reports.
 */

import type { GhosttyCell, RGB } from '../types';

// Every table below is checked against the loaded module's manifest by
// lib/abi-enums.test.ts; they are exported for it (not from lib/index.ts).

/** @internal GhosttyResult. */
export const Result = { SUCCESS: 0, OUT_OF_SPACE: -3 } as const;
export const GHOSTTY_SUCCESS = Result.SUCCESS;
export const GHOSTTY_OUT_OF_SPACE = Result.OUT_OF_SPACE;

/** @internal GhosttyTerminalOption. */
export const TerminalOpt = {
  WRITE_PTY: 2,
  COLOR_FOREGROUND: 12,
  COLOR_BACKGROUND: 13,
  COLOR_CURSOR: 14,
  COLOR_PALETTE: 15,
  SELECTION: 22,
  DEFAULT_CURSOR_STYLE: 23,
  DEFAULT_CURSOR_BLINK: 24,
  SCROLLBACK_MAX_BYTES: 28,
  SCROLLBACK_MAX_LINES: 29,
  MODE_DEFAULT: 34,
  MODE: 35,
  TERMINFO_NAME: 38,
} as const;

/** @internal GhosttyTerminalData. */
export const TerminalData = {
  CURSOR_X: 3,
  CURSOR_Y: 4,
  ACTIVE_SCREEN: 6,
  SCROLLBAR: 9,
  MOUSE_TRACKING: 11,
  TITLE: 12,
  PWD: 13,
  SCROLLBACK_ROWS: 15,
  COLOR_PALETTE_DEFAULT: 25,
  SELECTION: 31,
  MODE: 37,
  MOUSE_SHAPE: 41,
} as const;

/** @internal GhosttyTerminalScreen. */
export const TerminalScreen = { PRIMARY: 0, ALTERNATE: 1 } as const;

/** @internal GhosttyRenderStateData. */
export const RenderData = {
  DIRTY: 3,
  ROW_ITERATOR: 4,
  CURSOR: 18,
  COLORS: 19,
} as const;

/** @internal GhosttyRenderStateRowData. */
export const RowData = {
  DIRTY: 1,
  CELLS: 3,
  SELECTION: 4,
  CELLS_RAW: 5,
} as const;

/** @internal GhosttyRenderStateRowCellsData. */
export const RowCellsData = {
  STYLE: 2,
  GRAPHEMES_LEN: 3,
  GRAPHEMES_BUF: 4,
} as const;

/** @internal GhosttyRowData (ghostty_row_get). */
export const GridRowData = { WRAP_CONTINUATION: 2 } as const;

/** @internal GhosttyPointTag. */
export const PointTag = {
  ACTIVE: 0,
  VIEWPORT: 1,
  SCREEN: 2,
  HISTORY: 3,
} as const;

/** @internal GhosttySelectionOrder. */
export const SelectionOrder = { FORWARD: 0 } as const;

/** @internal GhosttyMouseShape, in order; Ghostty uses the CSS cursor names. */
export const MOUSE_SHAPES = [
  'default',
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'zoom-in',
  'zoom-out',
] as const;

/** @internal GhosttyFormatterOption. */
export const FormatterOpt = {
  EMIT: 1,
  UNWRAP: 2,
  TRIM: 3,
  SELECTION: 4,
  EXTRAS: 5,
} as const;

/** @internal GhosttyFormatterFormat. */
export const FormatterFormat = {
  PLAIN: 0,
  VT: 1,
  HTML: 2,
} as const;

/** Terminal state the VT formatter can restore (GHOSTTY_FORMATTER_EXTRA_*). */
export enum FormatterExtras {
  NONE = 0,
  PALETTE = 1 << 0,
  MODES = 1 << 1,
  SCROLLING_REGION = 1 << 2,
  TABSTOPS = 1 << 3,
  PWD = 1 << 4,
  KEYBOARD = 1 << 5,
  CURSOR = 1 << 6,
  STYLE = 1 << 7,
  HYPERLINK = 1 << 8,
  PROTECTION = 1 << 9,
  KITTY_KEYBOARD = 1 << 10,
  CHARSETS = 1 << 11,
  ALL = (1 << 12) - 1,
}

/** @internal GhosttySelectionGestureEventType. */
export const GestureEventType = {
  PRESS: 0,
  RELEASE: 1,
  DRAG: 2,
  AUTOSCROLL_TICK: 3,
} as const;

/** @internal GhosttySelectionGestureEventOption. */
export const GestureEventOpt = {
  REF: 1,
  POSITION: 2,
  REPEAT_DISTANCE: 3,
  TIME_NS: 4,
  REPEAT_INTERVAL_NS: 5,
  RECTANGLE: 8,
  GEOMETRY: 9,
  VIEWPORT: 10,
} as const;

/** @internal GhosttySelectionGestureData. */
export const GestureData = { AUTOSCROLL: 3 } as const;

/** Which clipboard a program wrote to (OSC 52). */
export type ClipboardLocation = 'standard' | 'selection' | 'primary';

/** A clipboard write requested by the running program (OSC 52). */
export interface ClipboardWriteRequest {
  location: ClipboardLocation;
  /** Representations of the same value; empty means "clear the clipboard". */
  contents: { mime: string; data: Uint8Array }[];
}

/** A desktop notification requested by the program (OSC 9 / OSC 777). */
export interface TerminalNotification {
  title: string;
  body: string;
}

/** A progress report from the program (OSC 9;4). */
export interface ProgressReport {
  state: 'remove' | 'set' | 'error' | 'indeterminate' | 'pause';
  /** 0-100, or null when the program gave no percentage. */
  progress: number | null;
}

/** A program status report (OSC 7501): what a program such as an agent is doing. */
export interface ProgramStatus {
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
  /** What a blocked program needs from the user. */
  kind: 'none' | 'permission' | 'question' | 'auth';
  progress: number | null;
  id: string;
  app: string;
  title: string;
  message: string;
}

/** A shell integration event (OSC 133). */
export interface SemanticPromptEvent {
  kind: 'prompt-start' | 'input-start' | 'output-start' | 'command-end';
  promptKind: 'primary' | 'right' | 'continuation' | 'secondary';
  /** Set on command-end when the shell reported it. */
  exitCode: number | null;
  /** The command about to run (output-start), when the shell reports it. */
  command: string;
  error: string;
}

/**
 * Handlers for what the running program asks of the terminal. Each is
 * optional; without one the request is ignored (or denied).
 */
export interface TerminalEffects {
  bell?(): void;
  titleChanged?(title: string): void;
  pwdChanged?(pwd: string): void;
  /** Return true if the write was carried out. */
  clipboardWrite?(request: ClipboardWriteRequest): boolean;
  notification?(notification: TerminalNotification): void;
  progress?(report: ProgressReport): void;
  programStatus?(status: ProgramStatus): void;
  semanticPrompt?(event: SemanticPromptEvent): void;
  /** Answer "is the terminal light or dark?" (CSI ? 996 n). */
  colorScheme?(): 'light' | 'dark' | null;
  /** Cell size in pixels, for size queries (CSI 14/16/18/19 t). */
  cellSize?(): { width: number; height: number } | null;
  /** The program performed a full reset (RIS). */
  reset?(): void;
  /** The answerback sent for ENQ (0x05); nothing is sent when absent or ''. */
  answerback?(): string;
}

/** Default colors for a terminal, as 0xRRGGBB; undefined means the built-in default. */
export interface TerminalColors {
  foreground?: number;
  background?: number;
  cursor?: number;
  /** Overrides for the 256-color palette, by index (usually the first 16). */
  palette?: (number | undefined)[];
}

/** Autoscroll a selection drag asks for (GhosttySelectionGestureAutoscroll). */
export enum SelectionAutoscroll {
  NONE = 0,
  UP = 1,
  DOWN = 2,
}

/** A selection as absolute screen rows (0 = oldest scrollback row), start first. */
export interface SelectionRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
  rectangle: boolean;
}

/** Options for GhosttyTerminal.formatScreen(). */
export interface FormatScreenOptions {
  format: 'plain' | 'vt' | 'html';
  /** Which screen to format (default: the active one). */
  screen?: 'active' | 'primary';
  /** VT only: terminal state to restore (FormatterExtras bits). */
  extras?: number;
  unwrap?: boolean;
  trim?: boolean;
  /** First absolute row of the screen to include. */
  fromRow?: number;
  /** Last absolute row of the screen to include. */
  toRow?: number;
  /** Keep at most this many scrollback lines; ignored when fromRow is given. */
  scrollback?: number;
  /** Only the terminal's current selection ('' when there is none). */
  onlySelection?: boolean;
}

/** The inactive primary screen, read while the alternate screen is active. */
export interface PrimaryScreen {
  /** Rows of history above its active area. */
  scrollback: number;
  /** Rows in all: scrollback and active area. */
  length: number;
  /** A line by absolute row (0 = oldest scrollback row), or null outside the screen. */
  line(row: number): { cells: GhosttyCell[]; wrapped: boolean } | null;
}

/** Display geometry for selection drags, in CSS pixels. */
export interface SelectionGeometry {
  columns: number;
  cellWidth: number;
  screenHeight: number;
}

/** @internal GhosttyTerminalOption values that install effect callbacks. */
export const EffectOpt = {
  BELL: 3,
  ENQUIRY: 4,
  TITLE_CHANGED: 6,
  SIZE: 7,
  COLOR_SCHEME: 8,
  PWD_CHANGED: 26,
  CLIPBOARD_WRITE: 27,
  DESKTOP_NOTIFICATION: 30,
  PROGRESS_REPORT: 31,
  RENDER_HOLD: 42,
  SEMANTIC_PROMPT: 43,
  RESET: 44,
  PROGRAM_STATUS: 47,
} as const;

/** @internal GhosttyClipboardLocation, in order. */
export const CLIPBOARD_LOCATIONS = ['standard', 'selection', 'primary'] as const;

/** @internal GhosttyClipboardWriteResult values ghostterm replies with. */
export const ClipboardWriteResult = { SUCCESS: 0, DENIED: 1 } as const;

/** @internal GhosttyPasteSource. */
export const PasteSource = { CLIPBOARD: 0, TEXT: 1 } as const;

/** @internal GhosttyFocusEvent. */
export const FocusEvent = { GAINED: 0, LOST: 1 } as const;

/** @internal GhosttyColorScheme. */
export const ColorScheme = { LIGHT: 0, DARK: 1 } as const;

/** @internal GhosttyTerminalProgressState, in order. */
export const PROGRESS_STATES = ['remove', 'set', 'error', 'indeterminate', 'pause'] as const;

/** @internal GhosttyProgramStatusState, in order. */
export const PROGRAM_STATUS_STATES = [
  'idle',
  'working',
  'done',
  'blocked',
  'error',
  'clear',
] as const;

/** @internal GhosttyProgramStatusKind, in order. */
export const PROGRAM_STATUS_KINDS = ['none', 'permission', 'question', 'auth'] as const;

/** @internal GhosttySemanticPromptKind, in order (0 is INVALID). */
export const SEMANTIC_PROMPT_KINDS = [
  null,
  'prompt-start',
  'input-start',
  'output-start',
  'command-end',
] as const;

/** @internal GhosttySemanticPromptPromptKind, in order. */
export const PROMPT_KINDS = ['primary', 'right', 'continuation', 'secondary'] as const;

/** Longest a render hold may freeze the screen before it is ended (ms). */
export const RENDER_HOLD_TIMEOUT_MS = 1000;

/** @internal GhosttyTerminalScrollViewportTag. */
export const ScrollViewport = {
  BOTTOM: 1,
  DELTA: 2,
  ROW: 3,
  DELTA_PROMPT: 4,
} as const;

/** How to extend a selection from the keyboard (GhosttySelectionAdjust). */
export type SelectionAdjust =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'page-up'
  | 'page-down'
  | 'line-start'
  | 'line-end';

/** @internal GhosttySelectionAdjust, by ghostterm's name. */
export const SELECTION_ADJUST: Record<SelectionAdjust, number> = {
  left: 0,
  right: 1,
  up: 2,
  down: 3,
  home: 4,
  end: 5,
  'page-up': 6,
  'page-down': 7,
  'line-start': 8,
  'line-end': 9,
};
export const SIZE_MAX = 0xffffffff;

/** @internal GhosttyCellContentTag. */
export const CellContent = {
  CODEPOINT: 0,
  CODEPOINT_GRAPHEME: 1,
  BG_COLOR_PALETTE: 2,
  BG_COLOR_RGB: 3,
} as const;

/** @internal GhosttyCellWide. */
export const CellWide = {
  NARROW: 0,
  WIDE: 1,
} as const;

/** @internal GhosttyStyleColorTag. */
export const StyleColorTag = {
  NONE: 0,
  PALETTE: 1,
  RGB: 2,
} as const;

/** @internal GhosttyCursorStyle. */
export const CursorStyle = {
  BAR: 0,
  BLOCK: 1,
  UNDERLINE: 2,
  BLOCK_HOLLOW: 3,
} as const;

/** Mode 2027: grapheme clustering, on by default as in Ghostty itself. */
export const MODE_GRAPHEME_CLUSTER = 2027;

/** GHOSTTY_TERMINAL_BOUNDARY_OSC_START. */
export const WRITE_BOUNDARY_OSC_START = 1 << 5;
/** Bytes that end an OSC string in libghostty's parser: BEL, ESC, CAN, SUB. */
export const OSC_TERMINATORS = new Set([0x07, 0x1b, 0x18, 0x1a]);
/** Longest OSC payload passed to writeCapturingOsc's callback, as in xterm.js. */
export const OSC_PAYLOAD_LIMIT = 10_000_000;

/** Pack a mode number the way ghostty_mode_new() does. */
export function packMode(mode: number, ansi: boolean): number {
  return (mode & 0x7fff) | (ansi ? 0x8000 : 0);
}
