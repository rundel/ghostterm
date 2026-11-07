/**
 * Checks after each test, preloaded by Bun after happydom.ts (bunfig.toml): fails the test if it
 * left a Terminal open, elements in document.body or output on the console. Tests that expect a
 * warning spy on console.warn and assert it.
 */

import { afterEach, beforeEach } from 'bun:test';

// Track open terminals. Imported once the globals exist; loading the module
// neither loads the WASM module nor initializes anything.
const { Terminal } = await import('./lib/terminal');
const openTerminals = new Set<InstanceType<typeof Terminal>>();
const { open, dispose } = Terminal.prototype;
Terminal.prototype.open = function (parent: HTMLElement) {
  open.call(this, parent);
  openTerminals.add(this);
};
Terminal.prototype.dispose = function () {
  openTerminals.delete(this);
  dispose.call(this);
};

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof consoleMethods)[number];
const realConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]])) as Record<
  ConsoleMethod,
  (...args: unknown[]) => void
>;
let consoleOutput: string[] = [];

beforeEach(() => {
  consoleOutput = [];
  for (const m of consoleMethods) {
    console[m] = (...args: unknown[]) => {
      consoleOutput.push(`console.${m}: ${args.map(String).join(' ')}`);
      realConsole[m](...args);
    };
  }
});

afterEach(() => {
  for (const m of consoleMethods) console[m] = realConsole[m];
  const problems: string[] = [];
  if (openTerminals.size > 0) {
    problems.push(`${openTerminals.size} Terminal(s) left open`);
    for (const term of [...openTerminals]) term.dispose();
  }
  if (document.body.childElementCount > 0) {
    problems.push(`${document.body.childElementCount} element(s) left in document.body`);
    document.body.replaceChildren();
  }
  if (consoleOutput.length > 0) {
    problems.push(`unexpected console output:\n  ${consoleOutput.join('\n  ')}`);
  }
  if (problems.length > 0) throw new Error(`Test cleanup: ${problems.join('; ')}`);
});
