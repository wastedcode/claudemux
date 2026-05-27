/**
 * Tiny async mutex. Wraps an async task so calls serialize per-instance.
 *
 * The substrate uses one mutex per `SessionHandle` so concurrent consumer
 * calls (e.g. `send` racing with `capture`) cannot interleave bytes.
 */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `task` with exclusive access. The mutex is released whether the
   * task resolves or rejects.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const prior = this.#tail;
    let resolveNext!: () => void;
    const next = new Promise<void>((res) => {
      resolveNext = res;
    });
    this.#tail = next;
    try {
      await prior;
      return await task();
    } finally {
      resolveNext();
    }
  }
}
