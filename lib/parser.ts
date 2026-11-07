/**
 * Parser hooks (xterm.js IParser)
 *
 * libghostty parses everything, and its C API has no hooks for CSI, ESC or
 * DCS sequences, so handlers for those are accepted and never called (a
 * warning is logged the first time one is registered).
 *
 * OSC handlers work, for every OSC code, including ones libghostty handles
 * itself. While any is registered, writes go through
 * GhosttyTerminal.writeCapturingOsc(): libghostty reports where each OSC
 * string starts, and the payload is passed here before the terminal acts on
 * it. As in xterm.js, handlers for a code run newest first until one returns
 * true; that one consumes the sequence, so libghostty ignores it. Handlers run
 * synchronously: a returned Promise is not awaited and counts as false.
 */

import type { IDisposable, IFunctionIdentifier, IParser } from './interfaces';

/**
 * The line feeds (LF, VT and FF, which libghostty all treats as LF) in
 * written data, for onLineFeed. libghostty doesn't report line feeds, so this
 * counts the bytes: one inside an OSC or DCS string, where it is not a line
 * feed, is counted too.
 */
export function countLineFeeds(data: string | Uint8Array): number {
  let count = 0;
  if (typeof data === 'string') {
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c >= 0x0a && c <= 0x0c) count++;
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      if (data[i] >= 0x0a && data[i] <= 0x0c) count++;
    }
  }
  return count;
}

type OscHandler = (data: string) => boolean | Promise<boolean>;

export class Parser implements IParser {
  private osc = new Map<number, OscHandler[]>();
  private warned = new Set<string>();
  private decoder = new TextDecoder();

  /** @internal Whether writes need to look for OSC strings. */
  get hasOscHandlers(): boolean {
    return this.osc.size > 0;
  }

  registerOscHandler(ident: number, callback: OscHandler): IDisposable {
    if (!Number.isInteger(ident) || ident < 0) {
      throw new Error(`registerOscHandler: invalid OSC code ${ident}`);
    }
    const handlers = this.osc.get(ident) ?? [];
    handlers.push(callback);
    this.osc.set(ident, handlers);
    return {
      dispose: () => {
        const list = this.osc.get(ident);
        const index = list?.indexOf(callback) ?? -1;
        if (!list || index < 0) return;
        list.splice(index, 1);
        if (list.length === 0) this.osc.delete(ident);
      },
    };
  }

  registerCsiHandler(
    _id: IFunctionIdentifier,
    _callback: (params: (number | number[])[]) => boolean | Promise<boolean>
  ): IDisposable {
    return this.unsupported('registerCsiHandler', 'CSI');
  }

  registerDcsHandler(
    _id: IFunctionIdentifier,
    _callback: (data: string, param: (number | number[])[]) => boolean | Promise<boolean>
  ): IDisposable {
    return this.unsupported('registerDcsHandler', 'DCS');
  }

  registerEscHandler(
    _id: IFunctionIdentifier,
    _handler: () => boolean | Promise<boolean>
  ): IDisposable {
    return this.unsupported('registerEscHandler', 'ESC');
  }

  private unsupported(method: string, kind: string): IDisposable {
    if (!this.warned.has(method)) {
      this.warned.add(method);
      console.warn(
        `parser.${method}: libghostty parses ${kind} sequences itself and has no hook for them; the handler is never called.`
      );
    }
    return { dispose: () => {} };
  }

  /**
   * @internal Run the handlers for an OSC payload (the bytes between the
   * introducer and the terminator). Returns true when one consumed it.
   */
  handleOsc(payload: Uint8Array): boolean {
    // "Ps;Pt" or a bare "Ps": a decimal code, then the data.
    let ident = 0;
    let i = 0;
    for (; i < payload.length && payload[i] !== 0x3b; i++) {
      const digit = payload[i] - 0x30;
      if (digit < 0 || digit > 9 || i >= 8) return false;
      ident = ident * 10 + digit;
    }
    if (i === 0) return false;
    const handlers = this.osc.get(ident);
    if (!handlers) return false;
    const data = this.decoder.decode(payload.subarray(i + 1));
    for (const handler of [...handlers].reverse()) {
      let result: boolean | Promise<boolean>;
      try {
        result = handler(data);
      } catch (error) {
        console.error(`OSC ${ident} handler failed:`, error);
        continue;
      }
      if (result === true) return true;
    }
    return false;
  }
}
