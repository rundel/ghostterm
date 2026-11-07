// The page the Playwright specs drive: one Terminal with fixed options and no program behind it.
// Everything the terminal sends is recorded in window.sent. Query parameters override the
// numeric options (cols, rows, fontSize, scrollback, smoothScrollDuration) and fontFamily;
// `theme=light|transparent` picks other colors, `allowTransparency` sets that option, and `fit`
// puts the terminal in a flex layout sized by CSS with a FitAddon observing it (window.fit).

import { FitAddon } from '../lib/addons/fit';
import { Terminal, init } from '../lib/index';
import { LIGHT_THEME, THEME, TRANSPARENT_THEME } from './theme';

declare global {
  interface Window {
    term: Terminal;
    /** Each onData payload, in order. */
    sent: string[];
    /** Resolves once the terminal is open. */
    ready: Promise<void>;
    /** Scratch space for specs recording what happens in the page (events, calls). */
    log: unknown[];
    /** The FitAddon, with `fit`. */
    fit?: FitAddon;
  }
}

const params = new URL(location.href).searchParams;
const num = (name: string, fallback: number) => {
  const value = params.get(name);
  return value === null ? fallback : Number(value);
};
const themes = { light: LIGHT_THEME, transparent: TRANSPARENT_THEME };

window.sent = [];
window.log = [];
window.ready = (async () => {
  await init();
  const fit = params.has('fit');
  if (fit) document.body.classList.add('fit');
  const term = new Terminal({
    cols: num('cols', 40),
    rows: num('rows', 10),
    fontSize: num('fontSize', 16),
    fontFamily: params.get('fontFamily') ?? 'monospace',
    scrollback: num('scrollback', 1000),
    smoothScrollDuration: num('smoothScrollDuration', 100),
    cursorBlink: false,
    allowTransparency: params.has('allowTransparency'),
    theme: themes[params.get('theme') as keyof typeof themes] ?? THEME,
  });
  term.onData((data) => window.sent.push(data));
  if (fit) {
    window.fit = new FitAddon();
    term.loadAddon(window.fit);
  }
  term.open(document.getElementById('terminal')!);
  if (window.fit) {
    window.fit.fit();
    window.fit.observeResize();
  }
  window.term = term;
})();
