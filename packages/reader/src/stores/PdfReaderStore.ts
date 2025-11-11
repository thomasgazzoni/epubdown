import { DEFAULT_PDFIUM_WASM_URL } from "@embedpdf/pdfium";
import {
  type DocumentHandle,
  type PDFEngine,
  type PageData,
  type PageStatus,
  PdfStateStore,
  PdfTocStore,
  RenderQueue,
  RenderScheduler,
  type RenderTask,
  RenderWorkerManager,
  type RendererKind,
  type TocNode,
  canUseOffscreenPipeline,
  createPdfiumEngine,
  createPdfjsEngine,
  logOffscreenCapabilities,
  mergeRenderQueueConfig,
} from "@epubdown/pdf-render";
import { makeAutoObservable, reaction, runInAction } from "mobx";
import type { AppEventSystem } from "../app/context";
import type { PdfPageSizeCache } from "../lib/PdfPageSizeCache";
import type { BookLibraryStore } from "./BookLibraryStore";

export type { PageStatus, PageData, TocNode };

/**
 * ARCHITECTURE: PDF Reader Store
 *
 * This is the central MobX store for PDF viewing functionality. It manages:
 *
 * 1. RENDERING ENGINE:
 *    - Supports two PDF engines: PDFium (WASM) and PDF.js
 *    - Engine choice affects rendering quality and performance
 *    - Each engine has different initialization requirements
 *
 * 2. STATE MANAGEMENT PATTERN:
 *    - MobX observables for reactive UI updates
 *    - Shallow observable for pages array (performance optimization)
 *    - currentPosition is NON-observable to prevent re-renders during scroll
 *    - dimensionRevision counter triggers re-renders when page sizes change
 *
 * 3. MEMORY MANAGEMENT:
 *    - Canvas cache with LRU eviction, byte-based budget (256MB default)
 *    - Only visible pages are rendered (window-based rendering)
 *    - Canvas detachment when pages leave viewport or zoom changes
 *    - Memory budget enforcement after each render cycle
 *
 * 4. RENDERING PIPELINE:
 *    - Visibility tracking → Scheduler trigger → Render cycle → Cache management
 *    - Two-phase rendering: size calculation (ensureSize) then canvas render
 *    - Scroll idle timer (120ms) to debounce render triggers during fast scrolling
 *
 * 5. PAGE SIZE CACHING:
 *    - IndexedDB cache for page dimensions (via PdfPageSizeCache)
 *    - Avoids re-loading page dimensions from PDF on subsequent opens
 *    - Critical for fast initial render with correct layout
 *
 * 6. URL SYNCHRONIZATION:
 *    - URL params: ?page=N&zoom=N&position=0.0-1.0
 *    - preventUrlWrite flag prevents flickering during initial restoration
 *    - writeUrl() throttled via state diffing (lastUrlState)
 *    - position writes are throttled separately in PdfViewer (100ms)
 *
 * 7. TABLE OF CONTENTS:
 *    - Flat outline from PDF engine → Tree structure (buildTocTree)
 *    - Stack-based algorithm for hierarchy reconstruction
 *    - Stable IDs generated from position+content for React keys
 *    - Active item tracks nearest ToC entry to current page
 *
 * 8. COORDINATE SYSTEMS:
 *    - PDF points (pt): 72 dpi, from PDF spec
 *    - Pixels (px): canvas pixels = pt * (effectivePpi/72) * devicePixelRatio
 *    - CSS pixels: px / devicePixelRatio
 *    - Effective PPI: calculated from viewport width and zoomPercent
 *
 * REFACTORING NOTES:
 * - Rendering infrastructure was merged from PdfRenderController into this store
 * - URL sync could be moved to separate concern/service
 * - Memory budget should be configurable based on device capabilities
 * - Future: Consider PageBox with ObservableMap for finer-grained reactivity
 */
export class PdfReaderStore {
  // ═══════════════════════════════════════════════════════════════
  // PDF ENGINE STATE
  // ═══════════════════════════════════════════════════════════════
  // IMPORTANT: Keep pdfBytes for engine switching (PDFium ↔ PDF.js)
  // without reloading from network/storage
  engineKind: RendererKind = "PDFium";
  engine: PDFEngine | null = null;
  doc: DocumentHandle | null = null;
  pdfBytes: Uint8Array | null = null;

  // ═══════════════════════════════════════════════════════════════
  // RENDERING & ZOOM STATE
  // ═══════════════════════════════════════════════════════════════
  pageCount = 0;
  // Current page number (1-based), fully observable for MobX reactivity
  currentPage = 1;
  // Zoom percent for viewport-based zoom (1.0 = 100%, 0.75 = 75%, etc.)
  zoomPercent = 1.0;
  // Last container width used for viewport zoom calculations
  private lastContainerWidth = 0;
  //
  maxPageWidth = 0;

  // ═══════════════════════════════════════════════════════════════
  // SCROLL RESTORATION
  // ═══════════════════════════════════════════════════════════════
  // pendingScrollRestore: Stores position to restore after zoom/dimension change
  // Pattern: Capture position → change zoom → wait for layout → restore position
  pendingScrollRestore: { pageNum: number; position: number } | null = null;
  // devicePixelRatio: Current device pixel ratio (for high-DPI displays)
  // Tracked to detect changes when moving windows between displays
  devicePixelRatio =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // ═══════════════════════════════════════════════════════════════
  // DOCUMENT STATE & RENDERING INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════
  private docState: PdfStateStore;
  private queue: RenderQueue | null = null;
  private scheduler: RenderScheduler | null = null;
  private workerManager: RenderWorkerManager | null = null;
  private useWorker = false; // Feature flag for Worker rendering

  // Bitmap storage (keys are 1-based page numbers)
  private bitmaps = new Map<number, ImageBitmap>(); // Full-res at current PPI
  private canvases = new Map<number, HTMLCanvasElement>(); // Fallback only
  private memoryBytes = 0;
  private bitmapBytes = 0; // Separate tracking for bitmaps
  memoryBudgetBytes = 512 * 1024 * 1024; // 256MB budget
  private debug = false;
  // Performance tracking
  private renderCallCount = 0;
  // Average full render duration tracking (rolling window)
  private renderDurations: number[] = [];
  private readonly MAX_RENDER_SAMPLES = 10;
  // Generation token for canceling stale tasks
  private taskGen = 0;
  // Scroll velocity tracking for adaptive quality
  private lastScrollTime = 0;
  private lastScrollPage = 1;
  private scrollVelocity = 0; // pages per second
  private scrollVelocityTimer: number | null = null;
  // Budget eviction debounce
  private budgetEvictionTimer: number | null = null;

  // ═══════════════════════════════════════════════════════════════
  // VISIBILITY & SCROLL TRACKING
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // DOCUMENT & NAVIGATION STATE
  // ═══════════════════════════════════════════════════════════════
  isLoading = false;
  error: string | null = null;
  currentBookId: number | null = null;
  bookTitle: string | null = null;
  // currentPosition: Scroll position within current page (0.0 = top, 1.0 = bottom)
  // NON-observable → Prevents re-render on every scroll event (performance)
  // Updated directly without triggering MobX reactions
  currentPosition = 0;
  // preventUrlWrite: Flag to prevent URL updates during initial page restoration
  // CRITICAL: Without this, URL flickers from ?page=5 to ?page=1 to ?page=5
  // during mount, causing browser history pollution
  preventUrlWrite = false;

  // ═══════════════════════════════════════════════════════════════
  // INITIAL VIEW RESTORATION STATE
  // ═══════════════════════════════════════════════════════════════
  // isRestoringInitialView: True while waiting for initial page to render
  // Controls loading overlay in PdfViewer component
  isRestoringInitialView = false;
  // restoreTargetPageNum: Which page we're waiting for (1-based)
  // When this page renders, restoration completes
  restoreTargetPageNum: number | null = null;
  // restoreTargetPosition: Scroll position within target page (0.0-1.0)
  restoreTargetPosition = 0;
  // restoreTimer: Safety timeout to unblock UI if page never renders
  private restoreTimer: number | null = null;

  // ═══════════════════════════════════════════════════════════════
  // TABLE OF CONTENTS STATE
  // ═══════════════════════════════════════════════════════════════
  isSidebarOpen = false;
  tocStore: PdfTocStore;

  constructor(
    private lib: BookLibraryStore,
    private events: AppEventSystem,
    private pageSizeCache: PdfPageSizeCache,
  ) {
    // Initialize document state and ToC
    this.docState = new PdfStateStore();
    this.docState.setDevicePixelRatio(this.devicePixelRatio);
    this.tocStore = new PdfTocStore();

    makeAutoObservable(
      this,
      {
        // currentPosition is non-observable to prevent re-renders during scroll
        currentPosition: false,
        // Bitmap/canvas storage Maps are non-observable to prevent re-renders
        // when storing bitmaps for other pages. Reactivity is triggered through
        // pageData.hasFull flag instead.
        bitmaps: false,
        canvases: false,
        memoryBytes: false,
        bitmapBytes: false,
      } as any,
      { autoBind: true },
    );

    // Set up reaction to update document title when page or TOC changes
    reaction(
      () => ({
        page: this.currentPage,
        tocItem: this.tocStore.getCurrentTocItem(this.currentPage),
        title: this.bookTitle,
      }),
      () => this.updateDocumentTitle(),
    );
  }

  /**
   * PPI clamping constants to prevent bitmap blowup
   */
  private readonly MAX_SIDE_PX = 4096; // cap each side
  private readonly MAX_AREA_PX = 16_000_000; // cap total pixels (~4Kx4K)

  /**
   * Clamp effective PPI to prevent huge bitmaps that blow memory budget
   * @param wPt Page width in points
   * @param hPt Page height in points
   * @param requestedPpi Desired effective PPI
   * @returns Safe PPI that respects pixel dimension caps
   */
  private clampPpiForPage(
    wPt: number,
    hPt: number,
    requestedPpi: number,
  ): number {
    // points → pixels: px = (pt * effectivePpi) / 72
    const ppiLimitBySide =
      (this.MAX_SIDE_PX * 72) / Math.max(wPt, hPt) / this.devicePixelRatio;
    const ppiLimitByArea =
      Math.sqrt((this.MAX_AREA_PX * 72 * 72) / (wPt * hPt)) /
      this.devicePixelRatio;
    const safe = Math.min(requestedPpi, ppiLimitBySide, ppiLimitByArea);
    return Math.max(72, Math.floor(safe)); // keep >=72 effective ppi
  }

  /**
   * Track render duration for performance metrics
   */
  private recordRenderDuration(durationMs: number) {
    this.renderDurations.push(durationMs);
    if (this.renderDurations.length > this.MAX_RENDER_SAMPLES) {
      this.renderDurations.shift();
    }
  }

  /**
   * Get average full render duration
   */
  private getAvgFullRenderMs(): number {
    if (this.renderDurations.length === 0) return 0;
    const sum = this.renderDurations.reduce((a, b) => a + b, 0);
    return sum / this.renderDurations.length;
  }

  /**
   * Get effective PPI for rendering
   * @param pageNum Page number to render
   */
  private getEffectivePpi(pageNum: number): number {
    // Get page dimensions
    const pageData = this.docState.getPageData(pageNum);
    if (!pageData?.wPt || !pageData?.hPt || !pageData?.wCss) {
      return 96; // fallback to default PPI
    }

    // Calculate PPI from viewport width and zoom percent
    if (this.lastContainerWidth > 0) {
      const targetCssW = this.lastContainerWidth * this.zoomPercent;
      const effectivePpi = (targetCssW * 72) / pageData.wPt;
      return this.clampPpiForPage(pageData.wPt, pageData.hPt, effectivePpi);
    }

    // Fallback when container width not yet measured
    return 96;
  }

  /**
   * Get current canvas memory usage in bytes (legacy)
   */
  get canvasBytes(): number {
    return this.memoryBytes + this.bitmapBytes;
  }

  /**
   * Get number of currently rendered pages (with bitmaps or canvases)
   */
  get renderedPageCount(): number {
    return this.bitmaps.size + this.canvases.size;
  }

  /**
   * Get current render window bounds for debugging
   */
  get renderWindow(): { start: number; end: number } {
    return {
      start: Math.max(1, this.currentPage - 5),
      end: Math.min(this.pageCount, this.currentPage + 5),
    };
  }

  /**
   * Get bitmap memory usage in bytes
   */
  get bitmapMemoryBytes(): number {
    return this.bitmapBytes;
  }

  /**
   * Get number of full bitmaps
   */
  get fullBitmapCount(): number {
    return this.bitmaps.size;
  }

  private updateDocumentTitle() {
    if (typeof window === "undefined") return;

    const parts: string[] = [];

    // Add current TOC item title if available
    const tocItem = this.tocStore.getCurrentTocItem(this.currentPage);
    if (tocItem?.title) {
      parts.push(tocItem.title);
    }

    // Add book title
    if (this.bookTitle) {
      parts.push(this.bookTitle);
    }

    // Set the title, or use default if no parts
    document.title = parts.length > 0 ? parts.join(" - ") : "PDF Reader";
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  setSidebarOpen(isOpen: boolean) {
    this.isSidebarOpen = isOpen;
  }

  /**
   * Update the active item ID based on current page
   */
  private updateActiveItem() {
    this.tocStore.updateActiveItem(this.currentPage);
  }

  handleTocPageSelect(pageNumber: number) {
    console.log("handleTocPageSelect");
    // Close sidebar on mobile
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      this.setSidebarOpen(false);
    }

    // Navigate to the page
    this.setCurrentPage(pageNumber);

    // Scroll to the page
    // The actual scrolling will be handled by PdfViewer component
    // through the currentPage observable change
  }

  /**
   * Parse URL parameters for initial page restoration
   * Should be called before load() to set up restoration state
   */
  parseUrlParams() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const page = Number(url.searchParams.get("page")) || 1;
    const position = Number(url.searchParams.get("position")) || 0;
    const zoom = Number(url.searchParams.get("zoom")) || 0;

    // Set up restoration if page > 1 or position > 0
    if (page > 1 || position > 0) {
      runInAction(() => {
        this.isRestoringInitialView = true;
        this.restoreTargetPageNum = page;
        this.restoreTargetPosition = position;
        this.preventUrlWrite = true;
        this.currentPage = page;
        // Restore zoom if specified
        if (zoom > 0) {
          this.zoomPercent = zoom;
        }
      });
    }
  }

  async load(bookId: number) {
    this.dispose();
    runInAction(() => {
      this.isLoading = true;
      this.error = null;
      this.currentBookId = bookId;
    });

    try {
      const data = await this.lib.loadBookForReading(bookId);
      if (!data) throw new Error("Book not found");
      const bytes = new Uint8Array(await data.blob.arrayBuffer());
      await this.open(bytes, this.engineKind);
      runInAction(() => {
        this.isLoading = false;
        this.bookTitle = data.metadata.title;
      });

      // Set up pending scroll restore if we're restoring initial view
      if (this.isRestoringInitialView && this.restoreTargetPageNum) {
        const targetPageNum = this.restoreTargetPageNum;
        const targetPosition = this.restoreTargetPosition;
        runInAction(() => {
          this.pendingScrollRestore = {
            pageNum: targetPageNum,
            position: targetPosition,
          };
        });

        // Set safety timeout to unblock UI if page never renders
        if (this.restoreTimer !== null) {
          clearTimeout(this.restoreTimer);
        }
        this.restoreTimer = window.setTimeout(() => {
          console.warn("[PdfReaderStore] Restoration timeout - unblocking UI");
          this.finishInitialRestore();
        }, 2000);
      }

      // Update document title after TOC is loaded
      this.updateDocumentTitle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runInAction(() => {
        this.error = message;
        this.isLoading = false;
        this.isRestoringInitialView = false;
        this.preventUrlWrite = false;
      });
    }
  }

  private makeEngine(kind: RendererKind): PDFEngine {
    return kind === "PDFium" ? createPdfiumEngine() : createPdfjsEngine();
  }

  /**
   * Open PDF document and initialize rendering infrastructure
   *
   * CRITICAL PATH PERFORMANCE:
   * 1. Engine initialization (WASM load for PDFium)
   * 2. Document parsing
   * 3. Page size loading (either from cache or PDF parsing)
   * 4. dimensionRevision++ triggers PdfViewer re-layout
   *
   * PAGE SIZE CACHING STRATEGY:
   * - Cache hit: Instant layout, pages render as they become visible
   * - Cache miss: Load ALL page sizes upfront (sequential, blocks UI)
   *   REFACTOR: Could batch or parallelize page size loading
   *   REFACTOR: Could render visible pages first, load others in background
   *
   * STATE SYNCHRONIZATION:
   * - runInAction() ensures atomic MobX updates
   * - Two runInAction() calls: one for state setup, one for dimensions
   * - dimensionRevision increment is critical trigger for PdfViewer
   *
   * MEMORY CLEANUP:
   * - disposeDocument() cleans up previous PDF if any
   * - New canvas Map is created for the new document
   * - Old canvases are GC'd when store is reset
   */
  async open(data: Uint8Array, kind: RendererKind = "PDFium") {
    this.disposeDocument();
    this.pdfBytes = data;
    this.engineKind = kind;

    // Check if OffscreenCanvas Worker rendering is supported
    logOffscreenCapabilities();
    this.useWorker =
      RenderWorkerManager.isSupported() && canUseOffscreenPipeline();

    console.log(
      `[STORE] Worker rendering: ${this.useWorker ? "enabled" : "disabled"}`,
    );

    // Initialize Worker if supported
    if (this.useWorker) {
      try {
        this.workerManager = new RenderWorkerManager((err) => {
          // Handle fatal worker errors
          runInAction(() => {
            this.error = `Worker error: ${err.message}`;
            console.error("[PdfReaderStore] Worker fatal error:", err);
          });
        });

        // Create a copy of the data for the worker (will be transferred via zero-copy)
        // Keep the original for TOC loading and engine switching
        // This one-time copy cost is acceptable vs. cloning on every postMessage
        const workerData = new Uint8Array(data);

        const pageCount = await this.workerManager.init({
          engine: kind,
          pdfData: workerData,
          wasmUrl: kind === "PDFium" ? DEFAULT_PDFIUM_WASM_URL : undefined,
        });

        console.log(`[STORE] Worker initialized with ${pageCount} pages`);

        runInAction(() => {
          this.pageCount = pageCount;
          this.docState.setTotalPages(pageCount);

          // Initialize render queue and scheduler for Worker
          this.initializeRenderInfrastructure();

          // Initialize state - preserve currentPage during URL restoration
          if (!this.isRestoringInitialView) {
            this.currentPage = 1;
          }
        });

        // Load TOC from main thread (Worker doesn't provide outline)
        // Create a temporary engine just for TOC extraction
        const tocEngine = this.makeEngine(kind);
        const tocInitOptions =
          kind === "PDFium" ? { wasmUrl: DEFAULT_PDFIUM_WASM_URL } : undefined;
        await tocEngine.init(tocInitOptions);
        const tocDoc = await tocEngine.loadDocument(data);
        await this.tocStore.load(tocDoc);
        tocDoc.destroy();

        runInAction(() => {
          this.tocStore.updateActiveItem(this.currentPage);
          this.tocStore.expandToActive();
        });

        // Load page sizes from cache or Worker
        await this.loadPageSizes();

        // Trigger initial render
        this.triggerRender();
        return;
      } catch (err) {
        console.warn(
          "[STORE] Worker initialization failed, falling back to main thread:",
          err,
        );
        this.useWorker = false;
        if (this.workerManager) {
          this.workerManager.destroy();
          this.workerManager = null;
        }
      }
    }

    // Fallback: Main-thread rendering (original code)
    const engine = this.makeEngine(kind);
    const initOptions =
      kind === "PDFium" ? { wasmUrl: DEFAULT_PDFIUM_WASM_URL } : undefined;
    await engine.init(initOptions);
    const doc = await engine.loadDocument(data);

    await this.tocStore.load(doc);

    runInAction(() => {
      this.engine = engine;
      this.doc = doc;
      this.pageCount = doc.pageCount();
      this.docState.setTotalPages(this.pageCount);

      // Initialize render queue and scheduler
      this.initializeRenderInfrastructure();

      // Initialize state (1-based page numbers) - preserve currentPage during URL restoration
      if (!this.isRestoringInitialView) {
        this.currentPage = 1;
      }

      this.tocStore.updateActiveItem(this.currentPage);
      this.tocStore.expandToActive();
    });

    // Load page sizes from cache or PDF
    await this.loadPageSizes();

    // Trigger initial render after page sizes are loaded
    this.triggerRender();
  }

  /**
   * Load page sizes from cache or PDF document
   *
   * This method tries to load page dimensions from cache first. If cache is valid,
   * it applies the cached dimensions. Otherwise, it loads dimensions from the PDF
   * document and saves them to cache.
   *
   * Uses a single loop to process all pages, improving efficiency over the previous
   * approach that had separate loops for cache hit and cache miss cases.
   *
   * NOTE: Cache now uses 1-based page numbers matching our internal representation.
   */
  private async loadPageSizes(): Promise<void> {
    if (!this.currentBookId || this.pageCount === 0) return;

    // Try to load from cache
    const cachedSizes = await this.pageSizeCache.getPageSizes(
      this.currentBookId,
    );
    const hasValidCache = cachedSizes && cachedSizes.length === this.pageCount;

    // Convert cache array to Map for O(1) lookup
    const cacheByPage = new Map(
      cachedSizes?.map((s) => [s.pageNumber, s]) ?? [],
    );

    // Single loop to process all pages (1-based page numbers)
    const newSizes: Array<{
      pageNumber: number;
      widthPt: number;
      heightPt: number;
    }> = [];

    let maxPageWidth = 0;

    // In worker mode without cache, temporarily load doc on main thread for page sizes
    let tempDoc: DocumentHandle | null = null;
    if (!hasValidCache && this.useWorker && !this.doc) {
      if (this.debug) {
        console.log(
          "[PdfReaderStore] Worker mode + no cache: loading doc on main thread for page sizes",
        );
      }
      const engine = this.makeEngine(this.engineKind);
      const initOptions =
        this.engineKind === "PDFium"
          ? { wasmUrl: DEFAULT_PDFIUM_WASM_URL }
          : undefined;
      await engine.init(initOptions);
      if (this.pdfBytes) {
        tempDoc = await engine.loadDocument(this.pdfBytes);
      }
    }

    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      if (hasValidCache) {
        // O(1) lookup instead of O(n) find
        const cached = cacheByPage.get(pageNum);
        if (cached) {
          this.docState.setPageDim(pageNum, cached.widthPt, cached.heightPt);
          const pageData = this.docState.getPageData(pageNum);
          if (pageData?.status === "idle") {
            this.docState.setPageStatus(pageNum, "ready");
          }
          // Track maximum CSS width
          if (pageData?.wCss && pageData.wCss > maxPageWidth) {
            maxPageWidth = pageData.wCss;
          }
        }
      } else {
        // Load from PDF (either this.doc or tempDoc in worker mode)
        if (tempDoc) {
          // Worker mode: use temporary doc
          this.docState.setPageStatus(pageNum, "sizing");
          try {
            const { wPt, hPt } = await tempDoc.getPageSize(pageNum - 1);
            this.docState.setPageDim(pageNum, wPt, hPt);
            this.docState.setPageStatus(pageNum, "ready");
            const pageData = this.docState.getPageData(pageNum);
            if (pageData.wPt && pageData.hPt) {
              newSizes.push({
                pageNumber: pageNum,
                widthPt: pageData.wPt,
                heightPt: pageData.hPt,
              });
              // Track maximum CSS width
              if (pageData.wCss && pageData.wCss > maxPageWidth) {
                maxPageWidth = pageData.wCss;
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.docState.setPageError(pageNum, message);
          }
        } else {
          // Main-thread mode: use ensurePageSize
          await this.ensurePageSize(pageNum);
          const pageData = this.docState.getPageData(pageNum);
          if (pageData.wPt && pageData.hPt) {
            newSizes.push({
              pageNumber: pageNum, // Cache now uses 1-based page numbers
              widthPt: pageData.wPt,
              heightPt: pageData.hPt,
            });
            // Track maximum CSS width
            if (pageData.wCss && pageData.wCss > maxPageWidth) {
              maxPageWidth = pageData.wCss;
            }
          }
        }
      }
    }

    // Clean up temporary doc
    if (tempDoc) {
      tempDoc.destroy();
      if (this.debug) {
        console.log(
          "[PdfReaderStore] Temporary doc destroyed after loading page sizes",
        );
      }
    }

    // Save to cache if we loaded from PDF
    if (!hasValidCache && newSizes.length === this.pageCount) {
      await this.pageSizeCache.savePageSizes(this.currentBookId, newSizes);
    }

    runInAction(() => {
      this.maxPageWidth = maxPageWidth;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CANVAS & MEMORY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get bitmap for a page
   * @param pageNum 1-based page number
   * @returns ImageBitmap if available, null otherwise
   */
  getBitmapForPage(pageNum: number): ImageBitmap | null {
    return this.bitmaps.get(pageNum) ?? null;
  }

  /**
   * Get full bitmap for a page
   * @param pageNum 1-based page number
   */
  getFullBitmap(pageNum: number): ImageBitmap | null {
    return this.bitmaps.get(pageNum) ?? null;
  }

  /**
   * Get canvas for a page (fallback only)
   * @param pageNum 1-based page number
   */
  getCanvas(pageNum: number): HTMLCanvasElement | null {
    return this.canvases.get(pageNum) ?? null;
  }

  /**
   * Calculate canvas memory size in bytes
   */
  private getCanvasSize(canvas: HTMLCanvasElement | null): number {
    return canvas ? (canvas.width | 0) * (canvas.height | 0) * 4 : 0;
  }

  /**
   * Calculate ImageBitmap memory size in bytes
   */
  private getBitmapSize(bitmap: ImageBitmap | null): number {
    return bitmap ? (bitmap.width | 0) * (bitmap.height | 0) * 4 : 0;
  }

  /**
   * Store bitmap for a page
   * @param pageNum 1-based page number
   * @param bitmap ImageBitmap to store
   */
  private async storeBitmap(pageNum: number, bitmap: ImageBitmap) {
    const size = this.getBitmapSize(bitmap);
    this.bitmapBytes += size;

    // Close old full bitmap if exists
    const oldBitmap = this.bitmaps.get(pageNum);
    if (oldBitmap) {
      this.bitmapBytes -= this.getBitmapSize(oldBitmap);
      oldBitmap.close();
    }
    this.bitmaps.set(pageNum, bitmap);
    this.docState.setPageHasFull(pageNum, true);

    // Record render duration for performance metrics
    const pageData = this.docState.getPageData(pageNum);
    if (pageData?.renderDurationMs) {
      this.recordRenderDuration(pageData.renderDurationMs);
    }

    this.docState.setPageRendered(pageNum);
    this.docState.touchPage(pageNum);

    // Note: Memory budget enforcement moved to setCurrentPage and periodic cleanup
    // to avoid evicting bitmaps immediately after storing them
  }

  /**
   * Attach a canvas to a page and update memory tracking (fallback only)
   * @param pageNum 1-based page number
   */
  private attachCanvas(pageNum: number, canvas: HTMLCanvasElement) {
    const size = this.getCanvasSize(canvas);
    this.memoryBytes += size;

    this.canvases.set(pageNum, canvas);
    this.docState.setPageRendered(pageNum);
    this.docState.touchPage(pageNum);

    // Note: Memory budget enforcement moved to setCurrentPage and periodic cleanup
    // to avoid evicting canvases immediately after attaching them
  }

  /**
   * Detach a canvas and update state
   */
  private detachCanvas(pageNum: number, canvas: HTMLCanvasElement) {
    const size = this.getCanvasSize(canvas);
    this.memoryBytes -= size;
    if (this.memoryBytes < 0) this.memoryBytes = 0;

    // Clear canvas memory
    canvas.width = 0;
    canvas.height = 0;

    this.docState.setPageStatus(pageNum, "detached");
  }

  /**
   * Mark all bitmaps as stale (on PPI/zoom change)
   * Keep them displayable but mark for upgrade - no white flashes!
   */
  private markZoomStale() {
    this.taskGen++; // Increment generation to cancel in-flight tasks
    this.docState.markAllFullBitmapsStale();
    // Do NOT clear bitmaps - keep showing them until upgrades arrive
  }

  /**
   * Invalidate the current window (current page ± 1) after zoom/DPR change
   * This forces these pages to be re-rendered with new dimensions.
   *
   * More explicit than relying on "stale" status alone - directly tells
   * the render system these pages need fresh bitmaps.
   */
  private invalidateCurrentWindow() {
    const start = Math.max(1, this.currentPage - 1);
    const end = Math.min(this.pageCount, this.currentPage + 1);

    for (let page = start; page <= end; page++) {
      // Mark as not having full bitmap (forces re-render)
      this.docState.setPageHasFull(page, false);
      // Reset status to idle (ready for rendering)
      this.docState.setPageStatus(page, "idle");
    }
  }

  /**
   * Clear all canvases (e.g., when PPI changes) - legacy fallback
   */
  private clearAllCanvases() {
    for (const [pageNum, canvas] of this.canvases.entries()) {
      this.detachCanvas(pageNum, canvas);
    }
    this.canvases.clear();
    this.memoryBytes = 0;
  }

  /**
   * Enforce memory budget by removing least recently used canvases.
   *
   * CRITICAL: Protects pages in the render window (current ± 5) from eviction
   * to prevent visible pages from disappearing. Only evicts pages outside
   * the render window, starting with least recently used.
   */
  /**
   * Schedule gentle memory budget enforcement (debounced)
   * Don't evict during hot scroll - wait for things to settle
   */
  private scheduleMemoryBudgetEnforcement() {
    const totalBytes = this.memoryBytes + this.bitmapBytes;

    // If we're far over budget (>130%), enforce immediately
    if (totalBytes > this.memoryBudgetBytes * 1.3) {
      if (this.budgetEvictionTimer !== null) {
        clearTimeout(this.budgetEvictionTimer);
        this.budgetEvictionTimer = null;
      }
      this.enforceMemoryBudget();
      return;
    }

    // Otherwise, debounce evictions to avoid work during scroll
    if (this.budgetEvictionTimer !== null) {
      clearTimeout(this.budgetEvictionTimer);
    }
    this.budgetEvictionTimer = window.setTimeout(() => {
      this.enforceMemoryBudget();
      this.budgetEvictionTimer = null;
    }, 100); // 100ms debounce
  }

  /**
   * Enforce memory budget by evicting bitmaps (LRU policy)
   *
   * Eviction priority:
   * 1. Full bitmaps outside window (LRU)
   * 2. Full bitmaps inside window if still over budget (LRU)
   */
  private enforceMemoryBudget() {
    const totalBytes = this.memoryBytes + this.bitmapBytes;
    if (totalBytes <= this.memoryBudgetBytes) return;

    if (this.debug) {
      console.log(
        `[MEMORY] Over budget: ${(totalBytes / 1024 / 1024).toFixed(1)} MB / ${(this.memoryBudgetBytes / 1024 / 1024).toFixed(0)} MB`,
      );
    }

    // Protect pages in render window (current ± 1, matching lookahead)
    const windowStart = Math.max(1, this.currentPage - 1);
    const windowEnd = Math.min(this.pageCount, this.currentPage + 1);

    // Get pages sorted by last touch time (least recently used first)
    const pages = this.docState.getPagesSortedByTouch();

    // First pass: evict full bitmaps outside window
    for (const page of pages) {
      if (this.memoryBytes + this.bitmapBytes <= this.memoryBudgetBytes) break;

      // Skip pages in render window
      if (page.pageNumber >= windowStart && page.pageNumber <= windowEnd) {
        continue;
      }

      // Evict full bitmap if exists
      const bitmap = this.bitmaps.get(page.pageNumber);
      if (bitmap) {
        const size = this.getBitmapSize(bitmap);
        if (this.debug) {
          console.log(
            `[MEMORY] Evicting page ${page.pageNumber} full bitmap (${(size / 1024 / 1024).toFixed(2)} MB)`,
          );
        }
        this.bitmapBytes -= size;
        bitmap.close();
        this.bitmaps.delete(page.pageNumber);
        this.docState.setPageHasFull(page.pageNumber, false);
      }

      // Evict canvas fallback if exists
      const canvas = this.canvases.get(page.pageNumber);
      if (canvas) {
        const size = this.getCanvasSize(canvas);
        if (this.debug) {
          console.log(
            `[MEMORY] Evicting page ${page.pageNumber} canvas (${(size / 1024 / 1024).toFixed(2)} MB)`,
          );
        }
        this.detachCanvas(page.pageNumber, canvas);
        this.canvases.delete(page.pageNumber);
      }
    }

    // Second pass: if still over budget, evict full bitmaps inside window (emergency)
    if (this.memoryBytes + this.bitmapBytes > this.memoryBudgetBytes) {
      if (this.debug) {
        console.log(
          "[MEMORY] Still over budget after first pass, evicting inside window",
        );
      }
      for (const page of pages) {
        if (this.memoryBytes + this.bitmapBytes <= this.memoryBudgetBytes)
          break;

        const bitmap = this.bitmaps.get(page.pageNumber);
        if (bitmap) {
          const size = this.getBitmapSize(bitmap);
          if (this.debug) {
            console.log(
              `[MEMORY] EMERGENCY: Evicting page ${page.pageNumber} full bitmap (${(size / 1024 / 1024).toFixed(2)} MB)`,
            );
          }
          this.bitmapBytes -= size;
          bitmap.close();
          this.bitmaps.delete(page.pageNumber);
          this.docState.setPageHasFull(page.pageNumber, false);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDERING INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize render queue and scheduler
   *
   * Configuration:
   * - lookaheadDistance: How many pages to prefetch in each direction
   * - maxConcurrent: Limit concurrent renders (2 is optimal for PDF engines)
   *
   * The RenderQueue handles prioritization and cancellation, ensuring:
   * - Current page renders first (critical priority)
   * - Adjacent pages render next (prefetch)
   * - Pages far from center are cancelled
   *
   * WEB WORKERS:
   * PDF rendering cannot be moved to web workers because:
   * - PDF engines (PDFium/PDF.js) need DOM canvas access
   * - OffscreenCanvas could work but requires significant refactoring
   * - The rendering itself is already off the main thread (WASM/native)
   * - Yielding to event loop (setTimeout 0) keeps UI responsive
   */
  private initializeRenderInfrastructure() {
    this.queue = new RenderQueue(
      mergeRenderQueueConfig({
        // Render current ± 1 page for immediate adjacent page readiness
        // Larger windows cause unnecessary re-queuing on scroll
        lookaheadDistance: 1, // Render current ± 1 pages
        debug: this.debug,
      }),
    );

    this.scheduler = new RenderScheduler({
      maxConcurrent: 2, // Limit to 2 concurrent renders
      queue: this.queue,
      worker: (task) => this.performRender(task),
    });
  }

  /**
   * Perform actual render task
   */
  private async performRender(task: RenderTask): Promise<void> {
    this.renderCallCount++;

    if (task.abortSignal.aborted) {
      return;
    }

    // Skip rendering ONLY if page has a fresh bitmap at current zoom
    // IMPORTANT: Pages marked "stale" need re-rendering (zoom changed)
    // Note: status can be "rendered", "stale", "rendering", etc.
    // We only skip if status is exactly "rendered" (not "stale")
    const pageData = this.docState.getPageData(task.pageNumber);
    if (pageData?.hasFull && pageData.status === "rendered") {
      // Page already rendered at current zoom level, skip re-render
      // (status "stale" will NOT match this check and will proceed to render)
      return;
    }

    // Use Worker rendering if available
    if (this.useWorker && this.workerManager) {
      return this.performWorkerRender(task);
    }

    // Fallback: Main-thread rendering
    if (!this.doc) {
      return;
    }

    let page: Awaited<ReturnType<DocumentHandle["loadPage"]>> | null = null;

    try {
      this.docState.setPageStatus(task.pageNumber, "rendering");

      // Convert to 0-based index for PDF engine
      page = await this.doc.loadPage(task.pageNumber - 1);

      if (task.abortSignal.aborted) {
        return;
      }

      // Create canvas and render
      const canvas = document.createElement("canvas");

      // Yield to event loop before expensive render to keep UI responsive
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (task.abortSignal.aborted) {
        return;
      }

      // Use effective PPI (clamped based on page size)
      const effectivePpi = this.getEffectivePpi(task.pageNumber);
      await page.renderToCanvas(canvas, effectivePpi);

      if (!task.abortSignal.aborted) {
        // Try to create ImageBitmap for better memory management
        // Fall back to canvas if createImageBitmap is not supported
        try {
          const bitmap = await createImageBitmap(canvas);

          if (!task.abortSignal.aborted) {
            // Store bitmap and update state
            runInAction(() => {
              this.storeBitmap(task.pageNumber, bitmap);

              // Check if this is the page we were waiting for during initial restoration
              if (
                this.isRestoringInitialView &&
                this.restoreTargetPageNum === task.pageNumber
              ) {
                this.finishInitialRestore();
              }
            });
          } else {
            // Clean up bitmap if aborted
            bitmap.close();
          }
        } catch (bitmapErr) {
          // createImageBitmap not supported or failed - fall back to canvas
          console.warn(
            `[PdfReaderStore] createImageBitmap failed for page ${task.pageNumber}, using canvas fallback:`,
            bitmapErr,
          );
          if (!task.abortSignal.aborted) {
            runInAction(() => {
              this.attachCanvas(task.pageNumber, canvas);

              // Check if this is the page we were waiting for during initial restoration
              if (
                this.isRestoringInitialView &&
                this.restoreTargetPageNum === task.pageNumber
              ) {
                this.finishInitialRestore();
              }
            });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[PdfReaderStore] Error rendering page ${task.pageNumber}:`,
        err,
      );
      runInAction(() => {
        this.docState.setPageError(task.pageNumber, message);
      });
    } finally {
      page?.destroy();
    }
  }

  /**
   * Perform render task using Worker (OffscreenCanvas)
   */
  private async performWorkerRender(task: RenderTask): Promise<void> {
    if (!this.workerManager) return;

    try {
      this.docState.setPageStatus(task.pageNumber, "rendering");

      const taskId = `${task.pageNumber}-${Date.now()}`;

      // Use effective PPI (clamped based on page size)
      const effectivePpi = this.getEffectivePpi(task.pageNumber);

      // Request render from Worker (0-based page index)
      const bitmap = await this.workerManager.renderPage(
        taskId,
        task.pageNumber - 1,
        effectivePpi,
      );

      // Check if task was aborted while waiting for Worker
      if (task.abortSignal.aborted) {
        bitmap.close();
        return;
      }

      // Store bitmap and update state
      runInAction(() => {
        this.storeBitmap(task.pageNumber, bitmap);

        // Check if this is the page we were waiting for during initial restoration
        if (
          this.isRestoringInitialView &&
          this.restoreTargetPageNum === task.pageNumber
        ) {
          this.finishInitialRestore();
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[PdfReaderStore] Worker error rendering page ${task.pageNumber}:`,
        err,
      );
      runInAction(() => {
        this.docState.setPageError(task.pageNumber, message);
      });
    }
  }

  /**
   * Update the render window and trigger rendering
   *
   * The RenderQueue uses a window-based approach where:
   * - center: Current page (highest priority)
   * - before/after: Pages to render in each direction
   * - Pages outside window are cancelled
   * - Pages closer to center have higher priority
   */
  private updateRenderWindow() {
    if (!this.queue) return;

    // Render current page ± 1 page (immediate neighbors only)
    const windowConfig = {
      center: this.currentPage,
      before: 1,
      after: 1,
      totalPages: this.pageCount,
    };

    this.queue.setWindow(windowConfig);
    this.scheduler?.pump();
  }

  /**
   * Trigger a render cycle
   */
  private triggerRender(): void {
    this.updateRenderWindow();
  }

  /**
   * Cancel all pending render tasks
   */
  cancelAll() {
    this.queue?.cancelAll();
  }

  /**
   * Get the number of currently running render tasks
   */
  getRunningCount(): number {
    return this.scheduler?.getRunningCount() ?? 0;
  }

  /**
   * Check if Worker rendering is active
   */
  get isWorkerActive(): boolean {
    return this.useWorker && this.workerManager !== null;
  }

  /**
   * Get Worker pending task count
   */
  get workerPendingCount(): number {
    return this.workerManager?.getPendingCount() ?? 0;
  }

  /**
   * Check if Worker is responsive (receiving heartbeat responses)
   * Returns false if worker hasn't responded to heartbeat within timeout
   */
  get isWorkerResponsive(): boolean {
    return this.workerManager?.isWorkerResponsive ?? true;
  }

  /**
   * Load page size (dimensions) if not already loaded
   * @param pageNum 1-based page number
   */
  async ensurePageSize(pageNum: number): Promise<void> {
    if (pageNum < 1 || pageNum > this.pageCount) return;
    if (this.docState.hasDimensions(pageNum)) return;

    if (!this.doc) {
      console.warn(
        `[PdfReaderStore] Cannot load page size ${pageNum}: no document attached`,
      );
      return;
    }

    this.docState.setPageStatus(pageNum, "sizing");

    try {
      // Convert to 0-based index for PDF engine
      const { wPt, hPt } = await this.doc.getPageSize(pageNum - 1);
      this.docState.setPageDim(pageNum, wPt, hPt);
      this.docState.setPageStatus(pageNum, "ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.docState.setPageError(pageNum, message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ZOOM MANIPULATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Calculate effective PPI needed to fit page width to container
   * (Used for legacy compatibility, prefer viewport zoom percent)
   */
  getMaxPpi(containerWidth: number, devicePixelRatio: number): number {
    if (!containerWidth || containerWidth <= 0 || this.pageCount === 0) {
      return 192;
    }

    const pageData = this.docState.getPageData(this.currentPage);
    if (!pageData?.wPt) return 192;

    // Calculate the effective PPI needed to fit the page width to the container
    const targetPx = containerWidth * devicePixelRatio;
    const ppiFit = (targetPx * 72) / pageData.wPt;

    return Math.round(ppiFit);
  }

  /**
   * Recalculate all page dimensions based on current zoom.
   */
  recalculateDimensions() {
    // Force recalculation of pixel dimensions for all pages
    if (this.lastContainerWidth > 0) {
      this.docState.setViewportZoom(this.lastContainerWidth, this.zoomPercent);
    }
  }

  /**
   * Apply viewport-based zoom to all pages
   * @param containerWidth Container width in CSS pixels
   */
  applyViewportZoom(containerWidth: number) {
    if (containerWidth <= 0) return;
    this.lastContainerWidth = containerWidth;
    this.docState.setViewportZoom(containerWidth, this.zoomPercent);
  }

  /**
   * Zoom in to next level
   * @param containerWidth Optional container width (falls back to lastContainerWidth)
   */
  zoomIn(
    currentPosition: number,
    zoomLevels: number[],
    containerWidth?: number,
  ) {
    this.setPendingScrollRestore(this.currentPage, currentPosition);

    // Find current zoom level
    let currentIndex = zoomLevels.findIndex(
      (z) => Math.abs(z - this.zoomPercent) < 0.01,
    );
    if (currentIndex === -1) {
      // Not at a standard level, find next level up
      currentIndex = zoomLevels.findIndex((z) => z > this.zoomPercent);
      if (currentIndex === -1) currentIndex = zoomLevels.length - 1;
      else currentIndex--;
    }

    const newIndex = Math.min(zoomLevels.length - 1, currentIndex + 1);
    const newZoom = zoomLevels[newIndex];

    if (newZoom && Math.abs(newZoom - this.zoomPercent) > 0.01) {
      this.setZoomPercent(newZoom, containerWidth);
    }
  }

  /**
   * Zoom out to previous level
   * @param containerWidth Optional container width (falls back to lastContainerWidth)
   */
  zoomOut(
    currentPosition: number,
    zoomLevels: number[],
    containerWidth?: number,
  ) {
    this.setPendingScrollRestore(this.currentPage, currentPosition);

    // Find current zoom level
    let currentIndex = zoomLevels.findIndex(
      (z) => Math.abs(z - this.zoomPercent) < 0.01,
    );
    if (currentIndex === -1) {
      // Not at a standard level, find next level down
      currentIndex = zoomLevels.findIndex((z) => z >= this.zoomPercent);
      if (currentIndex === -1) currentIndex = zoomLevels.length;
    }

    const newIndex = Math.max(0, currentIndex - 1);
    const newZoom = zoomLevels[newIndex];

    if (newZoom && Math.abs(newZoom - this.zoomPercent) > 0.01) {
      this.setZoomPercent(newZoom, containerWidth);
    }
  }

  /**
   * Reset zoom to 100% (fit to container width)
   * @param containerWidth Optional container width (falls back to lastContainerWidth)
   */
  resetZoom(currentPosition: number, containerWidth?: number) {
    this.setPendingScrollRestore(this.currentPage, currentPosition);
    if (Math.abs(this.zoomPercent - 1.0) > 0.01) {
      this.setZoomPercent(1.0, containerWidth);
    }
  }

  /**
   * Fit current page to container width (same as 100% in viewport mode)
   * @param containerWidth Optional container width (falls back to lastContainerWidth)
   */
  fitToWidth(currentPosition: number, containerWidth?: number) {
    this.setPendingScrollRestore(this.currentPage, currentPosition);
    // In viewport mode, fit = 100% = 1.0
    if (Math.abs(this.zoomPercent - 1.0) > 0.01) {
      this.setZoomPercent(1.0, containerWidth);
    }
  }

  /**
   * Check if zoom in is possible
   */
  canZoomIn(zoomLevels: number[]): boolean {
    const maxZoom = zoomLevels[zoomLevels.length - 1] ?? 2.0;
    return this.zoomPercent < maxZoom - 0.01;
  }

  /**
   * Check if zoom out is possible
   */
  canZoomOut(zoomLevels: number[]): boolean {
    const minZoom = zoomLevels[0] ?? 0.5;
    return this.zoomPercent > minZoom + 0.01;
  }

  /**
   * Set zoom percent and apply viewport zoom
   * @param zoomPercent Zoom fraction (1.0 = 100%, 0.75 = 75%, etc.)
   * @param containerWidth Optional container width (falls back to lastContainerWidth)
   */
  setZoomPercent(zoomPercent: number, containerWidth?: number) {
    if (Math.abs(zoomPercent - this.zoomPercent) < 0.01) return;
    this.zoomPercent = zoomPercent;

    // Use provided width or fall back to last known width
    const width = containerWidth ?? this.lastContainerWidth;

    // Apply viewport zoom if we have container width
    if (width > 0) {
      // 1) Recompute CSS/pixel sizes (also marks pages stale inside PdfState)
      this.applyViewportZoom(width);

      // 2) Explicitly invalidate visible window to force re-render
      this.invalidateCurrentWindow();

      // 3) Mark all bitmaps stale (for background pages)
      this.markZoomStale();

      // 4) Drop old tasks and requeue current ±1
      this.cancelAll();
      this.triggerRender();
    }
  }

  onScroll() {
    // Trigger render immediately on scroll to ensure adjacent pages start rendering
    // The RenderQueue will prioritize pages closer to currentPage and cancel distant ones
    this.triggerRender();
  }

  setCurrentPage(pageNumber: number) {
    const pageNum = Math.max(1, Math.min(this.pageCount, pageNumber));

    // Early return if page hasn't changed
    if (pageNum === this.currentPage) {
      return;
    }

    // Track scroll velocity for adaptive quality
    const now = Date.now();
    const timeDelta = now - this.lastScrollTime;
    const pageDelta = Math.abs(pageNum - this.lastScrollPage);

    if (timeDelta > 0 && timeDelta < 1000) {
      // Calculate pages per second
      this.scrollVelocity = (pageDelta / timeDelta) * 1000;
    } else {
      this.scrollVelocity = 0;
    }

    this.lastScrollTime = now;
    this.lastScrollPage = pageNum;

    // Reset velocity to 0 after 200ms of no scrolling
    if (this.scrollVelocityTimer !== null) {
      clearTimeout(this.scrollVelocityTimer);
    }
    this.scrollVelocityTimer = window.setTimeout(() => {
      this.scrollVelocity = 0;
      // Trigger upgrade to full quality after scroll stops
      this.triggerRender();
    }, 200);

    // Calculate the page jump distance
    const oldPage = this.currentPage;
    const pageJump = Math.abs(pageNum - oldPage);

    // If jumping more than 10 pages, cancel in-flight renders
    // to avoid wasting time rendering pages we're jumping away from
    if (pageJump > 10) {
      this.cancelAll();
    }

    // Update observable state (triggers MobX reactions)
    this.currentPage = pageNum;

    // Trigger render with new current page
    this.triggerRender();

    // Use gentle budget enforcement (debounced)
    this.scheduleMemoryBudgetEnforcement();

    this.writeUrl();

    // Update active item when page changes
    this.updateActiveItem();
  }

  updateFromUrl(url: URL) {
    const page = Number(url.searchParams.get("page") ?? 0);
    if (page > 0) {
      this.setCurrentPage(page);
    }
    const zoom = Number(url.searchParams.get("zoom") ?? 0);
    if (zoom > 0) {
      this.setZoomPercent(zoom);
    }
    const position = Number(url.searchParams.get("position") ?? 0);
    if (position >= 0 && position <= 1) {
      this.currentPosition = position;
    }
  }

  private lastUrlState: {
    page: number;
    zoom: string;
    position: string;
  } | null = null;

  /**
   * Synchronize current state to URL query parameters
   *
   * URL FORMAT: ?page=5&zoom=1.0&position=0.234
   * - page: 1-based page number
   * - zoom: viewport zoom percent (1.0 = 100%, 0.75 = 75%, etc.)
   * - position: scroll position within page (0.0-1.0)
   *
   * THROTTLING STRATEGY:
   * - State diffing via lastUrlState (prevents redundant history updates)
   * - preventUrlWrite flag (prevents flickering during initial load)
   * - Additional throttling in PdfViewer for position updates (100ms)
   *
   * CRITICAL TIMING:
   * - preventUrlWrite is TRUE during initial page restoration (450ms)
   * - This prevents URL flickering: ?page=5 → ?page=1 → ?page=5
   * - Must be FALSE before user can navigate (or URL won't update)
   *
   * BROWSER HISTORY:
   * - Uses replaceState (not pushState) to avoid polluting history
   * - Each scroll/zoom doesn't create a new history entry
   * - Only explicit navigation (clicking ToC) should use pushState
   *
   * REFACTOR CONSIDERATIONS:
   * - Could use URL hash instead of query params for client-side routing
   * - Could debounce position updates more aggressively
   * - Could extract to separate URLSyncService
   */
  writeUrl() {
    if (typeof window === "undefined") return;
    // Don't write URL during initial restoration to prevent flickering
    if (this.preventUrlWrite) return;

    const positionStr = this.currentPosition.toFixed(3);
    const zoomValue = this.zoomPercent.toFixed(3);
    const newState = {
      page: this.currentPage,
      zoom: zoomValue,
      position: positionStr,
    };

    // Skip if nothing changed
    if (
      this.lastUrlState &&
      this.lastUrlState.page === newState.page &&
      this.lastUrlState.zoom === newState.zoom &&
      this.lastUrlState.position === newState.position
    ) {
      return;
    }

    this.lastUrlState = newState;
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(newState.page));
    url.searchParams.set("zoom", newState.zoom);
    url.searchParams.set("position", positionStr);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  setPosition(position: number) {
    const newPos = Math.max(0, Math.min(1, position));
    this.currentPosition = newPos;
    this.writeUrl();
  }

  /**
   * Begin initial page restoration
   * Called once we know which page/position to show first
   * (typically after loading PDF and reading URL params)
   * @param targetPageNum 1-based page number
   */
  beginInitialRestore(targetPageNum: number, position: number) {
    // Guard against invalid page number
    if (targetPageNum < 1 || targetPageNum > this.pageCount) return;

    this.isRestoringInitialView = true;
    this.restoreTargetPageNum = targetPageNum;
    this.restoreTargetPosition = position;

    // Safety timeout: in case page never gets rendered we still unblock UI
    if (this.restoreTimer !== null) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.restoreTimer = window.setTimeout(() => {
      this.finishInitialRestore();
    }, 2000); // 2 second timeout matches component behavior
  }

  /**
   * Finish initial page restoration
   * Called by render-completion callback or by timeout
   */
  finishInitialRestore() {
    this.isRestoringInitialView = false;
    this.restoreTargetPageNum = null;
    if (this.restoreTimer !== null) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    // Re-enable URL writes now that restoration is complete
    this.preventUrlWrite = false;
  }

  /**
   * Update device pixel ratio (called when display changes)
   */
  updateDevicePixelRatio(dpr: number) {
    if (Math.abs(this.devicePixelRatio - dpr) < 0.001) return;
    this.devicePixelRatio = dpr;

    // setDevicePixelRatio will recalculate dimensions and mark stale only if changed
    this.docState.setDevicePixelRatio(dpr);

    // Reapply viewport zoom to recalculate with new DPR
    // (setDevicePixelRatio already handled dimension recalc, but not per-page viewport zoom)
    if (this.lastContainerWidth > 0) {
      this.applyViewportZoom(this.lastContainerWidth);
    }

    // Explicitly invalidate visible window to force re-render at new DPR
    this.invalidateCurrentWindow();

    // Trigger re-render with new DPR (only if dimensions changed)
    this.triggerRender();
  }

  /**
   * Store scroll position to restore after zoom/dimension change
   * @param pageNum 1-based page number
   */
  setPendingScrollRestore(pageNum: number, position: number) {
    if (this.debug) {
      console.log(
        `[STORE] Setting pending scroll restore: page ${pageNum}, position ${position.toFixed(3)}`,
      );
    }
    this.pendingScrollRestore = { pageNum, position };
  }

  /**
   * Clear pending scroll restoration
   */
  clearPendingScrollRestore() {
    this.pendingScrollRestore = null;
  }

  /**
   * Get page data for a specific page
   * @param pageNum 1-based page number
   */
  getPageData(pageNum: number): PageData | undefined {
    return this.docState.getPageData(pageNum);
  }

  /**
   * Get canvas for a specific page
   * @param pageNum 1-based page number
   */
  getPageCanvas(pageNum: number): HTMLCanvasElement | null {
    return this.getCanvas(pageNum);
  }

  /**
   * Check if page has dimensions loaded
   * @param pageNum 1-based page number
   */
  pageHasDimensions(pageNum: number): boolean {
    return this.docState.hasDimensions(pageNum);
  }

  dispose() {
    if (this.restoreTimer !== null) {
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.disposeDocument();
    runInAction(() => {
      this.pdfBytes = null;
      this.pageCount = 0;
      this.currentPage = 1;
      this.currentBookId = null;
      this.bookTitle = null;
      this.isLoading = false;
      this.isSidebarOpen = false;
      this.pendingScrollRestore = null;
      this.docState.clear();
      this.tocStore.clear();
    });
  }

  private disposeDocument() {
    // Cancel all pending render tasks
    this.cancelAll();
    this.doc?.destroy();
    this.doc = null;
    this.engine = null;
    this.queue = null;
    this.scheduler = null;

    // Clean up bitmaps - close all to free GPU memory promptly
    for (const bitmap of this.bitmaps.values()) {
      bitmap.close();
    }
    this.bitmaps.clear();

    // Clean up canvases
    for (const canvas of this.canvases.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.canvases.clear();

    // Reset memory tracking
    this.memoryBytes = 0;
    this.bitmapBytes = 0;

    // Clean up Worker if active
    if (this.workerManager) {
      console.log("[STORE] Destroying existing worker manager");
      this.workerManager.destroy();
      this.workerManager = null;
    }
    this.useWorker = false;
  }
}
