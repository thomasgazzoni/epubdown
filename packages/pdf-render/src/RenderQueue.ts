import type { RenderQueueConfig } from "./RenderQueueConfig";

export type RenderTaskKind = "critical" | "prefetch";

export interface RenderTask {
  pageNumber: number; // 1-based page number
  priority: number;
  abortSignal: AbortSignal;
  kind: RenderTaskKind;
}

interface InternalRenderTask {
  pageNumber: number; // 1-based page number
  priority: number;
  abortController: AbortController;
  kind: RenderTaskKind;
}

export class RenderQueue {
  private tasks: Map<number, InternalRenderTask> = new Map();
  private config: RenderQueueConfig;
  private currentPage = 1; // 1-based page number

  constructor(config: RenderQueueConfig) {
    this.config = config;
    this.log("RenderQueue initialized", { config });
  }

  private log(message: string, data?: unknown): void {
    if (this.config.debug) {
      console.log(`[RenderQueue] ${message}`, data ?? "");
    }
  }

  /**
   * @deprecated Use setWindow() instead for consistent 1-based API
   * @internal
   */
  private enqueueRange(currentPage: number, totalPages: number): void {
    this.currentPage = currentPage;
    const newRange = this.calculateRange(currentPage, totalPages);

    const cancelled: number[] = [];
    const kept: number[] = [];

    for (const [pageNum] of this.tasks) {
      if (!newRange.has(pageNum)) {
        cancelled.push(pageNum);
        this.cancelTask(pageNum);
      } else {
        kept.push(pageNum);
      }
    }

    const enqueued: number[] = [];
    for (const pageNum of newRange) {
      if (!this.tasks.has(pageNum)) {
        const priority = Math.abs(pageNum - currentPage);
        const abortController = new AbortController();
        this.tasks.set(pageNum, {
          pageNumber: pageNum,
          priority,
          abortController,
          kind: "prefetch",
        });
        enqueued.push(pageNum);
      }
    }

    if (cancelled.length || enqueued.length) {
      this.log(
        `Page ${currentPage} | New: [${enqueued.join(", ")}] | Kept: [${kept.join(", ")}] | Cancelled: [${cancelled.join(", ")}]`,
      );
    }
  }

  /**
   * @deprecated Use setWindow() instead for consistent 1-based API
   * @internal
   */
  private updateCurrentPage(newPage: number, totalPages: number): void {
    this.enqueueRange(newPage, totalPages);
  }

  /**
   * @deprecated Use setWindow() instead for consistent 1-based API
   * @internal
   */
  private setFocus(
    currentPage: number,
    totalPages: number,
    opts?: { lookaround?: number },
  ): void {
    this.currentPage = currentPage;
    let lookaround = opts?.lookaround ?? this.config.lookaheadDistance;

    // enforce maxQueueSize if needed
    const needed = 1 + 2 * lookaround;
    if (needed > this.config.maxQueueSize) {
      lookaround = Math.floor((this.config.maxQueueSize - 1) / 2);
    }

    const target = new Set<number>();

    // Fixed: 1-based page numbers (was 0-based)
    if (currentPage >= 1 && currentPage <= totalPages) {
      target.add(currentPage);
    }

    for (let offset = 1; offset <= lookaround; offset++) {
      const before = currentPage - offset;
      if (before >= 1) target.add(before);
      const after = currentPage + offset;
      if (after <= totalPages) target.add(after);
    }

    const cancelled: number[] = [];
    const kept: number[] = [];

    for (const [pageNum] of this.tasks) {
      if (!target.has(pageNum)) {
        cancelled.push(pageNum);
        this.cancelTask(pageNum);
      } else {
        kept.push(pageNum);
      }
    }

    const enqueued: number[] = [];
    for (const pageNum of target) {
      if (!this.tasks.has(pageNum)) {
        const priority = Math.abs(pageNum - currentPage);
        const abortController = new AbortController();
        const isCritical = pageNum === currentPage;
        this.tasks.set(pageNum, {
          pageNumber: pageNum,
          priority,
          abortController,
          kind: isCritical ? "critical" : "prefetch",
        });
        enqueued.push(pageNum);
      }
    }

    if (cancelled.length || enqueued.length) {
      this.log(
        `setFocus(${currentPage}) | New: [${enqueued.join(", ")}] | Kept: [${kept.join(", ")}] | Cancelled: [${cancelled.join(", ")}]`,
      );
    }
  }

  /**
   * Define a small render window around a center page.
   * Everything outside is cancelled, and priorities are recomputed.
   * This is the preferred API for orchestrating focused rendering.
   * @param center 1-based page number
   * @param before Number of pages before center
   * @param after Number of pages after center
   * @param totalPages Total page count
   */
  setWindow(opts: {
    center: number;
    before: number;
    after: number;
    totalPages: number;
  }): void {
    let { center, before, after, totalPages } = opts;
    this.currentPage = center;

    // Ensure we won't exceed the max queue budget
    const max = this.config.maxQueueSize;
    const needed = 1 + before + after;
    if (needed > max) {
      const budgetAround = Math.max(0, Math.floor((max - 1) / 2));
      before = Math.min(before, budgetAround);
      after = Math.min(after, budgetAround);
    }

    // Build target set (1-based page numbers)
    const target = new Set<number>();
    if (center >= 1 && center <= totalPages) {
      target.add(center);
    }

    for (let i = 1; i <= before; i++) {
      const p = center - i;
      if (p >= 1) target.add(p);
    }
    for (let i = 1; i <= after; i++) {
      const p = center + i;
      if (p <= totalPages) target.add(p);
    }

    // Cancel tasks not in target
    const cancelled: number[] = [];
    const kept: number[] = [];
    for (const [pageNum, task] of this.tasks) {
      if (!target.has(pageNum)) {
        cancelled.push(pageNum);
        task.abortController.abort();
        this.tasks.delete(pageNum);
      } else {
        kept.push(pageNum);
      }
    }

    // Ensure all target pages are present and update priorities
    const enqueued: number[] = [];
    for (const pageNum of target) {
      if (!this.tasks.has(pageNum)) {
        const abortController = new AbortController();
        const priority = Math.abs(pageNum - center);
        const kind = pageNum === center ? "critical" : "prefetch";
        this.tasks.set(pageNum, {
          pageNumber: pageNum,
          priority,
          abortController,
          kind,
        });
        enqueued.push(pageNum);
      } else {
        // Reassign priority and kind for kept tasks
        const task = this.tasks.get(pageNum)!;
        task.priority = Math.abs(pageNum - center);
        task.kind = pageNum === center ? "critical" : "prefetch";
      }
    }

    if (cancelled.length || enqueued.length) {
      this.log(
        `setWindow(center=${center}, before=${before}, after=${after}) | New: [${enqueued.join(", ")}] | Kept: [${kept.join(", ")}] | Cancelled: [${cancelled.join(", ")}]`,
      );
    }
  }

  getNextTask(): RenderTask | null {
    if (this.tasks.size === 0) return null;

    let minPriority = Number.POSITIVE_INFINITY;
    let selected: InternalRenderTask | null = null;

    for (const task of this.tasks.values()) {
      if (task.abortController.signal.aborted) {
        this.tasks.delete(task.pageNumber);
        continue;
      }

      // Determine if this task is better than the current selected task
      // Priority order:
      // 1. Lower priority number (closer to center)
      // 2. Critical over prefetch at same priority
      // 3. Page number as tiebreaker for stable ordering
      const isBetter =
        task.priority < minPriority ||
        (selected &&
          task.priority === minPriority &&
          task.kind === "critical" &&
          selected.kind !== "critical") ||
        (selected &&
          task.priority === minPriority &&
          task.kind === selected.kind &&
          task.pageNumber < selected.pageNumber);

      if (isBetter) {
        minPriority = task.priority;
        selected = task;
      }
    }

    if (selected) {
      this.tasks.delete(selected.pageNumber);
      this.log(
        `Dequeued page ${selected.pageNumber} (priority ${selected.priority}, kind ${selected.kind})`,
      );
      return {
        pageNumber: selected.pageNumber,
        priority: selected.priority,
        abortSignal: selected.abortController.signal,
        kind: selected.kind,
      };
    }

    return null;
  }

  cancelAll(): void {
    if (this.tasks.size === 0) return;
    const pages = Array.from(this.tasks.keys());
    for (const task of this.tasks.values()) {
      task.abortController.abort();
    }
    this.tasks.clear();
    this.log(`Cancelled all ${pages.length} tasks: [${pages.join(", ")}]`);
  }

  isEmpty(): boolean {
    return this.tasks.size === 0;
  }

  /**
   * Calculate render range around current page (1-based)
   */
  private calculateRange(currentPage: number, totalPages: number): Set<number> {
    const range = new Set<number>();
    if (totalPages === 0) return range;

    const { lookaheadDistance } = this.config;

    // Fixed: 1-based page numbers (was 0-based)
    if (currentPage >= 1 && currentPage <= totalPages) {
      range.add(currentPage);
    }

    for (let offset = 1; offset <= lookaheadDistance; offset++) {
      const before = currentPage - offset;
      if (before >= 1) range.add(before);
      const after = currentPage + offset;
      if (after <= totalPages) range.add(after);
    }

    return range;
  }

  private cancelTask(pageNumber: number): void {
    const task = this.tasks.get(pageNumber);
    if (task) {
      task.abortController.abort();
      this.tasks.delete(pageNumber);
    }
  }
}
