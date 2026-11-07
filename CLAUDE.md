# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other coding agents working in this repository.

## What this is

ghostterm is a browser terminal with an xterm.js-compatible API, for personal and experimental use (not published to npm; releases are on GitHub). It began as a fork of Coder's ghostty-web and has been largely rewritten. The terminal emulation comes from [libghostty-vt](https://lib.ghostty.org/), Ghostty's terminal library, through the official prebuilt WebAssembly module that Ghostty publishes with each release. ghostterm supplies what the library doesn't: drawing to a canvas, DOM event plumbing, layout, the xterm.js API and addons.

The guiding rule: terminal behavior belongs to libghostty. Before writing terminal logic in TypeScript (parsing sequences, encoding keys or mouse events, word boundaries, text extraction, color resolution, row arithmetic), check whether the C API already does it. Most of the hand-written versions of these were removed for that reason.

## Commands

Bun runs the tests and scripts; curl fetches the WASM module.

```sh
bun install
./scripts/fetch-wasm.sh          # download the pinned WASM builds and verify their SHA-256
bun test                         # all tests (happy-dom, no real browser)
bun test lib/ghostty.test.ts     # one file
bun test -t "pattern"            # matching tests
bun run test:e2e                 # browser tests (Playwright); `bun run test:e2e:install` once
bun run test:e2e -g "pattern"    # matching browser tests
bun run test:e2e --project chromium  # one browser (chromium, firefox, webkit)
bun run typecheck
bun run lint                     # Biome; `bun run lint:fix` to fix
bun run fmt                      # Prettier check; `bun run fmt:fix` to fix
bun run build                    # fetch WASM, Vite 8 build into dist/ (both entry points, both .wasm, index.d.ts), then scripts/check-dist.ts
bun run demo                     # Vite + PTY server: http://127.0.0.1:8000/demo/
bun run bench                    # throughput against xterm.js
bun run release <version>        # see "Releases" below
```

Before committing: `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.

`ghostty-vt.wasm` (ReleaseSmall, the default) and `ghostty-vt-fast.wasm` (ReleaseFast, opt-in through `init({ wasmPath })`) are gitignored. They have the same features and exports. Tests load them from the repo root, so run `fetch-wasm.sh` once after cloning. Both are shipped in `dist/`. The build has two entry points from the same modules: `dist/ghostterm.js` (`vite build`) inlines `ghostty-vt.wasm` through the `new URL(..., import.meta.url)` in `lib/wasm-default.ts`, and `dist/ghostterm-slim.js` (`vite build --mode slim`, package export `ghostterm/slim`) swaps that module for `lib/wasm-default-slim.ts`, which loads the `ghostty-vt.wasm` next to the bundle by URL (see `vite.config.js`). Nothing else may differ between them. `scripts/check-dist.ts` checks that only the default bundle inlines the module and that the slim one loads the file next to it. Don't reference a wasm file with a literal `new URL(..., import.meta.url)` anywhere else in `lib/`: Vite would inline it too. The bundles use Vite's default build target (`baseline-widely-available`). `bun install` may rewrite `bun.lock`; don't commit that unless dependencies changed.

## Architecture

```
Terminal (lib/terminal.ts)            xterm.js API, events, scrolling, options, frame scheduling
├─ GhosttyTerminal (lib/bridge/)      the only code that touches the WASM module
├─ CanvasRenderer (lib/renderer.ts)   draws the render state; cursor, scrollbar, highlights
├─ InputHandler (lib/input-handler.ts)    DOM keyboard/mouse/paste/focus → libghostty encoders
├─ PointerRouter (lib/pointer-router.ts)  which of scrollbar, program, selection gets a press
├─ Scrollbar (lib/scrollbar.ts)       thumb drag, track clicks, fade (the renderer draws it)
├─ SelectionManager (lib/selection-manager.ts)  DOM mouse → libghostty selection gesture
├─ BufferNamespace (lib/buffer.ts)    xterm.js IBuffer over absolute screen rows
├─ LinkDetector + providers           OSC 8 (libghostty hyperlinks) and regex URLs
├─ LinkHover (lib/link-hover.ts)      hovered link's underline and pointer, opening on click
└─ addons: FitAddon, SearchAddon, SerializeAddon (lib/addons/)
```

### The bridge: `lib/ghostty.ts`, `lib/bridge/`, `lib/abi.ts`, `lib/types.ts`

- `Ghostty` (`lib/ghostty.ts`) loads the module (it has no imports), owns the per-module state and creates terminals and encoders. The file also re-exports everything in `lib/bridge/`, so the rest of the code imports the bridge from `./ghostty`. It must keep importing `./wasm-default`: the slim build swaps that import (`vite.config.js`).
- `GhosttyTerminal` (`lib/bridge/terminal.ts`) wraps one `GhosttyTerminal` handle plus its render state, row iterator and row cells, and `TrackedRow` a tracked grid reference. Their public methods are what the rest of the code uses; nothing outside `lib/ghostty.ts` and `lib/bridge/` calls `exports.ghostty_*`.
- `KeyEncoder`, `MouseEncoder`, `SelectionGesture`, `TerminalSearch` (`lib/bridge/key-encoder.ts`, `mouse-encoder.ts`, `selection-gesture.ts`, `search.ts`) wrap the matching libghostty objects.
- `lib/bridge/abi-constants.ts` holds the C enum values and the effect payload types, `lib/bridge/layout.ts` the struct offsets and bit fields read from the manifest (`buildLayout()`), and `lib/bridge/memory.ts` `Memory`, `Scratch` and `wasmCallback()`.
- `lib/types.ts` declares the exports used (`GhosttyWasmExports`) and the TS enums (`Key`, `Mods`, `KeyEncoderOption`, `CellFlags`, ...). `lib/abi-enums.test.ts` checks those enums against the loaded module, so a library upgrade that renumbers them fails a test instead of silently mis-encoding keys.

Conventions in the bridge:

- Enum values are part of libghostty's ABI promise and are written as constants. Bit positions inside packed values (`GhosttyCell`, `GhosttyStyleFlags`) are not covered by the promise and are read from the module's manifest (`ghostty_type_json()`) by `AbiLayout` in `lib/abi.ts`. Struct offsets also come from the manifest.
- Structs passed by value in C are passed by pointer from JS (wasm32 C ABI); check an export's arity (`exports.fn.length`) when in doubt.
- Any export can grow memory, which detaches old `ArrayBuffer` views. Always get views through `this.mem.view()` / `this.mem.bytes()` right before use, after any call into the module.
- Out-parameters and small arguments go through named slots in a `Scratch` (one allocation per object, slots laid end to end so none overlap; `terminalSlots()` lists `GhosttyTerminal`'s, sized from the manifest where a struct is involved). Use `scratch.at('name')`, never a numeric offset; when adding a method, reuse a slot only for a value that isn't live at the same time as the slot's other uses, otherwise add one.
- Opaque handles are created through `ghostty_wasm_alloc_opaque` + `ghostty_wasm_take_opaque`.
- JS callbacks (write_pty, bell, clipboard, ...) need a function-table entry. `wasmCallback()` builds a tiny module that re-exports a JS function as a WASM function; `Ghostty.installEffects()` registers one entry per callback type and routes calls by the terminal handle (always the first argument). Callbacks run synchronously inside `vt_write` and friends.

### Coordinates

Three row systems are in use; mixing them up is the most common bug.

| System       | Row 0 is                        | Used by                                                                     |
| ------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Viewport row | top of what is displayed        | renderer, `getViewportLine`, mouse hit-testing                              |
| Active row   | top of the screen below history | `getLine`, `getCursor().x/y`                                                |
| Absolute row | oldest scrollback line          | `getScreenLine`, `isScreenRowWrapped`, buffer API, selection, search, links |

`Terminal.viewportY` is the scroll offset in rows above the bottom (fractional during smooth scrolling; always floored for mapping). libghostty owns the real viewport, and `Terminal` keeps it on `floor(viewportY)` at all times: `viewportY` changes only through `setViewportY()`, which moves libghostty's viewport with it (as does `syncViewport()` after a resize or a scrollback change), so viewport reads between frames see what is displayed and the renderer never scrolls anything. Code that lets libghostty scroll (search, selection autoscroll, prompt jumps) copies the result back with `scrollToViewportOffset(wasmTerm.getViewportOffset())`. Every immediate scroll goes through `scrollToViewportOffset`, which also cancels smooth scrolling. The public `scrollToLine()` and `onScroll` use absolute rows, as in xterm.js, and so do `select()`, `selectLines()` and `getSelectionPosition()`. When scrolled up, new output keeps the same content on screen (`followScrolledContent` in `writeInternal`); user input scrolls to the bottom.

### Rendering

`GhosttyTerminal.update()` refreshes the render state and accumulates dirty flags (an update only ever adds dirty state; `markClean()` clears it). Reads refresh it only when `pendingUpdate` is set, so anything that changes the terminal outside `write()` (search steps, gestures, reset) must call `invalidate()`. `getLine()` reads the live grid, not the render state. `getViewport()` re-reads only stale rows, one `CELLS_RAW` call per row, and only fetches styles and graphemes for cells that have them. Each `GhosttyCell` carries resolved colors, flags, width, underline style and color, overline, `selected` (from the render state's selection), `bg_default`, a hyperlink ID shared by every cell of one URI, and the full grapheme in `chars` (filled by `readRow`, so the renderer never looks graphemes up per cell).

Frames are drawn on demand, never in a loop: `GhosttyTerminal.onChange` (every change that marks the render state stale), `CanvasRenderer.onChange` (theme, font, focus, hover, cursor blink), scrolling, decorations, highlights and `refresh()` call `Terminal.requestRender()`, which schedules one animation frame (`drawFrame`). Changes made while `render()` runs don't schedule another. Anything new that changes what is drawn must reach one of those.

Synchronized output (mode 2026) arrives as a render hold: `onRenderHold` captures the frame when the hold starts and `update()` is a no-op until it ends or times out (1 s).

The renderer draws rows, then the cursor (shape, blink and color from the render state, which programs can change), then the scrollbar in a gutter right of the grid. `FitAddon` sizes that gutter to absorb leftover width so the canvas fills its container. Search highlights come from a provider callback (`setHighlightProvider`); the active match is drawn over the selection.

### Input

- Keys: every mapped key goes through the key encoder after `syncFromTerminal()`, which copies the program's keyboard modes (Kitty flags, modifyOtherKeys, cursor/keypad modes). Option-as-Alt is re-applied after each sync. Releases (keyup) are sent only when the program asked for them. Dead keys and IME use composition events.
- Pointer routing: `PointerRouter` (`lib/pointer-router.ts`) decides who handles a press, once per gesture: the scrollbar (over its gutter, with history), else the program (when it tracks the mouse and Shift isn't held), else selection and links. `Terminal`'s capture-phase mousedown calls `press()` before any other listener; `SelectionManager`, `InputHandler` and the link click handler read `gestureTarget()`, and both wheel handlers read `wheelTarget()`. Don't stop propagation to keep another listener out; check the router.
- Mouse: `MouseEncoder` synced from the terminal, with geometry and button state. Wheel steps are one per notch (large pixel deltas, about 100 px each) or one per cell of accumulated trackpad movement.
- Paste: `GhosttyTerminal.encodePaste()` via `ghostty_terminal_paste` (bracketed paste, unsafe-byte stripping, Kitty paste events). Unsafe pastes are allowed, matching xterm.js.
- Focus: reported only when the program enabled mode 1004.

`reset()` resets libghostty in place (`ghostty_terminal_reset`), so `Terminal.wasmTerm` stays the same object for the terminal's lifetime. A program's RIS (`ESC c`) is handled after `vt_write` returns. `Terminal` creates its `GhosttyTerminal` in the constructor, so writes, the buffer, markers, modes, `paste()`, `input()`, `clear()`, `reset()` and `resize()` work without `open()` (headless use); `open()` adds the view (canvas, renderer, input, selection, decorations' container) and `cleanupView()` removes it, while `freeTerminal()` (from `dispose()`) frees the rest. Writes made from event listeners during a write are queued and run after it. `flushPendingWrites()` hands libghostty at most `WRITE_CHUNK_SIZE` at a time (`splitWrite()` cuts outside surrogate pairs and UTF-8 sequences) and stops after `WRITE_TIME_BUDGET_MS`, continuing in a `setTimeout(0)` task; writes arriving meanwhile queue behind it. A write's callback is queued as a microtask once its last chunk is written.

## Tests

Tests run under happy-dom (`happydom.ts`, preloaded by `bunfig.toml`; the benchmark imports it too); there is no real drawing. Tests are typechecked by `tsconfig.test.json` (part of `bun run typecheck`).

- Fixture: call `terminalFixture()` once per file (or describe) from `lib/test-helpers.ts`. It loads the module once, and `fixture.open(opts)` returns `{ term, container, sent }` (an opened terminal with every `onData` payload in `sent`); `fixture.create()` gives an unopened terminal, `fixture.wasm()` a bridge `GhosttyTerminal`, `fixture.defer(fn)` registers cleanup. Everything is disposed, freed and removed after each test.
- Drawing: the 2D context records every call with the fill/stroke style, alpha, font and line dash in effect. `render(term)` draws one frame and returns the calls; `drawnText(term)`, `paintedRects(term, color?)` and `strokes(term)` read them (text by cell, filled rectangles, stroked paths such as underlines).
- Internals: `internals(term)` returns the renderer, input handler, selection manager, bridge terminal, canvas and textarea with non-null types; other private members are reached with typed bracket access (`term['renderFrame']`), never `as any`.
- Events and globals: `keyDown`, `mouseEvent` and `wheelEvent` build dispatchable events with the happy-dom workarounds below; `stub(obj, key, value)` replaces a global and returns its restore function (pass it to `fixture.defer`). `nextFrame()` waits for one animation frame (the render and smooth-scroll loops); prefer it, or fake timers (`jest.useFakeTimers()` and `jest.advanceTimersByTime`), to fixed sleeps.
- After every test `test-cleanup.ts` (preloaded after `happydom.ts`) fails the test if a `Terminal` was left open, elements were left in `document.body`, or anything was written to the console. A test that expects a warning spies on `console.warn` and asserts it.
- Bridge-level behavior (libghostty conformance, dirty tracking, viewport reads) is tested against `fixture.wasm()` in `lib/ghostty.test.ts`; `Terminal` behavior in the `lib/terminal-*.test.ts` files by public API area (lifecycle, options, input, effects, drawing); cell attributes, cursors and decorations as drawn in `lib/renderer.test.ts`; selection in `lib/selection-manager.test.ts`; key encoding as one table in `lib/input-handler.test.ts`. Assert what a program receives (`sent`), what is drawn, or values read through the public API.

happy-dom quirks: `WheelEvent` ignores `clientX`/`clientY`; set `offsetX`/`offsetY` on synthetic mouse events with `Object.defineProperty`; synthetic events need `cancelable: true` for `defaultPrevented` to mean anything.

### Browser tests

`e2e/*.e2e.ts` run in real browsers with Playwright (`playwright.config.ts`). Chromium runs every test; Firefox and WebKit run only the tests tagged `@cross` (`{ tag: '@cross' }`), the behavior that differs between browsers: clipboard, keyboard, wheel, focus, selection and layout basics. Tests that use the Chrome DevTools Protocol (IME, dead keys, drag and drop, device metrics) stay untagged. Specs are split by area: `focus`, `keyboard`, `ime`, `mouse`, `clipboard`, `selection`, `scrolling`, `links`, `rendering` (cursor, device pixel ratio, web fonts), `drawing` (colors, decorations, stale pixels), `output` (synchronized output, echo) and `resize`. The `.e2e.ts` suffix keeps them out of `bun test`. They are not in the pre-commit list; run them when touching input, focus, clipboard, links, the renderer or anything else happy-dom can't show, and CI runs them in a separate `e2e` job.

- Fixture: `e2e/fixture.html` (and `e2e/fixture.ts`) opens one `Terminal` with fixed options (40x10, 16px monospace, no cursor blink, the colors in `e2e/theme.ts`) and no program behind it. It exposes `window.term`, `window.sent` (every `onData` payload) and `window.log` (scratch space for a spec's own event recording). Query parameters (the `openFixture` options) set `cols`, `rows`, `fontSize`, `fontFamily`, `scrollback` and `smoothScrollDuration`; `theme=light|transparent` swaps the colors, `allowTransparency` sets that option, and `fit` puts the terminal in a flex frame (`#frame`, sized by CSS) with a `FitAddon` observing it as `window.fit`. Playwright starts Vite with `e2e/vite.config.js`, bound to 127.0.0.1:8137 (`E2E_PORT` to change) and serving only what the page needs, like the demo.
- Helpers (`e2e/helpers.ts`): `openFixture(page, options)`, `write(page, data)` (waits for the frame that draws it), `sent`/`clearSent`, `nextFrame`/`frames`, `lineText`/`viewportText`, `readClipboard`/`writeClipboard` (through the page's `#before` input and the paste/copy shortcuts, which works in every browser), `geometry` (canvas position, cell size, device pixel scale), `cellPoint`/`mouseToCell` for pointer positions, and `cellPixels`/`canvasPixels` with `countColor`, `countTinted`, `countTransparent`, `colorsOf`, `columnsWithColor` and `rowsWithColor` to read the canvas at known cells (or the scrollbar gutter).
- Assert bytes in `window.sent`, canvas pixels at known cells, focus, the clipboard or DOM state; no golden screenshots and no fixed sleeps (`expect.poll` or `nextFrame` instead; read pixels after a frame, since an action's effect is drawn on the next one). Timing features (the render-hold timeout, scrollbar fade, selection autoscroll) use bounded `expect.poll` timeouts.
- What belongs where: behavior a program sees from synthetic events, terminal state and drawing calls stay unit tests; browser behavior (real focus and Tab order, real mouse and keyboard events, IME, clipboard, drag and drop, devicePixelRatio, web fonts, pixels) goes in e2e.

Anything the e2e tests don't cover can still be checked by hand in a browser with `bun run demo`.

## Releases

When asked to make a release, make it a prerelease unless the request explicitly says it should be a full release. The release workflow currently publishes every tag as a GitHub prerelease, so a plain version (`bun run release 0.0.3 --push`) is fine; if that default has changed, make sure the published release is still marked as a prerelease (`gh release edit vX.Y.Z --prerelease --latest=false`).

Versions are ghostterm's own semver; `bun run release <version>` (`scripts/release.ts`) is the only thing that changes `version` in `package.json`. It requires a clean `main` equal to `origin/main` and a version newer than every `v*` tag, and entries under `## Unreleased` in `CHANGELOG.md`. It runs the checks and the build, moves those entries under `## X.Y.Z - <date>` (releases only; a prerelease leaves them, see `scripts/changelog.ts`), commits `Release vX.Y.Z` and creates an annotated tag; `--push` pushes both. The tag starts `.github/workflows/release.yml`: a `build` job (read-only token) checks the tag against `package.json`, builds and uploads the release files, and a `publish` job, the only one with `contents: write`, creates the GitHub release with the `npm pack` tarball, a `dist/` zip and `SHA256SUMS`; its notes are the version's changelog entries (`bun scripts/changelog.ts notes <version>`). Every GitHub release is currently published as a prerelease, with or without a suffix (`PRERELEASE=true` in `release.yml`'s tag step); a version with a suffix (`0.2.0-rc.1`) also leaves the Unreleased entries in place. `.github/workflows/ci.yml` runs the same checks on pushes to `main` and on pull requests. `release()` in `scripts/release.ts` takes its commands, files, date and output as `ReleaseDeps`, so `scripts/release.test.ts` runs the whole sequence (repository checks, the build, the commit, tag and push) against a scripted repository; keep new steps behind those deps, and keep `scripts/changelog.ts`'s command in `cli()`. Workflow actions are pinned to commit SHAs with the version in a trailing comment. The workflows pass `actionlint` (with shellcheck) and `zizmor`, neither of which is a dependency (`go run github.com/rhysd/actionlint/cmd/actionlint@latest`, `uvx zizmor .github/workflows`): checkouts don't persist credentials, and the release build doesn't use the setup-bun cache.

## Upgrading libghostty-vt

The bundled release is recorded twice: `VERSION` in `scripts/fetch-wasm.sh` (what is downloaded) and the `libghostty-vt` field in `package.json` (what release notes name). A test in `lib/ghostty.test.ts` keeps both equal to the loaded module's version. To move to a new release, follow the `bump-libghostty` skill (`.claude/skills/bump-libghostty/`). In short:

1. `./scripts/update-libghostty.sh [version]` finds the latest `vt-X.Y.Z` tag, takes both builds' hashes from the minisign-verified `SHA256SUMS` (it refuses to run without minisign unless given `--no-verify`), rewrites the pin and the `package.json` field, and fetches the modules.
2. Run the tests. `lib/abi-enums.test.ts` catches renumbered enums; `AbiLayout` throws on missing manifest fields. Add the release's Unicode version to `UNICODE_VERSIONS` in `lib/unicode.ts` (a test fails until you do).
3. Read the header diff and commits between the `vt-` tags for changed behavior in what the bridge relies on, and recheck everything in `LIBGHOSTTY.md`.

[LIBGHOSTTY.md](./LIBGHOSTTY.md) lists the libghostty-vt quirks the code works around and the APIs it lacks, with the workaround for each; every bump rechecks it.

## Conventions

- Keep the public API xterm.js-compatible where xterm.js has an equivalent; new events and methods are additive.
- `lib/index.ts` exports the public API only: `init`, `Terminal`, the xterm.js interfaces and event payload types, the addons and `Ghostty` (for `new Terminal({ ghostty })`). Everything else (renderer, input handler, selection manager, link detector, `GhosttyTerminal`, encoders, enums) is internal; don't add it back to the entry point.
- Tag exported things that are not public API (helpers for the addons, bridge tables, callback plumbing) `@internal`. API Extractor leaves them out of `dist/index.d.ts`, so a public declaration must not name one: that leaves a dangling name, and `scripts/check-dist.ts` (run by `bun run build`) fails. This is why the addons take an `ITerminalCore` in `activate()` and cast it to the internal `IAddonTerminal`. `scripts/dist-consumer.ts` compiles against the rollup, using the public API and expecting internals to be missing.
- Document deliberate differences from xterm.js (they follow Ghostty) in the README's "Behavior worth knowing".
- Tests accompany behavior changes; prefer asserting what a program would receive (bytes sent) or what is drawn.
- Changes users would notice get one short line (about ten words: what changed, not how or why) under `## Unreleased` in `CHANGELOG.md`, in the same commit. Details belong in the README or docs, not the changelog. Internal refactors, tests and tooling get no entry.
- Markdown is soft wrapped: each paragraph or list item is one line, never hard wrapped at a fixed width. Prettier enforces this (`proseWrap: "never"` for `*.md` in `.prettierrc`, so `bun run fmt` fails on hard wraps and `bun run fmt:fix` unwraps them); its Markdown `printWidth` is raised only so wide tables keep their aligned columns. Code comments keep the 100-column width.
