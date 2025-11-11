import { observer } from "mobx-react-lite";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import type { PdfReaderStore } from "../stores/PdfReaderStore";
import { ZOOM_PERCENT_LEVELS } from "./pdfConstants";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { PageSlider } from "../slider/PageSlider";
import { PageSlotWrapper } from "./PageSlot";
import { PdfDebugOverlay } from "./PdfDebugOverlay";

/**
 * Isolated observer component for PageSlider
 * This prevents PdfViewer from re-rendering when only currentPage changes
 */
const PageSliderObserver: FC<{
  store: PdfReaderStore;
  pageCount: number;
  onPageChange: (page: number) => void;
}> = observer(({ store, pageCount, onPageChange }) => {
  return (
    <div className="fixed top-0 right-0 h-screen pr-4 pt-8 pb-8 flex items-center z-10">
      <PageSlider
        currentPage={store.currentPage}
        totalPages={pageCount}
        onPageChange={onPageChange}
        height="calc(100vh - 4rem)"
        enableKeyboard={false}
      />
    </div>
  );
});

/**
 * Isolated observer component for zoom controls
 * This prevents PdfViewer from re-rendering when currentPage/ppi changes
 */
const ZoomControlsObserver: FC<{
  store: PdfReaderStore;
  containerRef: React.RefObject<HTMLDivElement | null>;
  containerWidth: number;
}> = observer(({ store, containerRef, containerWidth }) => {
  // Calculate position within current page
  const calculateCurrentPosition = useCallback((): number => {
    if (!containerRef.current) return 0;

    const pageNum = store.currentPage;
    const container = containerRef.current;
    const slots = container.querySelectorAll(".pdf-page-slot");
    const slot = slots[pageNum - 1] as HTMLElement | undefined;
    if (!slot) return 0;

    // Use offsetTop to avoid layout thrashing from getBoundingClientRect
    const top = slot.offsetTop - container.scrollTop;
    const offset = -top;
    const h = slot.offsetHeight || 1;

    // Return as ratio, clamped to [0, 1]
    return Math.max(0, Math.min(1, offset / h));
  }, [store, containerRef]);

  return (
    <div className="fixed bottom-4 left-4 z-10 bg-white rounded-lg shadow px-2 py-2 flex items-center gap-2">
      <button
        onClick={() => {
          const position = calculateCurrentPosition();
          store.zoomOut(position, ZOOM_PERCENT_LEVELS);
        }}
        disabled={!store.canZoomOut(ZOOM_PERCENT_LEVELS)}
        className="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100"
      >
        −
      </button>

      <span className="text-sm text-gray-600 min-w-[60px] text-center">
        {Math.round(store.zoomPercent * 100)}%
      </span>

      <button
        onClick={() => {
          const position = calculateCurrentPosition();
          store.zoomIn(position, ZOOM_PERCENT_LEVELS);
        }}
        disabled={!store.canZoomIn(ZOOM_PERCENT_LEVELS)}
        className="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100"
      >
        +
      </button>

      <button
        onClick={() => {
          const position = calculateCurrentPosition();
          store.fitToWidth(position);
        }}
        className="ml-1 px-2 py-1 rounded text-xs font-medium hover:bg-gray-100"
        title="Fit page width to container"
      >
        Fit
      </button>

      <button
        onClick={() => {
          const position = calculateCurrentPosition();
          store.resetZoom(position);
        }}
        className="px-2 py-1 rounded text-xs font-medium hover:bg-gray-100"
        title="Reset to 100%"
      >
        100%
      </button>
    </div>
  );
});

/**
 * ARCHITECTURE: PDF Viewer Component
 *
 * This is the main rendering component for PDF documents. It manages:
 *
 * 1. VIEWPORT & SCROLLING:
 *    - Virtual scrolling container with all pages stacked vertically
 *    - Scroll position tracked for URL synchronization
 *    - IntersectionObserver tracks visible pages
 *
 * 2. CANVAS LIFECYCLE:
 *    - Store owns canvas elements (via PageRecord)
 *    - Component mounts/unmounts canvases to DOM via refs
 *    - MobX reaction syncs canvas changes from store → DOM
 *    - Canvases persist across re-renders (performance)
 *
 * 3. INTERSECTION OBSERVER:
 *    - Single observer for current page detection
 *    - Threshold array provides precise visibility ratios
 *    - Page with highest intersection ratio becomes current page
 *    - Uses containerRef as root (not window) for nested scrolling
 *    - Rendering controlled by store's window-based render queue
 *
 * 4. ZOOM & LAYOUT:
 *    - Two zoom modes: manual (fixed PPI) and fit-to-width (dynamic PPI)
 *    - Zoom logic managed by store (zoomIn, zoomOut, resetZoom, fitToWidth)
 *    - ResizeObserver on container handles all resize events (window/responsive)
 *    - Media query listener detects devicePixelRatio changes (display/zoom changes)
 *    - Scroll position preserved across zoom changes (via store.pendingScrollRestore)
 *
 * 5. INITIAL PAGE RESTORATION:
 *    - Read URL params: ?page=N&ppi=N&position=0.0-1.0
 *    - Wait for dimensionRevision > 0 (page sizes loaded)
 *    - Store manages restoration state (isRestoringInitialView)
 *    - Loading overlay shown based on store state (single source of truth)
 *    - Store completes restoration when target page renders or timeout fires
 *    - preventUrlWrite flag prevents URL flickering
 *
 * 6. KEYBOARD SHORTCUTS:
 *    - Handled by useKeyboardShortcuts custom hook
 *    - +/= : Zoom in, -/_ : Zoom out, 0 : Reset to 100%
 *    - f/F : Fit to width
 *    - PageUp/PageDown : Navigate pages
 *    - Container must be focused (tabindex="0")
 *
 * 7. COORDINATE CALCULATIONS:
 *    - calculateCurrentPosition(): Returns scroll offset within current page (0.0-1.0)
 *    - Used for scroll restoration and URL synchronization
 *    - Throttled to ~10/s to reduce write frequency
 *
 * STATE MANAGEMENT:
 * - hasRestoredRef: Tracks if initial page restoration has been attempted
 * - slotRefs: Array of page slot DOM elements for scrolling and visibility tracking
 * - Store manages: zoomMode, pendingScrollRestore, devicePixelRatio, isRestoringInitialView
 *
 * REFACTORING NOTES:
 * - Zoom logic lives in store for centralized state management
 * - Keyboard shortcuts extracted to useKeyboardShortcuts hook
 * - Rendering infrastructure merged from PdfRenderController into store
 * - PageSlot component uses fine-grained observer pattern
 * - Future: Extract zoom controls and IntersectionObserver to separate components
 */

interface PdfViewerProps {
  store: PdfReaderStore;
}

export const PdfViewer = observer(({ store }: PdfViewerProps) => {
  // ═══════════════════════════════════════════════════════════════
  // DOM REFS - These persist across re-renders
  // ═══════════════════════════════════════════════════════════════
  const containerRef = useRef<HTMLDivElement>(null);
  // slotRefs: Array of page container divs (one per page)
  // Used for: scrollIntoView, IntersectionObserver, position calculations
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  // currentPageObserver: Consolidated observer for visibility and current page tracking
  const currentPageObserverRef = useRef<IntersectionObserver | null>(null);
  // Flag to prevent intersection observer from updating page during programmatic scrolls
  const isProgrammaticScrollRef = useRef(false);

  // ═══════════════════════════════════════════════════════════════
  // DEVICE PIXEL RATIO TRACKING
  // ═══════════════════════════════════════════════════════════════
  // devicePixelRatio is tracked in store

  // Track container width for responsive zoom calculations
  const [containerWidth, setContainerWidth] = useState(0);

  // Debug overlay state
  const [isDebugOpen, setIsDebugOpen] = useState(false);

  // Calculate current position within the current page (0.0 = top, 1.0 = bottom)
  const calculateCurrentPosition = useCallback((): number => {
    if (!containerRef.current) return 0;

    const pageNum = store.currentPage;
    const container = containerRef.current;
    const slot = slotRefs.current[pageNum - 1]; // Convert to 0-based index for array
    if (!slot) return 0;

    // Use offsetTop to avoid layout thrashing from getBoundingClientRect
    const top = slot.offsetTop - container.scrollTop;
    const offset = -top;
    const h = slot.offsetHeight || 1;

    // Return as ratio, clamped to [0, 1]
    return Math.max(0, Math.min(1, offset / h));
  }, [store, store.currentPage]);

  // Restore scroll position based on page number (1-based) and position percentage
  const restoreScrollPosition = (pageNum: number, position: number) => {
    const slot = slotRefs.current[pageNum - 1]; // Convert to 0-based index for array
    if (!slot || !containerRef.current) return;

    // Calculate absolute scroll position directly (avoids layout thrashing from scrollIntoView)
    const container = containerRef.current;
    const slotTop = slot.offsetTop;
    const slotHeight = slot.offsetHeight;

    // Set scroll position to page top + position percentage
    container.scrollTop = slotTop + slotHeight * position;
  };

  useEffect(() => {
    slotRefs.current.length = store.pageCount;
  }, [store.pageCount]);

  // Apply initial viewport zoom when pages are loaded
  useEffect(() => {
    if (store.pageCount > 0 && containerWidth > 0) {
      store.applyViewportZoom(containerWidth);
    }
  }, [store, store.pageCount, containerWidth]);

  // Track container width for zoom calculations
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        setContainerWidth(width);

        // Apply viewport zoom when container width changes
        if (width > 0 && store.pageCount > 0) {
          store.applyViewportZoom(width);
        }
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [store]);

  // Auto-focus container on mount so keyboard shortcuts work immediately
  useEffect(() => {
    if (containerRef.current && document.activeElement === document.body) {
      containerRef.current.focus({ preventScroll: true });
    }
  }, []);

  // Handle TOC navigation - scroll to page when currentPage changes externally
  const lastManualPageRef = useRef(store.currentPage);
  useEffect(() => {
    // Skip if this is just an update from the IntersectionObserver
    // (happens when user scrolls naturally)
    if (lastManualPageRef.current === store.currentPage) return;

    lastManualPageRef.current = store.currentPage;

    // Prevent intersection observer from interfering during programmatic scroll
    isProgrammaticScrollRef.current = true;

    // Scroll to the page (convert to 0-based index for array)
    const slot = slotRefs.current[store.currentPage - 1];
    if (slot && containerRef.current) {
      slot.scrollIntoView({ behavior: "auto", block: "start" });
    }

    // Clear flag after scroll settles
    const timer = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 100);

    return () => clearTimeout(timer);
  }, [store, store.currentPage]);

  // Keyboard shortcuts for zoom and navigation
  useKeyboardShortcuts({
    store,
    containerRef,
    calculateCurrentPosition,
    onNavigateToPage: (page: number) => {
      // Prevent intersection observer from interfering during programmatic scroll
      isProgrammaticScrollRef.current = true;

      store.setCurrentPage(page);
      lastManualPageRef.current = page;

      const slot = slotRefs.current[page - 1];
      if (slot && containerRef.current) {
        slot.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      // Clear flag after scroll settles (longer timeout for smooth scrolling)
      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 500);
    },
  });

  // Handle page changes from PageSlider
  const handlePageSliderChange = useCallback(
    (page: number) => {
      // Prevent intersection observer from interfering during programmatic scroll
      isProgrammaticScrollRef.current = true;

      store.setCurrentPage(page);
      lastManualPageRef.current = page;

      const slot = slotRefs.current[page - 1];
      if (slot && containerRef.current) {
        slot.scrollIntoView({ behavior: "auto", block: "start" });
      }

      // Clear flag after scroll settles (even with auto behavior, allow some time)
      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 100);
    },
    [store],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    // Track intersection ratios for current page detection
    const pageRatios = new Map<number, number>();

    // Observer for current page tracking based on visibility ratios
    const observer = new IntersectionObserver(
      (entries) => {
        // Skip updates during programmatic scrolls to prevent race conditions
        if (isProgrammaticScrollRef.current) {
          return;
        }

        // Update ratios map with changed entries
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (!Number.isNaN(index)) {
            if (entry.isIntersecting && entry.intersectionRatio > 0) {
              pageRatios.set(index, entry.intersectionRatio);
            } else {
              pageRatios.delete(index);
            }
          }
        }

        // Find the page with the highest visibility ratio
        let maxRatio = 0;
        let maxIndex = -1;
        for (const [index, ratio] of pageRatios.entries()) {
          if (ratio > maxRatio) {
            maxRatio = ratio;
            maxIndex = index;
          }
        }

        // Update current page immediately (no debouncing needed with ±1 window)
        if (maxIndex >= 0) {
          const newPage = maxIndex + 1;
          if (newPage !== store.currentPage) {
            store.setCurrentPage(newPage);
            lastManualPageRef.current = newPage;
          }
        }
      },
      {
        root: containerRef.current,
        threshold: [0, 0.5, 1], // Fewer thresholds for less callback overhead
        rootMargin: "10% 0px", // Prefetch earlier for smoother experience
      },
    );
    currentPageObserverRef.current = observer;

    // Observe existing slots
    for (const el of slotRefs.current) {
      if (el) {
        observer.observe(el);
      }
    }

    return () => {
      if (currentPageObserverRef.current === observer) {
        currentPageObserverRef.current = null;
      }
      observer.disconnect();
    };
  }, [store]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!containerRef.current) return;
    if (store.pageCount === 0) return;

    const container = containerRef.current;
    let rafIdForDpr: number | null = null;
    const prevDprRef = { current: window.devicePixelRatio || 1 };

    // Update position immediately on scroll (no RAF delay)
    const updatePosition = () => {
      // Don't update position/URL until initial restoration is complete
      if (store.isRestoringInitialView) return;

      const position = calculateCurrentPosition();
      store.setPosition(position);
    };

    // Throttle position updates to ~10/s (fix #5)
    let lastWriteTime = 0;
    const throttledUpdatePosition = () => {
      const now = performance.now();
      if (now - lastWriteTime > 100) {
        updatePosition();
        lastWriteTime = now;
      }
    };

    // Notify store about scroll/layout changes (triggers render scheduling)
    const onScrollEvent = () => {
      // Skip render scheduling if this is a programmatic scroll
      // (from slider, keyboard shortcuts, or TOC navigation)
      if (!isProgrammaticScrollRef.current) {
        store.onScroll();
      }

      // Update URL with throttling to reduce noise
      throttledUpdatePosition();
    };

    // Listen to scroll on the actual container, not window
    container.addEventListener("scroll", onScrollEvent, { passive: true });

    // Handle DPR changes (display changes, zoom, etc.)
    // Note: ResizeObserver on container handles actual resize events
    const onDprChange = () => {
      if (rafIdForDpr !== null) return;
      rafIdForDpr = window.requestAnimationFrame(() => {
        rafIdForDpr = null;
        const nowDpr = window.devicePixelRatio || 1;
        console.log("nowDpr", nowDpr);

        const dprChanged = Math.abs(nowDpr - prevDprRef.current) > 0.001;
        if (dprChanged) {
          prevDprRef.current = nowDpr;
          // Update store DPR (internally calls recalculateDimensions)
          store.updateDevicePixelRatio(nowDpr);
        }
      });
    };

    // Listen for DPR changes via media query
    // This detects when user moves window to different display or changes zoom
    const mq = window.matchMedia("(min-resolution: 0.001dppx)");
    const mqListener = () => onDprChange();
    if (mq?.addEventListener) mq.addEventListener("change", mqListener);
    else if ((mq as any)?.addListener) (mq as any).addListener(mqListener);

    // Trigger initial position update (only after restoration completes)
    updatePosition();

    return () => {
      if (rafIdForDpr !== null) {
        window.cancelAnimationFrame(rafIdForDpr);
        rafIdForDpr = null;
      }
      container.removeEventListener("scroll", onScrollEvent);
      if (mq?.removeEventListener) mq.removeEventListener("change", mqListener);
      else if ((mq as any)?.removeListener)
        (mq as any).removeListener(mqListener);
    };
  }, [store, calculateCurrentPosition, store.pageCount]);

  // ═══════════════════════════════════════════════════════════════
  // INITIAL PAGE RESTORATION FROM URL
  // ═══════════════════════════════════════════════════════════════
  const hasRestoredRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (store.pageCount === 0) return;
    if (hasRestoredRef.current) return;
    if (!store.pendingScrollRestore) return;

    hasRestoredRef.current = true;

    const { pageNum, position } = store.pendingScrollRestore;

    // Clear the pending restore
    store.clearPendingScrollRestore();

    // Prevent intersection observer interference during restoration
    isProgrammaticScrollRef.current = true;

    // Use double RAF to ensure layout has settled
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreScrollPosition(pageNum, position);
        // Clear programmatic scroll flag
        setTimeout(() => {
          isProgrammaticScrollRef.current = false;
          store.finishInitialRestore();
        }, 100);
      });
    });
  }, [store, store.pageCount, store.pendingScrollRestore]);

  // ═══════════════════════════════════════════════════════════════
  // ZOOM SCROLL RESTORATION (for zoom changes)
  // ═══════════════════════════════════════════════════════════════
  const lastPendingRestoreRef = useRef(store.pendingScrollRestore);

  useEffect(() => {
    // Skip initial restoration (handled above)
    if (!hasRestoredRef.current) {
      console.log(
        "[PdfViewer] Skipping zoom restore - waiting for initial restore",
      );
      return;
    }

    // Only run when pendingScrollRestore changes from null to non-null
    if (!store.pendingScrollRestore) {
      return;
    }
    if (lastPendingRestoreRef.current === store.pendingScrollRestore) {
      console.log("[PdfViewer] Skipping zoom restore - same restore object");
      return;
    }

    const { pageNum, position } = store.pendingScrollRestore;
    console.log(
      `[PdfViewer] Zoom scroll restore: page ${pageNum}, position ${position.toFixed(3)}`,
    );
    lastPendingRestoreRef.current = store.pendingScrollRestore;

    // Clear the pending restore
    store.clearPendingScrollRestore();

    // Prevent intersection observer interference during restoration
    isProgrammaticScrollRef.current = true;

    // Use double RAF to ensure layout has settled after PPI change
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreScrollPosition(pageNum, position);
        console.log(`[PdfViewer] Scroll position restored to page ${pageNum}`);
        // Clear programmatic scroll flag
        setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, 100);
      });
    });
  }, [store, store.pendingScrollRestore]);

  if (store.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Loading PDF…
      </div>
    );
  }

  if (store.error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-500">
        Error: {store.error}
      </div>
    );
  }

  const pageCount = store.pageCount;

  // Container width adapts to content but never exceeds viewport
  const containerMaxWidth =
    store.maxPageWidth > 0
      ? `min(${store.maxPageWidth + 32}px, 100vw - 2rem)`
      : "min(100vw - 2rem, 1200px)";

  return (
    <div
      ref={containerRef}
      className="h-screen bg-gray-100 relative overflow-auto outline-none"
    >
      {/* Debug overlay */}
      <PdfDebugOverlay
        store={store}
        isOpen={isDebugOpen}
        onToggle={() => setIsDebugOpen(!isDebugOpen)}
      />

      {/* Loading overlay during page restoration */}
      {store.isRestoringInitialView && (
        <div className="absolute inset-0 z-50 bg-gray-100 flex items-center justify-center">
          <div className="text-gray-500">Loading PDF…</div>
        </div>
      )}

      {/* Zoom controls */}
      {pageCount > 0 && (
        <ZoomControlsObserver
          store={store}
          containerRef={containerRef}
          containerWidth={containerWidth}
        />
      )}

      {/* Page slider navigation */}
      {pageCount > 0 && (
        <PageSliderObserver
          store={store}
          pageCount={pageCount}
          onPageChange={handlePageSliderChange}
        />
      )}

      <div
        className="pdf-scroll-container mx-auto px-4 py-8"
        style={{ maxWidth: containerMaxWidth }}
      >
        {Array.from({ length: pageCount }).map((_, index0) => {
          const page = index0 + 1; // Convert 0-based array index to 1-based page number
          const pageData = store.getPageData(page);

          if (!pageData) return null;

          return (
            <PageSlotWrapper
              key={page}
              store={store}
              pageData={pageData}
              slotRef={(el: HTMLDivElement | null) => {
                const prev = slotRefs.current[index0];
                if (prev && currentPageObserverRef.current) {
                  currentPageObserverRef.current.unobserve(prev);
                }
                slotRefs.current[index0] = el;
                if (el && currentPageObserverRef.current) {
                  currentPageObserverRef.current.observe(el);
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
});

export default PdfViewer;
