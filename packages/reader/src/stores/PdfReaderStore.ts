import { makeAutoObservable, observable, reaction, runInAction } from "mobx";
import { DEFAULT_PDFIUM_WASM_URL } from "@embedpdf/pdfium";
import type { AppEventSystem } from "../app/context";
import type { BookLibraryStore } from "./BookLibraryStore";
import {
  createPdfiumEngine,
  createPdfjsEngine,
  type DocumentHandle,
  type OutlineItem,
  type PDFEngine,
  type RendererKind,
} from "@epubdown/pdf-render";
import { PageRecord } from "./PageRecord";
import { PdfCanvasCache } from "./PdfCanvasCache";
import { PdfRenderScheduler } from "./PdfRenderScheduler";
import { DEFAULT_PAGE_PT } from "../pdf/pdfConstants";
import type { PdfPageSizeCache } from "../lib/PdfPageSizeCache";

export type { PageStatus, PageRecord } from "./PageRecord";

/**
 * Tree node representation of a ToC item with nested children
 */
export interface TocNode {
  id: string;
  title: string;
  pageNumber: number;
  level: number;
  children: TocNode[];
  parentId: string | null;
}

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
 *    - PdfCanvasCache: LRU cache with byte-based budget (256MB default)
 *    - Only visible pages are rendered (viewport-based rendering)
 *    - Canvas detachment when pages leave viewport or zoom changes
 *    - Cache enforcement after each render cycle
 *
 * 4. RENDERING PIPELINE:
 *    - Visibility tracking → Scheduler trigger → Render cycle → Cache management
 *    - Two-phase rendering: size calculation (ensureSize) then canvas render
 *    - Scroll idle timer (120ms) to debounce render triggers during fast scrolling
 *
 * 5. PAGE SIZE CACHING:
 *    - IndexedDB cache for page dimensions (via PdfPageSizeCache)
 *    - Avoids re-measuring pages on subsequent loads
 *    - Critical for fast initial render with correct layout
 *
 * 6. URL SYNCHRONIZATION:
 *    - URL params: ?page=N&ppi=N&position=0.0-1.0
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
 *    - Pixels (px): canvas pixels = pt * (ppi/72) * devicePixelRatio
 *    - CSS pixels: px / devicePixelRatio
 *    - PPI (pixels per inch): user zoom level, default 144 (150% of 96 base)
 *
 * REFACTORING CONSIDERATIONS:
 * - Store is tightly coupled to PdfViewer component (considers extracting visibility tracking)
 * - URL sync could be moved to separate concern/service
 * - ToC tree building could be extracted to utility functions
 * - Memory budget should be configurable based on device capabilities
 * - Consider splitting into multiple stores (document, navigation, toc, rendering)
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
  // ppi (pixels per inch): Controls zoom level. Base is 96, default is 144 (1.5x)
  // Changing ppi invalidates all rendered canvases → triggers re-render
  ppi = 144;
  pageCount = 0;
  // PERFORMANCE: pages array uses observable.shallow to avoid deep observation
  // React to changes in array identity, not individual PageRecord mutations
  pages: PageRecord[] = [];
  // dimensionRevision: Increment this to force PdfViewer re-layout
  // Used when: page sizes load, PPI changes, or engine switches
  // PATTERN: This is a "React cache bust" for useMemo dependencies
  dimensionRevision = 0;
  // zoomMode: Tracks if user manually zoomed or using fit-width
  // Used to: Disable automatic fit-width updates when user sets manual zoom
  zoomMode: "manual" | "fit" = "manual";
  // pendingScrollRestore: Stores position to restore after zoom/dimension change
  // Pattern: Capture position → change zoom → wait for layout → restore position
  pendingScrollRestore: { pageIndex: number; position: number } | null = null;
  // devicePixelRatio: Current device pixel ratio (for high-DPI displays)
  // Tracked to detect changes when moving windows between displays
  devicePixelRatio =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // ═══════════════════════════════════════════════════════════════
  // MEMORY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  // 256MB budget = ~50 pages at 1920x1080 with devicePixelRatio=2
  // REFACTOR: Should adapt to device memory (navigator.deviceMemory)
  memoryBudgetBytes = 256 * 1024 * 1024;
  canvasBytes = 0;
  private cache: PdfCanvasCache;
  private scheduler: PdfRenderScheduler;

  // ═══════════════════════════════════════════════════════════════
  // VISIBILITY & SCROLL TRACKING
  // ═══════════════════════════════════════════════════════════════
  // visibleSet: Page indexes (0-based) currently in viewport
  // Updated by IntersectionObserver in PdfViewer component
  visibleSet = new Set<number>();
  // scrollIdleMs: Wait time before triggering render after scroll stops
  // TRADE-OFF: Lower = more responsive, Higher = fewer render cycles
  scrollIdleMs = 120;
  private scrollIdleTimer: number | null = null;

  // ═══════════════════════════════════════════════════════════════
  // DOCUMENT & NAVIGATION STATE
  // ═══════════════════════════════════════════════════════════════
  isLoading = false;
  error: string | null = null;
  currentBookId: number | null = null;
  bookTitle: string | null = null;
  // currentPageIndex: 0-based page index (observable)
  // Observable → UI updates when page changes via scroll or navigation
  currentPageIndex = 0;
  // currentPosition: Scroll position within current page (0.0 = top, 1.0 = bottom)
  // NON-observable → Prevents re-render on every scroll event (performance)
  // Updated directly without triggering MobX reactions
  currentPosition = 0;
  // preventUrlWrite: Flag to prevent URL updates during initial page restoration
  // CRITICAL: Without this, URL flickers from ?page=5 to ?page=1 to ?page=5
  // during mount, causing browser history pollution
  preventUrlWrite = false;

  // ═══════════════════════════════════════════════════════════════
  // TABLE OF CONTENTS STATE
  // ═══════════════════════════════════════════════════════════════
  isSidebarOpen = false;
  // outline: Flat list from PDF engine's getOutline()
  // ARCHITECTURE: Store flat, build tree on-demand in computed getter
  // This allows filtering without rebuilding the entire tree
  private outline: OutlineItem[] = [];
  // expanded: Set of node IDs that are expanded in the tree UI
  // IDs are stable across renders (generated from level/page/index/title)
  expanded = new Set<string>();
  // activeItemId: ID of ToC node nearest to current page
  // Updated when page changes via scroll or navigation
  activeItemId: string | null = null;
  // filterQuery: Search query for filtering ToC
  // When set, all nodes are auto-expanded to show matches
  filterQuery = "";
  // tocLoaded: Lazy loading flag (ToC loaded on first sidebar open)
  private tocLoaded = false;

  constructor(
    private lib: BookLibraryStore,
    private events: AppEventSystem,
    private pageSizeCache: PdfPageSizeCache,
  ) {
    this.cache = new PdfCanvasCache(
      this.memoryBudgetBytes,
      this.pages,
      (bytes) => {
        this.canvasBytes = bytes;
      },
    );
    this.scheduler = new PdfRenderScheduler(
      async () => await this.performRenderCycle(),
    );
    makeAutoObservable(
      this,
      {
        pages: observable.shallow,
        // Only currentPosition is non-observable to prevent re-renders during scroll
        // currentPageIndex and currentPage are observable so UI updates when page changes
        currentPosition: false,
      },
      { autoBind: true },
    );

    // Set up reaction to update document title when page or TOC changes
    reaction(
      () => ({
        page: this.currentPage,
        toc: this.tocItems,
        title: this.bookTitle,
      }),
      () => this.updateDocumentTitle(),
    );
  }

  get currentPage(): number {
    return this.currentPageIndex + 1;
  }

  /**
   * Generate a stable ID for a ToC node based on its position and content
   */
  private generateNodeId(item: OutlineItem, index: number): string {
    return `${item.level}/${item.pageNumber}/${index}/${item.title.slice(0, 64)}`;
  }

  /**
   * Build a tree structure from the flat outline list
   *
   * ALGORITHM: Stack-based tree construction
   * - PDF outline is flat with level indicators (0=top, 1=child, etc.)
   * - Use stack to track potential parent nodes
   * - For each item, pop stack until we find a parent at lower level
   * - This handles arbitrary nesting and sibling relationships
   *
   * TIME COMPLEXITY: O(n) where n = number of outline items
   * SPACE COMPLEXITY: O(d) for stack where d = max depth
   *
   * EDGE CASES:
   * - Empty outline → empty tree
   * - Non-sequential levels (e.g., 0→2) → treated as direct child
   * - Multiple root nodes (level 0) → all added to root array
   */
  private buildTocTree(items: OutlineItem[]): TocNode[] {
    if (items.length === 0) return [];

    const nodes: TocNode[] = [];
    const stack: { node: TocNode; level: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      const node: TocNode = {
        id: this.generateNodeId(item, i),
        title: item.title,
        pageNumber: item.pageNumber,
        level: item.level,
        children: [],
        parentId: null,
      };

      // Pop stack until we find a parent at lower level
      while (stack.length > 0) {
        const stackTop = stack[stack.length - 1];
        if (!stackTop || stackTop.level >= item.level) {
          stack.pop();
        } else {
          break;
        }
      }

      // If there's a parent on the stack, add this node as a child
      if (stack.length > 0) {
        const stackTop = stack[stack.length - 1];
        if (stackTop) {
          const parent = stackTop.node;
          node.parentId = parent.id;
          parent.children.push(node);
        }
      } else {
        // This is a root node
        nodes.push(node);
      }

      // Push this node onto the stack
      stack.push({ node, level: item.level });
    }

    return nodes;
  }

  /**
   * Filter the tree based on the query string
   */
  private filterTree(nodes: TocNode[], query: string): TocNode[] {
    if (!query) return nodes;

    const lowercaseQuery = query.toLowerCase();
    const filtered: TocNode[] = [];

    for (const node of nodes) {
      const matches = node.title.toLowerCase().includes(lowercaseQuery);
      const filteredChildren = this.filterTree(node.children, query);

      if (matches || filteredChildren.length > 0) {
        filtered.push({
          ...node,
          children: filteredChildren,
        });
      }
    }

    return filtered;
  }

  /**
   * Computed: Get the ToC tree structure (derived from outline)
   */
  get tocTree(): TocNode[] {
    const tree = this.buildTocTree(this.outline);
    return this.filterTree(tree, this.filterQuery);
  }

  /**
   * Computed: Get all ToC items (for backward compatibility)
   */
  get tocItems(): OutlineItem[] {
    return this.outline;
  }

  /**
   * Computed: Get the active node (nearest to currentPage)
   */
  get activeNode(): TocNode | null {
    const activeId = this.activeItemId;
    if (!activeId) return null;

    // Find the node with the matching ID
    const findNode = (nodes: TocNode[]): TocNode | null => {
      for (const node of nodes) {
        if (node.id === activeId) return node;
        const found = findNode(node.children);
        if (found) return found;
      }
      return null;
    };

    return findNode(this.tocTree);
  }

  /**
   * Computed: Find the nearest node for a given page number
   */
  selectNearestNodeForPage(page: number): TocNode | null {
    if (this.outline.length === 0) return null;

    // Find the last node whose page number is <= the target page
    let nearestItem: OutlineItem | null = null;
    let nearestIndex = -1;

    for (let i = 0; i < this.outline.length; i++) {
      const item = this.outline[i];
      if (!item) continue;

      if (item.pageNumber <= page) {
        nearestItem = item;
        nearestIndex = i;
      } else {
        break;
      }
    }

    if (!nearestItem || nearestIndex === -1) return null;

    // Generate the ID and find the node in the tree
    const id = this.generateNodeId(nearestItem, nearestIndex);
    const findNode = (nodes: TocNode[]): TocNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = findNode(node.children);
        if (found) return found;
      }
      return null;
    };

    return findNode(this.tocTree);
  }

  get currentTocItem(): OutlineItem | null {
    if (this.tocItems.length === 0) return null;

    // Find the TOC item for the current page
    // Use the last TOC item whose page number is <= current page
    let currentItem: OutlineItem | null = null;
    for (const item of this.tocItems) {
      if (item.pageNumber <= this.currentPage) {
        currentItem = item;
      } else {
        break;
      }
    }
    return currentItem;
  }

  private updateDocumentTitle() {
    if (typeof window === "undefined") return;

    const parts: string[] = [];

    // Add current TOC item title if available
    const tocItem = this.currentTocItem;
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
   * Action: Set the outline (flat list from engine)
   */
  setOutline(items: OutlineItem[]) {
    this.outline = items;
    // Update active item based on current page
    this.updateActiveItem();
  }

  /**
   * Action: Toggle node expansion
   */
  toggleNode(id: string) {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
    }
  }

  /**
   * Action: Expand all parent nodes of the active item
   */
  expandToActive() {
    if (!this.activeItemId) return;

    // Find all parent IDs by walking up the tree
    const parentIds: string[] = [];
    const findParents = (nodes: TocNode[], targetId: string): boolean => {
      for (const node of nodes) {
        if (node.id === targetId) {
          return true;
        }
        if (findParents(node.children, targetId)) {
          parentIds.push(node.id);
          return true;
        }
      }
      return false;
    };

    findParents(this.tocTree, this.activeItemId);

    // Expand all parent nodes
    for (const id of parentIds) {
      this.expanded.add(id);
    }
  }

  /**
   * Action: Filter ToC by query string
   */
  filterToC(query: string) {
    this.filterQuery = query;
    // When filtering, expand all nodes to show matches
    if (query) {
      this.expandAll();
    }
  }

  /**
   * Action: Expand all nodes
   */
  private expandAll() {
    const collectIds = (nodes: TocNode[]): void => {
      for (const node of nodes) {
        this.expanded.add(node.id);
        collectIds(node.children);
      }
    };
    collectIds(this.tocTree);
  }

  /**
   * Update the active item ID based on current page
   */
  private updateActiveItem() {
    const nearest = this.selectNearestNodeForPage(this.currentPage);
    this.activeItemId = nearest?.id ?? null;
  }

  async loadTocOnce() {
    if (this.tocLoaded || !this.doc) return;

    try {
      const outline = await this.doc.getOutline();
      runInAction(() => {
        this.setOutline(outline);
        this.tocLoaded = true;
        // Automatically expand to the current chapter
        this.expandToActive();
      });
    } catch (err) {
      console.warn("Failed to load PDF outline:", err);
      runInAction(() => {
        this.setOutline([]);
        this.tocLoaded = true;
      });
    }
  }

  handleTocPageSelect(pageNumber: number) {
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

      // Load TOC after document is ready
      await this.loadTocOnce();

      // Update document title after TOC is loaded
      this.updateDocumentTitle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runInAction(() => {
        this.error = message;
        this.isLoading = false;
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
   * - New PdfCanvasCache created with new pages array
   * - Old canvases are GC'd when cache is replaced
   */
  async open(data: Uint8Array, kind: RendererKind = "PDFium") {
    this.disposeDocument();
    this.pdfBytes = data;
    this.engineKind = kind;
    const engine = this.makeEngine(kind);
    const initOptions =
      kind === "PDFium" ? { wasmUrl: DEFAULT_PDFIUM_WASM_URL } : undefined;
    await engine.init(initOptions);
    const doc = await engine.loadDocument(data);

    runInAction(() => {
      this.engine = engine;
      this.doc = doc;
      this.pageCount = doc.pageCount();
      this.pages = Array.from(
        { length: this.pageCount },
        (_, index0) => new PageRecord(index0),
      );
      // Reinitialize cache with new pages
      this.cache = new PdfCanvasCache(
        this.memoryBudgetBytes,
        this.pages,
        (bytes) => {
          this.canvasBytes = bytes;
        },
      );
      this.visibleSet = new Set();
      this.currentPageIndex = 0;
    });

    // Try to load page sizes from cache
    let cachedSizes = null;
    if (this.currentBookId !== null) {
      cachedSizes = await this.pageSizeCache.getPageSizes(this.currentBookId);
    }

    if (cachedSizes && cachedSizes.length === this.pageCount) {
      // Apply cached sizes
      runInAction(() => {
        for (const size of cachedSizes) {
          const page = this.pages[size.pageIndex];
          if (page) {
            page.wPt = size.widthPt;
            page.hPt = size.heightPt;
            page.setSizeFromPt(this.ppi);
            page.status = "ready";
          }
        }
        // Increment revision to trigger re-renders with new dimensions
        this.dimensionRevision++;
      });
    } else {
      // Load all page sizes and cache them
      const sizes = [];
      for (let i = 0; i < this.pageCount; i++) {
        await this.ensureSize(i);
        const page = this.pages[i];
        if (page?.wPt && page?.hPt) {
          sizes.push({
            pageIndex: i,
            widthPt: page.wPt,
            heightPt: page.hPt,
          });
        }
      }

      // Save to cache
      if (this.currentBookId !== null && sizes.length === this.pageCount) {
        await this.pageSizeCache.savePageSizes(this.currentBookId, sizes);
      }

      // Increment revision to trigger re-renders with new dimensions
      runInAction(() => {
        this.dimensionRevision++;
      });
    }

    this.scheduler.trigger();
  }

  async setEngine(kind: RendererKind) {
    if (kind === this.engineKind) return;
    if (!this.pdfBytes) {
      this.engineKind = kind;
      return;
    }
    runInAction(() => {
      this.isLoading = true;
      this.error = null;
    });
    try {
      await this.open(this.pdfBytes, kind);
    } finally {
      runInAction(() => {
        this.isLoading = false;
      });
    }
  }

  /**
   * Change zoom level (PPI = pixels per inch)
   *
   * INVALIDATION CASCADE:
   * 1. All page pixel dimensions recalculated (wPx, hPx)
   * 2. All rendered canvases detached from cache
   * 3. Page status reset to "ready" (needs re-render)
   * 4. dimensionRevision++ triggers PdfViewer re-layout
   * 5. Scheduler trigger starts new render cycle
   *
   * MEMORY IMPACT:
   * - canvasBytes reset to 0 (all canvases will be GC'd)
   * - New canvases will be larger (higher PPI) or smaller (lower PPI)
   * - Cache budget enforcement happens during render cycle
   *
   * SCROLL POSITION PRESERVATION:
   * - PdfViewer component handles scroll restoration
   * - Captures position before setPpi(), restores after dimensionRevision change
   */
  setPpi(ppi: number) {
    if (ppi === this.ppi) return;
    this.ppi = ppi;
    this.canvasBytes = 0;
    for (const page of this.pages) {
      page.setSizeFromPt(this.ppi);
      if (page.canvas) {
        this.cache.noteDetach(page);
      }
      if (page.status === "rendered") {
        page.status = "ready";
      }
    }
    // Increment revision to trigger re-renders
    this.dimensionRevision++;
    this.writeUrl();
    this.scheduler.trigger();
  }

  onPagesVisible(indexes: number[]) {
    const next = new Set(indexes);
    this.visibleSet = next;
    this.scheduler.trigger();
  }

  onScroll() {
    if (this.scrollIdleTimer !== null) {
      window.clearTimeout(this.scrollIdleTimer);
    }
    this.scrollIdleTimer = window.setTimeout(() => {
      this.scrollIdleTimer = null;
      this.scheduler.trigger();
    }, this.scrollIdleMs) as unknown as number;
  }

  getPageLayout(index0: number): { width: number; height: number } {
    const page = this.pages[index0];
    if (page?.wPx && page?.hPx) {
      return { width: page.wPx, height: page.hPx };
    }

    // Use average dimensions from already-sized pages as fallback
    let totalWidth = 0;
    let totalHeight = 0;
    let count = 0;
    for (const p of this.pages) {
      if (p.wPx && p.hPx) {
        totalWidth += p.wPx;
        totalHeight += p.hPx;
        count++;
      }
    }

    if (count > 0) {
      return {
        width: Math.floor(totalWidth / count),
        height: Math.floor(totalHeight / count),
      };
    }

    // Final fallback: standard US Letter at current PPI
    return {
      width: Math.floor((DEFAULT_PAGE_PT.w * this.ppi) / 72),
      height: Math.floor((DEFAULT_PAGE_PT.h * this.ppi) / 72),
    };
  }

  setCurrentPage(pageNumber: number) {
    const index0 = Math.max(0, Math.min(this.pageCount - 1, pageNumber - 1));
    this.setCurrentPageIndex(index0);
    // Update active item when page changes
    this.updateActiveItem();
  }

  updateFromUrl(url: URL) {
    const page = Number(url.searchParams.get("page") ?? 0);
    if (page > 0) {
      this.setCurrentPage(page);
    }
    const ppi = Number(url.searchParams.get("ppi") ?? 0);
    if (ppi > 0) {
      this.setPpi(ppi);
    }
    const position = Number(url.searchParams.get("position") ?? 0);
    if (position >= 0 && position <= 1) {
      this.currentPosition = position;
    }
  }

  private lastUrlState: { page: number; ppi: number; position: string } | null =
    null;

  /**
   * Synchronize current state to URL query parameters
   *
   * URL FORMAT: ?page=5&ppi=144&position=0.234
   * - page: 1-based page number
   * - ppi: current zoom level
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
    const newState = {
      page: this.currentPage,
      ppi: this.ppi,
      position: positionStr,
    };

    // Skip if nothing changed
    if (
      this.lastUrlState &&
      this.lastUrlState.page === newState.page &&
      this.lastUrlState.ppi === newState.ppi &&
      this.lastUrlState.position === newState.position
    ) {
      return;
    }

    this.lastUrlState = newState;
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(newState.page));
    url.searchParams.set("ppi", String(newState.ppi));
    url.searchParams.set("position", positionStr);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  setPosition(position: number) {
    const newPos = Math.max(0, Math.min(1, position));
    this.currentPosition = newPos;
    this.writeUrl();
  }

  /**
   * Update device pixel ratio (called when display changes)
   */
  updateDevicePixelRatio(dpr: number) {
    if (Math.abs(this.devicePixelRatio - dpr) < 0.001) return;
    this.devicePixelRatio = dpr;
    // Increment revision to trigger re-render with new DPR
    this.dimensionRevision++;
  }

  /**
   * Set zoom mode (manual or fit-to-width)
   */
  setZoomMode(mode: "manual" | "fit") {
    this.zoomMode = mode;
  }

  /**
   * Store scroll position to restore after zoom/dimension change
   */
  setPendingScrollRestore(pageIndex: number, position: number) {
    this.pendingScrollRestore = { pageIndex, position };
  }

  /**
   * Clear pending scroll restoration
   */
  clearPendingScrollRestore() {
    this.pendingScrollRestore = null;
  }

  /**
   * Zoom in to next level
   */
  zoomIn(currentPosition: number, zoomLevels: number[], maxPpi: number) {
    this.zoomMode = "manual";
    let currentZoomIndex = zoomLevels.indexOf(this.ppi);
    if (currentZoomIndex === -1) {
      currentZoomIndex = zoomLevels.findIndex((ppi) => ppi > this.ppi);
      if (currentZoomIndex === -1) currentZoomIndex = zoomLevels.length - 1;
      else currentZoomIndex--;
    }
    const newIndex = Math.min(zoomLevels.length - 1, currentZoomIndex + 1);
    let newPpi = zoomLevels[newIndex];

    // If we're at the last standard level and maxPpi is higher, zoom to maxPpi
    const lastStandardPpi = zoomLevels[zoomLevels.length - 1] ?? 192;
    if (
      newPpi &&
      newPpi === lastStandardPpi &&
      this.ppi >= lastStandardPpi &&
      maxPpi > lastStandardPpi
    ) {
      newPpi = maxPpi;
    }

    // Limit to fit width PPI
    if (newPpi && newPpi > maxPpi) {
      newPpi = maxPpi;
    }
    if (newPpi && newPpi !== this.ppi) {
      this.setPendingScrollRestore(this.currentPageIndex, currentPosition);
      this.setPpi(newPpi);
    }
  }

  /**
   * Zoom out to previous level
   */
  zoomOut(currentPosition: number, zoomLevels: number[]) {
    this.zoomMode = "manual";
    let currentZoomIndex = zoomLevels.indexOf(this.ppi);
    if (currentZoomIndex === -1) {
      currentZoomIndex = zoomLevels.findIndex((ppi) => ppi >= this.ppi);
      if (currentZoomIndex === -1) currentZoomIndex = zoomLevels.length;
    }
    const newIndex = Math.max(0, currentZoomIndex - 1);
    const newPpi = zoomLevels[newIndex];
    if (newPpi && newPpi !== this.ppi) {
      this.setPendingScrollRestore(this.currentPageIndex, currentPosition);
      this.setPpi(newPpi);
    }
  }

  /**
   * Reset zoom to 100% (96 PPI)
   */
  resetZoom(currentPosition: number) {
    this.zoomMode = "manual";
    if (this.ppi !== 96) {
      this.setPendingScrollRestore(this.currentPageIndex, currentPosition);
      this.setPpi(96);
    }
  }

  /**
   * Fit current page to container width
   */
  fitToWidth(
    containerWidth: number,
    currentPosition: number,
    devicePixelRatio: number,
  ) {
    this.zoomMode = "fit";
    if (!containerWidth || containerWidth <= 0) return;

    const index0 = Math.max(0, this.currentPage - 1);
    const page = this.pages[index0];
    if (!page) return;

    const ppiFit = this.calculateFitWidthPpi(
      containerWidth,
      devicePixelRatio,
      page,
    );
    if (ppiFit && ppiFit !== this.ppi) {
      this.setPendingScrollRestore(this.currentPageIndex, currentPosition);
      this.setPpi(ppiFit);
    }
  }

  /**
   * Calculate PPI for fit-to-width mode
   */
  private calculateFitWidthPpi(
    containerWidth: number,
    devicePixelRatio: number,
    page: PageRecord,
  ): number | null {
    if (!page.wPt) return null;

    // Calculate the PPI needed to fit the page width to the container
    const targetPx = containerWidth * devicePixelRatio;
    const ppiFit = (targetPx * 72) / page.wPt;

    return Math.round(ppiFit);
  }

  /**
   * Get maximum PPI for fit-to-width mode
   */
  getMaxPpi(containerWidth: number, devicePixelRatio: number): number {
    if (!containerWidth || containerWidth <= 0 || this.pageCount === 0)
      return 192;

    const index0 = Math.max(0, this.currentPage - 1);
    const page = this.pages[index0];
    if (!page) return 192;

    const ppiFit = this.calculateFitWidthPpi(
      containerWidth,
      devicePixelRatio,
      page,
    );
    return ppiFit ?? 192;
  }

  /**
   * Check if zoom in is possible
   */
  canZoomIn(_zoomLevels: number[], maxPpi: number): boolean {
    // Can always zoom in if below maxPpi
    if (this.ppi < maxPpi) {
      return true;
    }
    return false;
  }

  /**
   * Check if zoom out is possible
   */
  canZoomOut(zoomLevels: number[]): boolean {
    const i = zoomLevels.indexOf(this.ppi);
    if (i === -1) {
      // Not at a standard level, check if we can zoom out
      return this.ppi > (zoomLevels[0] ?? 72);
    }
    return i > 0;
  }

  async requestPageSize(index0: number): Promise<void> {
    if (index0 < 0 || index0 >= this.pageCount) return;
    await this.ensureSize(index0);
  }

  dispose() {
    if (this.scrollIdleTimer !== null) {
      window.clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = null;
    }
    this.disposeDocument();
    runInAction(() => {
      this.pdfBytes = null;
      this.pageCount = 0;
      this.pages = [];
      this.visibleSet = new Set();
      this.currentBookId = null;
      this.bookTitle = null;
      this.currentPageIndex = 0;
      this.canvasBytes = 0;
      this.isLoading = false;
      this.outline = [];
      this.expanded = new Set();
      this.activeItemId = null;
      this.filterQuery = "";
      this.tocLoaded = false;
      this.isSidebarOpen = false;
      this.zoomMode = "manual";
      this.pendingScrollRestore = null;
    });
  }

  private setCurrentPageIndex(index0: number) {
    if (index0 === this.currentPageIndex) {
      return;
    }
    this.currentPageIndex = index0;
    this.writeUrl();
    // Update active item when page changes from scrolling
    this.updateActiveItem();
  }

  /**
   * Main rendering pipeline - called by PdfRenderScheduler
   *
   * RENDER CYCLE FLOW:
   * 1. Get visible page indexes from IntersectionObserver
   * 2. Sort by page order (top to bottom)
   * 3. For each visible page:
   *    a. ensureSize() - load page dimensions if needed
   *    b. renderPage() - render PDF to canvas
   *    c. cache.enforce() - evict canvases if over memory budget
   *
   * SCHEDULING:
   * - Triggered by: scroll events, zoom changes, visibility changes
   * - Debounced via scroll idle timer (120ms)
   * - Sequential rendering (not parallel) to avoid overwhelming browser
   *
   * CANCELLATION:
   * - Check !this.doc at each step (handles disposal during render)
   * - Individual page renders are atomic (can't cancel mid-render)
   *
   * MEMORY MANAGEMENT:
   * - cache.enforce() after EACH page render (incremental eviction)
   * - This prevents memory spike when loading many pages
   * - LRU eviction keeps recently visible pages in memory
   *
   * PERFORMANCE:
   * - Typical render: 50-200ms per page (varies by PDF complexity)
   * - Blocking: Rendering blocks main thread (PDF engine limitation)
   * - REFACTOR: Could use OffscreenCanvas + Worker for async rendering
   */
  private async performRenderCycle() {
    if (!this.doc) return;
    const visible = [...this.visibleSet].sort((a, b) => a - b);
    const order = this.pickRenderOrder(visible);
    for (const index0 of order) {
      if (!this.doc) return;
      await this.ensureSize(index0);
      await this.renderPage(index0);
      this.cache.enforce(this.visibleSet, this.pageCount);
    }
  }

  private pickRenderOrder(visible: number[]): number[] {
    if (!this.pageCount) return [];
    if (visible.length === 0) {
      return [Math.min(this.currentPageIndex, this.pageCount - 1)];
    }
    // Only render visible pages to minimize memory usage
    return [...visible].sort((a, b) => a - b);
  }

  private async ensureSize(index0: number) {
    const page = this.pages[index0];
    if (!this.doc || !page || page.wPt || page.status === "error") return;
    page.status = "sizing";
    try {
      const { wPt, hPt } = await this.doc.getPageSize(index0);
      runInAction(() => {
        page.wPt = wPt;
        page.hPt = hPt;
        page.setSizeFromPt(this.ppi);
        page.status = "ready";
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runInAction(() => {
        page.status = "error";
        page.error = message;
      });
    }
  }

  private async renderPage(index0: number) {
    const page = this.pages[index0];
    if (!this.doc || !page) return;
    if (page.status === "rendered" && page.canvas) {
      page.touch();
      return;
    }
    if (page.status === "rendering" || page.status === "error") return;

    if (!page.wPx || !page.hPx) {
      await this.ensureSize(index0);
      if (!page.wPx || !page.hPx) return;
    }

    let handle: Awaited<ReturnType<DocumentHandle["loadPage"]>> | null = null;
    runInAction(() => {
      page.status = "rendering";
    });
    try {
      handle = await this.doc.loadPage(index0);
      const canvas = page.ensureCanvas();
      await handle.renderToCanvas(canvas, this.ppi);
      runInAction(() => {
        this.cache.noteAttach(page, canvas);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runInAction(() => {
        page.status = "error";
        page.error = message;
      });
      if (page.canvas) {
        this.cache.noteDetach(page);
      }
    } finally {
      handle?.destroy();
    }
  }

  private disposeDocument() {
    for (const page of this.pages) {
      if (page.canvas) {
        this.cache.noteDetach(page);
      }
    }
    this.doc?.destroy();
    this.doc = null;
    this.engine = null;
  }
}
