# Changelog

High-level changes in each ghostterm release. Add entries under Unreleased as changes land; `bun run release` moves them under the new version, and the GitHub release shows them. A prerelease shows the Unreleased entries and leaves them in place for the release that follows.

## Unreleased

- The package exports only the xterm.js-style API (`Terminal`, `init`, the interfaces and event types), the addons and `Ghostty`. The renderer, input handler, selection manager, link detector, encoders, `GhosttyTerminal` and the libghostty enums are no longer exported, and `Terminal.renderer` and `Terminal.viewportY` are private (`getViewportY()` remains).
- `input(data)` sends the data to the program (`onData`) by default, as in xterm.js; with `wasUserInput` false it is still sent but doesn't scroll to the bottom. It no longer writes to the screen.
- Text keeps grayscale antialiasing without `allowTransparency`; 0.0.2's opaque canvas gave it colored subpixel edges in Chromium on Linux.

## 0.0.2 - 2026-11-07

- Markers: `registerMarker()` and `markers`, tracked by libghostty as output scrolls, history is pruned and the screen reflows.
- Decorations: `registerDecoration()` places an element over a marker's line and can color its cells.
- `modes` reports the terminal modes a program set, as in xterm.js.
- `refresh(start, end)` redraws the viewport on the next frame.
- `onLineFeed` and `onWriteParsed` events.
- `unicode` follows xterm.js's `IUnicodeHandling` and reports libghostty's Unicode version (18) instead of a fixed 15.1; `IUnicodeVersionProvider` is now xterm.js's provider type.
- `parser.registerOscHandler()` sees and can consume any OSC sequence; the CSI, DCS and ESC registrations are accepted but not called.
- SearchAddon supports the `regex`, `wholeWord` and `caseSensitive` options.
- SerializeAddon's `range` accepts markers, as in xterm.js.
- `attachCustomKeyEventHandler` and `attachCustomWheelEventHandler` follow xterm.js: returning false stops the terminal handling the event. The key handler also runs for keyup, and the wheel handler also sees wheel events reported to a program.
- `onKey` reports the data sent for the key (`"\r"` for Enter) and fires only when something is sent.
- `select()`, `selectLines()`, `getSelectionPosition()` and `scrollToLine()` use buffer rows including the scrollback, and `onScroll` reports the top line, as in xterm.js. The end column of `getSelectionPosition()` is exclusive.
- `onSelectionChange` fires when the selection is cleared; `onRender`, `buffer.onBufferChange` and `onCursorMove` (for moves along a line) now fire.
- `write()`, `writeln()` and `resize()` work before `open()`, and writes from event listeners during a write are no longer lost.
- `clear()` keeps the cursor's line and drops the scrollback, and `reset()` resets in place; a program's reset (ESC c) also clears the title and scroll position.
- `scrollback: 0` keeps no scrollback, as in xterm.js (it used to mean unlimited), and changing `scrollback` after `open()` takes effect.
- Default colors come from `DEFAULT_THEME` everywhere, so OSC 10/11 color queries are answered without a theme, and a background set by a program is drawn.
- Ctrl+V is sent to programs; paste with Cmd+V or Ctrl+Shift+V. Ctrl+Shift+C copies the selection.
- A mouse drag reported to a program is released when the button is let go outside the terminal, and there are no more stray Kitty key releases for shortcuts the terminal handled itself.
- Alternate-screen wheel scrolling works with line-mode wheels and trackpads and honors mode 1007.
- Detected URLs keep their columns after emoji and wide characters, include balanced parentheses and work across wrapped lines. Links open only for http, https, mailto and ftp.
- IME input always composes in the hidden textarea, and `focus()` and `blur()` act on it.
- During synchronized output (mode 2026) the cursor stays with the frame on screen instead of moving ahead to where the program is drawing.
- The published typings leave out internal members and compile without `skipLibCheck`; the addons' `activate()` takes an `ITerminalCore`.
- `ghostterm/slim`, an entry point without the inlined WebAssembly module (156 kB instead of 1.28 MB): its `init()` loads `ghostty-vt.wasm`, now shipped again, by URL.
- Text dropped onto the terminal's canvas can no longer be inserted into the page, as was already the case for the rest of the terminal.
- Fixed the canvas redrawing every frame at fractional device pixel ratios, a stale cursor after hiding it or changing its shape or color, smooth scrolling pulling the view back after a jump, and `allowClipboardWrite: false` being ignored.
- The canvas follows device pixel ratio changes and web fonts finishing loading; a block cursor covers the whole of a wide character. Emoji and other multi-codepoint characters draw faster.
- `translateToString()` keeps spaces between words, the inactive buffer no longer shows the other screen, and buffer cells report their color modes (`isFgDefault`, `isBgRGB`, `isAttributeDefault`, ...).
- A hovered link's underline no longer lingers when output or scrolling moves it out from under a pointer that stays still.
- Programs that ask for the `default` pointer (OSC 22) get the arrow instead of the text cursor.
- FitAddon no longer ignores `fit()` shortly after a resize or after the terminal was resized another way.
- SerializeAddon keeps the normal screen and its scrollback while a full-screen program runs (honoring `scrollback`), and has new `excludeAltBuffer` and `range` options.
- SearchAddon counts `resultIndex` from the top as in xterm.js, counts every match and keeps its place during incremental search.
- `init()` loads the module once even when called concurrently, and warns when a later call asks for a different `wasmPath`.
- Without focus the cursor is drawn as a hollow block, as in Ghostty and xterm.js.
- Programs asking for the terminfo name (XTGETTCAP `TN`) are told `xterm-ghostty`, as Ghostty answers.
- `clear()` is no longer limited by a scroll region or origin mode the program set, keeps the program's colors and margins, and erases with the default background.
- `buffer.normal` can be read while a full-screen program uses the alternate screen.
- `allowTransparency` works as in xterm.js: a theme background with alpha is drawn transparent only when it is true, and opaque otherwise (the default).
- Underlines, strikethrough and overlines are drawn on whole device pixels and thicken with the font; double underlines show two lines and curly underlines a visible wave.
- Buffer, selection and search types (`IBuffer`, `IBufferLine`, `IBufferCell`, `IBufferNamespace`, `SelectionRange`, `TerminalSearch`, ...) are exported.
- Loading in a browser no longer tries the Node fs module, and the package no longer ships a separate `ghostty-vt.wasm`, since the default module is bundled into the library.
- Removed rarely used `GhosttyTerminal` methods (`getGrapheme`, `getGraphemeString`, `getViewportGraphemeString`, `isRowWrapped`, `getHyperlinkUri`, `hasResponse`) and `KeyEncoder.setKittyFlags`; use cell `chars`, `isScreenRowWrapped`, `getScreenHyperlinkUri` and `readResponse`. `GhosttyTerminal.getLine()` returns current content even while synchronized output holds the screen.

## 0.0.1 - 2026-11-07

First release as ghostterm, forked from [ghostty-web](https://github.com/coder/ghostty-web) 0.4.0 and largely rewritten.

- Terminal emulation comes from Ghostty's official libghostty-vt 1.0.0 WebAssembly release instead of a patched build, through its C API alone.
- Keyboard, mouse, paste and focus reporting use libghostty's encoders and follow the program's modes (Kitty keyboard protocol, modifyOtherKeys, all mouse report formats). The wheel sends one report per notch or cell.
- Selection uses libghostty: word and line rules, Alt+drag block selection, Shift+arrow keys, and copied text that joins soft-wrapped lines.
- Rendering follows libghostty's render state: scrolled views, the cursor shape, blink and color programs set, underline styles and colors, overline, explicit cell backgrounds and the OSC 22 mouse pointer.
- Program requests (bell, title, clipboard, notifications, progress, shell integration) arrive as events, and `scrollToPrompt()` jumps between shell prompts.
- New `SearchAddon` and `SerializeAddon`, backed by libghostty search and its formatter.
- The buffer API and link detection read libghostty's grid; theme colors apply after `open()`.
- A scrolled-up view stays in place on new output; typing returns to the bottom.
- The speed-optimized libghostty-vt build ships alongside the default as an opt-in (`init({ wasmPath })`).
- Releases are GitHub releases with the package tarball, a `dist/` zip and checksums; nothing is published to npm.
