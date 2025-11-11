import { makeAutoObservable } from "mobx";

/**
 * Document-level state for PDF viewer
 *
 * Stores document information including pages, dimensions, and rendering status.
 * Separate from UI state (current page, zoom, etc.).
 *
 * IMPORTANT: Uses 1-based page numbers (page 1 = first page) throughout.
 * No more index0 conversions needed since we use Maps instead of arrays.
 */

export type PageStatus =
  | "idle"
  | "sizing"
  | "ready"
  | "rendering"
  | "rendered"
  | "detached"
  | "stale" // Has bitmap but outdated (zoom/PPI changed)
  | "error";

export interface PageData {
  pageNumber: number; // 1-based page number
  status: PageStatus;
  wPt?: number;
  hPt?: number;
  wPx?: number;
  hPx?: number;
  wCss?: number;
  hCss?: number;
  error?: string;
  lastTouchTs?: number;
  renderStartTs?: number;
  renderEndTs?: number;
  renderDurationMs?: number;
  // Bitmap tracking
  hasFull?: boolean; // Has full-res bitmap at current PPI
}

/**
 * PdfStateStore holds document-level metadata as a MobX store:
 * - Total page count
 * - Per-page dimensions (width/height in points)
 * - Per-page rendering status and pixel dimensions
 *
 * This is separated from UI concerns and canvas management.
 *
 * Uses 1-based page numbering throughout (page 1 = first page).
 */
export class PdfStateStore {
  totalPages = 0;
  private pages: Map<number, PageData> = new Map();
  private ppi = 144;
  private devicePixelRatio = 1;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  setTotalPages(total: number) {
    this.totalPages = total;
    // Initialize page data for all pages (1-based)
    for (let pageNum = 1; pageNum <= total; pageNum++) {
      if (!this.pages.has(pageNum)) {
        this.pages.set(pageNum, {
          pageNumber: pageNum,
          status: "idle",
        });
      }
    }
  }

  setPpi(ppi: number) {
    this.ppi = ppi;
    // Recalculate pixel dimensions for all pages
    for (const page of this.pages.values()) {
      this.updatePixelDimensions(page);
    }
    // Mark all full bitmaps as stale to ensure upgrade path
    this.markAllFullBitmapsStale();
  }

  setDevicePixelRatio(dpr: number) {
    this.devicePixelRatio = dpr;
    // DPR now affects *pixel* dims; recompute both pixel & CSS sizes
    for (const page of this.pages.values()) {
      this.updatePixelDimensions(page);
    }
    // Mark all full bitmaps as stale for crisp re-render on display change
    this.markAllFullBitmapsStale();
  }

  private updatePixelDimensions(page: PageData) {
    if (page.wPt && page.hPt) {
      // Compute backing pixels with DPR-aware PPI for HiDPI displays
      const renderPpi = this.ppi * this.devicePixelRatio;
      page.wPx = Math.max(1, Math.floor((page.wPt * renderPpi) / 72));
      page.hPx = Math.max(1, Math.floor((page.hPt * renderPpi) / 72));

      // Optional clamp to stay under GPU limits (prevents forced downscale)
      const MAX_SIDE = 16384;
      const s = Math.min(1, MAX_SIDE / page.wPx, MAX_SIDE / page.hPx);
      if (s < 1) {
        page.wPx = Math.floor(page.wPx * s);
        page.hPx = Math.floor(page.hPx * s);
      }

      this.updateCssDimensions(page);
    }
  }

  private updateCssDimensions(page: PageData) {
    if (page.wPx && page.hPx) {
      page.wCss = Math.max(1, Math.round(page.wPx / this.devicePixelRatio));
      page.hCss = Math.max(1, Math.round(page.hPx / this.devicePixelRatio));
    }
  }

  setPageDim(pageNum: number, wPt: number, hPt: number) {
    const page = this.getOrCreatePage(pageNum);
    page.wPt = wPt;
    page.hPt = hPt;
    this.updatePixelDimensions(page);
  }

  getPageData(pageNum: number): PageData {
    const page = this.getOrCreatePage(pageNum);
    return page;
  }

  setPageStatus(pageNum: number, status: PageStatus) {
    const page = this.getOrCreatePage(pageNum);
    page.status = status;

    // Track rendering start time
    if (status === "rendering") {
      page.renderStartTs =
        typeof performance !== "undefined" ? performance.now() : Date.now();
    }
  }

  setPageError(pageNum: number, error: string) {
    const page = this.getOrCreatePage(pageNum);
    page.status = "error";
    page.error = error;
  }

  /**
   * Mark page as rendered and calculate render duration
   */
  setPageRendered(pageNum: number) {
    const page = this.getOrCreatePage(pageNum);
    page.status = "rendered";
    page.renderEndTs =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    if (page.renderStartTs) {
      page.renderDurationMs = page.renderEndTs - page.renderStartTs;
    }
  }

  /**
   * Mark page as having full bitmap
   */
  setPageHasFull(pageNum: number, hasFull: boolean) {
    const page = this.getOrCreatePage(pageNum);
    page.hasFull = hasFull;
  }

  /**
   * Mark all full bitmaps as stale (on zoom/PPI change)
   * Keep them displayable but mark for upgrade
   */
  markAllFullBitmapsStale() {
    for (const page of this.pages.values()) {
      if (page.hasFull && page.status === "rendered") {
        page.status = "stale";
      }
    }
  }

  touchPage(pageNum: number) {
    const page = this.pages.get(pageNum);
    if (page) {
      page.lastTouchTs =
        typeof performance !== "undefined" ? performance.now() : Date.now();
    }
  }

  /**
   * Check if page has valid dimensions
   */
  hasDimensions(pageNum: number): boolean {
    const page = this.pages.get(pageNum);
    return Boolean(page?.wPt && page?.hPt);
  }

  /**
   * Get all pages sorted by last touch time (for LRU eviction)
   */
  getPagesSortedByTouch(): PageData[] {
    return Array.from(this.pages.values()).sort(
      (a, b) => (a.lastTouchTs ?? 0) - (b.lastTouchTs ?? 0),
    );
  }

  clear() {
    this.totalPages = 0;
    this.pages.clear();
  }

  private getOrCreatePage(pageNum: number): PageData {
    let page = this.pages.get(pageNum);
    if (!page) {
      page = {
        pageNumber: pageNum,
        status: "idle",
      };
      this.pages.set(pageNum, page);
    }
    return page;
  }
}

/**
 * Legacy alias for backwards compatibility
 * @deprecated Use PdfStateStore instead
 */
export const PdfState = PdfStateStore;
