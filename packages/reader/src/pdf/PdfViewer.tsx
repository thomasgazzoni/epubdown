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
  calculateCurrentPositionWithPage: () => { pageNum: number; position: number };
  getContentWidth: () => number;
}> = observer(
  ({ store, calculateCurrentPositionWithPage, getContentWidth }) => {
    return (
      <div className="fixed bottom-4 left-4 z-10 bg-white rounded-lg shadow px-2 py-2 flex items-center gap-2">
        <button
          onClick={() => {
            const { pageNum, position } = calculateCurrentPositionWithPage();
            const width = getContentWidth();
            store.setPendingScrollRestore(pageNum, position);
            store.zoomOut(ZOOM_PERCENT_LEVELS, width);
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
            const { pageNum, position } = calculateCurrentPositionWithPage();
            const width = getContentWidth();
            store.setPendingScrollRestore(pageNum, position);
            store.zoomIn(ZOOM_PERCENT_LEVELS, width);
          }}
          disabled={!store.canZoomIn(ZOOM_PERCENT_LEVELS)}
          className="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100"
        >
          +
        </button>

        <button
          onClick={() => {
            const { pageNum, position } = calculateCurrentPositionWithPage();
            const width = getContentWidth();
            store.setPendingScrollRestore(pageNum, position);
            store.fitToWidth(width);
          }}
          className="ml-1 px-2 py-1 rounded text-xs font-medium hover:bg-gray-100"
          title="Fit page width to container"
        >
          Fit
        </button>

        <button
          onClick={() => {
            const { pageNum, position } = calculateCurrentPositionWithPage();
            const width = getContentWidth();
            store.setPendingScrollRestore(pageNum, position);
            store.resetZoom(width);
          }}
          className="px-2 py-1 rounded text-xs font-medium hover:bg-gray-100"
          title="Reset to 100%"
        >
          100%
        </button>
      </div>
    );
  },
);

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
 *    - Store manages restoration state via RestorationController
 *    - Loading overlay shown based on restoration.shouldShowOverlay
 *    - State machine: idle → initializing → ready → scrolling → complete
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
 * - Store manages: zoomMode, pendingScrollRestore, devicePixelRatio, restoration controller
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
  // contentRef: Inner container holding the pages (with max-width and padding)
  // Used for accurate width measurement for viewport zoom
  const contentRef = useRef<HTMLDivElement>(null);
  // slotRefs: Array of page container divs (one per page)
  // Used for: scrollIntoView, IntersectionObserver, position calculations
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  // currentPageObserver: Consolidated observer for visibility and current page tracking
  const currentPageObserverRef = useRef<IntersectionObserver | null>(null);
  // Flag to prevent intersection observer from updating page during programmatic scrolls
  const isProgrammaticScrollRef = useRef(false);

  /**
   * Helper to perform programmatic scroll and clear flag reliably
   * Uses RAF instead of setTimeout for more reliable scroll event handling
   */
  const performProgrammaticScroll = useCallback(
    (slot: HTMLElement, behavior: ScrollBehavior = "auto") => {
      isProgrammaticScrollRef.current = true;
      slot.scrollIntoView({ behavior, block: "start" });

      // Use double RAF to ensure scroll event has been processed
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    },
    [],
  );

  /**
   * Helper to wrap programmatic scroll operations (for direct scrollTop setting)
   * Uses RAF instead of setTimeout for more reliable flag clearing
   */
  const withProgrammaticScroll = useCallback((fn: () => void) => {
    isProgrammaticScrollRef.current = true;
    fn();

    // Use double RAF to ensure scroll event has been processed
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    });
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // DEVICE PIXEL RATIO TRACKING
  // ═══════════════════════════════════════════════════════════════
  // devicePixelRatio is tracked in store

  // Debug overlay state
  const [isDebugOpen, setIsDebugOpen] = useState(false);

  // Calculate current position within the current page (0.0 = top, 1.0 = bottom)
  // Returns the page number and position as a tuple for zoom operations
  // Note: This calculates the ACTUAL page at viewport center, not store.currentPage,
  // to avoid race conditions with IntersectionObserver updates
  const calculateCurrentPositionWithPage = useCallback((): {
    pageNum: number;
    position: number;
  } => {
    if (!containerRef.current) {
      console.log(
        "[PdfViewer] calculateCurrentPositionWithPage: no containerRef",
      );
      return { pageNum: store.currentPage, position: 0 };
    }

    const container = containerRef.current;
    const viewportCenter = container.clientHeight / 2;
    const absoluteCenter = container.scrollTop + viewportCenter;

    // Find which page contains the viewport center
    let foundPageNum = store.currentPage;
    for (let i = 0; i < slotRefs.current.length; i++) {
      const slot = slotRefs.current[i];
      if (!slot) continue;

      const slotTop = slot.offsetTop;
      const slotBottom = slotTop + slot.offsetHeight;

      if (absoluteCenter >= slotTop && absoluteCenter < slotBottom) {
        foundPageNum = i + 1; // Convert to 1-based page number
        break;
      }
    }

    const slot = slotRefs.current[foundPageNum - 1];
    if (!slot) {
      console.log(
        `[PdfViewer] calculateCurrentPositionWithPage: no slot for page ${foundPageNum}`,
      );
      return { pageNum: foundPageNum, position: 0 };
    }

    // Calculate position within the found page
    const slotTopRelativeToViewport = slot.offsetTop - container.scrollTop;
    const distanceFromSlotTopToCenter =
      viewportCenter - slotTopRelativeToViewport;
    const h = slot.offsetHeight || 1;
    const position = Math.max(0, Math.min(1, distanceFromSlotTopToCenter / h));

    console.log(
      `[PdfViewer] calculateCurrentPositionWithPage: page=${foundPageNum}, position=${position.toFixed(3)}`,
    );
    return { pageNum: foundPageNum, position };
  }, [store]);

  // Legacy wrapper for scroll position updates (uses store.currentPage)
  const calculateCurrentPosition = useCallback((): number => {
    if (!containerRef.current) {
      return 0;
    }

    const pageNum = store.currentPage;
    const container = containerRef.current;
    const slot = slotRefs.current[pageNum - 1];
    if (!slot) {
      return 0;
    }

    const viewportCenter = container.clientHeight / 2;
    const slotTopRelativeToViewport = slot.offsetTop - container.scrollTop;
    const distanceFromSlotTopToCenter =
      viewportCenter - slotTopRelativeToViewport;
    const h = slot.offsetHeight || 1;
    const position = Math.max(0, Math.min(1, distanceFromSlotTopToCenter / h));

    return position;
  }, [store]);

  // Get current content width directly from DOM
  // This avoids issues with stale state when ResizeObserver hasn't fired yet
  const getContentWidth = useCallback((): number => {
    if (!contentRef.current) return 0;
    const width = contentRef.current.getBoundingClientRect().width;
    console.log("[PdfViewer] getContentWidth:", width);
    return width;
  }, []);

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

  // Track content width for accurate viewport zoom calculations
  // Observe the inner container (with max-width and padding) not the outer scroll viewport
  useEffect(() => {
    if (!contentRef.current) return;

    const handleWidthChange = (width: number) => {
      if (width > 0) {
        // Always call applyViewportZoom to update lastContainerWidth
        // If pageCount === 0, it will just save the width for later use
        // If pageCount > 0, it will recalculate page dimensions
        store.applyViewportZoom(width);
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        handleWidthChange(entry.contentRect.width);
      }
    });

    resizeObserver.observe(contentRef.current);

    // Manually trigger initial measurement (ResizeObserver doesn't fire for initial size)
    const initialWidth = contentRef.current.getBoundingClientRect().width;
    if (initialWidth > 0) {
      handleWidthChange(initialWidth);
    }

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

    // Scroll to the page (convert to 0-based index for array)
    const slot = slotRefs.current[store.currentPage - 1];
    if (slot && containerRef.current) {
      performProgrammaticScroll(slot);
    }
  }, [store, store.currentPage, performProgrammaticScroll]);

  // Keyboard shortcuts for zoom and navigation
  useKeyboardShortcuts({
    store,
    containerRef,
    calculateCurrentPositionWithPage,
    onNavigateToPage: (page: number) => {
      store.setCurrentPage(page);
      lastManualPageRef.current = page;

      const slot = slotRefs.current[page - 1];
      if (slot && containerRef.current) {
        performProgrammaticScroll(slot);
      }
    },
  });

  // Handle page changes from PageSlider
  const handlePageSliderChange = useCallback(
    (page: number) => {
      store.setCurrentPage(page);
      lastManualPageRef.current = page;

      const slot = slotRefs.current[page - 1];
      if (slot && containerRef.current) {
        performProgrammaticScroll(slot);
      }
    },
    [store, performProgrammaticScroll],
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
    // NOTE: Don't check pageCount here! The event listener works regardless of whether pages are loaded.
    // Checking pageCount causes the effect to wait, then when pages load, the effect re-runs
    // but containerRef might be null at that moment due to React's rendering cycle.

    const container = containerRef.current;
    let rafIdForDpr: number | null = null;
    const prevDprRef = { current: window.devicePixelRatio || 1 };

    // Notify store about scroll/layout changes (triggers render scheduling)
    const onScrollEvent = () => {
      // Skip render scheduling if this is a programmatic scroll
      // (from slider, keyboard shortcuts, or TOC navigation)
      if (!isProgrammaticScrollRef.current) {
        store.onScroll();
      }

      // Update position in URL (throttled and restoration-aware in store)
      store.updatePositionFromScroll(calculateCurrentPosition);
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

    // NOTE: Do NOT call store.updatePositionFromScroll here!
    // That would write to the URL before parseUrlParams() is called, overwriting the initial URL.
    // The position will be updated naturally via scroll events after restoration completes.

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
  }, [
    store,
    calculateCurrentPosition,
    // NOTE: Do NOT add store.pageCount or store.restoration.phase here!
    // The scroll event listener doesn't depend on these values - it works regardless.
    // Adding them causes the effect to re-run when they change, which can lead to
    // race conditions where containerRef is unavailable during the re-run.
    // Restoration state is already handled inside store.updatePositionFromScroll()
  ]);

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

    // Use double RAF to ensure layout has settled
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        withProgrammaticScroll(() => {
          console.log("[PdfViewer] Restoring scroll position", {
            pageNum,
            position,
          });
          restoreScrollPosition(pageNum, position);

          // Mark scrolling in restoration state machine
          store.restoration.markScrolling();
        });

        // Trigger render after scroll restoration (important for pages to show up)
        requestAnimationFrame(() => {
          store.onScroll();
        });
      });
    });
  }, [
    store,
    store.pageCount,
    store.pendingScrollRestore,
    withProgrammaticScroll,
  ]);

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
      `[PdfViewer] Zoom scroll restore: page ${pageNum}, position ${position.toFixed(
        3,
      )}`,
    );
    lastPendingRestoreRef.current = store.pendingScrollRestore;

    // Clear the pending restore
    store.clearPendingScrollRestore();

    // Use triple RAF + setTimeout to ensure layout has fully settled after zoom
    // Zoom causes many pages to re-render with new dimensions, which can take time
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            withProgrammaticScroll(() => {
              restoreScrollPosition(pageNum, position);
              console.log(
                `[PdfViewer] Scroll position restored to page ${pageNum}`,
              );
            });
          }, 100);
        });
      });
    });
  }, [store, store.pendingScrollRestore, withProgrammaticScroll]);

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
      {store.restoration.shouldShowOverlay && (
        <div className="absolute inset-0 z-50 bg-gray-100 flex items-center justify-center">
          <div className="text-gray-500">Loading PDF…</div>
        </div>
      )}

      {/* Zoom controls */}
      {pageCount > 0 && (
        <ZoomControlsObserver
          store={store}
          calculateCurrentPositionWithPage={calculateCurrentPositionWithPage}
          getContentWidth={getContentWidth}
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
        ref={contentRef}
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
