import { makeAutoObservable, observable } from "mobx";

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

/**
 * Tile information for pages that exceed canvas limits
 */
export interface TileInfo {
  tileIndex: number; // 0-based index within page
  pageNumber: number; // 1-based page number
  // Source rectangle in PDF coordinates (points)
  srcX: number;
  srcY: number;
  srcWidth: number;
  srcHeight: number;
  // Target dimensions in pixels (including devicePixelRatio)
  targetPx: { w: number; h: number };
  // Display dimensions in CSS pixels
  displayCss: { w: number; h: number };
  // Effective PPI for this tile
  ppi: number;
}

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
  // Tiling support
  isTiled?: boolean; // Whether this page uses tiles
  tiles?: TileInfo[]; // Tile metadata (if isTiled)
  tilesLoaded?: Set<number>; // Which tile indices have bitmaps
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
    let anyChanged = false;
    for (const page of this.pages.values()) {
      anyChanged = this.updatePixelDimensions(page) || anyChanged;
    }
    // Only mark bitmaps stale if dimensions actually changed
    if (anyChanged) {
      this.markAllFullBitmapsStale();
    }
  }

  /**
   * Set viewport-based zoom: all pages target the same CSS width
   * @param containerCssWidth Container width in CSS pixels
   * @param zoomPercent Zoom fraction (1.0 = 100%, 0.75 = 75%, etc.)
   */
  setViewportZoom(containerCssWidth: number, zoomPercent: number) {
    let anyChanged = false;
    for (const page of this.pages.values()) {
      if (!(page.wPt && page.hPt)) {
        continue;
      }
      const targetCssW = Math.max(
        1,
        Math.round(containerCssWidth * zoomPercent),
      );
      const effectivePpi = (targetCssW * 72) / page.wPt;

      // Check if tiling is needed before updating dimensions
      const needsTiling = this.needsTiling(
        page.wPt,
        page.hPt,
        effectivePpi,
        targetCssW,
      );

      if (needsTiling) {
        // Calculate tiles instead of updating as single page
        const tiles = this.calculateTiles(
          page.pageNumber,
          page.wPt,
          page.hPt,
          effectivePpi,
          targetCssW,
        );
        this.setPageTiles(page.pageNumber, tiles);

        // Update page dimensions to be total of all tiles
        this.updatePageDimensionsFromTiles(page, tiles);
        anyChanged = true;
      } else {
        // Clear tiles if previously tiled
        if (page.isTiled) {
          this.clearPageTiles(page.pageNumber);
          anyChanged = true;
        }
        // Normal single-page rendering
        const changed = this.updatePixelDimensionsWithPpi(page, effectivePpi);
        anyChanged = anyChanged || changed;
      }
    }
    // Only mark bitmaps stale if dimensions actually changed
    if (anyChanged) {
      this.markAllFullBitmapsStale();
    }
  }

  /**
   * Update pixel dimensions for a page using a specific PPI
   * @param page Page data to update
   * @param effectivePpi PPI to use for this page
   * @returns true if dimensions changed, false otherwise
   */
  private updatePixelDimensionsWithPpi(
    page: PageData,
    effectivePpi: number,
  ): boolean {
    if (!page.wPt || !page.hPt) return false;

    const renderPpi = effectivePpi * this.devicePixelRatio;
    const nextWPx = Math.max(1, Math.floor((page.wPt * renderPpi) / 72));
    const nextHPx = Math.max(1, Math.floor((page.hPt * renderPpi) / 72));

    // Clamp to GPU limits
    const MAX_SIDE = 16384;
    const s = Math.min(1, MAX_SIDE / nextWPx, MAX_SIDE / nextHPx);
    const clampedW = s < 1 ? Math.floor(nextWPx * s) : nextWPx;
    const clampedH = s < 1 ? Math.floor(nextHPx * s) : nextHPx;

    // Check if dimensions actually changed
    const changed = clampedW !== page.wPx || clampedH !== page.hPx;

    page.wPx = clampedW;
    page.hPx = clampedH;
    this.updateCssDimensions(page);

    return changed;
  }

  setDevicePixelRatio(dpr: number) {
    this.devicePixelRatio = dpr;
    // Note: Dimensions will be recalculated by caller via setPpi() or setViewportZoom()
    // Don't recalculate here to avoid double-work in viewport zoom mode
  }

  private updatePixelDimensions(page: PageData): boolean {
    if (!page.wPt || !page.hPt) return false;

    // Compute backing pixels with DPR-aware PPI for HiDPI displays
    const renderPpi = this.ppi * this.devicePixelRatio;
    const nextWPx = Math.max(1, Math.floor((page.wPt * renderPpi) / 72));
    const nextHPx = Math.max(1, Math.floor((page.hPt * renderPpi) / 72));

    // Optional clamp to stay under GPU limits (prevents forced downscale)
    const MAX_SIDE = 16384;
    const s = Math.min(1, MAX_SIDE / nextWPx, MAX_SIDE / nextHPx);
    const clampedW = s < 1 ? Math.floor(nextWPx * s) : nextWPx;
    const clampedH = s < 1 ? Math.floor(nextHPx * s) : nextHPx;

    // Check if dimensions actually changed
    const changed = clampedW !== page.wPx || clampedH !== page.hPx;

    page.wPx = clampedW;
    page.hPx = clampedH;
    this.updateCssDimensions(page);

    return changed;
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
   * Set tile configuration for a page
   */
  setPageTiles(pageNum: number, tiles: TileInfo[]) {
    const page = this.getOrCreatePage(pageNum);
    page.isTiled = true;
    page.tiles = tiles;
    page.tilesLoaded = new Set();
  }

  /**
   * Mark a specific tile as loaded
   */
  markTileLoaded(pageNum: number, tileIndex: number) {
    const page = this.pages.get(pageNum);
    if (!page) return;
    if (!page.tilesLoaded) {
      page.tilesLoaded = new Set();
    }
    page.tilesLoaded.add(tileIndex);
  }

  /**
   * Mark a specific tile as unloaded
   */
  markTileUnloaded(pageNum: number, tileIndex: number) {
    const page = this.pages.get(pageNum);
    if (!page?.tilesLoaded) return;
    page.tilesLoaded.delete(tileIndex);
  }

  /**
   * Clear all tile data for a page
   */
  clearPageTiles(pageNum: number) {
    const page = this.pages.get(pageNum);
    if (!page) return;
    page.isTiled = false;
    page.tiles = undefined;
    page.tilesLoaded = undefined;
  }

  /**
   * Check if a page needs tiling based on dimensions and PPI
   * @param wPt Page width in points
   * @param hPt Page height in points
   * @param effectivePpi Effective PPI for rendering
   * @param targetCssW Target CSS width
   * @returns true if tiling is needed
   */
  private needsTiling(
    wPt: number,
    hPt: number,
    effectivePpi: number,
    targetCssW: number,
  ): boolean {
    const renderPpi = effectivePpi * this.devicePixelRatio;

    // Calculate what the pixel dimensions would be
    const wPx = Math.floor((wPt * renderPpi) / 72);
    const hPx = Math.floor((hPt * renderPpi) / 72);

    // Safe canvas limit (use 12288 to stay well under 16384 browser limit)
    const SAFE_CANVAS_LIMIT = 12288;

    // Tile if either dimension exceeds safe limit
    if (wPx > SAFE_CANVAS_LIMIT || hPx > SAFE_CANVAS_LIMIT) {
      console.log(
        `[PdfState] Page needs tiling: ${wPx}x${hPx} exceeds ${SAFE_CANVAS_LIMIT}`,
      );
      return true;
    }

    return false;
  }

  /**
   * Calculate tiles for a page that exceeds canvas limits
   * @param pageNumber Page number (1-based)
   * @param wPt Page width in points
   * @param hPt Page height in points
   * @param effectivePpi Effective PPI for rendering
   * @param targetCssW Target CSS width
   * @returns Array of tile information
   */
  private calculateTiles(
    pageNumber: number,
    wPt: number,
    hPt: number,
    effectivePpi: number,
    targetCssW: number,
  ): TileInfo[] {
    const TILE_HEIGHT_PX = 8192; // Safe tile height in device pixels
    const dpr = this.devicePixelRatio;
    const renderPpi = effectivePpi * dpr;

    // Calculate total height in pixels
    const totalHeightPx = Math.floor((hPt * renderPpi) / 72);

    // Calculate how many tiles we need
    const tileCount = Math.ceil(totalHeightPx / TILE_HEIGHT_PX);

    console.log(
      `[PdfState] Calculating ${tileCount} tiles for page ${pageNumber} (${totalHeightPx}px height)`,
    );

    const tiles: TileInfo[] = [];

    // Divide page height equally among tiles (in PDF coordinates)
    const tileHeightPt = hPt / tileCount;

    for (let i = 0; i < tileCount; i++) {
      const srcY = i * tileHeightPt;
      const srcH = Math.min(tileHeightPt, hPt - srcY);

      // Calculate pixel dimensions for this tile
      const targetW = Math.floor((wPt * renderPpi) / 72);
      const targetH = Math.floor((srcH * renderPpi) / 72);

      tiles.push({
        tileIndex: i,
        pageNumber,
        srcX: 0,
        srcY,
        srcWidth: wPt,
        srcHeight: srcH,
        targetPx: {
          w: targetW,
          h: targetH,
        },
        displayCss: {
          w: Math.round(targetW / dpr),
          h: Math.round(targetH / dpr),
        },
        ppi: effectivePpi,
      });
    }

    return tiles;
  }

  /**
   * Update page dimensions based on tiles
   * Sets the page's wCss/hCss to the total of all tiles
   * @param page Page data to update
   * @param tiles Tiles for this page
   */
  private updatePageDimensionsFromTiles(page: PageData, tiles: TileInfo[]) {
    if (tiles.length === 0) return;

    // Width comes from first tile
    page.wCss = tiles[0]?.displayCss.w;
    page.wPx = tiles[0]?.targetPx.w;

    // Height is sum of all tiles
    page.hCss = tiles.reduce((sum, tile) => sum + tile.displayCss.h, 0);
    page.hPx = tiles.reduce((sum, tile) => sum + tile.targetPx.h, 0);
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
      // Make the page record itself observable so wCss/hCss/wPx/hPx changes
      // re-render observers that read them.
      page = observable.object<PageData>(
        {
          pageNumber: pageNum,
          status: "idle",
          // keep remaining fields undefined initially
        },
        {},
        { deep: false }, // flat object; own props are observable
      );
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
