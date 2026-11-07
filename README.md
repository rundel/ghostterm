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

### Smaller bundle

The default entry point inlines `ghostty-vt.wasm` as base64, so it works as a single file but most of it is the module. `ghostterm/slim` is the same library without the inlined module: its `init()` fetches `ghostty-vt.wasm` (shipped as `ghostterm/ghostty-vt.wasm`) by URL instead, so the JavaScript is smaller and the browser caches the module apart from your code.

| Entry point                       | JavaScript             | WebAssembly fetched at `init()` |
| --------------------------------- | ---------------------- | ------------------------------- |
| `ghostterm` (`dist/ghostterm.js`) | 1,282 kB (439 kB gzip) | none                            |
| `ghostterm/slim`                  | 156 kB (40 kB gzip)    | 844 kB (300 kB gzip)            |

Without arguments, the slim `init()` loads `new URL('./ghostty-vt.wasm', import.meta.url)`, the file next to `dist/ghostterm-slim.js`. Bundlers that understand that pattern (Vite and webpack 5 builds) emit the file as an asset. Otherwise, or when a dev server pre-bundles dependencies (Vite's dev server does), pass the URL yourself:

```javascript
import { init, Terminal } from 'ghostterm/slim';
import wasm from 'ghostterm/ghostty-vt.wasm?url'; // Vite; or any URL where you serve the file

await init({ wasmPath: wasm });
```

The fast build works the same way with the slim entry (`ghostterm/ghostty-vt-fast.wasm`). Both entry points share `dist/index.d.ts`.

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

`SearchAddon` follows [`@xterm/addon-search`](https://www.npmjs.com/package/@xterm/addon-search) and `SerializeAddon` follows [`@xterm/addon-serialize`](https://www.npmjs.com/package/@xterm/addon-serialize). While a full-screen program has the alternate screen up, `serialize()` saves the normal screen and its scrollback first, then the alternate screen, so leaving the program after a restore shows the shell again; `excludeAltBuffer: true` keeps only the normal screen. `range: { start, end }` limits it to those lines, given as buffer lines or as markers (see [Markers and decorations](#markers-and-decorations)).

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

`term.modes` reports the modes the program set (xterm.js `IModes`: application cursor keys and keypad, bracketed paste, mouse tracking, focus reporting, synchronized output, ...), read from libghostty; `term.getMode(mode, isAnsi)` reads any other mode by number.

Programs can also query the terminal's light or dark color scheme and its cell size in pixels, change the cursor shape, blink and color, set the mouse pointer shape (OSC 22) and use synchronized output (mode 2026). ghostterm answers and applies all of these.

### Markers and decorations

`term.registerMarker(cursorYOffset)` marks the cursor's line (or one above or below it) and returns an xterm.js `IMarker`. Its `line` follows the content as output scrolls, history is pruned and the screen reflows, because libghostty tracks it (a tracked grid reference). A marker is disposed, firing `onDispose`, when its line leaves the buffer; as in xterm.js, `reset()` and `clear()` dispose every marker, and leaving the alternate screen disposes the markers made on it. `term.markers` lists the live ones.

```javascript
const marker = term.registerMarker();
marker.onDispose(() => console.log('line gone'));
term.scrollToLine(marker.line);
```

`term.registerDecoration({ marker, x, width, height, anchor, backgroundColor, foregroundColor, layer })` attaches an `IDecoration` to a marker's line. Its `element` is an absolutely positioned div over the canvas, created the first time the line is on screen and passed to `onRender` each time it is placed; style it or add content to it. It follows the line as the view scrolls and output arrives, is hidden while the line is off screen, and is removed when the decoration or its marker is disposed. `backgroundColor` and `foregroundColor` color the marker line's cells under the decoration (on the `top` layer the background is drawn over the selection); where decorations overlap, the last registered one's colors win.

```javascript
const marker = term.registerMarker();
const decoration = term.registerDecoration({ marker, width: 2, backgroundColor: '#2a4d2a' });
decoration?.onRender((el) => {
  el.title = 'command succeeded';
});
```

### Parser hooks

`term.parser.registerOscHandler(code, handler)` sees OSC sequences before the terminal acts on them, for any code, including ones libghostty handles (titles, OSC 7, OSC 133, ...). libghostty's parser reports where each OSC starts, so sequences split across writes or sitting inside other strings are found as the terminal finds them. The handler gets the text after `code;`; returning true consumes the sequence (the terminal then ignores it), false passes it to older handlers for the same code and then to the terminal.

```javascript
term.parser.registerOscHandler(633, (data) => {
  if (data.startsWith('E;')) recordCommand(data.slice(2));
  return true;
});
```

`registerCsiHandler`, `registerDcsHandler` and `registerEscHandler` exist for compatibility but their handlers are never called: libghostty parses those sequences itself and its API has no hook for them. The first registration of each logs a warning.

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
- Search: a plain search is libghostty's: literal text, case-insensitive for ASCII letters only, with results that follow new output. With `regex`, `wholeWord` or `caseSensitive` the addon searches the buffer text itself, one logical line at a time (soft-wrapped rows joined), and finds the matches when `findNext()` or `findPrevious()` is called; without `caseSensitive` that search ignores case for every letter. Either way `findNext()` moves toward older output (up from the prompt), as Ghostty's find does; `resultIndex` still counts matches from the top, as in xterm.js, so `findNext()` lowers it. An invalid regular expression finds nothing.
- Scrollback limit: libghostty drops history a page at a time, so right after a page is dropped the number of lines kept can be somewhat below the `scrollback` option. `scrollback: 0` keeps no history, as in xterm.js.
- Cursor: while the terminal doesn't have focus the cursor is a hollow block that doesn't blink, whatever shape the options or the program chose; focus restores it.
- Colors: the defaults are `DEFAULT_THEME`'s (#d4d4d4 on #1e1e1e) and are given to libghostty too, so programs that ask for the colors (OSC 10/11) get an answer. A background a program sets with OSC 11 is drawn, and survives `reset()`, as in Ghostty.

Other differences from xterm.js:

- `buffer.normal` while a full-screen program has the alternate screen: its lines, `length` and `baseY` are those of the normal screen, but `cursorX` and `cursorY` read 0 (libghostty keeps that cursor only as the saved cursor). `buffer.alternate` is empty while the normal screen is active, as in xterm.js.
- No password indicator: Ghostty marks password prompts (a lock at the cursor) from the PTY's terminal settings (echo off), which only its own PTY code can see. libghostty-vt has no way to be told, so ghostterm can't show one.
- `onLineFeed` fires once per LF, VT or FF byte written, after the write is processed rather than as each is parsed: libghostty doesn't report line feeds, so they are counted in the data, and one inside an OSC or DCS string counts too. `onWriteParsed` fires once the queued writes have been processed.
- `unicode`: character widths and grapheme clusters come from libghostty's Unicode tables (Unicode 18 in libghostty-vt 1.0.0), so `unicode.activeVersion` is that version and `unicode.versions` lists only it. Setting another version or calling `unicode.register()` changes nothing and logs a warning once.
- Parser hooks: only OSC handlers are called (see [Parser hooks](#parser-hooks)). They run synchronously; a handler returning a Promise is not awaited and counts as returning false.
- Decorations: `overviewRulerOptions` is accepted and not drawn (there is no overview ruler). Decoration elements are always above the canvas, whatever their layer. A decoration on the normal screen is hidden while the alternate screen is shown, and one made on the alternate screen is shown there (xterm.js hides every decoration on the alternate screen).
- Markers are disposed when their line leaves the buffer, not when the line is erased in place (xterm.js also disposes markers on lines erased with ED or EL). Since libghostty prunes scrollback a page at a time, a marker on an old line can be disposed some lines before the `scrollback` limit alone would drop it.

## Development

ghostterm runs on the official prebuilt WebAssembly module that Ghostty publishes with each [libghostty-vt](https://lib.ghostty.org/) release, and talks to it only through the library's stable C ABI. `scripts/fetch-wasm.sh` downloads both builds of the pinned release and checks their SHA-256; `scripts/update-libghostty.sh` moves the pin to a newer release after checking the release's minisign signature. The bundled release is also recorded in the `libghostty-vt` field of `package.json` and reported at runtime by `ghostty.version`.

Requires Bun and curl, and minisign to move the pin.

```bash
bun install
./scripts/fetch-wasm.sh
bun test
bun run test:e2e         # browser tests (run `bun run test:e2e:install` once first)
bun run build            # dist/: both entry points, both wasm builds, index.d.ts, then checks them
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
