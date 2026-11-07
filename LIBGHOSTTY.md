# libghostty-vt gaps

What ghostterm works around in, or can't do because of, the libghostty-vt release it bundles (currently 1.0.0, the `libghostty-vt` field in `package.json`). Every bump rechecks both lists (see the `bump-libghostty` skill): when a release fixes a quirk or adds a missing API, replace the workaround (or add the feature), adjust the tests and the README's "Behavior worth knowing", and drop the item. Bring the version above up to date with each bump.

## Quirks

Behavior the code works around or documents:

- Default `SCROLLBACK_MAX_BYTES` is 10,000 bytes; the bridge sets it to unlimited so the line limit governs.
- Scrollback is pruned a page at a time, so the retained line count can drop below the configured limit.
- `DELTA_PROMPT` scrolling by -1 doesn't move when a prompt is the top row; `scrollToPrompt` retries one row up.
- The gesture API has no default double-click interval or distance; `SelectionGesture` sets 500 ms and 10 px.
- `ghostty_terminal_compress` is unsupported on wasm32.
- The snapshot byte format is explicitly unstable; `SerializeAddon` uses the formatter's VT output instead.
- The render state copies the default foreground and background only while both are set, so `setColors()` sets the built-in defaults (white on black) instead of unsetting one, and `Terminal` always passes both.
- RIS (`ESC c`) doesn't fire the title effect; `Terminal` clears the title itself after a reset.

## Missing APIs

What the C API doesn't offer, how ghostterm gets by, and what would let it stop:

- Inactive screen access. The C API reads, formats and points into only the active screen. `buffer.normal` while the alternate screen is up, and `SerializeAddon` saving the normal screen, switch screens with mode 47 and back (`withPrimaryScreen()` / `readPrimary()` / `primaryScreen()` in `lib/ghostty.ts`), restoring modes, selection and dirty state by hand; the inactive normal buffer's cursor reads as 0, 0. Wanted: a screen selector for grid refs, row iteration and the formatter.
- Parser hooks. Only OSC can be intercepted, through `ghostty_terminal_vt_write_until` with the `OSC_START` boundary (`writeCapturingOsc()`, `lib/parser.ts`), which still scans for the OSC terminator in TypeScript. `registerCsiHandler`, `registerEscHandler` and `registerDcsHandler` register no-ops that warn once. Wanted: callbacks for CSI, ESC and DCS (and OSC) sequences that can consume them.
- Line feed events. `onLineFeed` counts LF, VT and FF bytes in written data (`countLineFeeds()` in `lib/parser.ts`), so line feeds inside OSC or DCS strings are counted too. Wanted: a line feed effect or a count from `vt_write`.
- Search options. libghostty search takes a literal needle, case-insensitive for ASCII only. `SearchAddon` runs its own text search in TypeScript (`lib/addons/search.ts`, `lib/line-text.ts`) when `regex`, `wholeWord` or `caseSensitive` is set. Wanted: case-sensitive, Unicode case folding, whole-word and regex options.
- Unicode version. The module doesn't report which Unicode version its tables follow, so `UNICODE_VERSIONS` in `lib/unicode.ts` maps each libghostty-vt release by hand. Wanted: a version query.
- Clear to the cursor line. There is no call for xterm.js's `clear()` (keep the cursor's line as the top line, drop the scrollback); `clearToCursorLine()` in `lib/ghostty.ts` writes VT sequences and saves and restores the program's scroll region, margins, origin mode and pen around them via the formatter's restore sequences. Wanted: a clear-screen-and-scrollback call that keeps the cursor row.
- Password input. The render state's `password_input` is set only by Ghostty's own PTY code from termios state, so it is always false in wasm and ghostterm shows no indicator (README "Behavior worth knowing"). Wanted: a way for the embedder to set it, or detection from the program's modes.
- Marker disposal on erase. Tracked grid references (markers) survive a line being erased in place (ED/EL); xterm.js disposes those markers. Wanted: a signal that a tracked row was erased.
