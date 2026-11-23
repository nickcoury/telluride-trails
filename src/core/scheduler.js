/**
 * Time-sliced main-thread task scheduler so streaming uploads and decoding
 * stay under an 8 ms budget per frame.
 */
export function createScheduler(defaultBudgetMs = 6) {
  /** @type {Array<{ id: number, priority: number, fn: () => (boolean|void), label?: string }>} */
  const queue = [];
  let nextId = 1;

  /**
   * Schedule a task. If fn returns `true`, it is re-queued to continue next slice.
   * Lower priority number runs sooner (0 = critical, 10 = normal, 20 = low).
   */
  function enqueue(fn, { priority = 10, label = '' } = {}) {
    const id = nextId++;
    queue.push({ id, priority, fn, label });
    queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    return () => cancel(id);
  }

  function cancel(id) {
    const idx = queue.findIndex((t) => t.id === id);
    if (idx !== -1) queue.splice(idx, 1);
  }

  function runSlice(budgetMs = defaultBudgetMs) {
    const start = performance.now();
    while (queue.length > 0) {
      const elapsed = performance.now() - start;
      if (elapsed >= budgetMs) break;

      const task = queue.shift();
      let more = false;
      try {
        more = task.fn() === true;
      } catch (err) {
        console.error(`[scheduler] task "${task.label}" failed:`, err);
      }
      if (more) {
        queue.push(task);
        queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
        if (performance.now() - start >= budgetMs) break;
      }
    }
  }

  function size() {
    return queue.length;
  }

  function clear() {
    queue.length = 0;
  }

  return { enqueue, cancel, runSlice, size, clear };
}
