# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility: a proper terminal emulator in the browser, built on [libghostty-vt](https://lib.ghostty.org/).

- Migrate from xterm.js by changing your import: `@xterm/xterm` → `ghostty-web`
- The terminal emulation is Ghostty's own, from the official libghostty-vt WebAssembly release: parsing, screen and scrollback, keyboard and mouse encoding, selection, search and serialization
- Zero runtime dependencies; the WebAssembly module is about 830 KB (300 KB gzipped)

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Try It

- [Live Demo](https://ghostty.ondis.co) on an ephemeral VM (thank you to Greg from [disco.cloud](https://disco.cloud) for hosting).

- On your computer:

  ```bash
  npx @ghostty-web/demo@next
  ```

  This starts a loopback-only HTTP server with a real shell on `http://127.0.0.1:8080`. The demo protects `/ws` with a per-run same-origin token and rejects cross-origin WebSocket handshakes. Works best on Linux and macOS.

  To intentionally bind somewhere else, set `HOST=<host>`. If you serve the demo through extra hostnames or a wildcard bind such as `HOST=0.0.0.0`, also set `GHOSTTY_ALLOWED_HOSTS=host1,host2`. Avoid remote exposure unless you understand the risk: the demo starts a real local shell.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere: VS Code, Hyper, countless web terminals. But it reimplements terminal emulation in JavaScript, with every escape sequence, edge case and Unicode quirk hand-coded. ghostty-web hands all of that to libghostty, the same code that runs the native Ghostty app.

| Issue                                | xterm.js                                                         | ghostty-web              |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------ |
| Complex scripts (Devanagari, Arabic) | Rendering issues                                                 | Proper grapheme handling |
| XTPUSHSGR/XTPOPSGR                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | Supported                |

From libghostty, ghostty-web also gets the Kitty keyboard protocol and modifyOtherKeys, every mouse report
format (X10, UTF-8, SGR, URxvt, SGR-Pixels), synchronized output, curly, double, dotted and dashed underlines with
underline colors, and a scrollback search whose results stay correct while output keeps arriving.

## Installation

```bash
npm install ghostty-web
```

## Usage

ghostty-web aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from 'ghostty-web';

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

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

### Addons

```javascript
import { FitAddon, SearchAddon, SerializeAddon } from 'ghostty-web';

// Size the terminal to its container
const fit = new FitAddon();
term.loadAddon(fit);
fit.fit();
fit.observeResize();

// Find text in the scrollback and screen
const search = new SearchAddon();
term.loadAddon(search);
search.onDidChangeResults(({ resultIndex, resultCount }) =>
  updateFindBar(resultIndex, resultCount)
);
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

`SearchAddon` follows [`@xterm/addon-search`](https://www.npmjs.com/package/@xterm/addon-search) and `SerializeAddon` follows [`@xterm/addon-serialize`](https://www.npmjs.com/package/@xterm/addon-serialize).

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

Programs can also query the terminal's light or dark color scheme and its cell size in pixels, change the cursor shape, blink and color, set the mouse pointer shape (OSC 22) and use synchronized output (mode 2026). ghostty-web answers and applies all of these.

### Behavior worth knowing

These follow Ghostty rather than xterm.js:

- Shift+Enter is sent as `ESC [27;2;13~` (`ESC [13;2u` under the Kitty keyboard protocol), so programs such as Claude Code and Codex can tell it from Enter. Shells that don't bind it won't treat it as Enter.
- Option on macOS acts as Alt (Meta).
- Mouse: when a program tracks the mouse, clicks and drags go to the program and Shift+drag selects text. The wheel sends one report per notch, or one per cell of trackpad movement.
- Selection: double-click selects a word and triple-click a line, using Ghostty's word rules (paths and URLs select as one word). Alt+drag selects a block. Shift+arrow keys extend a selection. Copied text joins soft-wrapped lines. `selectAll()` includes the scrollback.
- Scrolling: output arriving while you are scrolled up leaves the view where it is; typing returns to the bottom.
- Paste: control characters in pasted text are replaced with spaces, so a paste can't break out of bracketed paste. Without bracketed paste, newlines are sent as carriage returns.
- Clipboard: programs may write to the clipboard with OSC 52 (turn this off with `allowClipboardWrite: false`); reading it is always denied.
- Search: literal text, case-insensitive for ASCII letters. `findNext()` moves toward older output (up from the prompt), as Ghostty's find does. The `regex`, `wholeWord` and `caseSensitive` options are not supported.
- Scrollback limit: libghostty drops history a page at a time, so right after a page is dropped the number of lines kept can be somewhat below the `scrollback` option.

## Development

ghostty-web runs on the official prebuilt WebAssembly module that Ghostty publishes with each
[libghostty-vt](https://lib.ghostty.org/) release, and talks to it only through the library's stable C ABI.
`scripts/fetch-wasm.sh` downloads the pinned release and checks its SHA-256.

> Requires Bun and curl.

```bash
bun install
bun run build            # fetch the WASM module and build dist/
bun test                 # run the test suite
bun run demo:dev         # demo with a real shell at http://127.0.0.1:8000/demo/ (run `npm install` in demo/ first)
```

Before committing, run `bun run fmt && bun run lint && bun run typecheck && bun test && bun run build`.
[CLAUDE.md](./CLAUDE.md) describes the architecture for contributors and coding agents.

Mitchell Hashimoto (author of Ghostty) built `libghostty`, which makes this all possible. ghostty-web provides an
xterm.js compatible API on top of it.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
