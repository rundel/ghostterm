# Changelog

High-level changes in each ghostterm release. Add entries under Unreleased as changes land; `bun run release` moves them under the new version, and the GitHub release shows them. A prerelease shows the Unreleased entries and leaves them in place for the release that follows.

## Unreleased

- Update libghostty-vt to 1.0.1: stale prompts no longer pile up when resizing, and growing rows while shrinking columns pulls scrollback back down.

## 0.0.2 - 2026-11-07

- Works headless: writes, the buffer, markers and modes no longer need `open()`.
- Large writes no longer block the page; `write()` callbacks run once the data is parsed.
- An idle terminal no longer redraws every frame.
- Only the public API is exported; `Terminal.renderer` and `viewportY` are private.
- `input()` sends to `onData`, as in xterm.js.
- Markers and decorations.
- `modes`, `refresh()`, `onLineFeed` and `onWriteParsed`.
- `unicode` reports libghostty's Unicode version.
- `parser.registerOscHandler()`.
- SearchAddon: `regex`, `wholeWord` and `caseSensitive`.
- SerializeAddon: `range`, `excludeAltBuffer`, and the normal screen is kept under full-screen programs.
- `ghostterm/slim` entry point, without the inlined WebAssembly module.
- Custom key and wheel handlers, `onKey`, selection and scroll positions now match xterm.js.
- `clear()`, `reset()`, `scrollback: 0` and `allowTransparency` behave as in xterm.js.
- Ctrl+V goes to the program; paste with Cmd+V or Ctrl+Shift+V.
- `buffer.normal` is readable while the alternate screen is active.
- Hollow cursor without focus.
- Many rendering, link, IME, mouse and addon fixes.
- Removed rarely used `GhosttyTerminal` methods and `KeyEncoder.setKittyFlags`.

## 0.0.1 - 2026-11-07

First release as ghostterm, forked from [ghostty-web](https://github.com/coder/ghostty-web) 0.4.0 and largely rewritten.

- Runs on Ghostty's official libghostty-vt 1.0.0 WebAssembly release.
- Keyboard, mouse, paste, selection and rendering use libghostty.
- Events for program requests (title, clipboard, notifications, progress, shell integration).
- `SearchAddon` and `SerializeAddon`.
- An optional speed-optimized WebAssembly build.
- Released on GitHub, not npm.
