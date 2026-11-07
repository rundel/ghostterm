/**
 * Terminal events driven by libghostty's callbacks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

let container: HTMLElement;
let term: Terminal;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  term = await createIsolatedTerminal({ cols: 40, rows: 10 });
  term.open(container);
});

afterEach(() => {
  term.dispose();
  container.remove();
});

describe('Terminal events from libghostty', () => {
  test('onTitleChange fires once per change, even across writes', () => {
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]0;first\x07\x1b]2;first\x07');
    term.write('\x1b]2;sec');
    term.write('ond\x1b\\');
    expect(titles).toEqual(['first', 'second']);
  });

  test('onBell fires for BEL but not for a BEL ending an OSC sequence', () => {
    let bells = 0;
    term.onBell(() => bells++);
    term.write('\x1b]2;title\x07');
    expect(bells).toBe(0);
    term.write('\x07');
    expect(bells).toBe(1);
  });

  test('working directory, notifications, progress and shell integration', () => {
    const log: unknown[] = [];
    term.onWorkingDirectoryChange((d) => log.push(['cwd', d]));
    term.onNotification((n) => log.push(['notify', n.title, n.body]));
    term.onProgress((p) => log.push(['progress', p.state, p.progress]));
    term.onSemanticPrompt((e) => log.push(['prompt', e.kind]));
    term.write('\x1b]7;file://host/home/me\x07');
    term.write('\x1b]777;notify;Done;All tests passed\x07');
    term.write('\x1b]9;4;1;75\x07');
    term.write('\x1b]133;A\x07');
    expect(log).toEqual([
      ['cwd', 'file://host/home/me'],
      ['notify', 'Done', 'All tests passed'],
      ['progress', 'set', 75],
      ['prompt', 'prompt-start'],
    ]);
  });

  test('OSC 52 clipboard writes', () => {
    const writes: string[] = [];
    term.onClipboardWrite(({ text }) => writes.push(text));
    term.write(`\x1b]52;c;${btoa('from the program')}\x07`);
    expect(writes).toEqual(['from the program']);
  });

  test('events keep working after reset()', () => {
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.reset();
    term.write('\x1b]2;after reset\x07');
    expect(titles).toEqual(['after reset']);
  });

  test('color scheme queries are answered from the theme', async () => {
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    term.write('\x1b[?996n');
    expect(replies).toEqual(['\x1b[?997;1n']); // default theme is dark

    const light = await createIsolatedTerminal({ theme: { background: '#fafafa' } });
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    light.open(c2);
    const lightReplies: string[] = [];
    light.onData((d) => lightReplies.push(d));
    light.write('\x1b[?996n');
    expect(lightReplies).toEqual(['\x1b[?997;2n']);
    light.dispose();
    c2.remove();
  });

  test('cell size queries report the renderer metrics', () => {
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    term.write('\x1b[16t');
    const m = (term as any).renderer.getMetrics();
    expect(replies).toEqual([`\x1b[6;${Math.round(m.height)};${Math.round(m.width)}t`]);
  });
});
