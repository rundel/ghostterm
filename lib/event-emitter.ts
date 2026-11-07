import type { IDisposable, IEvent } from './interfaces';

export class EventEmitter<T> {
  private listeners: Array<(arg: T) => void> = [];

  fire(arg: T): void {
    // A copy, so a listener that disposes itself (or another) doesn't make
    // the next one miss this event.
    for (const listener of [...this.listeners]) {
      listener(arg);
    }
  }

  event: IEvent<T> = (listener) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  dispose(): void {
    this.listeners = [];
  }
}
