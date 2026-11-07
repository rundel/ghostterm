import { describe, expect, test } from 'bun:test';
import { PointerRouter } from './pointer-router';

function router(overScrollbar: boolean, tracking: boolean): PointerRouter {
  return new PointerRouter({
    overScrollbar: () => overScrollbar,
    programTracksMouse: () => tracking,
  });
}

const press = (init: MouseEventInit = {}) => new MouseEvent('mousedown', init);
/** happy-dom's WheelEvent ignores modifier keys in its init, so shiftKey is set by hand. */
const wheel = (init: WheelEventInit = {}) => {
  const event = new WheelEvent('wheel', init);
  Object.defineProperty(event, 'shiftKey', { value: !!init.shiftKey });
  return event;
};

describe('PointerRouter', () => {
  test('a press goes to the scrollbar first, then a tracking program, else selection', () => {
    expect(router(true, true).press(press())).toBe('scrollbar');
    expect(router(false, true).press(press())).toBe('program');
    expect(router(false, false).press(press())).toBe('selection');
  });

  test('Shift bypasses mouse reporting, for presses and the wheel', () => {
    expect(router(false, true).press(press({ shiftKey: true }))).toBe('selection');
    expect(router(false, true).wheelTarget(wheel({ shiftKey: true }))).toBe('scroll');
    expect(router(false, true).wheelTarget(wheel())).toBe('program');
    expect(router(true, false).wheelTarget(wheel())).toBe('scroll');
  });

  test('the gesture keeps the target of its press until the next one', () => {
    let tracking = false;
    const r = new PointerRouter({ overScrollbar: () => false, programTracksMouse: () => tracking });
    expect(r.gestureTarget()).toBeNull();
    r.press(press());
    tracking = true;
    expect(r.gestureTarget()).toBe('selection');
    expect(r.targetFor(press())).toBe('program');
    r.press(press());
    expect(r.gestureTarget()).toBe('program');
  });
});
