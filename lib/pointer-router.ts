/**
 * Who handles the pointer over the terminal.
 *
 * Several parts of the terminal listen to the same mouse events: the scrollbar (presses and drags
 * on its gutter), the program (reports, when it tracks the mouse), and text selection and links
 * (everything else). The router makes that choice in one place, once per gesture at the press and
 * once per wheel event, and each listener asks it instead of repeating the checks or stopping
 * propagation for the others.
 */

/** What a press over the terminal starts: a scrollbar drag, a report to the program, a selection. */
export type PointerTarget = 'scrollbar' | 'program' | 'selection';

/** What a wheel event over the terminal does: a report to the program, or scrolling. */
export type WheelTarget = 'program' | 'scroll';

/** What the router needs to know about the terminal. */
export interface PointerHost {
  /** Whether the event is over the scrollbar's track (and there is history to scroll). */
  overScrollbar(event: MouseEvent): boolean;
  /** Whether the program asked for mouse reports. */
  programTracksMouse(): boolean;
}

export class PointerRouter {
  private gesture: PointerTarget | null = null;

  constructor(private host: PointerHost) {}

  /**
   * Where a press would go now. Shift bypasses mouse reporting, so Shift+drag selects even while
   * a program tracks the mouse, as in Ghostty.
   */
  targetFor(event: MouseEvent): PointerTarget {
    if (this.host.overScrollbar(event)) return 'scrollbar';
    if (this.host.programTracksMouse() && !event.shiftKey) return 'program';
    return 'selection';
  }

  /**
   * Start a gesture: decides its target, which holds until the next press. Called by the first
   * mousedown listener (Terminal's, in the capture phase); later listeners read gestureTarget().
   */
  press(event: MouseEvent): PointerTarget {
    this.gesture = this.targetFor(event);
    return this.gesture;
  }

  /** The target of the gesture the last press started, or null before any press. */
  gestureTarget(): PointerTarget | null {
    return this.gesture;
  }

  /** Where a wheel event goes: to a program tracking the mouse (unless Shift is held), else scrolling. */
  wheelTarget(event: WheelEvent): WheelTarget {
    return this.host.programTracksMouse() && !event.shiftKey ? 'program' : 'scroll';
  }
}
