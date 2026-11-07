import { describe, expect, spyOn, test } from 'bun:test';
import { terminalFixture } from './test-helpers';

const fixture = terminalFixture();

function line(term: ReturnType<typeof fixture.open>['term'], y = 0): string {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

describe('parser.registerOscHandler', () => {
  test('gets the data of an OSC code libghostty does not know, ended by BEL or ST', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const seen: string[] = [];
    term.parser.registerOscHandler(633, (data) => {
      seen.push(data);
      return true;
    });
    term.write('a\x1b]633;A\x07b\x1b]633;E;ls -l\x1b\\c');
    expect(seen).toEqual(['A', 'E;ls -l']);
    // Nothing of the sequences is printed, the ST's backslash included.
    expect(line(term)).toBe('abc');
  });

  test('collects a sequence split across writes, even inside its introducer', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const seen: string[] = [];
    term.parser.registerOscHandler(1337, (data) => {
      seen.push(data);
      return true;
    });
    for (const chunk of ['x\x1b', ']13', '37;Set', 'Mark', '\x1b', '\\y']) term.write(chunk);
    expect(seen).toEqual(['SetMark']);
    expect(line(term)).toBe('xy');
  });

  test('decodes the data as UTF-8, including multi-byte characters split across writes', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const seen: string[] = [];
    term.parser.registerOscHandler(7000, (data) => {
      seen.push(data);
      return true;
    });
    const bytes = new TextEncoder().encode('\x1b]7000;hé ☃\x07');
    term.write(bytes.subarray(0, 10));
    term.write(bytes.subarray(10));
    expect(seen).toEqual(['hé ☃']);
  });

  test('a handler returning true consumes a sequence libghostty handles', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    let consume = true;
    term.parser.registerOscHandler(2, () => consume);
    term.write('\x1b]2;hidden\x07');
    expect(titles).toEqual([]);
    consume = false;
    term.write('\x1b]2;shown\x1b\\');
    expect(titles).toEqual(['shown']);
  });

  test('handlers run newest first until one returns true', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const calls: string[] = [];
    term.parser.registerOscHandler(777, () => {
      calls.push('old');
      return true;
    });
    const newer = term.parser.registerOscHandler(777, () => {
      calls.push('new');
      return false;
    });
    term.write('\x1b]777;x\x07');
    expect(calls).toEqual(['new', 'old']);
    newer.dispose();
    calls.length = 0;
    term.write('\x1b]777;x\x07');
    expect(calls).toEqual(['old']);
  });

  test('only gets its own code, and a bare code has empty data', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const seen: string[] = [];
    term.parser.registerOscHandler(104, (data) => {
      seen.push(data);
      return true;
    });
    term.write('\x1b]1040;no\x07\x1b]10;?\x07\x1b]104\x07\x1b]x104;no\x07');
    expect(seen).toEqual(['']);
  });

  test('a cancelled sequence (CAN) is not passed on', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const seen: string[] = [];
    term.parser.registerOscHandler(633, (data) => {
      seen.push(data);
      return true;
    });
    term.write('\x1b]633;A\x18after');
    expect(seen).toEqual([]);
    expect(line(term)).toBe('after');
  });

  test('other output, CSI sequences and responses work as usual while handlers are registered', () => {
    const { term, sent } = fixture.open({ cols: 40, rows: 5 });
    term.parser.registerOscHandler(633, () => true);
    term.write('\x1b[1mbold\x1b[0m\r\n\x1b[6n');
    expect(line(term)).toBe('bold');
    expect(sent.join('')).toBe('\x1b[2;1R');
  });

  test('a disposed handler is no longer called', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    let calls = 0;
    const handler = term.parser.registerOscHandler(633, () => {
      calls++;
      return true;
    });
    handler.dispose();
    term.write('\x1b]633;A\x07');
    expect(calls).toBe(0);
  });

  test('a handler that throws is skipped and logged', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const error = spyOn(console, 'error').mockImplementation(() => {});
    fixture.defer(() => error.mockRestore());
    term.parser.registerOscHandler(2, () => {
      throw new Error('boom');
    });
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]2;title\x07');
    expect(error).toHaveBeenCalledTimes(1);
    expect(titles).toEqual(['title']);
  });
});

describe('parser CSI, DCS and ESC handlers', () => {
  test('are accepted, never called, and warn once each', () => {
    const { term } = fixture.open({ cols: 40, rows: 5 });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fixture.defer(() => warn.mockRestore());
    let calls = 0;
    const handler = () => {
      calls++;
      return true;
    };
    const disposables = [
      term.parser.registerCsiHandler({ final: 'm' }, handler),
      term.parser.registerCsiHandler({ final: 'H' }, handler),
      term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, handler),
      term.parser.registerEscHandler({ final: 'c' }, handler),
    ];
    term.write('\x1b[1mx\x1bP$qm\x1b\\');
    expect(calls).toBe(0);
    expect(warn).toHaveBeenCalledTimes(3);
    for (const d of disposables) d.dispose();
  });
});
