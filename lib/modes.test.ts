import { describe, expect, test } from 'bun:test';
import type { IModes } from './interfaces';
import { terminalFixture } from './test-helpers';

const fixture = terminalFixture();

describe('modes', () => {
  test('defaults before open() and after', () => {
    const term = fixture.create();
    const defaults: IModes = {
      applicationCursorKeysMode: false,
      applicationKeypadMode: false,
      bracketedPasteMode: false,
      insertMode: false,
      mouseTrackingMode: 'none',
      originMode: false,
      reverseWraparoundMode: false,
      sendFocusMode: false,
      showCursor: true,
      synchronizedOutputMode: false,
      wraparoundMode: true,
    };
    expect(term.modes).toEqual(defaults);
    term.open(document.createElement('div'));
    expect(term.modes).toEqual(defaults);
  });

  test('follow what the program sets', () => {
    const { term } = fixture.open();
    term.write('\x1b[?1h\x1b=\x1b[?2004h\x1b[4h\x1b[?6h\x1b[?45h\x1b[?1004h\x1b[?25l\x1b[?7l');
    expect(term.modes).toMatchObject({
      applicationCursorKeysMode: true,
      applicationKeypadMode: true,
      bracketedPasteMode: true,
      insertMode: true,
      originMode: true,
      reverseWraparoundMode: true,
      sendFocusMode: true,
      showCursor: false,
      wraparoundMode: false,
    });
    term.write('\x1b[?1l\x1b>\x1b[?2004l\x1b[4l\x1b[?25h\x1b[?7h');
    expect(term.modes).toMatchObject({
      applicationCursorKeysMode: false,
      applicationKeypadMode: false,
      bracketedPasteMode: false,
      insertMode: false,
      showCursor: true,
      wraparoundMode: true,
    });
  });

  test('synchronizedOutputMode is set while a program holds output', () => {
    const { term } = fixture.open();
    term.write('\x1b[?2026h');
    expect(term.modes.synchronizedOutputMode).toBe(true);
    term.write('\x1b[?2026l');
    expect(term.modes.synchronizedOutputMode).toBe(false);
  });

  test('mouseTrackingMode names the reporting mode', () => {
    const { term } = fixture.open();
    const cases: Array<[number, IModes['mouseTrackingMode']]> = [
      [9, 'x10'],
      [1000, 'vt200'],
      [1002, 'drag'],
      [1003, 'any'],
    ];
    for (const [mode, name] of cases) {
      term.write(`\x1b[?${mode}h`);
      expect(term.modes.mouseTrackingMode).toBe(name);
      term.write(`\x1b[?${mode}l`);
      expect(term.modes.mouseTrackingMode).toBe('none');
    }
  });

  test('reset() restores the defaults', () => {
    const { term } = fixture.open();
    term.write('\x1b[?1h\x1b[?1003h');
    term.reset();
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    expect(term.modes.mouseTrackingMode).toBe('none');
  });
});
