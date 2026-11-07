/**
 * Terminal modes as xterm.js reports them (IModes), read from libghostty.
 */

import type { GhosttyTerminal } from './ghostty';
import type { IModes } from './interfaces';

/** The modes of a terminal that is not open yet: each mode's default. */
export const DEFAULT_MODES: IModes = Object.freeze({
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
});

/** The modes in effect now. */
export function readModes(term: GhosttyTerminal): IModes {
  const dec = (mode: number) => term.getMode(mode, false);
  return {
    applicationCursorKeysMode: dec(1),
    // DECKPAM / DECKPNM (ESC = / ESC >) set DECNKM, mode 66.
    applicationKeypadMode: dec(66),
    bracketedPasteMode: dec(2004),
    insertMode: term.getMode(4, true),
    mouseTrackingMode: mouseTrackingMode(term),
    originMode: dec(6),
    reverseWraparoundMode: dec(45),
    sendFocusMode: dec(1004),
    showCursor: dec(25),
    synchronizedOutputMode: dec(2026),
    wraparoundMode: dec(7),
  };
}

/**
 * The mouse tracking mode. Programs enable one of 9, 1000, 1002 and 1003;
 * should several be set, the one reporting the most events is named.
 */
function mouseTrackingMode(term: GhosttyTerminal): IModes['mouseTrackingMode'] {
  if (!term.hasMouseTracking()) return 'none';
  if (term.getMode(1003, false)) return 'any';
  if (term.getMode(1002, false)) return 'drag';
  if (term.getMode(1000, false)) return 'vt200';
  if (term.getMode(9, false)) return 'x10';
  return 'none';
}
