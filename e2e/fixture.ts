// The page the Playwright specs drive: one Terminal with fixed options and no program behind it.
// Everything the terminal sends is recorded in window.sent. Query parameters override the
// numeric options (cols, rows, fontSize, scrollback, smoothScrollDuration) and fontFamily.

import { Terminal, init } from '../lib/index';
import { THEME } from './theme';

declare global {
  interface Window {
    term: Terminal;
    /** Each onData payload, in order. */
    sent: string[];
    /** Resolves once the terminal is open. */
    ready: Promise<void>;
    /** Scratch space for specs recording what happens in the page (events, calls). */
    log: unknown[];
  }
}

const params = new URL(location.href).searchParams;
const num = (name: string, fallback: number) => {
  const value = params.get(name);
  return value === null ? fallback : Number(value);
};

window.sent = [];
window.log = [];
window.ready = (async () => {
  await init();
  const term = new Terminal({
    cols: num('cols', 40),
    rows: num('rows', 10),
    fontSize: num('fontSize', 16),
    fontFamily: params.get('fontFamily') ?? 'monospace',
    scrollback: num('scrollback', 1000),
    smoothScrollDuration: num('smoothScrollDuration', 100),
    cursorBlink: false,
    theme: THEME,
  });
  term.onData((data) => window.sent.push(data));
  term.open(document.getElementById('terminal')!);
  window.term = term;
})();
