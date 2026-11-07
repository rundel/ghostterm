/**
 * Checks that ghostterm's TypeScript enums match the C ABI of the loaded
 * libghostty-vt module, using the module's own type manifest.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import {
  BUILD_INFO_OPTIMIZE,
  CLIPBOARD_LOCATIONS,
  CellContent,
  CellWide,
  ClipboardWriteResult,
  ColorScheme,
  CursorStyle,
  EffectOpt,
  FocusEvent,
  FormatterFormat,
  FormatterOpt,
  GestureData,
  GestureEventOpt,
  GestureEventType,
  GridRowData,
  MOUSE_SHAPES,
  MouseAction,
  MouseButton,
  MouseEncoderOpt,
  OPTIMIZE_MODES,
  PROGRAM_STATUS_KINDS,
  PROGRAM_STATUS_STATES,
  PROGRESS_STATES,
  PROMPT_KINDS,
  PasteSource,
  PointTag,
  RenderData,
  Result,
  RowCellsData,
  RowData,
  SELECTION_ADJUST,
  SEMANTIC_PROMPT_KINDS,
  ScrollViewport,
  SearchData,
  SearchOpt,
  SelectionAutoscroll,
  SelectionOrder,
  StyleColorTag,
  TerminalData,
  TerminalOpt,
  TerminalScreen,
} from './ghostty';
import { DirtyState, Key, KeyAction, KeyEncoderOption, UnderlineStyle } from './types';

type Enum = Record<string, string | number>;

let types: Record<string, { values: Record<string, number> }>;

beforeAll(async () => {
  const bytes = fs.readFileSync(new URL('../ghostty-vt.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as { memory: WebAssembly.Memory; ghostty_type_json(): number };
  const mem = new Uint8Array(exports.memory.buffer);
  const ptr = exports.ghostty_type_json();
  let end = ptr;
  while (mem[end] !== 0) end++;
  types = JSON.parse(new TextDecoder().decode(mem.subarray(ptr, end))).types;
});

/** Names ghostterm uses that differ from libghostty-vt's. */
const KEY_ALIASES: Record<string, string> = {
  GRAVE: 'BACKQUOTE',
  ZERO: 'DIGIT_0',
  ONE: 'DIGIT_1',
  TWO: 'DIGIT_2',
  THREE: 'DIGIT_3',
  FOUR: 'DIGIT_4',
  FIVE: 'DIGIT_5',
  SIX: 'DIGIT_6',
  SEVEN: 'DIGIT_7',
  EIGHT: 'DIGIT_8',
  NINE: 'DIGIT_9',
  UP: 'ARROW_UP',
  DOWN: 'ARROW_DOWN',
  LEFT: 'ARROW_LEFT',
  RIGHT: 'ARROW_RIGHT',
  KP_PLUS: 'NUMPAD_ADD',
  KP_MINUS: 'NUMPAD_SUBTRACT',
  KP_PERIOD: 'NUMPAD_DECIMAL',
};

function keyName(name: string): string {
  return KEY_ALIASES[name] ?? name.replace(/^KP_/, 'NUMPAD_');
}

/** [ghostterm name, value, libghostty-vt value] for each mismatch. */
function mismatches(tsEnum: Enum, cType: string, rename: (n: string) => string) {
  const official = types[cType].values;
  return Object.entries(tsEnum)
    .filter(([, v]) => typeof v === 'number')
    .map(([name, v]) => [name, v, official[rename(name)]])
    .filter(([, v, o]) => v !== o);
}

describe('enums match the libghostty-vt ABI', () => {
  test('Key', () => {
    expect(mismatches(Key as unknown as Enum, 'GhosttyKey', keyName)).toEqual([]);
  });

  test('every libghostty-vt key has a ghostterm name', () => {
    const mine = new Set(Object.keys(Key).map(keyName));
    const missing = Object.keys(types.GhosttyKey.values).filter(
      (k) => k !== 'MAX_VALUE' && !mine.has(k)
    );
    expect(missing).toEqual([]);
  });

  test('KeyEncoderOption', () => {
    const rename = (n: string) => (n === 'KITTY_KEYBOARD_FLAGS' ? 'KITTY_FLAGS' : n);
    expect(
      mismatches(KeyEncoderOption as unknown as Enum, 'GhosttyKeyEncoderOption', rename)
    ).toEqual([]);
  });

  test('KeyAction', () => {
    expect(mismatches(KeyAction as unknown as Enum, 'GhosttyKeyAction', (n) => n)).toEqual([]);
  });
});

const same = (n: string) => n;
/** 'page-up' -> 'PAGE_UP' */
const constantCase = (n: string) => n.toUpperCase().replace(/-/g, '_');

describe('internal tables match the libghostty-vt ABI', () => {
  const tables: [string, Enum, string, (n: string) => string][] = [
    ['Result', Result, 'GhosttyResult', same],
    ['TerminalOpt', TerminalOpt, 'GhosttyTerminalOption', same],
    ['EffectOpt', EffectOpt, 'GhosttyTerminalOption', same],
    ['TerminalData', TerminalData, 'GhosttyTerminalData', same],
    ['TerminalScreen', TerminalScreen, 'GhosttyTerminalScreen', same],
    ['RenderData', RenderData, 'GhosttyRenderStateData', same],
    ['RowData', RowData, 'GhosttyRenderStateRowData', same],
    ['RowCellsData', RowCellsData, 'GhosttyRenderStateRowCellsData', same],
    ['GridRowData', GridRowData, 'GhosttyRowData', same],
    ['PointTag', PointTag, 'GhosttyPointTag', same],
    ['SelectionOrder', SelectionOrder, 'GhosttySelectionOrder', same],
    ['FormatterOpt', FormatterOpt, 'GhosttyFormatterOption', same],
    ['FormatterFormat', FormatterFormat, 'GhosttyFormatterFormat', same],
    ['GestureEventType', GestureEventType, 'GhosttySelectionGestureEventType', same],
    ['GestureEventOpt', GestureEventOpt, 'GhosttySelectionGestureEventOption', same],
    ['GestureData', GestureData, 'GhosttySelectionGestureData', same],
    ['ScrollViewport', ScrollViewport, 'GhosttyTerminalScrollViewportTag', same],
    ['SearchOpt', SearchOpt, 'GhosttySearchOption', same],
    ['SearchData', SearchData, 'GhosttySearchData', same],
    ['CellContent', CellContent, 'GhosttyCellContentTag', same],
    ['CellWide', CellWide, 'GhosttyCellWide', same],
    ['StyleColorTag', StyleColorTag, 'GhosttyStyleColorTag', same],
    ['CursorStyle', CursorStyle, 'GhosttyCursorStyle', same],
    ['MouseEncoderOpt', MouseEncoderOpt, 'GhosttyMouseEncoderOption', same],
    ['ClipboardWriteResult', ClipboardWriteResult, 'GhosttyClipboardWriteResult', same],
    ['PasteSource', PasteSource, 'GhosttyPasteSource', same],
    ['FocusEvent', FocusEvent, 'GhosttyFocusEvent', same],
    ['ColorScheme', ColorScheme, 'GhosttyColorScheme', same],
    ['MouseAction', MouseAction as unknown as Enum, 'GhosttyMouseAction', same],
    [
      'SelectionAutoscroll',
      SelectionAutoscroll as unknown as Enum,
      'GhosttySelectionGestureAutoscroll',
      same,
    ],
    ['UnderlineStyle', UnderlineStyle as unknown as Enum, 'GhosttySgrUnderline', same],
    [
      'DirtyState',
      DirtyState as unknown as Enum,
      'GhosttyRenderStateDirty',
      (n) => (n === 'NONE' ? 'FALSE' : n),
    ],
    [
      'MouseButton',
      MouseButton as unknown as Enum,
      'GhosttyMouseButton',
      (n) =>
        ({ WHEEL_UP: 'FOUR', WHEEL_DOWN: 'FIVE', WHEEL_LEFT: 'SIX', WHEEL_RIGHT: 'SEVEN' })[n] ?? n,
    ],
    [
      'SELECTION_ADJUST',
      SELECTION_ADJUST,
      'GhosttySelectionAdjust',
      (n) =>
        ({ 'line-start': 'BEGINNING_OF_LINE', 'line-end': 'END_OF_LINE' })[n] ?? constantCase(n),
    ],
  ];

  for (const [name, table, cType, rename] of tables) {
    test(name, () => {
      expect(mismatches(table, cType, rename)).toEqual([]);
    });
  }

  test('OPTIMIZE_MODES and BUILD_INFO_OPTIMIZE', () => {
    const byName = Object.fromEntries(
      Object.entries(OPTIMIZE_MODES).map(([value, mode]) => [constantCase(mode), Number(value)])
    );
    expect(mismatches(byName, 'GhosttyOptimizeMode', same)).toEqual([]);
    expect(types.GhosttyBuildInfo.values.OPTIMIZE).toBe(BUILD_INFO_OPTIMIZE);
  });

  /** Tables indexed by the C value: each entry's index must be its name's value. */
  const orderedTables: [string, readonly (string | null)[], string, Record<string, string>][] = [
    ['MOUSE_SHAPES', MOUSE_SHAPES, 'GhosttyMouseShape', {}],
    ['CLIPBOARD_LOCATIONS', CLIPBOARD_LOCATIONS, 'GhosttyClipboardLocation', {}],
    ['PROGRESS_STATES', PROGRESS_STATES, 'GhosttyTerminalProgressState', {}],
    ['PROGRAM_STATUS_STATES', PROGRAM_STATUS_STATES, 'GhosttyProgramStatusState', {}],
    ['PROGRAM_STATUS_KINDS', PROGRAM_STATUS_KINDS, 'GhosttyProgramStatusKind', {}],
    ['SEMANTIC_PROMPT_KINDS', SEMANTIC_PROMPT_KINDS, 'GhosttySemanticPromptKind', {}],
    ['PROMPT_KINDS', PROMPT_KINDS, 'GhosttySemanticPromptPromptKind', {}],
  ];

  for (const [name, list, cType, aliases] of orderedTables) {
    test(`${name} covers ${cType} in order`, () => {
      const official = Object.entries(types[cType].values)
        .filter(([, v]) => v >= 0 && v < 0x7fffffff)
        .sort(([, a], [, b]) => a - b)
        .map(([n]) => n);
      const mine = list.map((n) => (n === null ? 'INVALID' : (aliases[n] ?? constantCase(n))));
      expect(mine).toEqual(official);
    });
  }
});
