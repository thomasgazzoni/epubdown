/**
 * PDF Render Worker - Off-main-thread rendering with OffscreenCanvas
 *
 * This worker handles PDF page rendering using OffscreenCanvas, which:
 * - Keeps the main thread responsive during rendering
 * - Produces ImageBitmaps that can be transferred with zero-copy
 * - Enables smooth scrolling/zooming while pages render
 *
 * ARCHITECTURE:
 * 1. Main thread sends: { type: 'init', engine, pdfData }
 * 2. Worker loads PDF and responds: { type: 'ready', pageCount }
 * 3. Main thread requests: { type: 'render', taskId, pageIndex0, ppi }
 * 4. Worker renders and responds: { type: 'bitmap', taskId, pageIndex0, bitmap }
 * 5. Main thread can cancel: { type: 'cancel', taskId }
 */

import { createPdfjsEngine } from "./engines/pdfjs";
import { createPdfiumEngine } from "./engines/pdfium";
import type { DocumentHandle, PDFEngine, RendererKind } from "./engines/types";

// Worker message types
export interface InitMessage {
  type: "init";
  engine: RendererKind;
  pdfData: ArrayBuffer; // ArrayBuffer for zero-copy transfer
  wasmUrl?: string;
}

export interface InitDebugMessage {
  type: "initDebug";
}

export interface RenderMessage {
  type: "render";
  taskId: string;
  pageIndex0: number;
  ppi: number;
}

export interface CancelMessage {
  type: "cancel";
  taskId: string;
}

export interface PageSizeMessage {
  type: "pageSize";
  pageIndex0: number;
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

export type WorkerRequest =
  | InitMessage
  | InitDebugMessage
  | RenderMessage
  | CancelMessage
  | PageSizeMessage
  | HeartbeatMessage;

// Worker response types
export interface ReadyResponse {
  type: "ready";
  pageCount: number;
}

export interface BitmapResponse {
  type: "bitmap";
  taskId: string;
  pageIndex0: number;
  bitmap: ImageBitmap;
}

export interface ErrorResponse {
  type: "error";
  taskId?: string;
  message: string;
}

export interface PageSizeResponse {
  type: "pageSize";
  pageIndex0: number;
  wPt: number;
  hPt: number;
}

export interface PongResponse {
  type: "pong";
  timestamp: number;
}

export type WorkerResponse =
  | ReadyResponse
  | BitmapResponse
  | ErrorResponse
  | PageSizeResponse
  | PongResponse;

// Worker state
let engine: PDFEngine | null = null;
let doc: DocumentHandle | null = null;
const activeTasks = new Set<string>();
let DEBUG = false;

/**
 * Worker logging helper - only logs when DEBUG is enabled
 */
function wlog(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[Worker]", ...args);
  }
}

/**
 * Handle incoming messages from main thread
 */
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case "initDebug":
        DEBUG = true;
        wlog("Debug logging enabled");
        return;
      case "heartbeat":
        handleHeartbeat();
        return;
      case "init":
        await handleInit(msg);
        break;
      case "render":
        await handleRender(msg);
        break;
      case "cancel":
        handleCancel(msg);
        break;
      case "pageSize":
        await handlePageSize(msg);
        break;
    }
  } catch (err) {
    const error: ErrorResponse = {
      type: "error",
      taskId: "taskId" in msg ? msg.taskId : undefined,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(error);
  }
};

/**
 * Initialize PDF engine and load document
 */
async function handleInit(msg: InitMessage): Promise<void> {
  const startTime = performance.now();
  wlog("Initializing PDF engine:", msg.engine);

  try {
    // Create engine
    wlog("Creating engine...");
    if (msg.engine === "PDFJS") {
      engine = createPdfjsEngine();
    } else if (msg.engine === "PDFium") {
      engine = createPdfiumEngine();
    } else {
      throw new Error(`Unknown engine: ${msg.engine}`);
    }
    wlog(`Engine created in ${(performance.now() - startTime).toFixed(0)}ms`);

    // Initialize engine
    const initStart = performance.now();
    wlog("Initializing engine (loading WASM)...");
    await engine.init({
      wasmUrl: msg.wasmUrl,
      disableWorker: true, // We are the worker!
    });
    wlog(
      `Engine initialized in ${(performance.now() - initStart).toFixed(0)}ms`,
    );

    // Load document
    const loadStart = performance.now();
    const pdfData = new Uint8Array(msg.pdfData); // Re-wrap ArrayBuffer
    wlog(
      `Loading PDF document (${(pdfData.length / 1024 / 1024).toFixed(2)} MB)...`,
    );
    doc = await engine.loadDocument(pdfData);
    wlog(`Document loaded in ${(performance.now() - loadStart).toFixed(0)}ms`);

    const response: ReadyResponse = {
      type: "ready",
      pageCount: doc.pageCount(),
    };

    self.postMessage(response);
    wlog(
      `READY - Total init time: ${(performance.now() - startTime).toFixed(0)}ms, pages: ${doc.pageCount()}`,
    );
  } catch (err) {
    console.error("[Worker] Initialization failed:", err);
    throw err;
  }
}

/**
 * Render a page to OffscreenCanvas and return ImageBitmap
 */
async function handleRender(msg: RenderMessage): Promise<void> {
  if (!doc) {
    throw new Error("Document not loaded");
  }

  const { taskId, pageIndex0, ppi } = msg;

  // Early cancel registration
  if (!activeTasks.has(taskId)) {
    activeTasks.add(taskId);
  }

  wlog(`Rendering page ${pageIndex0 + 1} at ${ppi} PPI (task ${taskId})`);

  // Check if cancelled before loading page
  if (!activeTasks.has(taskId)) {
    wlog(`Task ${taskId} cancelled before loadPage`);
    return;
  }

  // Load page first (single operation instead of getPageSize + loadPage)
  const page = await doc.loadPage(pageIndex0);

  try {
    // Check if cancelled before rendering
    if (!activeTasks.has(taskId)) {
      wlog(`Task ${taskId} cancelled after loadPage`);
      return;
    }

    // Create OffscreenCanvas - engine will size it during render
    // Starting with 1x1; renderToCanvas will set the correct size
    const offscreen = new OffscreenCanvas(1, 1);

    // Render to OffscreenCanvas
    // The engine will size the canvas based on page dimensions and PPI
    await page.renderToCanvas(offscreen, ppi);

    // Check if cancelled after rendering
    if (!activeTasks.has(taskId)) {
      wlog(`Task ${taskId} cancelled after render`);
      return;
    }

    // Transfer bitmap to main thread (zero-copy transfer)
    // Note: Safari compatibility is verified by canUseOffscreenPipeline() before worker creation
    // This try-catch is a defensive fallback in case feature detection fails
    let bitmap: ImageBitmap;
    try {
      bitmap = offscreen.transferToImageBitmap();
    } catch (err) {
      // transferToImageBitmap not supported - this should be caught by feature detection
      // but we handle it gracefully just in case
      console.error(
        "[Worker] transferToImageBitmap failed (should be caught by feature detection):",
        err,
      );
      throw new Error(
        "transferToImageBitmap not supported - worker should not be initialized",
      );
    }

    const response: BitmapResponse = {
      type: "bitmap",
      taskId,
      pageIndex0,
      bitmap,
    };

    // Transfer bitmap ownership to main thread
    (self as any).postMessage(response, [bitmap]);

    wlog(
      `Completed page ${pageIndex0 + 1} (${bitmap.width}x${bitmap.height}) task ${taskId}`,
    );
  } finally {
    activeTasks.delete(taskId);
    page.destroy();
  }
}

/**
 * Cancel an active render task
 */
function handleCancel(msg: CancelMessage): void {
  wlog(`Cancelling task ${msg.taskId}`);
  activeTasks.delete(msg.taskId);
}

/**
 * Get page size in points
 */
async function handlePageSize(msg: PageSizeMessage): Promise<void> {
  if (!doc) {
    throw new Error("Document not loaded");
  }

  const { wPt, hPt } = await doc.getPageSize(msg.pageIndex0);

  const response: PageSizeResponse = {
    type: "pageSize",
    pageIndex0: msg.pageIndex0,
    wPt,
    hPt,
  };

  self.postMessage(response);
}

/**
 * Handle heartbeat ping from main thread
 * Responds immediately with a pong to indicate worker is alive
 */
function handleHeartbeat(): void {
  const response: PongResponse = {
    type: "pong",
    timestamp: performance.now(),
  };
  self.postMessage(response);
  wlog("Heartbeat pong sent");
}
