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
  IDecoration,
  IDecorationOptions,
  IDecorationOverviewRulerOptions,
  IFunctionIdentifier,
  IModes,
  IParser,
  IUnicodeHandling,
  IUnicodeVersionProvider,
  IBufferNamespace,
  IBuffer,
  IBufferLine,
  IBufferCell,
} from './interfaces';

// The libghostty-vt module, for loading one yourself (new Terminal({ ghostty }))
export { Ghostty } from './ghostty';
export type {
  ClipboardLocation,
  GhosttyOptimizeMode,
  ProgramStatus,
  ProgressReport,
  SemanticPromptEvent,
  TerminalNotification,
} from './ghostty';

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
