/**
 * Markers - buffer lines that follow their content (xterm.js IMarker)
 *
 * A marker holds a libghostty tracked grid reference to the start of its
 * line, so libghostty moves it as output scrolls, history is pruned and the
 * screen reflows on resize. When its line leaves the buffer (pruned from
 * scrollback, or dropped by ED 3) the reference loses its value and the
 * marker is disposed. As in xterm.js, reset() and clear() dispose every
 * marker, and leaving the alternate screen disposes the markers made on it.
 */

import { EventEmitter } from './event-emitter';
import type { GhosttyTerminal, TrackedRow } from './ghostty';
import type { IDisposable, IEvent, IMarker } from './interfaces';

let nextMarkerId = 1;

export class Marker implements IMarker {
  readonly id = nextMarkerId++;
  private disposeEmitter = new EventEmitter<void>();
  private disposed = false;
  private cachedLine = -1;
  private cachedAt = -1;

  readonly onDispose: IEvent<void> = this.disposeEmitter.event;

  /** @internal Created by MarkerRegistry. */
  constructor(
    private tracked: TrackedRow | null,
    /** @internal Whether the marker was made on the alternate screen. */
    readonly alternate: boolean,
    private registry: MarkerRegistry | null
  ) {
    if (!tracked) this.disposed = true;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The marker's absolute buffer line (0 = oldest scrollback line), or -1 once disposed. */
  get line(): number {
    if (this.disposed || !this.tracked || !this.registry) return -1;
    if (this.cachedAt === this.registry.generation) return this.cachedLine;
    const row = this.tracked.row;
    this.cachedLine = row ?? -1;
    this.cachedAt = this.registry.generation;
    return this.cachedLine;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracked?.free();
    this.tracked = null;
    this.registry?.remove(this);
    this.registry = null;
    // xterm.js fires onDispose before releasing its listeners.
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }

  /** @internal Whether libghostty still tracks the line. */
  hasLine(): boolean {
    return this.tracked?.alive ?? false;
  }
}

/** @internal The markers of one Terminal. */
export class MarkerRegistry implements IDisposable {
  private list: Marker[] = [];
  /** Bumped whenever the terminal may have moved lines; markers cache their line per value. */
  generation = 0;

  get markers(): readonly Marker[] {
    return this.list;
  }

  /**
   * A marker on absolute buffer line `line`; already disposed when the line
   * is outside the buffer, as xterm.js's would be once trimmed.
   */
  create(wasmTerm: GhosttyTerminal, line: number): Marker {
    const tracked = wasmTerm.trackRow(line);
    const marker = new Marker(tracked, wasmTerm.isAlternateScreen(), tracked ? this : null);
    if (tracked) this.list.push(marker);
    return marker;
  }

  /** @internal */
  remove(marker: Marker): void {
    const index = this.list.indexOf(marker);
    if (index >= 0) this.list.splice(index, 1);
  }

  /** The terminal changed: refresh lines and dispose markers whose line is gone. */
  update(): void {
    this.generation++;
    for (const marker of [...this.list]) {
      if (!marker.hasLine()) marker.dispose();
    }
  }

  /** Dispose the markers made on the alternate screen (it was left). */
  disposeAlternate(): void {
    for (const marker of [...this.list]) {
      if (marker.alternate) marker.dispose();
    }
  }

  /** Dispose every marker. */
  clear(): void {
    for (const marker of [...this.list]) marker.dispose();
    this.generation++;
  }

  dispose(): void {
    this.clear();
  }
}
