/**
 * TypeScript wrapper for the official libghostty-vt WebAssembly module.
 *
 * This talks to the prebuilt `ghostty-vt.wasm` that Ghostty publishes with each
 * libghostty-vt release, using only its stable C ABI. Rendering goes through the
 * RenderState API: one update call snapshots the viewport, and each dirty row is
 * read back with a single call that returns its raw cells.
 */

import { AbiLayout, type BitField, readBits } from './abi';
import {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  KeyEncoderOption,
  type KeyEvent,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
  type TerminalHandle,
  UnderlineStyle,
} from './types';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
};

// ============================================================================
// C ABI constants (enum values are part of the libghostty-vt ABI promise)
// ============================================================================

// Every table below is checked against the loaded module's manifest by
// lib/abi-enums.test.ts; they are exported for it (not from lib/index.ts).

/** @internal GhosttyResult. */
export const Result = { SUCCESS: 0, OUT_OF_SPACE: -3 } as const;
const GHOSTTY_SUCCESS = Result.SUCCESS;
const GHOSTTY_OUT_OF_SPACE = Result.OUT_OF_SPACE;

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

/** Display geometry for selection drags, in CSS pixels. */
export interface SelectionGeometry {
  columns: number;
  cellWidth: number;
  screenHeight: number;
}

/** @internal GhosttyTerminalOption values that install effect callbacks. */
export const EffectOpt = {
  BELL: 3,
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
const RENDER_HOLD_TIMEOUT_MS = 1000;

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
const SIZE_MAX = 0xffffffff;

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
const MODE_GRAPHEME_CLUSTER = 2027;

/** Pack a mode number the way ghostty_mode_new() does. */
function packMode(mode: number, ansi: boolean): number {
  return (mode & 0x7fff) | (ansi ? 0x8000 : 0);
}

// ============================================================================
// Layout derived from the module's type manifest
// ============================================================================

interface Layout {
  abi: AbiLayout;
  cell: {
    contentTag: BitField;
    codepoint: BitField;
    bgPalette: BitField;
    bgR: BitField;
    bgG: BitField;
    bgB: BitField;
    styleId: BitField;
    wide: BitField;
    hyperlink: BitField;
  };
  styleFlags: {
    bold: BitField;
    italic: BitField;
    faint: BitField;
    blink: BitField;
    inverse: BitField;
    invisible: BitField;
    strikethrough: BitField;
    underline: BitField;
    overline: BitField;
  };
  /** Size of a raw GhosttyCell, as stored in a row's cells view. */
  cellSize: number;
  style: { size: number; fg: number; bg: number; underline: number; flags: number };
  styleColor: { tag: number; value: number; r: number; g: number; b: number };
  cursor: {
    size: number;
    hasValue: number;
    x: number;
    y: number;
    visible: number;
    blinking: number;
    style: number;
  };
  colors: {
    size: number;
    bg: number;
    fg: number;
    cursor: number;
    hasCursor: number;
    palette: number;
  };
  point: { size: number; value: number; x: number; y: number };
  gridRef: number;
  cellsView: { ptr: number; len: number };
  modeConfig: { size: number; value: number };
  selection: { size: number; start: number; end: number; rectangle: number };
  coordinate: { size: number; x: number; y: number };
  geometry: { columns: number; cellWidth: number; paddingLeft: number; screenHeight: number };
  surface: { x: number; y: number };
  string: { size: number; ptr: number; len: number };
  rgb: { size: number; r: number; g: number; b: number };
  writer: { write: number; userdata: number };
  clipboardWrite: { location: number; contents: number; contentsLen: number; reply: number };
  clipboardContent: { size: number; mime: number; data: number };
  clipboardReply: { size: number; result: number; remember: number };
  notification: { title: number; body: number };
  progress: { state: number; progress: number };
  programStatus: {
    state: number;
    kind: number;
    progress: number;
    id: number;
    app: number;
    title: number;
    message: number;
  };
  semanticPrompt: {
    kind: number;
    promptKind: number;
    hasExitCode: number;
    exitCode: number;
    command: number;
    error: number;
  };
  sizeReport: { rows: number; columns: number; cellWidth: number; cellHeight: number };
  paste: {
    size: number;
    location: number;
    source: number;
    mimes: number;
    mimesLen: number;
    reader: number;
    allowUnsafe: number;
  };
  mimeReader: { read: number; userdata: number };
  mouseSize: {
    size: number;
    screenWidth: number;
    screenHeight: number;
    cellWidth: number;
    cellHeight: number;
  };
  mousePosition: { x: number; y: number };
  scrollbar: { size: number; total: number; offset: number; len: number };
  scrollViewport: { size: number; tag: number; delta: number; row: number };
  rowSelection: { size: number; startX: number; endX: number };
  selectionBuffer: { size: number; ptr: number; cap: number; len: number };
  codepointBuffer: { ptr: number; cap: number; len: number };
}

function buildLayout(abi: AbiLayout): Layout {
  const cellBits = (f: string) => abi.bits('GhosttyCell', f);
  const content = (arm: string, inner: string) =>
    abi.unionBits('GhosttyCell', 'content', arm, inner);
  const flag = (f: string) => abi.bits('GhosttyStyleFlags', f);
  const at = (struct: string) => (field: string) => abi.offset(struct, field);
  const rgb = at('GhosttyColorRgb');
  const clip = at('GhosttyClipboardWrite');
  const status = at('GhosttyTerminalProgramStatus');
  const prompt = at('GhosttyTerminalSemanticPrompt');
  const sizeReport = at('GhosttySizeReportSize');
  const paste = at('GhosttyPaste');
  const mouseSize = at('GhosttyMouseEncoderSize');
  const scrollValue = abi.offset('GhosttyTerminalScrollViewport', 'value');
  const styleColorValue = abi.offset('GhosttyStyleColor', 'value');
  const styleColorRgb = styleColorValue + abi.offset('GhosttyStyleColorValue', 'rgb');
  return {
    abi,
    cell: {
      contentTag: cellBits('content_tag'),
      codepoint: content('CODEPOINT', 'codepoint'),
      bgPalette: content('BG_COLOR_PALETTE', 'index'),
      bgR: content('BG_COLOR_RGB', 'r'),
      bgG: content('BG_COLOR_RGB', 'g'),
      bgB: content('BG_COLOR_RGB', 'b'),
      styleId: cellBits('style_id'),
      wide: cellBits('wide'),
      hyperlink: cellBits('hyperlink'),
    },
    styleFlags: {
      bold: flag('bold'),
      italic: flag('italic'),
      faint: flag('faint'),
      blink: flag('blink'),
      inverse: flag('inverse'),
      invisible: flag('invisible'),
      strikethrough: flag('strikethrough'),
      underline: flag('underline'),
      overline: flag('overline'),
    },
    cellSize: abi.size('GhosttyCell'),
    styleColor: {
      tag: abi.offset('GhosttyStyleColor', 'tag'),
      value: styleColorValue + abi.offset('GhosttyStyleColorValue', 'palette'),
      r: styleColorRgb + rgb('r'),
      g: styleColorRgb + rgb('g'),
      b: styleColorRgb + rgb('b'),
    },
    style: {
      size: abi.size('GhosttyStyle'),
      fg: abi.offset('GhosttyStyle', 'fg_color'),
      bg: abi.offset('GhosttyStyle', 'bg_color'),
      underline: abi.offset('GhosttyStyle', 'underline_color'),
      flags: abi.offset('GhosttyStyle', 'flags'),
    },
    cursor: {
      size: abi.size('GhosttyRenderStateCursor'),
      hasValue: abi.offset('GhosttyRenderStateCursor', 'viewport_has_value'),
      x: abi.offset('GhosttyRenderStateCursor', 'viewport_x'),
      y: abi.offset('GhosttyRenderStateCursor', 'viewport_y'),
      visible: abi.offset('GhosttyRenderStateCursor', 'visible'),
      blinking: abi.offset('GhosttyRenderStateCursor', 'blinking'),
      style: abi.offset('GhosttyRenderStateCursor', 'visual_style'),
    },
    colors: {
      size: abi.size('GhosttyRenderStateColors'),
      bg: abi.offset('GhosttyRenderStateColors', 'background'),
      fg: abi.offset('GhosttyRenderStateColors', 'foreground'),
      cursor: abi.offset('GhosttyRenderStateColors', 'cursor'),
      hasCursor: abi.offset('GhosttyRenderStateColors', 'cursor_has_value'),
      palette: abi.offset('GhosttyRenderStateColors', 'palette'),
    },
    point: {
      size: abi.size('GhosttyPoint'),
      value: abi.offset('GhosttyPoint', 'value'),
      x: abi.offset('GhosttyPointCoordinate', 'x'),
      y: abi.offset('GhosttyPointCoordinate', 'y'),
    },
    gridRef: abi.size('GhosttyGridRef'),
    cellsView: {
      ptr: abi.offset('GhosttyCellsView', 'ptr'),
      len: abi.offset('GhosttyCellsView', 'len'),
    },
    modeConfig: {
      size: abi.size('GhosttyTerminalModeConfig'),
      value: abi.offset('GhosttyTerminalModeConfig', 'value'),
    },
    selection: {
      size: abi.size('GhosttySelection'),
      start: abi.offset('GhosttySelection', 'start'),
      end: abi.offset('GhosttySelection', 'end'),
      rectangle: abi.offset('GhosttySelection', 'rectangle'),
    },
    coordinate: {
      size: abi.size('GhosttyPointCoordinate'),
      x: abi.offset('GhosttyPointCoordinate', 'x'),
      y: abi.offset('GhosttyPointCoordinate', 'y'),
    },
    geometry: {
      columns: abi.offset('GhosttySelectionGestureGeometry', 'columns'),
      cellWidth: abi.offset('GhosttySelectionGestureGeometry', 'cell_width'),
      paddingLeft: abi.offset('GhosttySelectionGestureGeometry', 'padding_left'),
      screenHeight: abi.offset('GhosttySelectionGestureGeometry', 'screen_height'),
    },
    surface: {
      x: abi.offset('GhosttySurfacePosition', 'x'),
      y: abi.offset('GhosttySurfacePosition', 'y'),
    },
    string: {
      size: abi.size('GhosttyString'),
      ptr: abi.offset('GhosttyString', 'ptr'),
      len: abi.offset('GhosttyString', 'len'),
    },
    rgb: {
      size: abi.size('GhosttyColorRgb'),
      r: rgb('r'),
      g: rgb('g'),
      b: rgb('b'),
    },
    writer: {
      write: abi.offset('GhosttyWriter', 'write'),
      userdata: abi.offset('GhosttyWriter', 'userdata'),
    },
    clipboardWrite: {
      location: clip('location'),
      contents: clip('contents'),
      contentsLen: clip('contents_len'),
      reply: clip('reply'),
    },
    clipboardContent: {
      size: abi.size('GhosttyClipboardContent'),
      mime: abi.offset('GhosttyClipboardContent', 'mime'),
      data: abi.offset('GhosttyClipboardContent', 'data'),
    },
    clipboardReply: {
      size: abi.size('GhosttyClipboardWriteReply'),
      result: abi.offset('GhosttyClipboardWriteReply', 'result'),
      remember: abi.offset('GhosttyClipboardWriteReply', 'remember'),
    },
    notification: {
      title: abi.offset('GhosttyTerminalDesktopNotification', 'title'),
      body: abi.offset('GhosttyTerminalDesktopNotification', 'body'),
    },
    progress: {
      state: abi.offset('GhosttyTerminalProgressReport', 'state'),
      progress: abi.offset('GhosttyTerminalProgressReport', 'progress'),
    },
    programStatus: {
      state: status('state'),
      kind: status('kind'),
      progress: status('progress'),
      id: status('id'),
      app: status('app'),
      title: status('title'),
      message: status('message'),
    },
    semanticPrompt: {
      kind: prompt('kind'),
      promptKind: prompt('prompt_kind'),
      hasExitCode: prompt('has_exit_code'),
      exitCode: prompt('exit_code'),
      command: prompt('command'),
      error: prompt('error'),
    },
    sizeReport: {
      rows: sizeReport('rows'),
      columns: sizeReport('columns'),
      cellWidth: sizeReport('cell_width'),
      cellHeight: sizeReport('cell_height'),
    },
    paste: {
      size: abi.size('GhosttyPaste'),
      location: paste('location'),
      source: paste('source'),
      mimes: paste('mimes'),
      mimesLen: paste('mimes_len'),
      reader: paste('reader'),
      allowUnsafe: paste('allow_unsafe'),
    },
    mimeReader: {
      read: abi.offset('GhosttyMimeReader', 'read'),
      userdata: abi.offset('GhosttyMimeReader', 'userdata'),
    },
    mouseSize: {
      size: abi.size('GhosttyMouseEncoderSize'),
      screenWidth: mouseSize('screen_width'),
      screenHeight: mouseSize('screen_height'),
      cellWidth: mouseSize('cell_width'),
      cellHeight: mouseSize('cell_height'),
    },
    mousePosition: {
      x: abi.offset('GhosttyMousePosition', 'x'),
      y: abi.offset('GhosttyMousePosition', 'y'),
    },
    scrollbar: {
      size: abi.size('GhosttyTerminalScrollbar'),
      total: abi.offset('GhosttyTerminalScrollbar', 'total'),
      offset: abi.offset('GhosttyTerminalScrollbar', 'offset'),
      len: abi.offset('GhosttyTerminalScrollbar', 'len'),
    },
    scrollViewport: {
      size: abi.size('GhosttyTerminalScrollViewport'),
      tag: abi.offset('GhosttyTerminalScrollViewport', 'tag'),
      delta: scrollValue + abi.offset('GhosttyTerminalScrollViewportValue', 'delta'),
      row: scrollValue + abi.offset('GhosttyTerminalScrollViewportValue', 'row'),
    },
    rowSelection: {
      size: abi.size('GhosttyRenderStateRowSelection'),
      startX: abi.offset('GhosttyRenderStateRowSelection', 'start_x'),
      endX: abi.offset('GhosttyRenderStateRowSelection', 'end_x'),
    },
    selectionBuffer: {
      size: abi.size('GhosttySelectionBuffer'),
      ptr: abi.offset('GhosttySelectionBuffer', 'ptr'),
      cap: abi.offset('GhosttySelectionBuffer', 'cap'),
      len: abi.offset('GhosttySelectionBuffer', 'len'),
    },
    codepointBuffer: {
      ptr: abi.offset('GhosttyCodepointBuffer', 'ptr'),
      cap: abi.offset('GhosttyCodepointBuffer', 'cap'),
      len: abi.offset('GhosttyCodepointBuffer', 'len'),
    },
  };
}

// ============================================================================
// WASM memory helpers
// ============================================================================

/**
 * Views over the module's linear memory. Any export can grow memory, which
 * detaches earlier views, so callers fetch a fresh view right before each access.
 */
class Memory {
  private buffer: ArrayBuffer | null = null;
  private dv!: DataView;
  private u8!: Uint8Array;

  constructor(private memory: WebAssembly.Memory) {}

  private refresh(): void {
    const buffer = this.memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.dv = new DataView(buffer);
      this.u8 = new Uint8Array(buffer);
    }
  }

  view(): DataView {
    this.refresh();
    return this.dv;
  }

  bytes(): Uint8Array {
    this.refresh();
    return this.u8;
  }
}

/**
 * Build a tiny module that re-exports a JavaScript function as a WebAssembly
 * function taking `params` i32 arguments and returning nothing. Only WebAssembly
 * functions can be stored in a function table, so this is how a JS callback gets
 * a function pointer that libghostty-vt can call.
 */
function wasmCallback(
  fn: (...args: number[]) => unknown,
  params: number,
  returnsI32 = false
): unknown {
  const results = returnsI32 ? [0x01, 0x7f] : [0x00];
  const typeSection = [0x01, 0x60, params, ...new Array(params).fill(0x7f), ...results];
  const importSection = [0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00];
  const exportSection = [0x01, 0x01, 0x66, 0x00, 0x00];
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    typeSection.length,
    ...typeSection,
    0x02,
    importSection.length,
    ...importSection,
    0x07,
    exportSection.length,
    ...exportSection,
  ]);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, { env: { f: fn } });
  return instance.exports.f;
}

// ============================================================================
// Ghostty: module loader and factory
// ============================================================================

/** The file system path of a `file:` URL, without a leading slash before a Windows drive letter. */
function fileUrlPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/** How the loaded libghostty-vt module was optimized (`GhosttyOptimizeMode` in build_info.h). */
export type GhosttyOptimizeMode =
  | 'debug'
  | 'release-safe'
  | 'release-small'
  | 'release-fast'
  | 'unknown';

/** @internal GhosttyBuildInfo's OPTIMIZE query. */
export const BUILD_INFO_OPTIMIZE = 4;
/** @internal GhosttyOptimizeMode. */
export const OPTIMIZE_MODES: Record<number, GhosttyOptimizeMode> = {
  0: 'debug',
  1: 'release-safe',
  2: 'release-small',
  3: 'release-fast',
};

/**
 * Main Ghostty WASM wrapper class
 */
export class Ghostty {
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;
  private mem: Memory;
  private layout: Layout;
  private terminals = new Map<number, GhosttyTerminal>();
  private writePtyFn = 0;

  constructor(wasmInstance: WebAssembly.Instance) {
    this.exports = wasmInstance.exports as GhosttyWasmExports;
    this.memory = this.exports.memory;
    this.mem = new Memory(this.memory);
    this.layout = buildLayout(new AbiLayout(this.readTypeJson()));
  }

  /** The libghostty-vt version reported by the loaded module. */
  get version(): string | undefined {
    return this.layout.abi.version;
  }

  /**
   * The optimization mode the loaded module was built with: `'release-small'` for the default
   * `ghostty-vt.wasm`, `'release-fast'` for `ghostty-vt-fast.wasm`.
   */
  get optimizeMode(): GhosttyOptimizeMode {
    const ex = this.exports;
    const out = ex.ghostty_wasm_alloc(4);
    try {
      const result = ex.ghostty_build_info(BUILD_INFO_OPTIMIZE, out);
      if (result !== 0) throw new Error(`ghostty-vt: failed to read build info (${result})`);
      return OPTIMIZE_MODES[this.mem.view().getInt32(out, true)] ?? 'unknown';
    } finally {
      ex.ghostty_wasm_free(out, 4);
    }
  }

  private readTypeJson(): string {
    const ptr = this.exports.ghostty_type_json();
    const bytes = this.mem.bytes();
    let end = ptr;
    while (bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(ptr, end));
  }

  /**
   * Function-table index of the shared write_pty callback, created on first use.
   * libghostty-vt passes the terminal handle as the first argument, which routes
   * the bytes to the right GhosttyTerminal.
   */
  private writePtyCallback(): number {
    if (this.writePtyFn) return this.writePtyFn;
    const fn = wasmCallback((term: number, _userdata: number, ptr: number, len: number) => {
      this.terminals.get(term)?.queueResponse(this.mem.bytes().slice(ptr, ptr + len));
    }, 4);
    const table = this.exports.__indirect_function_table;
    const index = table.grow(1);
    table.set(index, fn);
    this.writePtyFn = index;
    return index;
  }

  private effectFns = new Map<number, number>();

  /**
   * Install every effect callback on a terminal. Each callback type gets one
   * shared function-table entry; libghostty passes the terminal handle first,
   * which routes the call to the right GhosttyTerminal.
   */
  private installEffects(term: GhosttyTerminal): void {
    const route =
      (impl: (t: GhosttyTerminal, ...args: number[]) => unknown) =>
      (handle: number, _userdata: number, ...args: number[]) => {
        const t = this.terminals.get(handle);
        return t ? impl(t, ...args) : 0;
      };
    const table: [number, number, boolean, (t: GhosttyTerminal, ...a: number[]) => unknown][] = [
      [EffectOpt.BELL, 2, false, (t) => t.onEffect('bell')],
      [EffectOpt.TITLE_CHANGED, 2, false, (t) => t.onEffect('title')],
      [EffectOpt.PWD_CHANGED, 2, false, (t) => t.onEffect('pwd')],
      [EffectOpt.CLIPBOARD_WRITE, 3, false, (t, ptr) => t.onClipboardWrite(ptr)],
      [EffectOpt.DESKTOP_NOTIFICATION, 3, false, (t, ptr) => t.onNotification(ptr)],
      [EffectOpt.PROGRESS_REPORT, 3, false, (t, ptr) => t.onProgress(ptr)],
      [EffectOpt.PROGRAM_STATUS, 3, false, (t, ptr) => t.onProgramStatus(ptr)],
      [EffectOpt.SEMANTIC_PROMPT, 3, false, (t, ptr) => t.onSemanticPrompt(ptr)],
      [EffectOpt.COLOR_SCHEME, 3, true, (t, ptr) => t.onColorScheme(ptr)],
      [EffectOpt.SIZE, 3, true, (t, ptr) => t.onSizeQuery(ptr)],
      [EffectOpt.RENDER_HOLD, 3, false, (t, held) => t.onRenderHold(held !== 0)],
      [EffectOpt.RESET, 2, false, (t) => t.onEffect('reset')],
    ];
    for (const [option, params, returnsI32, impl] of table) {
      let index = this.effectFns.get(option);
      if (index === undefined) {
        index = this.tableFunction(wasmCallback(route(impl), params, returnsI32));
        this.effectFns.set(option, index);
      }
      this.exports.ghostty_terminal_set(term.handle, option, index);
    }
  }

  /** @internal Call a function pointer from the module's function table. */
  callTable(index: number, ...args: number[]): number {
    const fn = this.exports.__indirect_function_table.get(index) as (...a: number[]) => number;
    return fn(...args);
  }

  /** Put a JS function in the module's function table; returns its index. */
  private tableFunction(fn: unknown): number {
    const table = this.exports.__indirect_function_table;
    const index = table.grow(1);
    table.set(index, fn as any);
    return index;
  }

  private mimeReaderFn = 0;
  /** Bytes the paste being performed should read, if any. */
  private pasteData: Uint8Array | null = null;

  /**
   * Function-table index of the GhosttyMimeReaderFn used by
   * ghostty_terminal_paste. It hands the current paste's bytes to the
   * GhosttyWriter that libghostty passes in, by calling its function pointer.
   */
  private mimeReaderCallback(): number {
    if (this.mimeReaderFn) return this.mimeReaderFn;
    const ex = this.exports;
    const fn = wasmCallback(
      (_userdata: number, _mimePtr: number, writerPtr: number) => {
        const data = this.pasteData;
        if (!data) return 0;
        const view = this.mem.view();
        const W = this.layout.writer;
        const write = view.getUint32(writerPtr + W.write, true);
        const writerData = view.getUint32(writerPtr + W.userdata, true);
        const len = Math.max(1, data.length);
        const ptr = ex.ghostty_wasm_alloc(len);
        if (!ptr) return 0;
        this.mem.bytes().set(data, ptr);
        const writeFn = ex.__indirect_function_table.get(write) as (
          ud: number,
          p: number,
          n: number
        ) => number;
        const ok = writeFn(writerData, ptr, data.length);
        ex.ghostty_wasm_free(ptr, len);
        return ok ? 1 : 0;
      },
      3,
      true
    );
    this.mimeReaderFn = this.tableFunction(fn);
    return this.mimeReaderFn;
  }

  /** @internal Run a paste with `data` as the clipboard's text/plain. */
  withPasteData<T>(data: Uint8Array, run: (readerFn: number) => T): T {
    const readerFn = this.mimeReaderCallback();
    this.pasteData = data;
    try {
      return run(readerFn);
    } finally {
      this.pasteData = null;
    }
  }

  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this.exports, this.mem, this.layout);
  }

  createMouseEncoder(): MouseEncoder {
    return new MouseEncoder(this.exports, this.mem, this.layout);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    const term = new GhosttyTerminal(this.exports, this.mem, this.layout, cols, rows, config);
    term.ghostty = this;
    this.terminals.set(term.handle, term);
    term.setWritePty(this.writePtyCallback(), () => this.terminals.delete(term.handle));
    this.installEffects(term);
    return term;
  }

  /**
   * Load the libghostty-vt module.
   *
   * Without an argument this loads the size-optimized `ghostty-vt.wasm` (bundled into the library
   * build). Pass a path or URL to load another copy, such as the speed-optimized
   * `ghostty-vt-fast.wasm` shipped alongside it.
   */
  static async load(wasmPath?: string | URL): Promise<Ghostty> {
    if (wasmPath) {
      if (typeof wasmPath === 'string') return Ghostty.loadFromPath(wasmPath);
      return Ghostty.loadFromPath(
        wasmPath.protocol === 'file:' ? fileUrlPath(wasmPath) : wasmPath.href
      );
    }

    // Resolve path relative to this module
    const moduleUrl = new URL('../ghostty-vt.wasm', import.meta.url);

    // Build paths to try, prioritizing file system paths for Node/Bun
    const defaultPaths: string[] = [];

    // For Node/Bun: try absolute file path first
    if (moduleUrl.protocol === 'file:') {
      defaultPaths.push(fileUrlPath(moduleUrl));
    }

    // Also try other common paths
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');

    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work. The specifier is a variable so bundlers
    // leave it alone; browsers never get here.
    if (!wasmBytes && typeof process !== 'undefined' && process.versions?.node) {
      try {
        const fsModule = 'node:fs/promises';
        const fs = await import(/* @vite-ignore */ fsModule);
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // fs failed, try fetch
      }
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    // The official module has no imports.
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
    return new Ghostty(wasmInstance);
  }
}

// ============================================================================
// Key encoder
// ============================================================================

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private exports: GhosttyWasmExports;
  private mem: Memory;
  private encoder: number = 0;
  private L: Layout;

  constructor(exports: GhosttyWasmExports, mem: Memory, layout: Layout) {
    this.exports = exports;
    this.mem = mem;
    this.L = layout;
    const slot = this.exports.ghostty_wasm_alloc_opaque();
    const result = this.exports.ghostty_key_encoder_new(0, slot);
    this.encoder = this.exports.ghostty_wasm_take_opaque(slot);
    this.exports.ghostty_wasm_free_opaque(slot);
    if (result !== GHOSTTY_SUCCESS) throw new Error(`Failed to create key encoder: ${result}`);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    // Options are a bool, a u8 (kitty flags) or a 4-byte enum (option-as-alt);
    // a little-endian u32 write covers all three.
    const valuePtr = this.exports.ghostty_wasm_alloc(4);
    this.mem.view().setUint32(valuePtr, typeof value === 'boolean' ? (value ? 1 : 0) : value, true);
    this.exports.ghostty_key_encoder_set(this.encoder, option, valuePtr);
    this.exports.ghostty_wasm_free(valuePtr, 4);
  }

  /**
   * Copy the terminal's keyboard modes into the encoder: cursor and keypad
   * application modes, Kitty keyboard flags, modifyOtherKeys, the alt escape
   * prefix and backarrow mode. Programs change these in any write, so call it
   * right before encoding. It resets MACOS_OPTION_AS_ALT, which is not a
   * terminal mode; set that again afterwards.
   */
  syncFromTerminal(terminal: GhosttyTerminal): void {
    this.exports.ghostty_key_encoder_set_from_terminal(this.encoder, terminal.handle);
  }

  encode(event: KeyEvent): Uint8Array {
    const ex = this.exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    const createResult = ex.ghostty_key_event_new(0, slot);
    const eventPtr = ex.ghostty_wasm_take_opaque(slot);
    ex.ghostty_wasm_free_opaque(slot);
    if (createResult !== GHOSTTY_SUCCESS)
      throw new Error(`Failed to create key event: ${createResult}`);

    // The key event borrows its UTF-8 text, so it must outlive encode().
    let utf8Ptr = 0;
    let utf8Len = 0;
    let stringPtr = 0;
    const bufferSize = 128;
    const bufPtr = ex.ghostty_wasm_alloc(bufferSize);
    const writtenPtr = ex.ghostty_wasm_alloc(4);

    try {
      ex.ghostty_key_event_set_action(eventPtr, event.action);
      ex.ghostty_key_event_set_key(eventPtr, event.key);
      ex.ghostty_key_event_set_mods(eventPtr, event.mods);
      if (event.consumedMods !== undefined) {
        ex.ghostty_key_event_set_consumed_mods(eventPtr, event.consumedMods);
      }
      if (event.composing !== undefined) {
        ex.ghostty_key_event_set_composing(eventPtr, event.composing);
      }
      if (event.unshiftedCodepoint !== undefined) {
        ex.ghostty_key_event_set_unshifted_codepoint(eventPtr, event.unshiftedCodepoint);
      }

      if (event.utf8) {
        const utf8Bytes = new TextEncoder().encode(event.utf8);
        utf8Len = utf8Bytes.length;
        utf8Ptr = ex.ghostty_wasm_alloc(utf8Len);
        stringPtr = ex.ghostty_wasm_alloc(this.L.string.size);
        this.mem.bytes().set(utf8Bytes, utf8Ptr);
        const view = this.mem.view();
        view.setUint32(stringPtr + this.L.string.ptr, utf8Ptr, true);
        view.setUint32(stringPtr + this.L.string.len, utf8Len, true);
        ex.ghostty_key_event_set_utf8(eventPtr, stringPtr);
      }

      const encodeResult = ex.ghostty_key_encoder_encode(
        this.encoder,
        eventPtr,
        bufPtr,
        bufferSize,
        writtenPtr
      );
      if (encodeResult !== GHOSTTY_SUCCESS) {
        throw new Error(`Failed to encode key: ${encodeResult}`);
      }

      const bytesWritten = this.mem.view().getUint32(writtenPtr, true);
      return this.mem.bytes().slice(bufPtr, bufPtr + bytesWritten);
    } finally {
      ex.ghostty_wasm_free(bufPtr, bufferSize);
      ex.ghostty_wasm_free(writtenPtr, 4);
      if (stringPtr) ex.ghostty_wasm_free(stringPtr, this.L.string.size);
      if (utf8Ptr) ex.ghostty_wasm_free(utf8Ptr, utf8Len);
      ex.ghostty_key_event_free(eventPtr);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

// ============================================================================
// Mouse encoder
// ============================================================================

/** Mouse button (GhosttyMouseButton). Wheel ticks are buttons 4-7. */
export enum MouseButton {
  LEFT = 1,
  RIGHT = 2,
  MIDDLE = 3,
  WHEEL_UP = 4,
  WHEEL_DOWN = 5,
  WHEEL_LEFT = 6,
  WHEEL_RIGHT = 7,
}

/** Mouse event action (GhosttyMouseAction). */
export enum MouseAction {
  PRESS = 0,
  RELEASE = 1,
  MOTION = 2,
}

/** Surface geometry for mouse encoding, in CSS pixels. */
export interface MouseGeometry {
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
}

/** @internal GhosttyMouseEncoderOption. */
export const MouseEncoderOpt = {
  SIZE: 3,
  ANY_BUTTON_PRESSED: 4,
  TRACK_LAST_CELL: 5,
} as const;

/**
 * Mouse Encoder - converts pointer events into mouse reports for programs
 * that turned on mouse tracking, in whichever mode and format (X10, UTF-8,
 * SGR, URxvt, SGR-Pixels) they asked for.
 */
export class MouseEncoder {
  private exports: GhosttyWasmExports;
  private mem: Memory;
  private encoder = 0;
  private event = 0;
  private scratch = 0;
  private L: Layout;

  constructor(exports: GhosttyWasmExports, mem: Memory, layout: Layout) {
    this.exports = exports;
    this.mem = mem;
    this.L = layout;
    const ex = exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      if (ex.ghostty_mouse_encoder_new(0, slot) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create mouse encoder');
      }
      this.encoder = ex.ghostty_wasm_take_opaque(slot);
      if (ex.ghostty_mouse_event_new(0, slot) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create mouse event');
      }
      this.event = ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    this.scratch = ex.ghostty_wasm_alloc(256);
    // Report motion only when the pointer moves to another cell.
    this.mem.view().setUint8(this.scratch, 1);
    ex.ghostty_mouse_encoder_set(this.encoder, MouseEncoderOpt.TRACK_LAST_CELL, this.scratch);
  }

  /** Copy the terminal's mouse tracking mode and report format. */
  syncFromTerminal(terminal: GhosttyTerminal): void {
    this.exports.ghostty_mouse_encoder_set_from_terminal(this.encoder, terminal.handle);
  }

  /** Surface size and cell size; the encoder turns positions into cells. */
  setGeometry(g: MouseGeometry): void {
    const p = this.scratch;
    const S = this.L.mouseSize;
    const view = this.mem.view();
    const u32 = (offset: number, v: number) => view.setUint32(p + offset, v, true);
    this.mem.bytes().fill(0, p, p + S.size);
    u32(0, S.size); // sized struct: the size field comes first
    u32(S.screenWidth, Math.max(1, Math.round(g.screenWidth)));
    u32(S.screenHeight, Math.max(1, Math.round(g.screenHeight)));
    u32(S.cellWidth, Math.max(1, Math.round(g.cellWidth)));
    u32(S.cellHeight, Math.max(1, Math.round(g.cellHeight)));
    this.exports.ghostty_mouse_encoder_set(this.encoder, MouseEncoderOpt.SIZE, p);
  }

  /** Whether any button is held, which decides motion reporting in button mode. */
  setAnyButtonPressed(pressed: boolean): void {
    this.mem.view().setUint8(this.scratch, pressed ? 1 : 0);
    this.exports.ghostty_mouse_encoder_set(
      this.encoder,
      MouseEncoderOpt.ANY_BUTTON_PRESSED,
      this.scratch
    );
  }

  /** Forget the last reported cell, so the next motion is reported. */
  reset(): void {
    this.exports.ghostty_mouse_encoder_reset(this.encoder);
  }

  /**
   * Encode one mouse event at surface position (x, y). Returns '' when the
   * current mode reports nothing for it.
   */
  encode(
    action: MouseAction,
    button: MouseButton | null,
    mods: number,
    x: number,
    y: number
  ): string {
    const ex = this.exports;
    const ev = this.event;
    ex.ghostty_mouse_event_set_action(ev, action);
    if (button === null) ex.ghostty_mouse_event_clear_button(ev);
    else ex.ghostty_mouse_event_set_button(ev, button);
    ex.ghostty_mouse_event_set_mods(ev, mods);
    const pos = this.scratch + 64;
    const view = this.mem.view();
    view.setFloat32(pos + this.L.mousePosition.x, x, true);
    view.setFloat32(pos + this.L.mousePosition.y, y, true);
    ex.ghostty_mouse_event_set_position(ev, pos);

    const buf = this.scratch + 96;
    const written = this.scratch + 88;
    if (ex.ghostty_mouse_encoder_encode(this.encoder, ev, buf, 128, written) !== GHOSTTY_SUCCESS) {
      return '';
    }
    const len = this.mem.view().getUint32(written, true);
    const bytes = this.mem.bytes().slice(buf, buf + len);
    // The UTF-8 format is valid UTF-8. The X10/normal format puts raw bytes
    // up to 255 in the report, which go out one character per byte.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return String.fromCharCode(...bytes);
    }
  }

  dispose(): void {
    const ex = this.exports;
    if (this.event) ex.ghostty_mouse_event_free(this.event);
    if (this.encoder) ex.ghostty_mouse_encoder_free(this.encoder);
    if (this.scratch) ex.ghostty_wasm_free(this.scratch, 256);
    this.event = this.encoder = this.scratch = 0;
  }
}

// ============================================================================
// Terminal
// ============================================================================

/** Size of the per-terminal scratch area for out-parameters. */
const SCRATCH_SIZE = 2048;
const SELECTION_SCRATCH_SIZE = 256;
/** How many hyperlink URIs a terminal remembers IDs for. */
const MAX_LINK_IDS = 4096;
/** Where in the scratch area grapheme codepoints are read, and how much room they have. */
const GRAPHEME_BUFFER = 1008; // the GhosttyCodepointBuffer describing them
const GRAPHEME_SCRATCH = 1024;
const GRAPHEME_SCRATCH_SIZE = SCRATCH_SIZE - GRAPHEME_SCRATCH;

/**
 * GhosttyTerminal - terminal emulator backed by libghostty-vt
 *
 * The viewport is read through a RenderState. Rows are cached on the JS side and
 * only re-read when libghostty-vt reports them dirty, so rendering a frame costs
 * one call per changed row plus one call per styled cell in those rows.
 */
export class GhosttyTerminal {
  private exports: GhosttyWasmExports;
  private mem: Memory;
  private L: Layout;
  readonly handle: TerminalHandle;
  private _cols: number;
  private _rows: number;

  private renderState = 0;
  private rowIterSlot = 0;
  private rowCellsSlot = 0;
  private scratch = 0;
  /** Separate scratch for selection and formatter calls (see selectionScratch). */
  private selScratch = 0;
  private onFree: (() => void) | null = null;
  private freed = false;

  /** Dirty flags since the last markClean(), mirroring the render state's. */
  private dirty: DirtyState = DirtyState.FULL;
  private rowDirty: Uint8Array;
  /** Rows whose cached cells no longer match the render state. */
  private rowStale: Uint8Array;

  /** Cell pool for zero-allocation rendering */
  private cellPool: GhosttyCell[] = [];

  /** Default colors and palette from the last update, used to resolve cell colors. */
  private fgDefault: RGB = { r: 204, g: 204, b: 204 };
  private bgDefault: RGB = { r: 0, g: 0, b: 0 };
  /** The 256-color palette as GhosttyColorRgb[256]. */
  private palette: Uint8Array;
  private colorsFresh = false;
  /** Whether libghostty's viewport is pinned to the active area. */
  private atBottom = true;

  /** Set by write()/resize(); getViewport() updates the render state first. */
  private pendingUpdate = true;

  /** Bytes the terminal wrote back for the pty (DSR, DA, DECRQM replies, ...). */
  private responses: Uint8Array[] = [];

  constructor(
    exports: GhosttyWasmExports,
    mem: Memory,
    layout: Layout,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.exports = exports;
    this.mem = mem;
    this.L = layout;
    this.palette = new Uint8Array(256 * layout.rgb.size);
    this._cols = cols;
    this._rows = rows;

    const ex = this.exports;
    this.scratch = ex.ghostty_wasm_alloc(SCRATCH_SIZE);
    this.selScratch = ex.ghostty_wasm_alloc(SELECTION_SCRATCH_SIZE);
    if (!this.scratch) throw new Error('Failed to allocate terminal scratch memory');

    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      this.check(ex.ghostty_terminal_new(0, slot, cols, rows), 'create terminal');
      this.handle = ex.ghostty_wasm_take_opaque(slot);
      this.check(ex.ghostty_render_state_new(0, slot), 'create render state');
      this.renderState = ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }

    // Iterator and row-cell handles are reused for every frame; the render state
    // fills them in place, so they live in persistent slots.
    this.rowIterSlot = ex.ghostty_wasm_alloc_opaque();
    this.check(
      ex.ghostty_render_state_row_iterator_new(0, this.rowIterSlot),
      'create row iterator'
    );
    this.rowCellsSlot = ex.ghostty_wasm_alloc_opaque();
    this.check(ex.ghostty_render_state_row_cells_new(0, this.rowCellsSlot), 'create row cells');

    this.setMode(MODE_GRAPHEME_CLUSTER, false, true);
    this.applyConfig(config);

    this.rowDirty = new Uint8Array(rows).fill(1);
    this.rowStale = new Uint8Array(rows).fill(1);
    this.initCellPool();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  private check(result: number, what: string): void {
    if (result !== GHOSTTY_SUCCESS) throw new Error(`libghostty-vt: failed to ${what} (${result})`);
  }

  /** @internal Called by Ghostty to route write_pty callbacks here. */
  setWritePty(fnIndex: number, onFree: () => void): void {
    this.onFree = onFree;
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.WRITE_PTY, fnIndex);
  }

  /** @internal */
  queueResponse(bytes: Uint8Array): void {
    (this.capture ?? this.responses).push(bytes);
  }

  /** @internal The Ghostty instance that created this terminal. */
  ghostty?: Ghostty;

  /** Handlers for the program's requests (bell, title, clipboard, ...). */
  private effects: TerminalEffects = {};
  /** When the current render hold began (performance.now()), or null. */
  private holdStarted: number | null = null;

  setEffects(effects: TerminalEffects): void {
    this.effects = effects;
  }

  /** Read a GhosttyString (ptr, len) at `at` as UTF-8. */
  private readString(at: number): string {
    const view = this.mem.view();
    const ptr = view.getUint32(at + this.L.string.ptr, true);
    const len = view.getUint32(at + this.L.string.len, true);
    if (!ptr || !len) return '';
    return new TextDecoder().decode(this.mem.bytes().slice(ptr, ptr + len));
  }

  /** Read a GhosttyString-valued terminal data field (title, pwd). */
  private readDataString(data: number): string {
    const out = this.selScratch + 240;
    if (this.exports.ghostty_terminal_get(this.handle, data, out) !== GHOSTTY_SUCCESS) return '';
    return this.readString(out);
  }

  /** The window title the program set (OSC 0/2). */
  getTitle(): string {
    return this.readDataString(TerminalData.TITLE);
  }

  /**
   * The pointer shape in effect, as a CSS cursor name: what the program asked
   * for (OSC 22), else libghostty's default, 'text'. Null if it can't be read.
   */
  getMouseShape(): string | null {
    const out = this.selScratch + 240;
    if (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.MOUSE_SHAPE, out) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const shape = this.mem.view().getUint32(out, true);
    return MOUSE_SHAPES[shape] ?? null;
  }

  /** The working directory the program reported (OSC 7). */
  getPwd(): string {
    return this.readDataString(TerminalData.PWD);
  }

  /** @internal */
  onEffect(kind: 'bell' | 'title' | 'pwd' | 'reset'): void {
    const e = this.effects;
    if (kind === 'bell') e.bell?.();
    else if (kind === 'title') e.titleChanged?.(this.getTitle());
    else if (kind === 'pwd') e.pwdChanged?.(this.getPwd());
    else e.reset?.();
  }

  /** @internal Answer a GhosttyClipboardWrite; not replying denies it. */
  onClipboardWrite(ptr: number): void {
    const handler = this.effects.clipboardWrite;
    if (!handler || !this.ghostty) return;
    const W = this.L.clipboardWrite;
    const C = this.L.clipboardContent;
    const view = this.mem.view();
    const location = CLIPBOARD_LOCATIONS[view.getUint32(ptr + W.location, true)];
    const contentsPtr = view.getUint32(ptr + W.contents, true);
    const count = view.getUint32(ptr + W.contentsLen, true);
    const contents: ClipboardWriteRequest['contents'] = [];
    for (let i = 0; i < count; i++) {
      const c = contentsPtr + i * C.size;
      const v = this.mem.view();
      const dataPtr = v.getUint32(c + C.data + this.L.string.ptr, true);
      const dataLen = v.getUint32(c + C.data + this.L.string.len, true);
      contents.push({
        mime: this.readString(c + C.mime),
        data: this.mem.bytes().slice(dataPtr, dataPtr + dataLen),
      });
    }
    const ok = handler({ location: location ?? 'standard', contents });

    const R = this.L.clipboardReply;
    const reply = this.selScratch + 160;
    this.mem.bytes().fill(0, reply, reply + R.size);
    const v = this.mem.view();
    v.setUint32(reply, R.size, true); // sized struct: the size field comes first
    v.setUint32(
      reply + R.result,
      ok ? ClipboardWriteResult.SUCCESS : ClipboardWriteResult.DENIED,
      true
    );
    v.setUint8(reply + R.remember, 0);
    const replyFn = v.getUint32(ptr + W.reply, true);
    this.ghostty.callTable(replyFn, ptr, reply);
  }

  /** @internal */
  onNotification(ptr: number): void {
    const N = this.L.notification;
    this.effects.notification?.({
      title: this.readString(ptr + N.title),
      body: this.readString(ptr + N.body),
    });
  }

  /** @internal */
  onProgress(ptr: number): void {
    const P = this.L.progress;
    const view = this.mem.view();
    const progress = view.getInt8(ptr + P.progress);
    this.effects.progress?.({
      state: PROGRESS_STATES[view.getUint32(ptr + P.state, true)] ?? 'remove',
      progress: progress < 0 ? null : progress,
    });
  }

  /** @internal */
  onProgramStatus(ptr: number): void {
    const S = this.L.programStatus;
    const view = this.mem.view();
    const progress = view.getInt8(ptr + S.progress);
    this.effects.programStatus?.({
      state: PROGRAM_STATUS_STATES[view.getUint32(ptr + S.state, true)] ?? 'idle',
      kind: PROGRAM_STATUS_KINDS[view.getUint32(ptr + S.kind, true)] ?? 'none',
      progress: progress < 0 ? null : progress,
      id: this.readString(ptr + S.id),
      app: this.readString(ptr + S.app),
      title: this.readString(ptr + S.title),
      message: this.readString(ptr + S.message),
    });
  }

  /** @internal */
  onSemanticPrompt(ptr: number): void {
    const S = this.L.semanticPrompt;
    const view = this.mem.view();
    const kind = SEMANTIC_PROMPT_KINDS[view.getUint32(ptr + S.kind, true)];
    if (!kind) return;
    this.effects.semanticPrompt?.({
      kind,
      promptKind: PROMPT_KINDS[view.getUint32(ptr + S.promptKind, true)] ?? 'primary',
      exitCode: view.getUint8(ptr + S.hasExitCode) ? view.getInt32(ptr + S.exitCode, true) : null,
      command: this.readString(ptr + S.command),
      error: this.readString(ptr + S.error),
    });
  }

  /** @internal Fill a GhosttyColorScheme; returning 0 leaves the query unanswered. */
  onColorScheme(ptr: number): number {
    const scheme = this.effects.colorScheme?.();
    if (!scheme) return 0;
    const value = scheme === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT;
    this.mem.view().setUint32(ptr, value, true);
    return 1;
  }

  /** @internal Fill a GhosttySizeReportSize for XTWINOPS size queries. */
  onSizeQuery(ptr: number): number {
    const cell = this.effects.cellSize?.();
    if (!cell) return 0;
    const S = this.L.sizeReport;
    const view = this.mem.view();
    view.setUint16(ptr + S.rows, this._rows, true);
    view.setUint16(ptr + S.columns, this._cols, true);
    view.setUint32(ptr + S.cellWidth, Math.max(1, Math.round(cell.width)), true);
    view.setUint32(ptr + S.cellHeight, Math.max(1, Math.round(cell.height)), true);
    return 1;
  }

  /**
   * @internal Synchronized output (mode 2026): when a hold starts, capture the
   * frame the program wants left on screen; keep showing it until the hold
   * ends (or times out).
   */
  onRenderHold(held: boolean): void {
    if (held) {
      this.holdStarted = null;
      this.update();
      this.holdStarted = performance.now();
    } else {
      this.holdStarted = null;
      this.pendingUpdate = true;
    }
  }

  /** Whether a render hold is freezing the screen. */
  isRenderHeld(): boolean {
    if (this.holdStarted === null) return false;
    if (performance.now() - this.holdStarted > RENDER_HOLD_TIMEOUT_MS) {
      this.holdStarted = null;
      return false;
    }
    return true;
  }
  /** While set, write_pty output is collected here instead of as responses. */
  private capture: Uint8Array[] | null = null;

  /**
   * Encode a paste of `text` the way the terminal's current modes require:
   * bracketed paste (mode 2004) when the program asked for it, newlines as
   * carriage returns otherwise, unsafe control bytes replaced with spaces, and
   * a Kitty paste event (mode 5522) when applicable. Returns the bytes for the
   * pty, or '' if nothing should be written.
   *
   * Text that could run commands (a newline outside bracketed paste, or the
   * bracketed paste terminator) is allowed, as ghostterm and xterm.js always
   * have; libghostty can refuse it instead, which a future confirmation hook
   * could use.
   */
  encodePaste(text: string): string {
    const ghostty = this.ghostty;
    if (!ghostty) return '';
    const ex = this.exports;
    const data = new TextEncoder().encode(text);
    const mime = new TextEncoder().encode('text/plain');

    const P = this.L.paste;
    const S = this.L.string;
    const R = this.L.mimeReader;
    // One block: the GhosttyPaste, the out-param, a GhosttyString[1] of mime
    // types and the mime type's bytes.
    const align4 = (n: number) => (n + 3) & ~3;
    const out = align4(P.size);
    const mimes = out + 4;
    const mimeBytes = mimes + align4(S.size);
    const blockSize = mimeBytes + mime.length;

    return ghostty.withPasteData(data, (readerFn) => {
      const block = ex.ghostty_wasm_alloc(blockSize);
      const paste = block;
      this.mem.bytes().fill(0, block, block + blockSize);
      this.mem.bytes().set(mime, block + mimeBytes);
      const view = this.mem.view();
      view.setUint32(block + mimes + S.ptr, block + mimeBytes, true);
      view.setUint32(block + mimes + S.len, mime.length, true);
      view.setUint32(paste, P.size, true); // sized struct: the size field comes first
      view.setUint32(paste + P.location, CLIPBOARD_LOCATIONS.indexOf('standard'), true);
      view.setUint32(paste + P.source, PasteSource.CLIPBOARD, true);
      view.setUint32(paste + P.mimes, block + mimes, true);
      view.setUint32(paste + P.mimesLen, 1, true);
      view.setUint32(paste + P.reader + R.read, readerFn, true);
      view.setUint32(paste + P.reader + R.userdata, 0, true);
      view.setUint8(paste + P.allowUnsafe, 1);

      this.capture = [];
      try {
        const result = ex.ghostty_terminal_paste(this.handle, paste, block + out);
        const chunks = this.capture;
        if (result !== GHOSTTY_SUCCESS) return '';
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        return new TextDecoder().decode(all);
      } finally {
        this.capture = null;
        ex.ghostty_wasm_free(block, blockSize);
      }
    });
  }

  /**
   * Encode a focus change for a program that asked for focus reports (mode
   * 1004), or '' when it didn't.
   */
  encodeFocus(focused: boolean): string {
    if (!this.getMode(1004, false)) return '';
    const ex = this.exports;
    const buf = this.selScratch + 192;
    const written = this.selScratch + 224;
    if (
      ex.ghostty_focus_encode(focused ? FocusEvent.GAINED : FocusEvent.LOST, buf, 16, written) !==
      GHOSTTY_SUCCESS
    )
      return '';
    const len = this.mem.view().getUint32(written, true);
    return new TextDecoder().decode(this.mem.bytes().slice(buf, buf + len));
  }

  private setMode(mode: number, ansi: boolean, value: boolean): void {
    const ptr = this.scratch;
    const view = this.mem.view();
    view.setUint16(ptr, packMode(mode, ansi), true);
    view.setUint8(ptr + this.L.modeConfig.value, value ? 1 : 0);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.MODE_DEFAULT, ptr);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.MODE, ptr);
  }

  /** Write 0xRRGGBB as a GhosttyColorRgb at `at`. */
  private writeRgb(at: number, hex: number): void {
    const C = this.L.rgb;
    const view = this.mem.view();
    view.setUint8(at + C.r, (hex >> 16) & 0xff);
    view.setUint8(at + C.g, (hex >> 8) & 0xff);
    view.setUint8(at + C.b, hex & 0xff);
  }

  /** Read a GhosttyColorRgb at `at`. */
  private readRgb(at: number): RGB {
    const C = this.L.rgb;
    const b = this.mem.bytes();
    return { r: b[at + C.r], g: b[at + C.g], b: b[at + C.b] };
  }

  private setColor(option: number, hex: number): void {
    this.writeRgb(this.scratch, hex);
    this.exports.ghostty_terminal_set(this.handle, option, this.scratch);
  }

  /** Apply ghostterm's config: the scrollback limit. */
  private applyConfig(config?: GhosttyTerminalConfig): void {
    this.setScrollbackLimit(config?.scrollbackLimit ?? 10000);
  }

  /**
   * Lines of history to keep, at any time; 0 means no scrollback, as in
   * xterm.js. Lowering it prunes existing history.
   */
  setScrollbackLimit(lines: number): void {
    const ex = this.exports;
    // The library also caps history by bytes, 10,000 by default, which would
    // otherwise win, so that cap is lifted. A line limit alone can't turn
    // history off (a page of rows is always kept), but a byte limit of 0 does.
    const scrollback = Math.max(0, Math.floor(lines));
    this.mem.view().setUint32(this.scratch, scrollback === 0 ? 0 : SIZE_MAX, true);
    ex.ghostty_terminal_set(this.handle, TerminalOpt.SCROLLBACK_MAX_BYTES, this.scratch);
    this.mem.view().setUint32(this.scratch, Math.min(scrollback, SIZE_MAX), true);
    ex.ghostty_terminal_set(this.handle, TerminalOpt.SCROLLBACK_MAX_LINES, this.scratch);
    this.pendingUpdate = true;
  }

  /**
   * Set the terminal's default colors, at any time (a theme change). Colors
   * are 0xRRGGBB; undefined restores libghostty's built-in default. Palette
   * entries override the built-in 256-color palette by index. Programs can
   * still change colors with OSC 4/10/11/12; those overrides are kept.
   */
  setColors(colors: TerminalColors): void {
    const ex = this.exports;
    const set = (option: number, hex: number | undefined) => {
      if (hex === undefined) ex.ghostty_terminal_set(this.handle, option, 0);
      else this.setColor(option, hex);
    };
    set(TerminalOpt.COLOR_FOREGROUND, colors.foreground);
    set(TerminalOpt.COLOR_BACKGROUND, colors.background);
    set(TerminalOpt.COLOR_CURSOR, colors.cursor);

    // Start from the built-in palette, then apply the overrides.
    ex.ghostty_terminal_set(this.handle, TerminalOpt.COLOR_PALETTE, 0);
    if (colors.palette?.some((c) => c !== undefined)) {
      const ptr = this.scratch;
      this.check(
        ex.ghostty_terminal_get(this.handle, TerminalData.COLOR_PALETTE_DEFAULT, ptr),
        'read default palette'
      );
      colors.palette.forEach((hex, i) => {
        if (hex !== undefined && i < 256) this.writeRgb(ptr + i * this.L.rgb.size, hex);
      });
      ex.ghostty_terminal_set(this.handle, TerminalOpt.COLOR_PALETTE, ptr);
    }

    // Every cell's resolved colors may have changed.
    this.colorsFresh = false;
    this.pendingUpdate = true;
    this.dirty = DirtyState.FULL;
    this.rowDirty?.fill(1);
    this.rowStale?.fill(1);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    const ptr = this.exports.ghostty_wasm_alloc(bytes.length);
    if (!ptr) throw new Error('Failed to allocate write buffer (out of memory)');
    this.mem.bytes().set(bytes, ptr);
    this.exports.ghostty_terminal_vt_write(this.handle, ptr, bytes.length);
    this.pendingUpdate = true;
    this.exports.ghostty_wasm_free(ptr, bytes.length);
  }

  /**
   * The cursor shape and blink the user configured. Programs can change them
   * (DECSCUSR, mode 12); `CSI 0 q` returns to these. getCursor() reports
   * what is in effect.
   */
  setDefaultCursor(style: 'block' | 'underline' | 'bar', blink: boolean): void {
    const ptr = this.scratch;
    const value =
      style === 'bar'
        ? CursorStyle.BAR
        : style === 'underline'
          ? CursorStyle.UNDERLINE
          : CursorStyle.BLOCK;
    this.mem.view().setUint32(ptr, value, true);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.DEFAULT_CURSOR_STYLE, ptr);
    this.mem.view().setUint8(ptr, blink ? 1 : 0);
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.DEFAULT_CURSOR_BLINK, ptr);
    this.pendingUpdate = true;
  }

  /** Cell size in pixels, reported to programs (in-band resize, mode 2048). */
  private cellPx = { width: 0, height: 0 };

  /** Tell the terminal its cell size in pixels. */
  setCellPixelSize(width: number, height: number): void {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === this.cellPx.width && h === this.cellPx.height) return;
    this.cellPx = { width: w, height: h };
    this.exports.ghostty_terminal_resize(this.handle, this._cols, this._rows, w, h);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.exports.ghostty_terminal_resize(
      this.handle,
      cols,
      rows,
      this.cellPx.width,
      this.cellPx.height
    );
    this.pendingUpdate = true;
    this.atBottom = this.getViewportOffset() === 0;
    this.rowDirty = new Uint8Array(rows).fill(1);
    this.rowStale = new Uint8Array(rows).fill(1);
    this.dirty = DirtyState.FULL;
    this.initCellPool();
  }

  /** Release the terminal and everything it holds. Calling it again does nothing. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    const ex = this.exports;
    this.onFree?.();
    this.onFree = null;
    if (this.rowCellsSlot) {
      ex.ghostty_render_state_row_cells_free(this.mem.view().getUint32(this.rowCellsSlot, true));
      ex.ghostty_wasm_free_opaque(this.rowCellsSlot);
      this.rowCellsSlot = 0;
    }
    if (this.rowIterSlot) {
      ex.ghostty_render_state_row_iterator_free(this.mem.view().getUint32(this.rowIterSlot, true));
      ex.ghostty_wasm_free_opaque(this.rowIterSlot);
      this.rowIterSlot = 0;
    }
    if (this.renderState) {
      ex.ghostty_render_state_free(this.renderState);
      this.renderState = 0;
    }
    ex.ghostty_terminal_free(this.handle);
    if (this.scratch) {
      ex.ghostty_wasm_free(this.scratch, SCRATCH_SIZE);
      ex.ghostty_wasm_free(this.selScratch, SELECTION_SCRATCH_SIZE);
      this.scratch = 0;
    }
  }

  // ==========================================================================
  // RenderState API
  // ==========================================================================

  /**
   * Update render state from terminal.
   *
   * libghostty-vt only ever adds dirty state on update; it is cleared by
   * markClean(). So this is safe to call any number of times per frame.
   * Screen switches (normal <-> alternate) are reported as FULL.
   */
  update(): DirtyState {
    const ex = this.exports;
    // During a render hold the render state keeps the frame captured when the
    // hold began.
    if (this.isRenderHeld()) return this.dirty;
    ex.ghostty_render_state_update(this.renderState, this.handle);
    this.colorsFresh = false;
    this.pendingUpdate = false;

    ex.ghostty_render_state_get(this.renderState, RenderData.DIRTY, this.scratch);
    const dirty = this.mem.view().getInt32(this.scratch, true) as DirtyState;
    if (dirty === DirtyState.NONE) return this.dirty;
    if (dirty > this.dirty) this.dirty = dirty;

    if (dirty === DirtyState.FULL) {
      this.rowDirty.fill(1);
      this.rowStale.fill(1);
      return this.dirty;
    }

    // Partial: record exactly which rows changed.
    const iter = this.rowIterator();
    const yPtr = this.scratch;
    while (ex.ghostty_render_state_row_iterator_next_dirty(iter, yPtr)) {
      const y = this.mem.view().getUint16(yPtr, true);
      if (y < this._rows) {
        this.rowDirty[y] = 1;
        this.rowStale[y] = 1;
      }
    }
    return this.dirty;
  }

  private rowIterator(): number {
    this.exports.ghostty_render_state_get(
      this.renderState,
      RenderData.ROW_ITERATOR,
      this.rowIterSlot
    );
    return this.mem.view().getUint32(this.rowIterSlot, true);
  }

  /**
   * Cursor state: shape, blink, visibility and viewport position from the
   * render state (updated first if the terminal changed), position in the
   * active area from the terminal.
   */
  getCursor(): RenderStateCursor {
    if (this.pendingUpdate) this.update();
    const ptr = this.scratch;
    const c = this.L.cursor;
    const view = this.mem.view();
    view.setUint32(ptr, c.size, true);
    this.exports.ghostty_render_state_get(this.renderState, RenderData.CURSOR, ptr);

    // x and y are in the active area; viewportX/Y place the cursor in the
    // (possibly scrolled) viewport, or are -1 when it is scrolled out of view.
    this.exports.ghostty_terminal_get(this.handle, TerminalData.CURSOR_X, ptr + 64);
    this.exports.ghostty_terminal_get(this.handle, TerminalData.CURSOR_Y, ptr + 68);
    const v = this.mem.view();
    const x = v.getUint16(ptr + 64, true);
    const y = v.getUint16(ptr + 68, true);
    const hasValue = v.getUint8(ptr + c.hasValue) !== 0;
    const style = v.getInt32(ptr + c.style, true);
    return {
      x,
      y,
      viewportX: hasValue ? v.getUint16(ptr + c.x, true) : -1,
      viewportY: hasValue ? v.getUint16(ptr + c.y, true) : -1,
      visible: v.getUint8(ptr + c.visible) !== 0,
      blinking: v.getUint8(ptr + c.blinking) !== 0,
      style:
        style === CursorStyle.BAR ? 'bar' : style === CursorStyle.UNDERLINE ? 'underline' : 'block',
    };
  }

  /** Refresh the default colors and palette used to resolve cell colors. */
  private loadColors(force = false): void {
    if (this.colorsFresh && !force) return;
    const ptr = this.scratch;
    const c = this.L.colors;
    this.mem.view().setUint32(ptr, c.size, true);
    this.exports.ghostty_render_state_get(this.renderState, RenderData.COLORS, ptr);
    this.bgDefault = this.readRgb(ptr + c.bg);
    this.fgDefault = this.readRgb(ptr + c.fg);
    const palette = ptr + c.palette;
    this.palette.set(this.mem.bytes().subarray(palette, palette + this.palette.length));
    this.colorsFresh = true;
  }

  /**
   * Get default colors from render state
   */
  getColors(): RenderStateColors {
    if (this.pendingUpdate) this.update();
    // Forced so the cursor color below is read from a fresh copy in scratch.
    this.loadColors(true);
    const ptr = this.scratch;
    const c = this.L.colors;
    const b = this.mem.bytes();
    const hasCursor = b[ptr + c.hasCursor] !== 0;
    return {
      background: { ...this.bgDefault },
      foreground: { ...this.fgDefault },
      cursor: hasCursor ? this.readRgb(ptr + c.cursor) : null,
    };
  }

  /**
   * Check if a specific row is dirty
   */
  isRowDirty(y: number): boolean {
    return this.dirty === DirtyState.FULL || this.rowDirty[y] === 1;
  }

  /**
   * Mark render state as clean (call after rendering)
   */
  markClean(): void {
    this.exports.ghostty_render_state_clean(this.renderState);
    this.dirty = DirtyState.NONE;
    this.rowDirty.fill(0);
  }

  /**
   * Full reset, as RIS (ESC c) does: screen, scrollback, modes and what the
   * program set. The handle, callbacks and configured defaults stay, so
   * objects holding this terminal remain valid.
   */
  reset(): void {
    this.exports.ghostty_terminal_reset(this.handle);
    this.holdStarted = null;
    this.responses = [];
    this.atBottom = true;
    this.colorsFresh = false;
    this.pendingUpdate = true;
    this.dirty = DirtyState.FULL;
    this.rowDirty.fill(1);
    this.rowStale.fill(1);
  }

  /**
   * Get all viewport cells. Returns a reusable cell array (zero allocation
   * after warmup); only rows that changed since they were last read are
   * fetched from WASM.
   */
  getViewport(): GhosttyCell[] {
    if (this.pendingUpdate) this.update();
    if (!this.rowStale.includes(1)) return this.cellPool;
    this.loadColors();

    const ex = this.exports;
    const iter = this.rowIterator();
    const viewPtr = this.scratch;
    const cellsHandle = () => this.mem.view().getUint32(this.rowCellsSlot, true);
    let y = 0;
    while (y < this._rows && ex.ghostty_render_state_row_iterator_next(iter)) {
      if (this.rowStale[y]) {
        if (ex.ghostty_render_state_row_get(iter, RowData.CELLS_RAW, viewPtr) === GHOSTTY_SUCCESS) {
          // Row cells are only fetched (and the iterator only positioned on this
          // row) when a cell needs its style or grapheme cluster.
          let cellsReady = false;
          const rowCells = () => {
            if (!cellsReady) {
              ex.ghostty_render_state_row_get(iter, RowData.CELLS, this.rowCellsSlot);
              cellsReady = true;
            }
            return cellsHandle();
          };
          // The row's selected columns (inclusive), from the terminal's selection.
          const RS = this.L.rowSelection;
          const selPtr = this.scratch + 192;
          this.mem.view().setUint32(selPtr, RS.size, true);
          const selected =
            ex.ghostty_render_state_row_get(iter, RowData.SELECTION, selPtr) === GHOSTTY_SUCCESS
              ? ([
                  this.mem.view().getUint16(selPtr + RS.startX, true),
                  this.mem.view().getUint16(selPtr + RS.endX, true),
                ] as const)
              : null;
          this.readRow(y, viewPtr, rowCells, selected);
        }
        this.rowStale[y] = 0;
      }
      y++;
    }
    return this.cellPool;
  }

  /** Decode one viewport row from its raw cells view into the cell pool. */
  private readRow(
    y: number,
    viewPtr: number,
    rowCells: () => number,
    selected: readonly [number, number] | null
  ): void {
    const ex = this.exports;
    const L = this.L;
    const view = this.mem.view();
    const cellsPtr = view.getUint32(viewPtr + L.cellsView.ptr, true);
    const len = Math.min(view.getUint32(viewPtr + L.cellsView.len, true), this._cols);
    const base = y * this._cols;
    const stylePtr = this.scratch + 64;

    // Copy the raw row out first: style lookups below may grow memory.
    const cellSize = L.cellSize;
    const raw = this.mem.bytes().slice(cellsPtr, cellsPtr + len * cellSize);
    const rawView = new DataView(raw.buffer);

    for (let x = 0; x < this._cols; x++) {
      const cell = this.cellPool[base + x];
      if (x >= len) {
        this.setBlank(cell);
        continue;
      }
      const lo = rawView.getUint32(x * cellSize, true);
      const hi = rawView.getUint32(x * cellSize + 4, true);
      const styleId = readBits(lo, hi, L.cell.styleId);
      const tag = readBits(lo, hi, L.cell.contentTag);

      let graphemeLen = 0;
      let chars: string | undefined;
      let style: DataView | null = null;
      if (styleId !== 0 || tag === CellContent.CODEPOINT_GRAPHEME) {
        const cells = rowCells();
        ex.ghostty_render_state_row_cells_select(cells, x);
        if (styleId !== 0) {
          ex.ghostty_render_state_row_cells_get(cells, RowCellsData.STYLE, stylePtr);
          style = new DataView(this.mem.bytes().slice(stylePtr, stylePtr + L.style.size).buffer);
        }
        if (tag === CellContent.CODEPOINT_GRAPHEME) {
          const codepoints = this.rowCellGrapheme(cells);
          if (codepoints.length > 0) {
            chars = String.fromCodePoint(...codepoints);
            graphemeLen = codepoints.length - 1;
          }
        }
      }
      this.decodeCell(cell, lo, hi, style, graphemeLen);
      cell.chars = chars;
      cell.selected = selected !== null && x >= selected[0] && x <= selected[1];
      if (cell.hyperlink_id) {
        cell.hyperlink_id = this.linkId(this.hyperlinkAt(PointTag.VIEWPORT, x, y));
      }
    }
  }

  /**
   * The codepoints of the selected row cell's grapheme cluster, base codepoint
   * first, read into a GhosttyCodepointBuffer.
   */
  private rowCellGrapheme(cells: number): number[] {
    const ex = this.exports;
    const B = this.L.codepointBuffer;
    const desc = this.scratch + GRAPHEME_BUFFER;
    /** Read into buf (cap codepoints); the codepoints, or a result code on failure. */
    const read = (buf: number, cap: number): number[] | number => {
      const view = this.mem.view();
      view.setUint32(desc + B.ptr, buf, true);
      view.setUint32(desc + B.cap, cap, true);
      view.setUint32(desc + B.len, 0, true);
      const result = ex.ghostty_render_state_row_cells_get(cells, RowCellsData.GRAPHEMES_BUF, desc);
      if (result !== GHOSTTY_SUCCESS) return result;
      const len = this.mem.view().getUint32(desc + B.len, true);
      return Array.from(new Uint32Array(this.mem.bytes().slice(buf, buf + len * 4).buffer));
    };

    const first = read(this.scratch + GRAPHEME_SCRATCH, GRAPHEME_SCRATCH_SIZE / 4);
    if (typeof first !== 'number') return first;
    if (first !== GHOSTTY_OUT_OF_SPACE) return [];
    // Too long for the scratch area: size a buffer to fit.
    if (ex.ghostty_render_state_row_cells_get(cells, RowCellsData.GRAPHEMES_LEN, desc)) return [];
    const needed = this.mem.view().getUint32(desc, true);
    const big = ex.ghostty_wasm_alloc(needed * 4);
    try {
      const second = read(big, needed);
      return typeof second === 'number' ? [] : second;
    } finally {
      ex.ghostty_wasm_free(big, needed * 4);
    }
  }

  private setBlank(cell: GhosttyCell): void {
    cell.codepoint = 0;
    cell.fg_r = this.fgDefault.r;
    cell.fg_g = this.fgDefault.g;
    cell.fg_b = this.fgDefault.b;
    cell.bg_r = this.bgDefault.r;
    cell.bg_g = this.bgDefault.g;
    cell.bg_b = this.bgDefault.b;
    cell.flags = 0;
    cell.width = 1;
    cell.hyperlink_id = 0;
    cell.grapheme_len = 0;
    cell.chars = undefined;
    cell.underline_style = UnderlineStyle.NONE;
    cell.underline_color = undefined;
    cell.overline = false;
    cell.selected = false;
    cell.bg_default = true;
    cell.fg_default = true;
  }

  /**
   * Fill a GhosttyCell from a raw cell (as two 32-bit halves) and its style.
   * Colors are resolved against the current palette and default colors, the
   * same way Ghostty's own renderer does it; inverse is left to the renderer.
   */
  private decodeCell(
    cell: GhosttyCell,
    lo: number,
    hi: number,
    style: DataView | null,
    graphemeLen: number
  ): void {
    const L = this.L;
    const tag = readBits(lo, hi, L.cell.contentTag);
    const hasText = tag === CellContent.CODEPOINT || tag === CellContent.CODEPOINT_GRAPHEME;
    cell.codepoint = hasText ? readBits(lo, hi, L.cell.codepoint) : 0;

    let fg = this.fgDefault;
    let bg = this.bgDefault;
    let bgDefault = true;
    let fgDefault = true;
    let flags = 0;
    let underlineStyle = UnderlineStyle.NONE;
    let underlineColor: number | undefined;
    let overline = false;
    if (style) {
      underlineStyle = readBits(style.getUint16(L.style.flags, true), 0, L.styleFlags.underline);
      overline = readBits(style.getUint16(L.style.flags, true), 0, L.styleFlags.overline) !== 0;
      const ul = this.resolveStyleColor(style, L.style.underline);
      if (ul) underlineColor = (ul.r << 16) | (ul.g << 8) | ul.b;
      const styleFg = this.resolveStyleColor(style, L.style.fg);
      if (styleFg) {
        fg = styleFg;
        fgDefault = false;
      }
      const styleBg = this.resolveStyleColor(style, L.style.bg);
      if (styleBg) {
        bg = styleBg;
        bgDefault = false;
      }
      const f = style.getUint16(L.style.flags, true);
      const sf = L.styleFlags;
      if (readBits(f, 0, sf.bold)) flags |= CellFlags.BOLD;
      if (readBits(f, 0, sf.italic)) flags |= CellFlags.ITALIC;
      if (readBits(f, 0, sf.underline)) flags |= CellFlags.UNDERLINE;
      if (readBits(f, 0, sf.strikethrough)) flags |= CellFlags.STRIKETHROUGH;
      if (readBits(f, 0, sf.inverse)) flags |= CellFlags.INVERSE;
      if (readBits(f, 0, sf.invisible)) flags |= CellFlags.INVISIBLE;
      if (readBits(f, 0, sf.blink)) flags |= CellFlags.BLINK;
      if (readBits(f, 0, sf.faint)) flags |= CellFlags.FAINT;
    }
    if (tag === CellContent.BG_COLOR_PALETTE) {
      bg = this.paletteColor(readBits(lo, hi, L.cell.bgPalette));
      bgDefault = false;
    } else if (tag === CellContent.BG_COLOR_RGB) {
      bg = {
        r: readBits(lo, hi, L.cell.bgR),
        g: readBits(lo, hi, L.cell.bgG),
        b: readBits(lo, hi, L.cell.bgB),
      };
      bgDefault = false;
    }

    cell.fg_r = fg.r;
    cell.fg_g = fg.g;
    cell.fg_b = fg.b;
    cell.bg_r = bg.r;
    cell.bg_g = bg.g;
    cell.bg_b = bg.b;
    cell.bg_default = bgDefault;
    cell.fg_default = fgDefault;
    cell.flags = flags;
    const wide = readBits(lo, hi, L.cell.wide);
    cell.width = wide === CellWide.NARROW ? 1 : wide === CellWide.WIDE ? 2 : 0;
    cell.hyperlink_id = readBits(lo, hi, L.cell.hyperlink) ? 1 : 0;
    cell.grapheme_len = graphemeLen;
    cell.underline_style = underlineStyle;
    cell.underline_color = underlineColor;
    cell.overline = overline;
  }

  private paletteColor(index: number): RGB {
    const C = this.L.rgb;
    const p = this.palette;
    const at = index * C.size;
    return { r: p[at + C.r], g: p[at + C.g], b: p[at + C.b] };
  }

  /** Resolve a GhosttyStyleColor at `offset`; null means "use the default". */
  private resolveStyleColor(style: DataView, offset: number): RGB | null {
    const C = this.L.styleColor;
    const tag = style.getUint8(offset + C.tag);
    if (tag === StyleColorTag.PALETTE) return this.paletteColor(style.getUint8(offset + C.value));
    if (tag === StyleColorTag.RGB) {
      return {
        r: style.getUint8(offset + C.r),
        g: style.getUint8(offset + C.g),
        b: style.getUint8(offset + C.b),
      };
    }
    return null;
  }

  // ==========================================================================
  // Compatibility methods (delegate to render state)
  // ==========================================================================

  /**
   * A row of the active area (the screen without scrollback) as the terminal
   * holds it now, whatever the viewport is scrolled to and even while a
   * render hold (mode 2026) freezes what is displayed. Read from the grid,
   * like getScreenLine(); `selected` is always false. Returns new cells.
   */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    return this.readGridLine(PointTag.ACTIVE, y);
  }

  /**
   * A row of the viewport as it is displayed, which includes scrollback rows
   * when scrolled up (see setViewportOffset) and the held frame during a
   * render hold. Read from the render state. Returns a copy of the cells.
   */
  getViewportLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    const viewport = this.getViewport();
    const start = y * this._cols;
    return viewport.slice(start, start + this._cols).map((cell) => ({ ...cell }));
  }

  /**
   * Scroll libghostty's viewport to `offset` rows above the bottom of the
   * scrollback (0 = pinned to the active area, following new output).
   * The offset is clamped to the scrollback length.
   */
  setViewportOffset(offset: number): void {
    const { total, offset: top, len } = this.scrollbar();
    const maxOffset = Math.max(0, total - len);
    const target = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
    const current = maxOffset - top;
    if (target === current && this.atBottom === (target === 0)) return;

    if (target === 0) this.scrollViewport(ScrollViewport.BOTTOM, 0);
    else this.scrollViewport(ScrollViewport.ROW, maxOffset - target);
    this.atBottom = target === 0;
  }

  /** The terminal's GhosttyTerminalScrollbar: rows in total, top of the viewport, its height. */
  private scrollbar(): { total: number; offset: number; len: number } {
    const S = this.L.scrollbar;
    const ptr = this.scratch + 448;
    this.exports.ghostty_terminal_get(this.handle, TerminalData.SCROLLBAR, ptr);
    const view = this.mem.view();
    return {
      total: Number(view.getBigUint64(ptr + S.total, true)),
      offset: Number(view.getBigUint64(ptr + S.offset, true)),
      len: Number(view.getBigUint64(ptr + S.len, true)),
    };
  }

  /**
   * Scroll libghostty's viewport (GhosttyTerminalScrollViewport). `value` is
   * the delta for DELTA and DELTA_PROMPT and the row for ROW.
   */
  private scrollViewport(tag: number, value: number): void {
    const S = this.L.scrollViewport;
    const ptr = this.scratch + 480;
    this.mem.bytes().fill(0, ptr, ptr + S.size);
    const view = this.mem.view();
    view.setInt32(ptr + S.tag, tag, true);
    if (tag === ScrollViewport.ROW) view.setUint32(ptr + S.row, value, true);
    else view.setInt32(ptr + S.delta, value, true);
    this.exports.ghostty_terminal_scroll_viewport(this.handle, ptr);
    this.pendingUpdate = true;
  }

  private scrollBy(tag: number, amount: number): void {
    this.scrollViewport(tag, amount);
    this.atBottom = this.getViewportOffset() === 0;
  }

  /**
   * Scroll the viewport by `delta` shell prompts (negative = older), using the
   * prompt marks shell integration (OSC 133) leaves. Returns whether it moved.
   */
  scrollToPrompt(delta: number): boolean {
    if (delta === 0) return false;
    const before = this.getViewportOffset();
    this.scrollBy(ScrollViewport.DELTA_PROMPT, delta);
    if (this.getViewportOffset() === before && delta < 0) {
      // libghostty-vt 1.0 doesn't move back one prompt when a prompt is the
      // top row; starting one row higher finds the one before it.
      this.scrollBy(ScrollViewport.DELTA, -1);
      this.scrollBy(ScrollViewport.DELTA_PROMPT, delta);
    }
    const moved = this.getViewportOffset() !== before;
    if (!moved) this.setViewportOffset(before);
    return moved;
  }

  /** Rows the viewport is scrolled above the bottom (0 when pinned). */
  getViewportOffset(): number {
    const { total, offset, len } = this.scrollbar();
    return Math.max(0, total - len - offset);
  }

  /**
   * Check if a full redraw is needed (screen change, resize, etc.)
   * Note: This calls update() to ensure fresh state. Safe to call multiple times.
   */
  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  /** Mark render state as clean after rendering */
  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    this.exports.ghostty_terminal_get(this.handle, TerminalData.ACTIVE_SCREEN, this.scratch);
    return this.mem.view().getInt32(this.scratch, true) === TerminalScreen.ALTERNATE;
  }

  hasBracketedPaste(): boolean {
    // Mode 2004 = bracketed paste (DEC mode)
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    // Mode 1004 = focus events (DEC mode)
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    this.exports.ghostty_terminal_get(this.handle, TerminalData.MOUSE_TRACKING, this.scratch);
    return this.mem.view().getUint8(this.scratch) !== 0;
  }

  /**
   * Query arbitrary terminal mode by number
   * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    const ptr = this.scratch;
    const view = this.mem.view();
    view.setUint16(ptr, packMode(mode, isAnsi), true);
    view.setUint8(ptr + this.L.modeConfig.value, 0);
    const result = this.exports.ghostty_terminal_get(this.handle, TerminalData.MODE, ptr);
    if (result !== GHOSTTY_SUCCESS) return false;
    return this.mem.view().getUint8(ptr + this.L.modeConfig.value) !== 0;
  }

  // ==========================================================================
  // Grid access (scrollback, wrapping, graphemes, hyperlinks)
  // ==========================================================================

  /** Get dimensions - for compatibility */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Get number of scrollback lines (history, not including active screen) */
  getScrollbackLength(): number {
    this.exports.ghostty_terminal_get(this.handle, TerminalData.SCROLLBACK_ROWS, this.scratch);
    return this.mem.view().getUint32(this.scratch, true);
  }

  /** @internal Write the grid reference for a viewport cell to refPtr. */
  viewportRef(col: number, row: number, refPtr: number): boolean {
    return this.gridRef(PointTag.VIEWPORT, col, row, refPtr);
  }

  /**
   * Resolve a grid point to a GhosttyGridRef written at `refPtr`.
   * Returns false if the point is outside the requested area.
   */
  private gridRef(tag: number, x: number, y: number, refPtr: number): boolean {
    const P = this.L.point;
    const pointPtr = this.scratch + 256;
    const view = this.mem.view();
    for (let i = 0; i < P.size; i += 4) view.setUint32(pointPtr + i, 0, true);
    view.setInt32(pointPtr, tag, true);
    view.setUint16(pointPtr + P.value + P.x, x, true);
    view.setUint32(pointPtr + P.value + P.y, y, true);
    return (
      this.exports.ghostty_terminal_grid_ref(this.handle, pointPtr, refPtr) === GHOSTTY_SUCCESS
    );
  }

  /**
   * Get a line from the scrollback buffer.
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (offset < 0 || offset >= this.getScrollbackLength()) return null;
    return this.readGridLine(PointTag.HISTORY, offset);
  }

  /**
   * Read one row of the terminal's grid cell by cell through grid references,
   * independent of the render state's (possibly held) frame.
   */
  private readGridLine(tag: number, row: number): GhosttyCell[] | null {
    // Only the default colors and palette come from the render state.
    if (this.pendingUpdate) this.update();
    this.loadColors();

    const ex = this.exports;
    const refPtr = this.scratch + 320;
    const rawPtr = this.scratch + 336;
    const stylePtr = this.scratch + 352;
    const L = this.L;
    const cells: GhosttyCell[] = [];

    for (let x = 0; x < this._cols; x++) {
      const cell = {} as GhosttyCell;
      if (
        !this.gridRef(tag, x, row, refPtr) ||
        ex.ghostty_grid_ref_cell(refPtr, rawPtr) !== GHOSTTY_SUCCESS
      ) {
        if (x === 0) return null;
        this.setBlank(cell);
        cells.push(cell);
        continue;
      }
      const view = this.mem.view();
      const lo = view.getUint32(rawPtr, true);
      const hi = view.getUint32(rawPtr + 4, true);

      let style: DataView | null = null;
      if (readBits(lo, hi, L.cell.styleId) !== 0) {
        if (ex.ghostty_grid_ref_style(refPtr, stylePtr) === GHOSTTY_SUCCESS) {
          style = new DataView(this.mem.bytes().slice(stylePtr, stylePtr + L.style.size).buffer);
        }
      }
      let codepoints: number[] | null = null;
      if (readBits(lo, hi, L.cell.contentTag) === CellContent.CODEPOINT_GRAPHEME) {
        codepoints = this.graphemeAt(tag, x, row);
      }
      const graphemeLen = codepoints ? Math.max(0, codepoints.length - 1) : 0;
      this.decodeCell(cell, lo, hi, style, graphemeLen);
      cell.selected = false;
      if (graphemeLen > 0) cell.chars = String.fromCodePoint(...codepoints!);
      if (cell.hyperlink_id) cell.hyperlink_id = this.linkId(this.hyperlinkAt(tag, x, row));
      cells.push(cell);
    }
    return cells;
  }

  /** Hyperlink IDs by URI, so cells of the same link share one ID. */
  private linkIds = new Map<string, number>();
  private nextLinkId = 1;

  /**
   * The ID for a hyperlink URI (0 for none). IDs are never reused. The map
   * is bounded: when it fills up it starts over, and the viewport is re-read
   * so its cells don't keep IDs a URI no longer has.
   */
  private linkId(uri: string | null): number {
    if (!uri) return 0;
    let id = this.linkIds.get(uri);
    if (id === undefined) {
      if (this.linkIds.size >= MAX_LINK_IDS) {
        this.linkIds.clear();
        this.rowStale.fill(1);
        this.rowDirty.fill(1);
        this.dirty = DirtyState.FULL;
      }
      id = this.nextLinkId++;
      this.linkIds.set(uri, id);
    }
    return id;
  }

  /**
   * A line of the screen by absolute row: 0 is the oldest scrollback row,
   * rows after the scrollback are the active area. Cells carry their full
   * grapheme cluster (`chars`) and a hyperlink ID that is the same for every
   * cell of one link.
   */
  getScreenLine(row: number): GhosttyCell[] | null {
    if (row < 0) return null;
    return this.readGridLine(PointTag.SCREEN, row);
  }

  /** Whether a screen row (absolute, as in getScreenLine) continues the previous one. */
  isScreenRowWrapped(row: number): boolean {
    return this.rowWraps(PointTag.SCREEN, row);
  }

  /** The hyperlink URI at a screen cell (absolute row), or null. */
  getScreenHyperlinkUri(row: number, col: number): string | null {
    return this.hyperlinkAt(PointTag.SCREEN, col, row);
  }

  private rowWraps(tag: number, row: number): boolean {
    const refPtr = this.scratch + 320;
    const rowPtr = this.scratch + 336;
    const outPtr = this.scratch + 352;
    if (!this.gridRef(tag, 0, row, refPtr)) return false;
    if (this.exports.ghostty_grid_ref_row(refPtr, rowPtr) !== GHOSTTY_SUCCESS) return false;
    const rowValue = this.mem.view().getBigUint64(rowPtr, true);
    if (
      this.exports.ghostty_row_get(rowValue, GridRowData.WRAP_CONTINUATION, outPtr) !==
      GHOSTTY_SUCCESS
    ) {
      return false;
    }
    return this.mem.view().getUint8(outPtr) !== 0;
  }

  /** Read a grid reference's hyperlink URI, or null if the cell has none. */
  private hyperlinkAt(tag: number, x: number, y: number): string | null {
    const ex = this.exports;
    const refPtr = this.scratch + 320;
    const lenPtr = this.scratch + 336;
    if (!this.gridRef(tag, x, y, refPtr)) return null;
    const sizeResult = ex.ghostty_grid_ref_hyperlink_uri(refPtr, 0, 0, lenPtr);
    if (sizeResult !== GHOSTTY_OUT_OF_SPACE) return null;
    const len = this.mem.view().getUint32(lenPtr, true);
    if (len === 0) return null;
    const buf = ex.ghostty_wasm_alloc(len);
    try {
      if (ex.ghostty_grid_ref_hyperlink_uri(refPtr, buf, len, lenPtr) !== GHOSTTY_SUCCESS) {
        return null;
      }
      const written = this.mem.view().getUint32(lenPtr, true);
      return new TextDecoder().decode(this.mem.bytes().slice(buf, buf + written));
    } finally {
      ex.ghostty_wasm_free(buf, len);
    }
  }

  /**
   * Read pending responses from the terminal.
   * Returns the response string, or null if no responses pending.
   *
   * Responses are generated by escape sequences that require replies:
   * - DSR 6 (cursor position): Returns \x1b[row;colR
   * - DSR 5 (operating status): Returns \x1b[0n
   */
  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    const total = this.responses.reduce((n, r) => n + r.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const r of this.responses) {
      all.set(r, at);
      at += r.length;
    }
    this.responses = [];
    return new TextDecoder().decode(all);
  }

  // ==========================================================================
  // Selection (the terminal owns it and keeps it in step with the content)
  // ==========================================================================

  /** Whether the terminal has an active selection. */
  hasSelection(): boolean {
    return (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, this.selScratch) ===
      GHOSTTY_SUCCESS
    );
  }

  /** The active selection in absolute screen rows, start before end. */
  getSelectionRange(): SelectionRange | null {
    const sel = this.selScratch;
    if (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    return this.selectionRangeAt(sel);
  }

  /** @internal A GhosttySelection snapshot at `sel` as an absolute range. */
  selectionRangeAt(sel: number): SelectionRange | null {
    const ex = this.exports;
    const S = this.L.selection;
    const ordered = this.selScratch + 32;
    if (
      ex.ghostty_terminal_selection_ordered(this.handle, sel, SelectionOrder.FORWARD, ordered) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const start = this.screenPoint(ordered + S.start);
    const end = this.screenPoint(ordered + S.end);
    if (!start || !end) return null;
    return {
      startCol: start.x,
      startRow: start.y,
      endCol: end.x,
      endRow: end.y,
      rectangle: this.mem.view().getUint8(ordered + S.rectangle) !== 0,
    };
  }

  private screenPoint(refPtr: number): { x: number; y: number } | null {
    const out = this.selScratch + 64;
    if (
      this.exports.ghostty_terminal_point_from_grid_ref(
        this.handle,
        refPtr,
        PointTag.SCREEN,
        out
      ) !== GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const view = this.mem.view();
    return {
      x: view.getUint16(out + this.L.coordinate.x, true),
      y: view.getUint32(out + this.L.coordinate.y, true),
    };
  }

  /**
   * Select from (startCol, startRow) to (endCol, endRow), both included, in
   * absolute screen rows. Returns false if either end is outside the screen.
   */
  setSelectionRange(
    startCol: number,
    startRow: number,
    endCol: number,
    endRow: number,
    rectangle = false
  ): boolean {
    const S = this.L.selection;
    const sel = this.selScratch + 128;
    for (let i = 0; i < S.size; i++) this.mem.view().setUint8(sel + i, 0);
    if (
      !this.gridRef(PointTag.SCREEN, startCol, startRow, sel + S.start) ||
      !this.gridRef(PointTag.SCREEN, endCol, endRow, sel + S.end)
    ) {
      return false;
    }
    this.mem.view().setUint8(sel + S.rectangle, rectangle ? 1 : 0);
    return this.installSelection(sel);
  }

  /**
   * @internal Note that the terminal changed outside write() and friends, so
   * the next read refreshes the render state.
   */
  invalidate(): void {
    this.pendingUpdate = true;
  }

  /** @internal Make the selection snapshot at ptr the terminal's selection. */
  installSelection(ptr: number): boolean {
    const ok =
      this.exports.ghostty_terminal_set(this.handle, TerminalOpt.SELECTION, ptr) ===
      GHOSTTY_SUCCESS;
    this.pendingUpdate = true;
    return ok;
  }

  /**
   * Move the selection's moving end the way keyboard selection does in
   * Ghostty (Shift+arrows and friends). Returns false without a selection.
   */
  adjustSelection(how: SelectionAdjust): boolean {
    const ex = this.exports;
    const sel = this.selScratch + 128;
    if (ex.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !== GHOSTTY_SUCCESS)
      return false;
    if (
      ex.ghostty_terminal_selection_adjust(this.handle, sel, SELECTION_ADJUST[how]) !==
      GHOSTTY_SUCCESS
    ) {
      return false;
    }
    return this.installSelection(sel);
  }

  clearSelection(): void {
    this.exports.ghostty_terminal_set(this.handle, TerminalOpt.SELECTION, 0);
    this.pendingUpdate = true;
  }

  /** Select all selectable content, scrollback included. */
  selectAll(): boolean {
    const sel = this.selScratch + 128;
    if (this.exports.ghostty_terminal_select_all(this.handle, sel) !== GHOSTTY_SUCCESS)
      return false;
    return this.installSelection(sel);
  }

  /**
   * The selected text as Ghostty copies it: plain text, soft-wrapped lines
   * joined and trailing spaces trimmed.
   */
  getSelectionText(): string {
    const sel = this.selScratch;
    if (
      this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return '';
    }
    return this.format({ format: 'plain', unwrap: true, trim: true, selectionPtr: sel });
  }

  /**
   * Format the active screen (scrollback included) with libghostty's
   * formatter: plain text, VT sequences that recreate it when written to
   * another terminal, or HTML. `fromRow` limits the output to absolute
   * screen rows from there to the end.
   */
  formatScreen(options: {
    format: 'plain' | 'vt' | 'html';
    /** VT only: terminal state to restore (FormatterExtras bits). */
    extras?: number;
    unwrap?: boolean;
    trim?: boolean;
    fromRow?: number;
    /** Only the terminal's current selection ('' when there is none). */
    onlySelection?: boolean;
  }): string {
    let selectionPtr: number | undefined;
    if (options.onlySelection) {
      const sel = this.selScratch;
      if (
        this.exports.ghostty_terminal_get(this.handle, TerminalData.SELECTION, sel) !==
        GHOSTTY_SUCCESS
      ) {
        return '';
      }
      return this.format({ ...options, selectionPtr: sel });
    }
    if (options.fromRow !== undefined && options.fromRow > 0) {
      // A selection from fromRow to the last cell narrows the output.
      const S = this.L.selection;
      const sel = this.selScratch + 128;
      for (let i = 0; i < S.size; i++) this.mem.view().setUint8(sel + i, 0);
      const lastRow = this.getScrollbackLength() + this._rows - 1;
      if (
        this.gridRef(PointTag.SCREEN, 0, options.fromRow, sel + S.start) &&
        this.gridRef(PointTag.SCREEN, this._cols - 1, lastRow, sel + S.end)
      ) {
        selectionPtr = sel;
      }
    }
    return this.format({ ...options, selectionPtr });
  }

  private format(options: {
    format: 'plain' | 'vt' | 'html';
    extras?: number;
    unwrap?: boolean;
    trim?: boolean;
    selectionPtr?: number;
  }): string {
    const ex = this.exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    const created = ex.ghostty_formatter_terminal_new(0, slot, this.handle);
    const formatter = ex.ghostty_wasm_take_opaque(slot);
    ex.ghostty_wasm_free_opaque(slot);
    if (created !== GHOSTTY_SUCCESS) return '';

    const opt = this.selScratch + 192;
    try {
      const emit =
        options.format === 'vt'
          ? FormatterFormat.VT
          : options.format === 'html'
            ? FormatterFormat.HTML
            : FormatterFormat.PLAIN;
      this.mem.view().setUint32(opt, emit, true);
      ex.ghostty_formatter_set(formatter, FormatterOpt.EMIT, opt);
      this.mem.view().setUint8(opt, options.unwrap ? 1 : 0);
      ex.ghostty_formatter_set(formatter, FormatterOpt.UNWRAP, opt);
      this.mem.view().setUint8(opt, options.trim ? 1 : 0);
      ex.ghostty_formatter_set(formatter, FormatterOpt.TRIM, opt);
      if (options.extras !== undefined) {
        this.mem.view().setUint32(opt, options.extras, true);
        ex.ghostty_formatter_set(formatter, FormatterOpt.EXTRAS, opt);
      }
      if (options.selectionPtr !== undefined) {
        ex.ghostty_formatter_set(formatter, FormatterOpt.SELECTION, options.selectionPtr);
      }

      const outPtr = opt + 16;
      const outLen = opt + 20;
      if (ex.ghostty_formatter_format_alloc(formatter, 0, outPtr, outLen) !== GHOSTTY_SUCCESS) {
        return '';
      }
      const v = this.mem.view();
      const ptr = v.getUint32(outPtr, true);
      const len = v.getUint32(outLen, true);
      const text = new TextDecoder().decode(this.mem.bytes().slice(ptr, ptr + len));
      ex.ghostty_free(0, ptr, len);
      return text;
    } finally {
      ex.ghostty_formatter_free(formatter);
    }
  }

  /** Create a search over this terminal's scrollback and screen. */
  createSearch(): TerminalSearch {
    return new TerminalSearch(this.exports, this.mem, this.L, this);
  }

  /** Create a selection gesture: Ghostty's click, double-click and drag rules. */
  createSelectionGesture(): SelectionGesture {
    return new SelectionGesture(this.exports, this.mem, this.L, this);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private initCellPool(): void {
    const total = this._cols * this._rows;
    if (this.cellPool.length < total) {
      for (let i = this.cellPool.length; i < total; i++) {
        this.cellPool.push({
          codepoint: 0,
          fg_r: 204,
          fg_g: 204,
          fg_b: 204,
          bg_r: 0,
          bg_g: 0,
          bg_b: 0,
          flags: 0,
          width: 1,
          hyperlink_id: 0,
          grapheme_len: 0,
        });
      }
    }
  }

  /** Read the grapheme codepoints at a grid point. */
  private graphemeAt(tag: number, x: number, y: number): number[] | null {
    const ex = this.exports;
    const refPtr = this.scratch + 320;
    const countPtr = this.scratch + 336;
    if (!this.gridRef(tag, x, y, refPtr)) return null;
    const cap = GRAPHEME_SCRATCH_SIZE / 4;
    const buf = this.scratch + GRAPHEME_SCRATCH;
    let result = ex.ghostty_grid_ref_graphemes(refPtr, buf, cap, countPtr);
    if (result === GHOSTTY_SUCCESS) {
      const count = this.mem.view().getUint32(countPtr, true);
      return Array.from(new Uint32Array(this.mem.bytes().slice(buf, buf + count * 4).buffer));
    }
    if (result !== GHOSTTY_OUT_OF_SPACE) return null;
    const needed = this.mem.view().getUint32(countPtr, true);
    const big = ex.ghostty_wasm_alloc(needed * 4);
    try {
      result = ex.ghostty_grid_ref_graphemes(refPtr, big, needed, countPtr);
      if (result !== GHOSTTY_SUCCESS) return null;
      const count = this.mem.view().getUint32(countPtr, true);
      return Array.from(new Uint32Array(this.mem.bytes().slice(big, big + count * 4).buffer));
    } finally {
      ex.ghostty_wasm_free(big, needed * 4);
    }
  }
}

// ============================================================================
// Selection gestures
// ============================================================================

/**
 * Turns pointer events into selections using libghostty's selection gesture
 * state machine: click counts (cell, word, line), word-granular dragging and
 * autoscroll at the edges. Every selection it produces is installed as the
 * terminal's selection. Pointer positions are viewport cells plus CSS pixels.
 */
const DOUBLE_CLICK_INTERVAL_MS = 500;
const DOUBLE_CLICK_DISTANCE_PX = 10;

export class SelectionGesture {
  private gesture = 0;
  private events: Record<number, number> = {};
  private scratch = 0;

  constructor(
    private exports: GhosttyWasmExports,
    private mem: Memory,
    private L: Layout,
    private term: GhosttyTerminal
  ) {
    const ex = this.exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      if (ex.ghostty_selection_gesture_new(0, slot) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create selection gesture');
      }
      this.gesture = ex.ghostty_wasm_take_opaque(slot);
      for (const type of [
        GestureEventType.PRESS,
        GestureEventType.RELEASE,
        GestureEventType.DRAG,
        GestureEventType.AUTOSCROLL_TICK,
      ]) {
        if (ex.ghostty_selection_gesture_event_new(0, slot, type) !== GHOSTTY_SUCCESS) {
          throw new Error('libghostty-vt: failed to create selection gesture event');
        }
        this.events[type] = ex.ghostty_wasm_take_opaque(slot);
      }
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    this.scratch = ex.ghostty_wasm_alloc(256);
    this.setRepeat(DOUBLE_CLICK_INTERVAL_MS, DOUBLE_CLICK_DISTANCE_PX);
  }

  /**
   * How close in time (ms) and space (CSS px) presses must be to count as a
   * double or triple click. libghostty has no defaults for these; browsers
   * don't expose the OS settings, so ghostterm picks common values.
   */
  setRepeat(intervalMs: number, distancePx: number): void {
    const ex = this.exports;
    const press = this.events[GestureEventType.PRESS];
    const p = this.scratch + 112;
    this.mem.view().setBigUint64(p, BigInt(Math.round(intervalMs * 1e6)), true);
    ex.ghostty_selection_gesture_event_set(press, GestureEventOpt.REPEAT_INTERVAL_NS, p);
    this.mem.view().setFloat64(p + 8, distancePx, true);
    ex.ghostty_selection_gesture_event_set(press, GestureEventOpt.REPEAT_DISTANCE, p + 8);
  }

  /** The terminal this gesture was created for. */
  get terminal(): GhosttyTerminal {
    return this.term;
  }

  private setRef(event: number, col: number, row: number): void {
    const ref = this.scratch;
    if (this.term.viewportRef(col, row, ref)) {
      this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.REF, ref);
    } else {
      this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.REF, 0);
    }
  }

  private setPosition(event: number, x: number, y: number): void {
    const p = this.scratch + 16;
    const view = this.mem.view();
    view.setFloat64(p + this.L.surface.x, x, true);
    view.setFloat64(p + this.L.surface.y, y, true);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.POSITION, p);
  }

  private setRectangle(event: number, rectangle: boolean): void {
    const p = this.scratch + 104;
    this.mem.view().setUint8(p, rectangle ? 1 : 0);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.RECTANGLE, p);
  }

  private setGeometry(event: number, g: SelectionGeometry): void {
    const p = this.scratch + 32;
    const G = this.L.geometry;
    const view = this.mem.view();
    view.setUint32(p + G.columns, Math.max(1, g.columns), true);
    view.setUint32(p + G.cellWidth, Math.max(1, Math.round(g.cellWidth)), true);
    view.setUint32(p + G.paddingLeft, 0, true);
    view.setUint32(p + G.screenHeight, Math.max(1, Math.round(g.screenHeight)), true);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.GEOMETRY, p);
  }

  /** Apply an event; install its selection, or clear when it yields none. */
  private apply(event: number, clearOnNone: boolean): boolean {
    const out = this.scratch + 64;
    const result = this.exports.ghostty_selection_gesture_event(
      this.gesture,
      this.term.handle,
      event,
      out
    );
    // Autoscroll ticks scroll the viewport even when no selection results.
    this.term.invalidate();
    if (result === GHOSTTY_SUCCESS) {
      this.term.installSelection(out);
      return true;
    }
    if (clearOnNone) this.term.clearSelection();
    return false;
  }

  /**
   * Pointer pressed on a viewport cell. `timeMs` is a monotonic time (such as
   * performance.now()) that lets repeated presses count as double and triple
   * clicks. Returns true when the press itself selected something.
   */
  press(col: number, row: number, x: number, y: number, timeMs: number): boolean {
    const event = this.events[GestureEventType.PRESS];
    this.setRef(event, col, row);
    this.setPosition(event, x, y);
    const t = this.scratch + 48;
    this.mem.view().setBigUint64(t, BigInt(Math.max(0, Math.round(timeMs * 1e6))), true);
    this.exports.ghostty_selection_gesture_event_set(event, GestureEventOpt.TIME_NS, t);
    return this.apply(event, true);
  }

  /**
   * Pointer dragged to a viewport cell; x and y may lie outside the surface.
   * With `rectangle` the drag selects a block of columns (Alt-drag).
   */
  drag(
    col: number,
    row: number,
    x: number,
    y: number,
    geometry: SelectionGeometry,
    rectangle = false
  ): boolean {
    const event = this.events[GestureEventType.DRAG];
    this.setRef(event, col, row);
    this.setPosition(event, x, y);
    this.setGeometry(event, geometry);
    this.setRectangle(event, rectangle);
    return this.apply(event, true);
  }

  /** Pointer released. */
  release(): void {
    this.apply(this.events[GestureEventType.RELEASE], false);
  }

  /**
   * Continue an edge drag: scrolls libghostty's viewport one row and extends
   * the selection. Returns false once the gesture has cancelled itself.
   */
  autoscrollTick(
    col: number,
    row: number,
    x: number,
    y: number,
    geometry: SelectionGeometry,
    rectangle = false
  ): boolean {
    const ex = this.exports;
    const event = this.events[GestureEventType.AUTOSCROLL_TICK];
    this.setRectangle(event, rectangle);
    const coord = this.scratch + 80;
    const view = this.mem.view();
    this.mem.bytes().fill(0, coord, coord + this.L.coordinate.size);
    view.setUint16(coord + this.L.coordinate.x, col, true);
    view.setUint32(coord + this.L.coordinate.y, row, true);
    ex.ghostty_selection_gesture_event_set(event, GestureEventOpt.VIEWPORT, coord);
    this.setPosition(event, x, y);
    this.setGeometry(event, geometry);
    return this.apply(event, false);
  }

  /** The autoscroll the current drag asks for. */
  autoscroll(): SelectionAutoscroll {
    const out = this.scratch + 96;
    this.mem.view().setUint32(out, 0, true);
    this.exports.ghostty_selection_gesture_get(
      this.gesture,
      this.term.handle,
      GestureData.AUTOSCROLL,
      out
    );
    return this.mem.view().getUint32(out, true) as SelectionAutoscroll;
  }

  /** Cancel the current click sequence. */
  reset(): void {
    this.exports.ghostty_selection_gesture_reset(this.gesture, this.term.handle);
  }

  /** Free the gesture. Pass terminalAlive=false if its terminal was already freed. */
  dispose(terminalAlive = true): void {
    const ex = this.exports;
    if (!this.gesture) return;
    for (const event of Object.values(this.events)) ex.ghostty_selection_gesture_event_free(event);
    this.events = {};
    ex.ghostty_selection_gesture_free(this.gesture, terminalAlive ? this.term.handle : 0);
    this.gesture = 0;
    ex.ghostty_wasm_free(this.scratch, 256);
  }
}

// ============================================================================
// Search
// ============================================================================

/** @internal GhosttySearchOption. */
export const SearchOpt = { NEEDLE: 1 } as const;
/** @internal GhosttySearchData. */
export const SearchData = {
  STATUS: 1,
  TOTAL_MATCHES: 3,
  SELECTED_INDEX: 4,
  SELECTED_MATCH: 5,
  VIEWPORT_MATCHES: 7,
} as const;

/**
 * A search for literal text over a terminal's scrollback and screen, using
 * libghostty's search. Matching is byte-exact except that ASCII letters
 * compare case-insensitively. Results stay valid as the terminal changes
 * (new output, pruning, resize). "Next" moves toward older content.
 */
export class TerminalSearch {
  private search = 0;
  private scratch = 0;
  private needle = '';

  constructor(
    private exports: GhosttyWasmExports,
    private mem: Memory,
    private L: Layout,
    private term: GhosttyTerminal
  ) {
    const ex = exports;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      if (ex.ghostty_search_new(0, slot, term.handle) !== GHOSTTY_SUCCESS) {
        throw new Error('libghostty-vt: failed to create search');
      }
      this.search = ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
    this.scratch = ex.ghostty_wasm_alloc(64);
  }

  /** Set what to search for; '' clears the search. Same text keeps results. */
  setNeedle(text: string): void {
    const ex = this.exports;
    this.needle = text;
    if (!text) {
      ex.ghostty_search_set(this.search, SearchOpt.NEEDLE, 0);
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const ptr = ex.ghostty_wasm_alloc(bytes.length);
    this.mem.bytes().set(bytes, ptr);
    const str = this.scratch;
    const view = this.mem.view();
    view.setUint32(str, ptr, true);
    view.setUint32(str + 4, bytes.length, true);
    ex.ghostty_search_set(this.search, SearchOpt.NEEDLE, str);
    ex.ghostty_wasm_free(ptr, bytes.length);
  }

  getNeedle(): string {
    return this.needle;
  }

  /** Bring the search up to date with the terminal (blocking). */
  run(): void {
    if (this.needle) this.exports.ghostty_search_run(this.search);
  }

  /** Select the next (older) match. Returns false when there is none. */
  next(): boolean {
    if (!this.needle) return false;
    // Selecting a match can scroll the viewport.
    this.term.invalidate();
    return this.exports.ghostty_search_select_next(this.search) === GHOSTTY_SUCCESS;
  }

  /** Select the previous (newer) match. Returns false when there is none. */
  previous(): boolean {
    if (!this.needle) return false;
    this.term.invalidate();
    return this.exports.ghostty_search_select_prev(this.search) === GHOSTTY_SUCCESS;
  }

  private getU32(data: number): number | null {
    const out = this.scratch;
    if (this.exports.ghostty_search_get(this.search, data, out) !== GHOSTTY_SUCCESS) return null;
    return this.mem.view().getUint32(out, true);
  }

  /** Matches found so far on the active screen. */
  get totalMatches(): number {
    return this.getU32(SearchData.TOTAL_MATCHES) ?? 0;
  }

  /** Index of the selected match, 0 being the newest; -1 when none. */
  get selectedIndex(): number {
    return this.getU32(SearchData.SELECTED_INDEX) ?? -1;
  }

  /** The selected match in absolute screen rows, or null. */
  selectedMatch(): SelectionRange | null {
    const sel = this.scratch + 32;
    if (
      this.exports.ghostty_search_get(this.search, SearchData.SELECTED_MATCH, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }
    return this.term.selectionRangeAt(sel);
  }

  /** Make the selected match the terminal's selection. */
  selectMatchAsSelection(): boolean {
    const sel = this.scratch + 32;
    if (
      this.exports.ghostty_search_get(this.search, SearchData.SELECTED_MATCH, sel) !==
      GHOSTTY_SUCCESS
    ) {
      return false;
    }
    return this.term.installSelection(sel);
  }

  /**
   * Matches on and around the viewport, in absolute screen rows, for drawing
   * highlights. Reflects the terminal as of the last feed, so this feeds first.
   */
  viewportMatches(): SelectionRange[] {
    const ex = this.exports;
    if (!this.needle) return [];
    ex.ghostty_search_feed(this.search);
    // A first call with no buffer reports how many matches there are.
    const B = this.L.selectionBuffer;
    const selectionSize = this.L.selection.size;
    const buf = this.scratch + 16;
    this.mem.bytes().fill(0, buf, buf + B.size);
    ex.ghostty_search_get(this.search, SearchData.VIEWPORT_MATCHES, buf);
    const count = this.mem.view().getUint32(buf + B.len, true);
    if (count === 0) return [];
    const bytes = count * selectionSize;
    const arr = ex.ghostty_wasm_alloc(bytes);
    try {
      const v = this.mem.view();
      v.setUint32(buf + B.ptr, arr, true);
      v.setUint32(buf + B.cap, count, true);
      if (
        ex.ghostty_search_get(this.search, SearchData.VIEWPORT_MATCHES, buf) !== GHOSTTY_SUCCESS
      ) {
        return [];
      }
      const written = this.mem.view().getUint32(buf + B.len, true);
      const out: SelectionRange[] = [];
      for (let i = 0; i < Math.min(written, count); i++) {
        const range = this.term.selectionRangeAt(arr + i * selectionSize);
        if (range) out.push(range);
      }
      return out;
    } finally {
      ex.ghostty_wasm_free(arr, bytes);
    }
  }

  dispose(): void {
    if (this.search) this.exports.ghostty_search_free(this.search);
    if (this.scratch) this.exports.ghostty_wasm_free(this.scratch, 64);
    this.search = this.scratch = 0;
  }
}
