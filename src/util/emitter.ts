/**
 * Tiny typed event emitter. One observable, many subscribers; subscribe
 * returns an unsubscribe function (no `off()` needed).
 *
 * Subscriber errors are caught so a single broken handler cannot break
 * the producer or sibling subscribers.
 */
export class Emitter<T> {
  #handlers = new Set<(value: T) => void>();

  /** Register a subscriber; returns an unsubscribe function. */
  on(handler: (value: T) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  /** Synchronously fan-out `value` to every subscriber. */
  emit(value: T): void {
    for (const handler of this.#handlers) {
      try {
        handler(value);
      } catch {
        // Subscriber errors must not affect the producer or other subscribers.
      }
    }
  }

  /** Current subscriber count. Diagnostic only. */
  get size(): number {
    return this.#handlers.size;
  }
}
