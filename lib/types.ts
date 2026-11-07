/**
 * TypeScript type definitions for libghostty-vt WASM API
 * Based on include/ghostty/vt/*.h from Ghostty repository
 */

// ============================================================================
// Key Encoder Types
// ============================================================================

/**
 * Key encoder options
 */
export enum KeyEncoderOption {
  CURSOR_KEY_APPLICATION = 1, // DEC mode 1
  KEYPAD_KEY_APPLICATION = 2, // DEC mode 66
  IGNORE_KEYPAD_WITH_NUMLOCK = 3, // DEC mode 1035
  ALT_ESC_PREFIX = 4, // DEC mode 1036
  MODIFY_OTHER_KEYS_STATE_2 = 5, // xterm modifyOtherKeys
  KITTY_KEYBOARD_FLAGS = 6, // Kitty protocol flags
  MACOS_OPTION_AS_ALT = 7, // GhosttyOptionAsAlt
  BACKARROW_KEY_MODE = 8, // DEC mode 67
}

/**
 * Key action
 */
export enum KeyAction {
  RELEASE = 0,
  PRESS = 1,
  REPEAT = 2,
}

/**
 * Physical key codes matching Ghostty's internal Key enum.
 * These values are used by Ghostty's key encoder to produce correct escape sequences.
 * Reference: ghostty/src/input/key.zig
 */
export enum Key {
  // Unidentified key
  UNIDENTIFIED = 0,

  // Writing System Keys
  GRAVE = 1, // ` and ~
  BACKSLASH = 2, // \ and |
  BRACKET_LEFT = 3, // [ and {
  BRACKET_RIGHT = 4, // ] and }
  COMMA = 5, // , and <
  ZERO = 6,
  ONE = 7,
  TWO = 8,
  THREE = 9,
  FOUR = 10,
  FIVE = 11,
  SIX = 12,
  SEVEN = 13,
  EIGHT = 14,
  NINE = 15,
  EQUAL = 16, // = and +
  INTL_BACKSLASH = 17,
  INTL_RO = 18,
  INTL_YEN = 19,
  A = 20,
  B = 21,
  C = 22,
  D = 23,
  E = 24,
  F = 25,
  G = 26,
  H = 27,
  I = 28,
  J = 29,
  K = 30,
  L = 31,
  M = 32,
  N = 33,
  O = 34,
  P = 35,
  Q = 36,
  R = 37,
  S = 38,
  T = 39,
  U = 40,
  V = 41,
  W = 42,
  X = 43,
  Y = 44,
  Z = 45,
  MINUS = 46, // - and _
  PERIOD = 47, // . and >
  QUOTE = 48, // ' and "
  SEMICOLON = 49, // ; and :
  SLASH = 50, // / and ?

  // Functional Keys
  ALT_LEFT = 51,
  ALT_RIGHT = 52,
  BACKSPACE = 53,
  CAPS_LOCK = 54,
  CONTEXT_MENU = 55,
  CONTROL_LEFT = 56,
  CONTROL_RIGHT = 57,
  ENTER = 58,
  META_LEFT = 59,
  META_RIGHT = 60,
  SHIFT_LEFT = 61,
  SHIFT_RIGHT = 62,
  SPACE = 63,
  TAB = 64,
  CONVERT = 65,
  KANA_MODE = 66,
  NON_CONVERT = 67,

  // Control Pad Section
  DELETE = 68,
  END = 69,
  HELP = 70,
  HOME = 71,
  INSERT = 72,
  PAGE_DOWN = 73,
  PAGE_UP = 74,

  // Arrow Pad Section
  DOWN = 75,
  LEFT = 76,
  RIGHT = 77,
  UP = 78,

  // Numpad Section
  NUM_LOCK = 79,
  KP_0 = 80,
  KP_1 = 81,
  KP_2 = 82,
  KP_3 = 83,
  KP_4 = 84,
  KP_5 = 85,
  KP_6 = 86,
  KP_7 = 87,
  KP_8 = 88,
  KP_9 = 89,
  KP_PLUS = 90, // Keypad +
  KP_BACKSPACE = 91,
  KP_CLEAR = 92,
  KP_CLEAR_ENTRY = 93,
  KP_COMMA = 94,
  KP_PERIOD = 95, // Keypad .
  KP_DIVIDE = 96, // Keypad /
  KP_ENTER = 97, // Keypad Enter
  KP_EQUAL = 98,
  KP_MEMORY_ADD = 99,
  KP_MEMORY_CLEAR = 100,
  KP_MEMORY_RECALL = 101,
  KP_MEMORY_STORE = 102,
  KP_MEMORY_SUBTRACT = 103,
  KP_MULTIPLY = 104, // Keypad *
  KP_PAREN_LEFT = 105,
  KP_PAREN_RIGHT = 106,
  KP_MINUS = 107, // Keypad -
  KP_SEPARATOR = 108,
  NUMPAD_UP = 109,
  NUMPAD_DOWN = 110,
  NUMPAD_RIGHT = 111,
  NUMPAD_LEFT = 112,
  NUMPAD_BEGIN = 113,
  NUMPAD_HOME = 114,
  NUMPAD_END = 115,
  NUMPAD_INSERT = 116,
  NUMPAD_DELETE = 117,
  NUMPAD_PAGE_UP = 118,
  NUMPAD_PAGE_DOWN = 119,

  // Function Keys
  ESCAPE = 120,
  F1 = 121,
  F2 = 122,
  F3 = 123,
  F4 = 124,
  F5 = 125,
  F6 = 126,
  F7 = 127,
  F8 = 128,
  F9 = 129,
  F10 = 130,
  F11 = 131,
  F12 = 132,
  F13 = 133,
  F14 = 134,
  F15 = 135,
  F16 = 136,
  F17 = 137,
  F18 = 138,
  F19 = 139,
  F20 = 140,
  F21 = 141,
  F22 = 142,
  F23 = 143,
  F24 = 144,
  F25 = 145,
  FN = 146,
  FN_LOCK = 147,
  PRINT_SCREEN = 148,
  SCROLL_LOCK = 149,
  PAUSE = 150,

  // Media Keys
  BROWSER_BACK = 151,
  BROWSER_FAVORITES = 152,
  BROWSER_FORWARD = 153,
  BROWSER_HOME = 154,
  BROWSER_REFRESH = 155,
  BROWSER_SEARCH = 156,
  BROWSER_STOP = 157,
  EJECT = 158,
  LAUNCH_APP_1 = 159,
  LAUNCH_APP_2 = 160,
  LAUNCH_MAIL = 161,
  MEDIA_PLAY_PAUSE = 162,
  MEDIA_SELECT = 163,
  MEDIA_STOP = 164,
  MEDIA_TRACK_NEXT = 165,
  MEDIA_TRACK_PREVIOUS = 166,
  POWER = 167,
  SLEEP = 168,
  AUDIO_VOLUME_DOWN = 169,
  AUDIO_VOLUME_MUTE = 170,
  AUDIO_VOLUME_UP = 171,
  WAKE_UP = 172,

  // Clipboard Keys
  COPY = 173,
  CUT = 174,
  PASTE = 175,
}

/**
 * Modifier keys
 */
export enum Mods {
  NONE = 0,
  SHIFT = 1 << 0,
  CTRL = 1 << 1,
  ALT = 1 << 2,
  SUPER = 1 << 3, // Windows/Command key
  CAPSLOCK = 1 << 4,
  NUMLOCK = 1 << 5,
}

/**
 * Key event structure
 */
export interface KeyEvent {
  action: KeyAction;
  key: Key;
  mods: Mods;
  consumedMods?: Mods;
  composing?: boolean;
  utf8?: string;
  unshiftedCodepoint?: number;
}

// ============================================================================
// WASM Exports Interface
// ============================================================================

/**
 * Interface for libghostty-vt WASM exports
 */
export interface GhosttyWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;

  // Type manifest (NUL-terminated JSON describing the C ABI)
  ghostty_type_json(): number;

  // Build info (build_info.h)
  ghostty_build_info(data: number, outPtr: number): number;

  // Memory helpers (wasm.h)
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(slot: number): void;
  ghostty_wasm_take_opaque(slot: number): number;

  // Key encoder
  ghostty_key_encoder_new(allocator: number, slot: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_set(encoder: number, option: number, valuePtr: number): number;
  ghostty_key_encoder_set_from_terminal(encoder: number, terminal: TerminalHandle): number;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    bufPtr: number,
    bufLen: number,
    writtenPtr: number
  ): number;

  // Key event
  ghostty_key_event_new(allocator: number, slot: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): number;
  ghostty_key_event_set_key(event: number, key: number): number;
  ghostty_key_event_set_mods(event: number, mods: number): number;
  ghostty_key_event_set_consumed_mods(event: number, mods: number): number;
  ghostty_key_event_set_composing(event: number, composing: boolean): number;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): number;
  /** Takes a pointer to a GhosttyString { ptr, len }; the event borrows the bytes. */
  ghostty_key_event_set_utf8(event: number, stringPtr: number): number;

  // Mouse encoder and events
  ghostty_mouse_encoder_new(allocator: number, slot: number): number;
  ghostty_mouse_encoder_free(encoder: number): void;
  ghostty_mouse_encoder_set(encoder: number, option: number, value: number): number;
  ghostty_mouse_encoder_set_from_terminal(encoder: number, terminal: TerminalHandle): number;
  ghostty_mouse_encoder_reset(encoder: number): number;
  ghostty_mouse_encoder_encode(
    encoder: number,
    event: number,
    bufPtr: number,
    bufLen: number,
    writtenPtr: number
  ): number;
  ghostty_mouse_event_new(allocator: number, slot: number): number;
  ghostty_mouse_event_free(event: number): void;
  ghostty_mouse_event_set_action(event: number, action: number): number;
  ghostty_mouse_event_set_button(event: number, button: number): number;
  ghostty_mouse_event_clear_button(event: number): number;
  ghostty_mouse_event_set_mods(event: number, mods: number): number;
  /** Takes a pointer to a GhosttyMousePosition { f32 x, f32 y }. */
  ghostty_mouse_event_set_position(event: number, positionPtr: number): number;

  // Focus and paste
  ghostty_focus_encode(event: number, bufPtr: number, bufLen: number, writtenPtr: number): number;
  /** Takes a pointer to a GhosttyPaste; the output goes to the write_pty callback. */
  ghostty_terminal_paste(terminal: TerminalHandle, pastePtr: number, outPasted: number): number;

  // Terminal
  ghostty_terminal_new(allocator: number, slot: number, cols: number, rows: number): number;
  ghostty_terminal_free(terminal: TerminalHandle): void;
  ghostty_terminal_reset(terminal: TerminalHandle): void;
  ghostty_terminal_resize(
    terminal: TerminalHandle,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ): number;
  ghostty_terminal_set(terminal: TerminalHandle, option: number, value: number): number;
  ghostty_terminal_get(terminal: TerminalHandle, data: number, out: number): number;
  ghostty_terminal_vt_write(terminal: TerminalHandle, dataPtr: number, len: number): void;
  ghostty_terminal_grid_ref(terminal: TerminalHandle, pointPtr: number, outRef: number): number;
  ghostty_terminal_grid_ref_track(
    terminal: TerminalHandle,
    pointPtr: number,
    outRef: number
  ): number;
  ghostty_tracked_grid_ref_free(ref: number): void;
  ghostty_tracked_grid_ref_has_value(ref: number): number;
  ghostty_tracked_grid_ref_point(ref: number, tag: number, outCoord: number): number;
  /** Takes a pointer to a GhosttyTerminalScrollViewport. */
  ghostty_terminal_scroll_viewport(terminal: TerminalHandle, behaviorPtr: number): number;

  ghostty_free(allocator: number, ptr: number, len: number): void;

  // Selection
  ghostty_terminal_point_from_grid_ref(
    terminal: TerminalHandle,
    refPtr: number,
    tag: number,
    outCoord: number
  ): number;
  ghostty_terminal_selection_ordered(
    terminal: TerminalHandle,
    selectionPtr: number,
    desired: number,
    outSelection: number
  ): number;
  ghostty_terminal_select_all(terminal: TerminalHandle, outSelection: number): number;
  ghostty_terminal_selection_adjust(
    terminal: TerminalHandle,
    selectionPtr: number,
    adjustment: number
  ): number;
  ghostty_selection_gesture_new(allocator: number, slot: number): number;
  ghostty_selection_gesture_free(gesture: number, terminal: TerminalHandle): void;
  ghostty_selection_gesture_reset(gesture: number, terminal: TerminalHandle): void;
  ghostty_selection_gesture_get(
    gesture: number,
    terminal: TerminalHandle,
    data: number,
    out: number
  ): number;
  ghostty_selection_gesture_event_new(allocator: number, slot: number, type: number): number;
  ghostty_selection_gesture_event_free(event: number): void;
  ghostty_selection_gesture_event_set(event: number, option: number, value: number): number;
  ghostty_selection_gesture_event(
    gesture: number,
    terminal: TerminalHandle,
    event: number,
    outSelection: number
  ): number;

  // Search
  ghostty_search_new(allocator: number, slot: number, terminal: TerminalHandle): number;
  ghostty_search_free(search: number): void;
  ghostty_search_feed(search: number): number;
  ghostty_search_run(search: number): number;
  ghostty_search_select_next(search: number): number;
  ghostty_search_select_prev(search: number): number;
  ghostty_search_set(search: number, option: number, value: number): number;
  ghostty_search_get(search: number, data: number, out: number): number;

  // Formatter
  ghostty_formatter_terminal_new(allocator: number, slot: number, terminal: TerminalHandle): number;
  ghostty_formatter_set(formatter: number, option: number, value: number): number;
  ghostty_formatter_format_alloc(
    formatter: number,
    allocator: number,
    outPtr: number,
    outLen: number
  ): number;
  ghostty_formatter_free(formatter: number): void;

  // Grid references, cells and rows
  ghostty_grid_ref_cell(refPtr: number, outCell: number): number;
  ghostty_grid_ref_row(refPtr: number, outRow: number): number;
  ghostty_grid_ref_style(refPtr: number, outStyle: number): number;
  ghostty_grid_ref_graphemes(
    refPtr: number,
    bufPtr: number,
    bufLen: number,
    writtenPtr: number
  ): number;
  ghostty_grid_ref_hyperlink_uri(
    refPtr: number,
    bufPtr: number,
    bufLen: number,
    writtenPtr: number
  ): number;
  ghostty_row_get(row: bigint, data: number, out: number): number;

  // Render state
  ghostty_render_state_new(allocator: number, slot: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: TerminalHandle): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_get(state: number, data: number, out: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_iterator_next(iterator: number): boolean;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): boolean;
  ghostty_render_state_row_get(iterator: number, data: number, out: number): number;
  ghostty_render_state_row_cells_new(allocator: number, slot: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number;
}

// ============================================================================
// Terminal Types
// ============================================================================

/**
 * Dirty state from RenderState
 */
export enum DirtyState {
  NONE = 0,
  PARTIAL = 1,
  FULL = 2,
}

/**
 * Cursor state from RenderState
 */
export interface RenderStateCursor {
  x: number;
  y: number;
  viewportX: number; // -1 if not in viewport
  viewportY: number;
  visible: boolean;
  blinking: boolean;
  style: 'block' | 'underline' | 'bar';
}

/**
 * Default colors from RenderState
 */
export interface RenderStateColors {
  background: RGB;
  foreground: RGB;
  cursor: RGB | null;
}

/**
 * Terminal configuration applied with ghostty_terminal_set() after creation.
 * scrollbackLimit counts lines; 0 keeps no scrollback.
 */
export interface GhosttyTerminalConfig {
  scrollbackLimit?: number;
  /** Reported for an XTGETTCAP query of "TN" (default 'xterm-ghostty'; '' reports nothing). */
  terminfoName?: string;
}

/**
 * Opaque terminal pointer (WASM memory address)
 */
export type TerminalHandle = number;

/**
 * A decoded cell: libghostty's packed GhosttyCell (8 bytes) together with
 * its style, with colors resolved against the palette and default colors.
 * Not a C struct; the bridge builds it.
 */
export interface GhosttyCell {
  codepoint: number; // Unicode codepoint (the first codepoint of a grapheme cluster)
  fg_r: number; // foreground red, 0-255
  fg_g: number; // foreground green
  fg_b: number; // foreground blue
  bg_r: number; // background red
  bg_g: number; // background green
  bg_b: number; // background blue
  flags: number; // CellFlags
  width: number; // 1 = normal, 2 = wide, 0 = spacer after a wide character
  hyperlink_id: number; // 0 = no link; otherwise the same ID for every cell of one link URI
  grapheme_len: number; // number of codepoints beyond the first
  /** Underline style (UnderlineStyle); NONE when not underlined. */
  underline_style?: UnderlineStyle;
  /** Underline color as 0xRRGGBB, or undefined to use the text color. */
  underline_color?: number;
  /** Overline (SGR 53). */
  overline?: boolean;
  /** True when the cell has no background color of its own (the theme's shows). */
  bg_default?: boolean;
  /** True when the cell has no foreground color of its own (the default applies). */
  fg_default?: boolean;
  /** Inside the terminal's selection (viewport rows only). */
  selected?: boolean;
  /** The full grapheme cluster, for cells with grapheme_len > 0; undefined otherwise. */
  chars?: string;
}

/** Underline styles (SGR 4:x), as libghostty reports them. */
export enum UnderlineStyle {
  NONE = 0,
  SINGLE = 1,
  DOUBLE = 2,
  CURLY = 3,
  DOTTED = 4,
  DASHED = 5,
}

/**
 * RGB color
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Cell style flags (bitfield)
 */
export enum CellFlags {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  UNDERLINE = 1 << 2,
  STRIKETHROUGH = 1 << 3,
  INVERSE = 1 << 4,
  INVISIBLE = 1 << 5,
  BLINK = 1 << 6,
  FAINT = 1 << 7,
}

/**
 * Cursor position and visibility
 */
export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}
