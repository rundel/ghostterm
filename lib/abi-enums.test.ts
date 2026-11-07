/**
 * Checks that ghostterm's TypeScript enums match the C ABI of the loaded
 * libghostty-vt module, using the module's own type manifest.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { Key, KeyAction, KeyEncoderOption } from './types';

type Enum = Record<string, string | number>;

let types: Record<string, { values: Record<string, number> }>;

beforeAll(async () => {
  const bytes = fs.readFileSync(new URL('../ghostty-vt.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as { memory: WebAssembly.Memory; ghostty_type_json(): number };
  const mem = new Uint8Array(exports.memory.buffer);
  const ptr = exports.ghostty_type_json();
  let end = ptr;
  while (mem[end] !== 0) end++;
  types = JSON.parse(new TextDecoder().decode(mem.subarray(ptr, end))).types;
});

/** Names ghostterm uses that differ from libghostty-vt's. */
const KEY_ALIASES: Record<string, string> = {
  GRAVE: 'BACKQUOTE',
  ZERO: 'DIGIT_0',
  ONE: 'DIGIT_1',
  TWO: 'DIGIT_2',
  THREE: 'DIGIT_3',
  FOUR: 'DIGIT_4',
  FIVE: 'DIGIT_5',
  SIX: 'DIGIT_6',
  SEVEN: 'DIGIT_7',
  EIGHT: 'DIGIT_8',
  NINE: 'DIGIT_9',
  UP: 'ARROW_UP',
  DOWN: 'ARROW_DOWN',
  LEFT: 'ARROW_LEFT',
  RIGHT: 'ARROW_RIGHT',
  KP_PLUS: 'NUMPAD_ADD',
  KP_MINUS: 'NUMPAD_SUBTRACT',
  KP_PERIOD: 'NUMPAD_DECIMAL',
};

function keyName(name: string): string {
  return KEY_ALIASES[name] ?? name.replace(/^KP_/, 'NUMPAD_');
}

/** [ghostterm name, value, libghostty-vt value] for each mismatch. */
function mismatches(tsEnum: Enum, cType: string, rename: (n: string) => string) {
  const official = types[cType].values;
  return Object.entries(tsEnum)
    .filter(([, v]) => typeof v === 'number')
    .map(([name, v]) => [name, v, official[rename(name)]])
    .filter(([, v, o]) => v !== o);
}

describe('enums match the libghostty-vt ABI', () => {
  test('Key', () => {
    expect(mismatches(Key as unknown as Enum, 'GhosttyKey', keyName)).toEqual([]);
  });

  test('every libghostty-vt key has a ghostterm name', () => {
    const mine = new Set(Object.keys(Key).map(keyName));
    const missing = Object.keys(types.GhosttyKey.values).filter(
      (k) => k !== 'MAX_VALUE' && !mine.has(k)
    );
    expect(missing).toEqual([]);
  });

  test('KeyEncoderOption', () => {
    const rename = (n: string) => (n === 'KITTY_KEYBOARD_FLAGS' ? 'KITTY_FLAGS' : n);
    expect(
      mismatches(KeyEncoderOption as unknown as Enum, 'GhosttyKeyEncoderOption', rename)
    ).toEqual([]);
  });

  test('KeyAction', () => {
    expect(mismatches(KeyAction as unknown as Enum, 'GhosttyKeyAction', (n) => n)).toEqual([]);
  });
});
