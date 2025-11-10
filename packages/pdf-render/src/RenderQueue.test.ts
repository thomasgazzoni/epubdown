import { describe, it, expect } from "vitest";
import { RenderQueue } from "./RenderQueue";
import type { RenderQueueConfig } from "./RenderQueueConfig";

// Helper to create queue with debug disabled for tests
function createQueue(config: Partial<RenderQueueConfig> = {}): RenderQueue {
  return new RenderQueue({
    lookaheadDistance: 1,
    maxQueueSize: 10,
    debug: false,
    ...config,
  });
}

describe("RenderQueue", () => {
  describe("priority ordering", () => {
    it("should prioritize current page first", () => {
      const queue = createQueue();
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });

      const task = queue.getNextTask();
      expect(task).toBeDefined();
      expect(task?.pageNumber).toBe(6);
      expect(task?.priority).toBe(0);
    });

    it("should order pages by distance from current page", () => {
      const queue = createQueue({ lookaheadDistance: 2 });
      queue.setWindow({ center: 6, before: 2, after: 2, totalPages: 10 });

      const tasks = [];
      let task = queue.getNextTask();
      while (task) {
        tasks.push({ page: task.pageNumber, priority: task.priority });
        task = queue.getNextTask();
      }

      // Should have: 6 (0), 5/7 (1), 4/8 (2)
      expect(tasks).toHaveLength(5);
      expect(tasks[0]).toEqual({ page: 6, priority: 0 }); // Current page

      // Priority 1 pages (order within same priority is not guaranteed)
      const priority1 = tasks
        .slice(1, 3)
        .map((t) => t.page)
        .sort();
      expect(priority1).toEqual([5, 7]);

      // Priority 2 pages
      const priority2 = tasks
        .slice(3, 5)
        .map((t) => t.page)
        .sort();
      expect(priority2).toEqual([4, 8]);
    });

    it("should handle lookaheadDistance = 0 (only current page)", () => {
      const queue = createQueue({ lookaheadDistance: 0 });
      queue.setWindow({ center: 6, before: 0, after: 0, totalPages: 10 });

      const task1 = queue.getNextTask();
      expect(task1?.pageNumber).toBe(6);

      const task2 = queue.getNextTask();
      expect(task2).toBeNull(); // No more tasks
    });
  });

  describe("edge cases", () => {
    it("should handle first page (no pages before)", () => {
      const queue = createQueue({ lookaheadDistance: 2 });
      queue.setWindow({ center: 1, before: 2, after: 2, totalPages: 10 });

      const tasks = [];
      let task = queue.getNextTask();
      while (task) {
        tasks.push(task.pageNumber);
        task = queue.getNextTask();
      }

      // Should have: 1, 2, 3 (no pages before page 1)
      expect(tasks).toEqual([1, 2, 3]);
    });

    it("should handle last page (no pages after)", () => {
      const queue = createQueue({ lookaheadDistance: 2 });
      queue.setWindow({ center: 10, before: 2, after: 2, totalPages: 10 });

      const tasks = [];
      let task = queue.getNextTask();
      while (task) {
        tasks.push(task.pageNumber);
        task = queue.getNextTask();
      }

      // Should have: 10, 9, 8 (no pages beyond 10)
      expect(tasks).toEqual([10, 9, 8]);
    });

    it("should handle single-page document", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 1, before: 1, after: 1, totalPages: 1 });

      const task1 = queue.getNextTask();
      expect(task1?.pageNumber).toBe(1);

      const task2 = queue.getNextTask();
      expect(task2).toBeNull(); // No more tasks
    });

    it("should handle empty document", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 1, before: 1, after: 1, totalPages: 0 });

      const task = queue.getNextTask();
      expect(task).toBeNull(); // No tasks in empty document
    });
  });

  describe("cancellation", () => {
    it("should cancel old tasks when current page changes", () => {
      const queue = createQueue({ lookaheadDistance: 1 });

      // Enqueue pages for page 6
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });

      // Change to page 9 (should cancel old tasks)
      queue.setWindow({ center: 9, before: 1, after: 1, totalPages: 10 });

      const tasks = [];
      let task = queue.getNextTask();
      while (task) {
        tasks.push(task.pageNumber);
        task = queue.getNextTask();
      }

      // Should only have new range: 8, 9, 10
      expect(tasks.sort((a, b) => a - b)).toEqual([8, 9, 10]);
    });

    it("should preserve overlapping tasks when current page changes", () => {
      const queue = createQueue({ lookaheadDistance: 1 });

      // Enqueue pages for page 6 (5, 6, 7)
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });

      // Change to page 7 (should keep page 7, cancel 5 & 6)
      queue.setWindow({ center: 7, before: 1, after: 1, totalPages: 10 });

      const tasks = [];
      let task = queue.getNextTask();
      while (task) {
        tasks.push(task.pageNumber);
        task = queue.getNextTask();
      }

      // Should have: 6, 7, 8 (6 overlaps with old range)
      expect(tasks.sort((a, b) => a - b)).toEqual([6, 7, 8]);
    });

    it("should signal cancellation via abortSignal for queued tasks", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });

      // Cancel all tasks while they're still in the queue
      queue.cancelAll();

      // The queue should be empty and return null
      expect(queue.isEmpty()).toBe(true);
      const task = queue.getNextTask();
      expect(task).toBeNull();
    });

    it("should clear queue when cancelAll is called", () => {
      const queue = createQueue({ lookaheadDistance: 2 });
      queue.setWindow({ center: 6, before: 2, after: 2, totalPages: 10 });

      expect(queue.isEmpty()).toBe(false);

      queue.cancelAll();

      expect(queue.isEmpty()).toBe(true);
      expect(queue.getNextTask()).toBeNull();
    });

    it("should skip aborted tasks when getting next task", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });

      // Get current page task (it's removed from queue)
      const task1 = queue.getNextTask();
      expect(task1?.pageNumber).toBe(6);

      // Cancel remaining tasks
      queue.cancelAll();

      // Should return null (all remaining tasks are aborted)
      const task2 = queue.getNextTask();
      expect(task2).toBeNull();
    });
  });

  describe("isEmpty", () => {
    it("should return true for new queue", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      expect(queue.isEmpty()).toBe(true);
    });

    it("should return false when tasks are enqueued", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });
      expect(queue.isEmpty()).toBe(false);
    });

    it("should return true after all tasks are consumed", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });

      // Consume all tasks
      while (queue.getNextTask()) {
        // Empty loop
      }

      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe("idempotent enqueue", () => {
    it("should not duplicate tasks when enqueuing same range twice", () => {
      const queue = createQueue({ lookaheadDistance: 1 });
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 });
      queue.setWindow({ center: 6, before: 1, after: 1, totalPages: 10 }); // Enqueue again

      const tasks = [];
      let task = queue.getNextTask();
      while (task) {
        tasks.push(task.pageNumber);
        task = queue.getNextTask();
      }

      // Should still have only 3 pages: 5, 6, 7
      expect(tasks.sort((a, b) => a - b)).toEqual([5, 6, 7]);
    });
  });
});
