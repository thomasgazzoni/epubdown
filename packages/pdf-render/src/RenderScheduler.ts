import type { RenderTask } from "./RenderQueue";

/**
 * Worker function that performs the actual rendering work for a task
 */
export type RenderWorker = (task: RenderTask) => Promise<void>;

/**
 * RenderScheduler manages concurrent execution of render tasks from a queue.
 *
 * This is a thin layer that pulls tasks from RenderQueue and executes them
 * with controlled concurrency. The scheduler:
 * - Limits concurrent renders (recommended: 1-2 for PDF engines)
 * - Automatically pulls next task when a render completes
 * - Respects task abort signals
 *
 * PERFORMANCE NOTES:
 * - pdf.js and PDFium both benefit from limiting concurrency (1-2 at a time)
 * - Too many concurrent renders can overwhelm the browser
 * - Single-threaded rendering is often faster due to cache locality
 *
 * @example
 * ```typescript
 * const scheduler = new RenderScheduler({
 *   maxConcurrent: 1,
 *   queue: renderQueue,
 *   worker: async (task) => {
 *     const page = await doc.loadPage(task.pageIndex0);
 *     await page.renderToCanvas(canvas, ppi);
 *     page.destroy();
 *   },
 * });
 *
 * // Start processing queue
 * scheduler.pump();
 * ```
 */
export class RenderScheduler {
  private readonly maxConcurrent: number;
  private readonly queue: { getNextTask(): RenderTask | null };
  private readonly worker: RenderWorker;
  private running = 0;

  constructor(opts: {
    maxConcurrent: number;
    queue: { getNextTask(): RenderTask | null };
    worker: RenderWorker;
  }) {
    this.maxConcurrent = opts.maxConcurrent;
    this.queue = opts.queue;
    this.worker = opts.worker;
  }

  /**
   * Start processing tasks from the queue.
   * Call this after enqueueing new tasks to start/continue rendering.
   *
   * This method is idempotent - calling it multiple times is safe.
   * It will only start new workers if below the concurrency limit.
   */
  pump() {
    while (this.running < this.maxConcurrent) {
      const task = this.queue.getNextTask();
      if (!task) break;
      this.running++;
      void this.runTask(task);
    }
  }

  /**
   * Execute a single render task and automatically pump for the next one
   */
  private async runTask(task: RenderTask) {
    try {
      if (!task.abortSignal.aborted) {
        await this.worker(task);
      }
    } finally {
      this.running--;
      this.pump(); // Pull the next task
    }
  }

  /**
   * Get the number of currently running tasks
   */
  getRunningCount(): number {
    return this.running;
  }
}
