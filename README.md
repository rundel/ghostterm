# ghostterm

A terminal emulator for the browser, built on [libghostty-vt](https://lib.ghostty.org/), with an [xterm.js](https://github.com/xtermjs/xterm.js)-compatible API. The terminal emulation is Ghostty's own, from the official libghostty-vt WebAssembly release: parsing, screen and scrollback, keyboard and mouse encoding, selection, search and serialization. ghostterm draws it to a canvas and handles the DOM.

This is a personal, experimental project. It is not published to npm; releases are on GitHub.

## Origins

ghostterm started as a fork of [ghostty-web](https://github.com/coder/ghostty-web) by [Coder](https://coder.com), published on npm as `ghostty-web`. It was forked after ghostty-web 0.4.0 (at [`640db46`](https://github.com/coder/ghostty-web/commit/640db46)) and has since been largely rewritten around Ghostty's official libghostty-vt WebAssembly module and its C API. The git history before the fork is ghostty-web's.

[Ghostty](https://github.com/ghostty-org/ghostty) and libghostty are by Mitchell Hashimoto and the Ghostty contributors.

## Installation

Install a release's package tarball from GitHub:

```bash
npm install https://github.com/rundel/ghostterm/releases/download/v0.0.1/ghostterm-0.0.1.tgz
```

or build it from a checkout (`bun run build`) and depend on the directory (`"ghostterm": "file:../ghostterm"`).

## Usage

```javascript
import { init, Terminal } from 'ghostterm';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

See [`demo/index.html`](./demo/index.html) for a complete client connected to a shell.

### Faster WebAssembly build

`init()` loads the size-optimized libghostty-vt module, which is bundled into the library. The package also ships `ghostty-vt-fast.wasm`, Ghostty's speed-optimized build of the same release. It has the same features, is 10-20% faster on output heavy in escape sequences, and is about 1.5 times larger (1.2 MB instead of 840 KB). To use it, pass its URL to `init()`:

```javascript
import { init } from 'ghostterm';
import fastWasm from 'ghostterm/ghostty-vt-fast.wasm?url'; // Vite; other bundlers have their own asset imports

await init({ wasmPath: fastWasm });
```

`Ghostty.load(path)` takes the same argument, and `ghostty.optimizeMode` reports which build was loaded. The module is loaded once: later `init()` calls, concurrent ones included, share it, and one asking for a different `wasmPath` logs a warning.

### Addons

```javascript
import { FitAddon, SearchAddon, SerializeAddon } from 'ghostterm';

// Size the terminal to its container
const fit = new FitAddon();
term.loadAddon(fit);
fit.fit();
fit.observeResize();

// Find text in the scrollback and screen
const search = new SearchAddon();
term.loadAddon(search);
search.onDidChangeResults(({ resultIndex, resultCount }) => updateFindBar(resultIndex, resultCount));
search.findNext('error', {
  decorations: { matchBackground: '#5a4a00', activeMatchBackground: '#d97700' },
});

// Save the terminal, and restore it later in a fresh terminal of the same size
const serializer = new SerializeAddon();
term.loadAddon(serializer);
const saved = serializer.serialize();
newTerm.write(saved);
const html = serializer.serializeAsHTML({ onlySelection: true });
```

`SearchAddon` follows [`@xterm/addon-search`](https://www.npmjs.com/package/@xterm/addon-search) and `SerializeAddon` follows [`@xterm/addon-serialize`](https://www.npmjs.com/package/@xterm/addon-serialize). While a full-screen program has the alternate screen up, `serialize()` saves the normal screen and its scrollback first, then the alternate screen, so leaving the program after a restore shows the shell again; `excludeAltBuffer: true` keeps only the normal screen.

Some xterm.js addons aren't needed: links (OSC 8 hyperlinks and plain URLs) are detected without `@xterm/addon-web-links`, character widths come from libghostty rather than `@xterm/addon-unicode11`, and OSC 52 clipboard writes arrive through `onClipboardWrite` instead of `@xterm/addon-clipboard`.

### Events from the running program

Besides the xterm.js events (`onData`, `onResize`, `onTitleChange`, `onBell`, `onSelectionChange`, ...), `Terminal` reports what programs ask of the terminal:

| Event                      | Sent by the program                                          |
| -------------------------- | ------------------------------------------------------------ |
| `onWorkingDirectoryChange` | OSC 7, the current directory as a `file://` URL              |
| `onClipboardWrite`         | OSC 52 clipboard writes                                      |
| `onNotification`           | OSC 9 / OSC 777 desktop notifications                        |
| `onProgress`               | OSC 9;4 progress reports                                     |
| `onProgramStatus`          | OSC 7501 status reports (idle, working, blocked on the user) |
| `onSemanticPrompt`         | OSC 133 shell integration: prompt, input, output, exit code  |

With shell integration, `term.scrollToPrompt(-1)` and `term.scrollToPrompt(1)` jump between prompts.

Programs can also query the terminal's light or dark color scheme and its cell size in pixels, change the cursor shape, blink and color, set the mouse pointer shape (OSC 22) and use synchronized output (mode 2026). ghostterm answers and applies all of these.

### Behavior worth knowing

These follow Ghostty rather than xterm.js:

- Shift+Enter is sent as `ESC [27;2;13~` (`ESC [13;2u` under the Kitty keyboard protocol), so programs such as Claude Code and Codex can tell it from Enter. Shells that don't bind it won't treat it as Enter.
- Option on macOS acts as Alt (Meta).
- Mouse: when a program tracks the mouse, clicks and drags go to the program and Shift+drag selects text. The wheel sends one report per notch, or one per cell of trackpad movement.
- Mouse pointer: over the text it is a text cursor unless the program asks for another shape with OSC 22 (`default` is the arrow).
- Wheel on the alternate screen: while a full-screen program leaves alternate scroll (mode 1007) on, the default, the wheel sends one arrow key per line scrolled; with it off the wheel sends nothing.
- Selection: double-click selects a word and triple-click a line, using Ghostty's word rules (paths and URLs select as one word). Alt+drag selects a block. Shift+arrow keys extend a selection. Copied text joins soft-wrapped lines. `selectAll()` includes the scrollback.
- Copy and paste: selecting text copies it to the clipboard. Cmd+C (macOS) and Ctrl+Shift+C also copy a selection; without one, Ctrl+Shift+C goes to the program. Ctrl+V is sent to the program (^V); paste with Cmd+V or Ctrl+Shift+V.
- Links: Ctrl+click (Cmd+click on macOS) opens OSC 8 hyperlinks and plain-text URLs, including URLs that wrap across lines. Only http, https, mailto and ftp links are opened, and plain-text URLs are detected only for those schemes.
- Scrolling: output arriving while you are scrolled up leaves the view where it is; typing returns to the bottom.
- Paste: control characters in pasted text are replaced with spaces, so a paste can't break out of bracketed paste. Without bracketed paste, newlines are sent as carriage returns.
- Clipboard: programs may write to the clipboard with OSC 52 (turn this off with `allowClipboardWrite: false`); reading it is always denied.
- Search: literal text, case-insensitive for ASCII letters. `findNext()` moves toward older output (up from the prompt), as Ghostty's find does; `resultIndex` still counts matches from the top, as in xterm.js, so `findNext()` lowers it. The `regex`, `wholeWord` and `caseSensitive` options are not supported, and the first search that sets one logs a warning.
- Scrollback limit: libghostty drops history a page at a time, so right after a page is dropped the number of lines kept can be somewhat below the `scrollback` option. `scrollback: 0` keeps no history, as in xterm.js.
- Colors: the defaults are `DEFAULT_THEME`'s (#d4d4d4 on #1e1e1e) and are given to libghostty too, so programs that ask for the colors (OSC 10/11) get an answer. A background a program sets with OSC 11 is drawn, and survives `reset()`, as in Ghostty.

Other differences from xterm.js:

- `buffer.normal` and `buffer.alternate`: libghostty exposes only the active screen, so the inactive buffer reads as empty (length 0) until the program switches to it.
- `clear()` keeps the cursor's line as the new top line and drops the scrollback, as in xterm.js, but works through the terminal's own scrolling, so a scroll region set by the program limits it.
- `allowTransparency` is accepted and ignored: a theme background with alpha is always drawn transparent.

## Development

ghostterm runs on the official prebuilt WebAssembly module that Ghostty publishes with each [libghostty-vt](https://lib.ghostty.org/) release, and talks to it only through the library's stable C ABI. `scripts/fetch-wasm.sh` downloads both builds of the pinned release and checks their SHA-256; `scripts/update-libghostty.sh` moves the pin to a newer release after checking the release's minisign signature. The bundled release is also recorded in the `libghostty-vt` field of `package.json` and reported at runtime by `ghostty.version`.

Requires Bun and curl, and minisign to move the pin.

```bash
bun install
./scripts/fetch-wasm.sh
bun test
bun run build            # dist/
bun run demo             # a real shell at http://127.0.0.1:8000/demo/ (see demo/README.md)
```

Before committing, run `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`. [CLAUDE.md](./CLAUDE.md) describes the architecture for contributors and coding agents.

## Releases

Versions are ghostterm's own semver, and [CHANGELOG.md](./CHANGELOG.md) records what changed in each one: add entries under `## Unreleased` as changes land. To release from an up-to-date, clean `main`:

```bash
bun run release 0.2.0-rc.1        # a prerelease: any suffix after the patch number
bun run release 0.2.0 --push      # a release, pushed straight away
```

This refuses to run while Unreleased is empty. It runs the checks and the build, sets the version in `package.json`, moves the Unreleased entries under the new version (a prerelease leaves them for the release that follows), commits and tags. Pushing the tag runs `.github/workflows/release.yml`, which builds and creates the GitHub release, marked as a prerelease when the version has a suffix. Each release carries the package tarball, a zip of `dist/` and `SHA256SUMS`, and its notes are its changelog entries and the libghostty-vt release it is built on.

## License

[MIT](./LICENSE). The original ghostty-web code is © Coder.
