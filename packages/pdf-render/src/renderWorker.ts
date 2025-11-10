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
  pdfData: Uint8Array;
  wasmUrl?: string;
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

export type WorkerRequest =
  | InitMessage
  | RenderMessage
  | CancelMessage
  | PageSizeMessage;

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

export type WorkerResponse =
  | ReadyResponse
  | BitmapResponse
  | ErrorResponse
  | PageSizeResponse;

// Worker state
let engine: PDFEngine | null = null;
let doc: DocumentHandle | null = null;
const activeTasks = new Set<string>();

/**
 * Handle incoming messages from main thread
 */
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
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
  console.log("[Worker] Initializing PDF engine:", msg.engine);

  try {
    // Create engine
    console.log("[Worker] Creating engine...");
    if (msg.engine === "PDFJS") {
      engine = createPdfjsEngine();
    } else if (msg.engine === "PDFium") {
      engine = createPdfiumEngine();
    } else {
      throw new Error(`Unknown engine: ${msg.engine}`);
    }
    console.log(
      `[Worker] Engine created in ${(performance.now() - startTime).toFixed(0)}ms`,
    );

    // Initialize engine
    const initStart = performance.now();
    console.log("[Worker] Initializing engine (loading WASM)...");
    await engine.init({
      wasmUrl: msg.wasmUrl,
      disableWorker: true, // We are the worker!
    });
    console.log(
      `[Worker] Engine initialized in ${(performance.now() - initStart).toFixed(0)}ms`,
    );

    // Load document
    const loadStart = performance.now();
    console.log(
      `[Worker] Loading PDF document (${(msg.pdfData.length / 1024 / 1024).toFixed(2)} MB)...`,
    );
    doc = await engine.loadDocument(msg.pdfData);
    console.log(
      `[Worker] Document loaded in ${(performance.now() - loadStart).toFixed(0)}ms`,
    );

    const response: ReadyResponse = {
      type: "ready",
      pageCount: doc.pageCount(),
    };

    self.postMessage(response);
    console.log(
      `[Worker] READY - Total init time: ${(performance.now() - startTime).toFixed(0)}ms, pages: ${doc.pageCount()}`,
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

  // Check if task was cancelled before starting
  if (!activeTasks.has(taskId)) {
    activeTasks.add(taskId);
  }

  console.log(
    `[Worker] Rendering page ${pageIndex0 + 1} at ${ppi} PPI (task ${taskId})`,
  );

  // Get page size
  const { wPt, hPt } = await doc.getPageSize(pageIndex0);

  // Calculate pixel dimensions
  const wPx = Math.max(1, Math.floor((wPt * ppi) / 72));
  const hPx = Math.max(1, Math.floor((hPt * ppi) / 72));

  // Check if cancelled
  if (!activeTasks.has(taskId)) {
    console.log(`[Worker] Task ${taskId} cancelled before render`);
    return;
  }

  // Create OffscreenCanvas
  const offscreen = new OffscreenCanvas(wPx, hPx);
  const ctx = offscreen.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get 2D context from OffscreenCanvas");
  }

  // Load page and render
  const page = await doc.loadPage(pageIndex0);

  try {
    // Check if cancelled before rendering
    if (!activeTasks.has(taskId)) {
      console.log(`[Worker] Task ${taskId} cancelled before page.render`);
      page.destroy();
      return;
    }

    // Render to OffscreenCanvas
    // Note: The renderToCanvas method expects HTMLCanvasElement, but
    // OffscreenCanvas has the same API for 2D context, so this works
    await (page as any).renderToCanvas(offscreen as any, ppi);

    // Check if cancelled after rendering
    if (!activeTasks.has(taskId)) {
      console.log(`[Worker] Task ${taskId} cancelled after render`);
      page.destroy();
      return;
    }

    // Transfer bitmap to main thread (zero-copy transfer)
    const bitmap = offscreen.transferToImageBitmap();

    const response: BitmapResponse = {
      type: "bitmap",
      taskId,
      pageIndex0,
      bitmap,
    };

    // Transfer bitmap ownership to main thread
    (self as any).postMessage(response, [bitmap]);

    console.log(
      `[Worker] Completed page ${pageIndex0 + 1} (${wPx}x${hPx}) task ${taskId}`,
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
  console.log(`[Worker] Cancelling task ${msg.taskId}`);
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

export {};
