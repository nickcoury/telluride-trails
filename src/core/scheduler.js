/**
 * Time-sliced main-thread task scheduler so streaming uploads and decoding
 * stay under an 8 ms budget per frame.
 * Tasks returning `true` yield to the NEXT frame's slice (at most once per frame),
 * preventing high-priority yielding tasks from spinning or starving lower-priority work.
 */
export function createScheduler(defaultBudgetMs = 6) {
  /** @type {Array<{ id: number, priority: number, fn: () => (boolean|void), label?: string, cancelled: boolean }>} */
  const queue = [];
  /** @type {Array<{ id: number, priority: number, fn: () => (boolean|void), label?: string, cancelled: boolean }>} */
  const deferred = [];
  /** @type {Map<number, { id: number, priority: number, fn: () => (boolean|void), label?: string, cancelled: boolean }>} */
  const tasksById = new Map();
  let nextId = 1;
  let dirty = false;

  function sortQueue() {
    if (!dirty) return;
    queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    dirty = false;
  }

  /**
   * Schedule a task. If fn returns `true`, it is deferred to continue in the next frame's slice.
   * Lower priority number runs sooner (0 = critical, 10 = normal, 20 = low).
   */
  function enqueue(fn, { priority = 10, label = '' } = {}) {
    const id = nextId++;
    const task = { id, priority, fn, label, cancelled: false };
    tasksById.set(id, task);
    queue.push(task);
    dirty = true;
    return () => cancel(id);
  }

  function cancel(id) {
    const task = tasksById.get(id);
    if (!task) return;
    task.cancelled = true;
    tasksById.delete(id);
  }

  function runSlice(budgetMs = defaultBudgetMs) {
    const start = performance.now();
    while (queue.length > 0) {
      if (performance.now() - start >= budgetMs) break;
      if (dirty) sortQueue();

      const task = queue.shift();
      if (!task || task.cancelled) continue;

      let more = false;
      try {
        more = task.fn() === true;
      } catch (err) {
        console.error(`[scheduler] task "${task.label}" failed:`, err);
      }

      if (more && !task.cancelled) {
        deferred.push(task);
      } else {
        tasksById.delete(task.id);
      }
    }

    if (deferred.length > 0) {
      for (let i = 0; i < deferred.length; i++) {
        const task = deferred[i];
        if (!task.cancelled) {
          queue.push(task);
          dirty = true;
        }
      }
      deferred.length = 0;
    }
  }

  function size() {
    return tasksById.size;
  }

  function clear() {
    for (const task of tasksById.values()) {
      task.cancelled = true;
    }
    tasksById.clear();
    queue.length = 0;
    deferred.length = 0;
    dirty = false;
  }

  return { enqueue, cancel, runSlice, size, clear };
}
