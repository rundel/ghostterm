/**
 * Public API for ghostterm
 *
 * Main entry point following xterm.js conventions
 */

export { init } from './init';
export type { InitOptions } from './init';

// Main Terminal class
export { Terminal } from './terminal';

// xterm.js-compatible interfaces
export type {
  ITerminalOptions,
  ITheme,
  ITerminalAddon,
  ITerminalCore,
  IDisposable,
  IEvent,
  IBufferRange,
  IBufferCellPosition,
  ILink,
  ILinkProvider,
  IKeyEvent,
  IMarker,
  IUnicodeVersionProvider,
  IBufferNamespace,
  IBuffer,
  IBufferLine,
  IBufferCell,
} from './interfaces';

// Ghostty WASM components (for advanced usage)
export {
  Ghostty,
  GhosttyTerminal,
  KeyEncoder,
  CellFlags,
  DirtyState,
  KeyEncoderOption,
  FormatterExtras,
  MouseAction,
  MouseButton,
  SelectionAutoscroll,
} from './ghostty';
export type {
  FormatScreenOptions,
  MouseEncoder,
  MouseGeometry,
  SelectionAdjust,
  SelectionGeometry,
  SelectionGesture,
  SelectionRange,
  TerminalColors,
  TerminalSearch,
  ClipboardLocation,
  ClipboardWriteRequest,
  GhosttyOptimizeMode,
  ProgramStatus,
  ProgressReport,
  SemanticPromptEvent,
  TerminalEffects,
  TerminalNotification,
} from './ghostty';
export { Key, KeyAction, Mods, UnderlineStyle } from './types';
export type { KeyEvent, GhosttyCell, RGB, Cursor, TerminalHandle } from './types';
export type { TrackedRow } from './ghostty';

// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export type { RendererOptions, FontMetrics, IRenderable, HighlightRange } from './renderer';
export { InputHandler } from './input-handler';
export { EventEmitter } from './event-emitter';
export { SelectionManager } from './selection-manager';

// Addons
export { FitAddon } from './addons/fit';
export { SearchAddon } from './addons/search';
export { SerializeAddon } from './addons/serialize';
export type { ISerializeOptions, ISerializeRange, IHTMLSerializeOptions } from './addons/serialize';
export type {
  ISearchOptions,
  ISearchDecorationOptions,
  ISearchResultChangeEvent,
} from './addons/search';
export type { ITerminalDimensions } from './addons/fit';

// Link providers
export { OSC8LinkProvider } from './providers/osc8-link-provider';
export { UrlRegexProvider } from './providers/url-regex-provider';
export { LinkDetector } from './link-detector';
