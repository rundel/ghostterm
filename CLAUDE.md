# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other coding agents working in this repository.

## What this is

ghostty-web is a browser terminal with an xterm.js-compatible API. The terminal emulation comes from
[libghostty-vt](https://lib.ghostty.org/), Ghostty's terminal library, through the official prebuilt WebAssembly
module that Ghostty publishes with each release. ghostty-web supplies what the library doesn't: drawing to a
canvas, DOM event plumbing, layout, the xterm.js API and addons.

The guiding rule: terminal behavior belongs to libghostty. Before writing terminal logic in TypeScript (parsing
sequences, encoding keys or mouse events, word boundaries, text extraction, color resolution, row arithmetic),
check whether the C API already does it. Most of the hand-written versions of these were removed for that reason.

## Commands

Bun runs the tests and scripts; curl fetches the WASM module.

```sh
bun install
./scripts/fetch-wasm.sh          # download the pinned ghostty-vt.wasm and verify its SHA-256
bun test                         # all tests (happy-dom, no real browser)
bun test lib/ghostty.test.ts     # one file
bun test -t "pattern"            # matching tests
bun run typecheck
bun run lint                     # Biome; `bun run lint:fix` to fix
bun run fmt                      # Prettier check; `bun run fmt:fix` to fix
bun run build                    # fetch WASM + vite build into dist/
bun run demo:dev                 # Vite + PTY server: http://127.0.0.1:8000/demo/ (needs `npm install` in demo/)
```

Before committing: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

`ghostty-vt.wasm` is gitignored. Tests load it from the repo root, so run `fetch-wasm.sh` once after cloning.
`bun install` may rewrite `bun.lock`; don't commit that unless dependencies changed.

## Architecture

```
Terminal (lib/terminal.ts)            xterm.js API, events, scrolling, options, render loop
├─ GhosttyTerminal (lib/ghostty.ts)   the only code that touches the WASM module
├─ CanvasRenderer (lib/renderer.ts)   draws the render state; cursor, scrollbar, highlights
├─ InputHandler (lib/input-handler.ts)    DOM keyboard/mouse/paste/focus → libghostty encoders
├─ SelectionManager (lib/selection-manager.ts)  DOM mouse → libghostty selection gesture
├─ BufferNamespace (lib/buffer.ts)    xterm.js IBuffer over absolute screen rows
├─ LinkDetector + providers           OSC 8 (libghostty hyperlinks) and regex URLs
└─ addons: FitAddon, SearchAddon, SerializeAddon (lib/addons/)
```

### The bridge: `lib/ghostty.ts`, `lib/abi.ts`, `lib/types.ts`

- `Ghostty` loads the module (it has no imports), owns the per-module state and creates terminals and encoders.
- `GhosttyTerminal` wraps one `GhosttyTerminal` handle plus its render state, row iterator and row cells. Its
  public methods are what the rest of the code uses; nothing else calls `exports.ghostty_*`.
- `KeyEncoder`, `MouseEncoder`, `SelectionGesture`, `TerminalSearch` wrap the matching libghostty objects.
- `lib/types.ts` declares the exports used (`GhosttyWasmExports`) and the public TS enums (`Key`, `Mods`,
  `KeyEncoderOption`, `CellFlags`, ...). `lib/abi-enums.test.ts` checks those enums against the loaded module, so
  a library upgrade that renumbers them fails a test instead of silently mis-encoding keys.

Conventions in the bridge:

- Enum values are part of libghostty's ABI promise and are written as constants. Bit positions inside packed
  values (`GhosttyCell`, `GhosttyStyleFlags`) are not covered by the promise and are read from the module's
  manifest (`ghostty_type_json()`) by `AbiLayout` in `lib/abi.ts`. Struct offsets also come from the manifest.
- Structs passed by value in C are passed by pointer from JS (wasm32 C ABI); check an export's arity
  (`exports.fn.length`) when in doubt.
- Any export can grow memory, which detaches old `ArrayBuffer` views. Always get views through
  `this.mem.view()` / `this.mem.bytes()` right before use, after any call into the module.
- Out-parameters go through two per-terminal scratch areas (`scratch`, 2 KB, and `selScratch`, 256 B) at fixed
  offsets. When adding a method, pick offsets that don't overlap anything that can be live at the same time.
- Opaque handles are created through `ghostty_wasm_alloc_opaque` + `ghostty_wasm_take_opaque`.
- JS callbacks (write_pty, bell, clipboard, ...) need a function-table entry. `wasmCallback()` builds a tiny
  module that re-exports a JS function as a WASM function; `Ghostty.installEffects()` registers one entry per
  callback type and routes calls by the terminal handle (always the first argument). Callbacks run synchronously
  inside `vt_write` and friends.

### Coordinates

Three row systems are in use; mixing them up is the most common bug.

| System       | Row 0 is                        | Used by                                                         |
| ------------ | ------------------------------- | --------------------------------------------------------------- |
| Viewport row | top of what is displayed        | renderer, `getViewportLine`, mouse hit-testing                  |
| Active row   | top of the screen below history | `getLine`, `getCursor().x/y`, `isRowWrapped`, `getHyperlinkUri` |
| Absolute row | oldest scrollback line          | `getScreenLine`, buffer API, selection ranges, search, links    |

`Terminal.viewportY` is the scroll offset in rows above the bottom (fractional during smooth scrolling; always
floored for mapping). libghostty owns the real viewport: the renderer calls `setViewportOffset(floor(viewportY))`
each frame, and code that lets libghostty scroll (search, selection autoscroll, prompt jumps) copies the result
back with `scrollToLine(wasmTerm.getViewportOffset())`. When scrolled up, new output keeps the same content on
screen (`followScrolledContent` in `writeInternal`); user input scrolls to the bottom.

### Rendering

`GhosttyTerminal.update()` refreshes the render state and accumulates dirty flags (an update only ever adds dirty
state; `markClean()` clears it). `getViewport()` re-reads only stale rows, one `CELLS_RAW` call per row, and only
fetches styles and graphemes for cells that have them. Each `GhosttyCell` carries resolved colors, flags, width,
underline style and color, overline, `selected` (from the render state's selection), `bg_default`, a hyperlink ID
shared by every cell of one URI, and, for screen lines, the full grapheme in `chars`.

Synchronized output (mode 2026) arrives as a render hold: `onRenderHold` captures the frame when the hold starts
and `update()` is a no-op until it ends or times out (1 s).

The renderer draws rows, then the cursor (shape, blink and color from the render state, which programs can
change), then the scrollbar in a gutter right of the grid. `FitAddon` sizes that gutter to absorb leftover width
so the canvas fills its container. Search highlights come from a provider callback (`setHighlightProvider`); the
active match is drawn over the selection.

### Input

- Keys: every mapped key goes through the key encoder after `syncFromTerminal()`, which copies the program's
  keyboard modes (Kitty flags, modifyOtherKeys, cursor/keypad modes). Option-as-Alt is re-applied after each sync.
  Releases (keyup) are sent only when the program asked for them. Dead keys and IME use composition events.
- Mouse: `MouseEncoder` synced from the terminal, with geometry and button state. Shift bypasses reporting so
  Shift+drag selects. Wheel steps are one per notch (large pixel deltas, about 100 px each) or one per cell of
  accumulated trackpad movement.
- Paste: `GhosttyTerminal.encodePaste()` via `ghostty_terminal_paste` (bracketed paste, unsafe-byte stripping,
  Kitty paste events). Unsafe pastes are allowed, matching xterm.js.
- Focus: reported only when the program enabled mode 1004.

`Terminal.wasmTerm` is replaced by `reset()`. Anything holding on to it (gestures, searches, encoders) must look
it up again or detect the change, as `SelectionManager` and `SearchAddon` do.

## Tests

Tests run under happy-dom with a mock 2D canvas (`happydom.ts`); there is no real drawing. To test rendering,
replace `ctx.fillRect`/`fillText`/`stroke` on `(term as any).renderer.ctx` and inspect the calls. Use
`createIsolatedTerminal()` from `lib/test-helpers.ts`, `open()` it in a container, and `dispose()` it.
Bridge-level behavior is tested directly against `Ghostty.load()` in `lib/ghostty.test.ts`.

happy-dom quirks: `WheelEvent` ignores `clientX`/`clientY`; set `offsetX`/`offsetY` on synthetic mouse events
with `Object.defineProperty`; synthetic events need `cancelable: true` for `defaultPrevented` to mean anything.

Visual behavior (canvas output, real keyboard and mouse, clipboard) can only be checked in a browser with
`bun run demo:dev`.

## Upgrading libghostty-vt

1. Update `VERSION` and `SHA256` in `scripts/fetch-wasm.sh` (hashes are in the release's `SHA256SUMS` at
   `https://release.files.ghostty.org/libghostty-vt/<version>/`) and run it.
2. Run the tests. `lib/abi-enums.test.ts` catches renumbered enums; `AbiLayout` throws on missing manifest fields.
3. Read the release notes for changed behavior in what the bridge relies on.

Known libghostty-vt 1.0 quirks the code works around or documents:

- Default `SCROLLBACK_MAX_BYTES` is 10,000 bytes; the bridge sets it to unlimited so the line limit governs.
- Scrollback is pruned a page at a time, so the retained line count can drop below the configured limit.
- `DELTA_PROMPT` scrolling by -1 doesn't move when a prompt is the top row; `scrollToPrompt` retries one row up.
- The gesture API has no default double-click interval or distance; `SelectionGesture` sets 500 ms and 10 px.
- `ghostty_terminal_compress` is unsupported on wasm32.
- The snapshot byte format is explicitly unstable; `SerializeAddon` uses the formatter's VT output instead.

## Conventions

- Keep the public API xterm.js-compatible where xterm.js has an equivalent; new events and methods are additive.
- Document deliberate differences from xterm.js (they follow Ghostty) in the README's "Behavior worth knowing".
- Tests accompany behavior changes; prefer asserting what a program would receive (bytes sent) or what is drawn.
