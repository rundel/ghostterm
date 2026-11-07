import { describe, expect, test } from 'bun:test';
import { EventEmitter } from './event-emitter';

describe('EventEmitter', () => {
  test('a listener disposing itself does not make the next one miss the event', () => {
    const emitter = new EventEmitter<number>();
    const seen: string[] = [];
    const first = emitter.event(() => {
      seen.push('first');
      first.dispose();
    });
    emitter.event(() => seen.push('second'));
    emitter.fire(1);
    expect(seen).toEqual(['first', 'second']);
    emitter.fire(2);
    expect(seen).toEqual(['first', 'second', 'second']);
  });

  test('a listener added during fire is not called for that event', () => {
    const emitter = new EventEmitter<void>();
    let late = 0;
    emitter.event(() => {
      emitter.event(() => late++);
    });
    emitter.fire();
    expect(late).toBe(0);
  });
});
