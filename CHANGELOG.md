# Changelog

High-level changes in each ghostterm release. Add entries under Unreleased as changes land; `bun run release`
moves them under the new version, and the GitHub release shows them. A prerelease shows the Unreleased entries
and leaves them in place for the release that follows.

## Unreleased

## 0.0.1 - 2026-11-07

First release as ghostterm, forked from [ghostty-web](https://github.com/coder/ghostty-web) 0.4.0 and largely
rewritten.

- Terminal emulation comes from Ghostty's official libghostty-vt 1.0.0 WebAssembly release instead of a
  patched build, through its C API alone.
- Keyboard, mouse, paste and focus reporting use libghostty's encoders and follow the program's modes (Kitty
  keyboard protocol, modifyOtherKeys, all mouse report formats). The wheel sends one report per notch or cell.
- Selection uses libghostty: word and line rules, Alt+drag block selection, Shift+arrow keys, and copied text
  that joins soft-wrapped lines.
- Rendering follows libghostty's render state: scrolled views, the cursor shape, blink and color programs set,
  underline styles and colors, overline, explicit cell backgrounds and the OSC 22 mouse pointer.
- Program requests (bell, title, clipboard, notifications, progress, shell integration) arrive as events, and
  `scrollToPrompt()` jumps between shell prompts.
- New `SearchAddon` and `SerializeAddon`, backed by libghostty search and its formatter.
- The buffer API and link detection read libghostty's grid; theme colors apply after `open()`.
- A scrolled-up view stays in place on new output; typing returns to the bottom.
- The speed-optimized libghostty-vt build ships alongside the default as an opt-in (`init({ wasmPath })`).
- Releases are GitHub releases with the package tarball, a `dist/` zip and checksums; nothing is published to
  npm.
