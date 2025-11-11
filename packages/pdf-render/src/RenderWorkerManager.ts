/**
 * RenderWorkerManager - Manages off-main-thread PDF rendering
 *
 * This class coordinates between the main thread and the render worker:
 * - Creates and initializes the Worker
 * - Sends render requests with task IDs
 * - Receives ImageBitmaps via transferable objects
 * - Handles task cancellation
 * - Falls back to main-thread rendering if Workers unavailable
 */

import type {
  WorkerRequest,
  WorkerResponse,
  BitmapResponse,
} from "./renderWorker";
import type { RendererKind } from "./engines/types";
import { canRenderInWorker } from "./offscreenCapabilities";

export interface RenderTask {
  taskId: string;
  pageIndex0: number;
  ppi: number;
  onComplete: (bitmap: ImageBitmap) => void;
  onError: (error: Error) => void;
}

export interface WorkerManagerOptions {
  engine: RendererKind;
  pdfData: Uint8Array;
  wasmUrl?: string;
}

/**
 * Heartbeat interval (milliseconds)
 * How often to ping the worker to check if it's alive
 */
const HEARTBEAT_INTERVAL_MS = 5000; // 5 seconds

/**
 * Heartbeat timeout (milliseconds)
 * If no pong response within this time, worker is considered unresponsive
 */
const HEARTBEAT_TIMEOUT_MS = 15000; // 15 seconds

export class RenderWorkerManager {
  private worker: Worker | null = null;
  private tasks = new Map<string, RenderTask>();
  private initPromise: Promise<number> | null = null;
  private isInitialized = false;
  private pageCount = 0;
  private initTimeoutId: number | null = null;

  // Heartbeat state
  private heartbeatIntervalId: number | null = null;
  private lastHeartbeatResponse = 0;
  private _isWorkerResponsive = true;

  /**
   * Optional callback to handle fatal worker errors
   */
  constructor(private onFatalError?: (err: Error) => void) {}

  /**
   * Check if OffscreenCanvas Worker rendering is supported
   */
  static isSupported(): boolean {
    return typeof Worker !== "undefined" && canRenderInWorker();
  }

  /**
   * Initialize the worker and load the PDF document
   */
  async init(options: WorkerManagerOptions): Promise<number> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init(options);
    return this.initPromise;
  }

  private async _init(options: WorkerManagerOptions): Promise<number> {
    if (this.isInitialized) {
      return this.pageCount;
    }

    const initStartTime = performance.now();
    console.log("[WorkerManager] Initializing render worker");

    // Create worker
    try {
      const workerCreateStart = performance.now();
      // Note: In Vite, this will be handled by the ?worker import
      // For now, we'll use a URL pattern that Vite recognizes
      this.worker = new Worker(new URL("./renderWorker.ts", import.meta.url), {
        type: "module",
      });
      console.log(
        `[WorkerManager] Worker created in ${(performance.now() - workerCreateStart).toFixed(0)}ms`,
      );
    } catch (err) {
      console.error("[WorkerManager] Failed to create worker:", err);
      throw new Error("Worker creation failed");
    }

    // Set up message handler
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.handleWorkerMessage(e.data);
    };

    this.worker.onerror = (err) => {
      console.error("[WorkerManager] Worker error:", err);
      const error = new Error("Worker crashed");
      // Fail all pending tasks
      for (const task of this.tasks.values()) {
        task.onError(error);
      }
      this.tasks.clear();
      // Notify UI of fatal error
      this.onFatalError?.(error);
    };

    // Send init message with ArrayBuffer transfer (zero-copy)
    const initMsg = {
      type: "init" as const,
      engine: options.engine,
      pdfData: options.pdfData.buffer, // ArrayBuffer
      wasmUrl: options.wasmUrl,
    };

    console.log(
      `[WorkerManager] Sending init message (PDF size: ${(options.pdfData.length / 1024 / 1024).toFixed(2)} MB)`,
    );

    // Wait for ready response
    return new Promise((resolve, reject) => {
      this.initTimeoutId = window.setTimeout(() => {
        console.error(
          `[WorkerManager] TIMEOUT after ${(performance.now() - initStartTime).toFixed(0)}ms - worker did not respond with 'ready' message`,
        );
        this.initTimeoutId = null;
        reject(new Error("Worker initialization timeout"));
      }, 30000); // 30s timeout

      const originalHandler = this.worker!.onmessage;
      this.worker!.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        console.log(
          `[WorkerManager] Received message during init: ${msg.type}`,
        );
        if (msg.type === "ready") {
          if (this.initTimeoutId !== null) {
            clearTimeout(this.initTimeoutId);
            this.initTimeoutId = null;
          }
          this.isInitialized = true;
          this.pageCount = msg.pageCount;
          this.worker!.onmessage = originalHandler;
          const totalTime = (performance.now() - initStartTime).toFixed(0);
          console.log(
            `[WorkerManager] Worker ready with ${msg.pageCount} pages (total init: ${totalTime}ms)`,
          );
          // Start heartbeat monitoring after successful initialization
          this.startHeartbeat();
          resolve(msg.pageCount);
        } else if (msg.type === "error") {
          if (this.initTimeoutId !== null) {
            clearTimeout(this.initTimeoutId);
            this.initTimeoutId = null;
          }
          console.error("[WorkerManager] Worker init error:", msg.message);
          reject(new Error(msg.message));
        } else {
          console.warn(
            `[WorkerManager] Unexpected message type during init: ${msg.type}`,
          );
        }
      };

      // Transfer the underlying buffer to the worker (zero copy)
      this.worker!.postMessage(initMsg, [initMsg.pdfData]);
      console.log("[WorkerManager] Init message posted to worker");
    });
  }

  /**
   * Request a page to be rendered
   * Returns a promise that resolves with the ImageBitmap
   */
  async renderPage(
    taskId: string,
    pageIndex0: number,
    ppi: number,
  ): Promise<ImageBitmap> {
    if (!this.isInitialized || !this.worker) {
      throw new Error("Worker not initialized");
    }

    // Create promise for this task
    return new Promise<ImageBitmap>((resolve, reject) => {
      const task: RenderTask = {
        taskId,
        pageIndex0,
        ppi,
        onComplete: resolve,
        onError: reject,
      };

      this.tasks.set(taskId, task);

      // Send render request
      const msg: WorkerRequest = {
        type: "render",
        taskId,
        pageIndex0,
        ppi,
      };

      this.worker!.postMessage(msg);
    });
  }

  /**
   * Cancel a pending render task
   */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.tasks.delete(taskId);

    if (this.worker) {
      const msg: WorkerRequest = {
        type: "cancel",
        taskId,
      };
      this.worker.postMessage(msg);
    }
  }

  /**
   * Handle messages from the worker
   */
  private handleWorkerMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "bitmap": {
        const bitmapMsg = msg as BitmapResponse;
        const task = this.tasks.get(bitmapMsg.taskId);
        if (task) {
          this.tasks.delete(bitmapMsg.taskId);
          task.onComplete(bitmapMsg.bitmap);
        }
        break;
      }
      case "error": {
        const taskId = msg.taskId;
        if (taskId) {
          const task = this.tasks.get(taskId);
          if (task) {
            this.tasks.delete(taskId);
            task.onError(new Error(msg.message));
          }
        } else {
          console.error("[WorkerManager] Worker error:", msg.message);
        }
        break;
      }
      case "pong": {
        // Worker responded to heartbeat - update last response time
        this.lastHeartbeatResponse = performance.now();
        if (!this._isWorkerResponsive) {
          console.log("[WorkerManager] Worker is responsive again");
          this._isWorkerResponsive = true;
        }
        break;
      }
    }
  }

  /**
   * Start heartbeat monitoring
   * Sends periodic pings to worker and checks for responses
   */
  private startHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      return; // Already started
    }

    // Initialize last response time to now
    this.lastHeartbeatResponse = performance.now();
    this._isWorkerResponsive = true;

    // Send heartbeat and check for timeout
    const sendHeartbeat = () => {
      if (!this.worker || !this.isInitialized) {
        return;
      }

      // Send heartbeat ping
      const msg: WorkerRequest = {
        type: "heartbeat",
      };
      this.worker.postMessage(msg);

      // Check if worker is responsive
      const now = performance.now();
      const timeSinceLastResponse = now - this.lastHeartbeatResponse;

      if (timeSinceLastResponse > HEARTBEAT_TIMEOUT_MS) {
        if (this._isWorkerResponsive) {
          console.warn(
            `[WorkerManager] Worker unresponsive (no pong for ${(timeSinceLastResponse / 1000).toFixed(1)}s)`,
          );
          this._isWorkerResponsive = false;
        }
      }
    };

    // Send initial heartbeat
    sendHeartbeat();

    // Schedule periodic heartbeats
    this.heartbeatIntervalId = window.setInterval(
      sendHeartbeat,
      HEARTBEAT_INTERVAL_MS,
    );

    console.log(
      `[WorkerManager] Heartbeat monitoring started (interval: ${HEARTBEAT_INTERVAL_MS}ms, timeout: ${HEARTBEAT_TIMEOUT_MS}ms)`,
    );
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
      console.log("[WorkerManager] Heartbeat monitoring stopped");
    }
  }

  /**
   * Check if worker is currently responsive
   * Returns false if worker hasn't responded to heartbeat within timeout
   */
  get isWorkerResponsive(): boolean {
    return this._isWorkerResponsive;
  }

  /**
   * Terminate the worker and clean up
   */
  destroy(): void {
    // Stop heartbeat monitoring
    this.stopHeartbeat();

    // Cancel pending initialization timeout
    if (this.initTimeoutId !== null) {
      console.log("[WorkerManager] Clearing pending init timeout");
      clearTimeout(this.initTimeoutId);
      this.initTimeoutId = null;
    }

    if (this.worker) {
      console.log("[WorkerManager] Terminating worker");
      this.worker.terminate();
      this.worker = null;
    }

    // Reject all pending tasks
    for (const task of this.tasks.values()) {
      task.onError(new Error("Worker terminated"));
    }
    this.tasks.clear();

    this.isInitialized = false;
    this.initPromise = null;
  }

  /**
   * Get the number of pending render tasks
   */
  getPendingCount(): number {
    return this.tasks.size;
  }
}
