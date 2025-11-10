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
  private readonly shouldRetry?: (task: RenderTask) => boolean;
  private running = 0;
  // Track retry counts per page number (1-based)
  private retryCount = new Map<number, number>();
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  // Retry backlog to avoid bypassing maxConcurrent limit
  private retryBacklog: RenderTask[] = [];

  constructor(opts: {
    maxConcurrent: number;
    queue: { getNextTask(): RenderTask | null };
    worker: RenderWorker;
    maxRetries?: number;
    retryDelayMs?: number;
    shouldRetry?: (task: RenderTask) => boolean;
  }) {
    this.maxConcurrent = opts.maxConcurrent;
    this.queue = opts.queue;
    this.worker = opts.worker;
    this.maxRetries = opts.maxRetries ?? 1;
    this.retryDelayMs = opts.retryDelayMs ?? 100;
    this.shouldRetry = opts.shouldRetry;
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
      // First check retry backlog, then regular queue
      const task =
        this.retryBacklog.length > 0
          ? this.retryBacklog.shift()!
          : this.queue.getNextTask();
      if (!task) break;
      this.running++;
      void this.runTask(task);
    }
  }

  /**
   * Execute a single render task with retry on failure
   */
  private async runTask(task: RenderTask) {
    try {
      if (!task.abortSignal.aborted) {
        await this.worker(task);
        // Success - clear retry count
        this.retryCount.delete(task.pageNumber);
      }
    } catch (err) {
      // Don't retry if task was aborted
      if (task.abortSignal.aborted) {
        this.retryCount.delete(task.pageNumber);
        return;
      }

      // Check if we should retry this task (e.g., page may have left render window)
      if (this.shouldRetry && !this.shouldRetry(task)) {
        this.retryCount.delete(task.pageNumber);
        return;
      }

      const retries = this.retryCount.get(task.pageNumber) ?? 0;
      if (retries < this.maxRetries) {
        // Schedule retry with backoff
        this.retryCount.set(task.pageNumber, retries + 1);
        const delay = this.retryDelayMs * Math.pow(2, retries); // Exponential backoff
        console.warn(
          `[RenderScheduler] Render failed for page ${task.pageNumber}, retry ${retries + 1}/${this.maxRetries} in ${delay}ms:`,
          err,
        );
        // Enqueue into retry backlog instead of running directly
        // This ensures we honor maxConcurrent limit
        setTimeout(() => {
          if (!task.abortSignal.aborted) {
            this.retryBacklog.push(task);
            this.pump();
          }
        }, delay);
      } else {
        // Max retries reached - log error and give up
        console.error(
          `[RenderScheduler] Render failed for page ${task.pageNumber} after ${this.maxRetries} retries:`,
          err,
        );
        this.retryCount.delete(task.pageNumber);
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
