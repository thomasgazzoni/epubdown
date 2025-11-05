import { observer } from "mobx-react-lite";
import { reaction } from "mobx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfReaderStore } from "../stores/PdfReaderStore";
import { makeVisibilityTracker } from "./VisibilityWindow";
import { ZOOM_PPI_LEVELS } from "./pdfConstants";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { PageSlider } from "../slider/PageSlider";

/**
 * ARCHITECTURE: PDF Viewer Component
 *
 * This is the main rendering component for PDF documents. It manages:
 *
 * 1. VIEWPORT & SCROLLING:
 *    - Virtual scrolling container with all pages stacked vertically
 *    - Each page slot has fixed dimensions (from store.getPageLayout)
 *    - Scroll position tracked for URL synchronization
 *    - IntersectionObserver tracks visible pages
 *
 * 2. CANVAS LIFECYCLE:
 *    - Store owns canvas elements (via PageRecord)
 *    - Component mounts/unmounts canvases to DOM via refs
 *    - MobX reaction syncs canvas changes from store → DOM
 *    - Canvases persist across re-renders (performance)
 *
 * 3. INTERSECTION OBSERVERS:
 *    - visibilityTracker: Coarse viewport tracking (triggers rendering)
 *    - currentPageObserver: Fine-grained page visibility (current page indicator)
 *    - Both use containerRef as root (not window) for nested scrolling
 *
 * 4. ZOOM & LAYOUT:
 *    - Two zoom modes: manual (fixed PPI) and fit-to-width (dynamic PPI)
 *    - Zoom logic managed by store (zoomIn, zoomOut, resetZoom, fitToWidth)
 *    - ResizeObserver updates fit-width when container resizes
 *    - Scroll position preserved across zoom changes (via store.pendingScrollRestore)
 *    - devicePixelRatio tracked by store and updated on display changes
 *
 * 5. INITIAL PAGE RESTORATION:
 *    - Read URL params: ?page=N&ppi=N&position=0.0-1.0
 *    - Wait for dimensionRevision > 0 (page sizes loaded)
 *    - Show loading overlay during scroll restoration (prevents page jumping)
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
 * - hasRestoredRef: Tracks if initial page restoration is complete
 * - isRestoring: Controls loading overlay visibility
 * - slotRefs: Array of page slot DOM elements
 * - canvasHostRefs: Array of canvas container elements
 * - Store manages: zoomMode, pendingScrollRestore, devicePixelRatio
 *
 * REFACTORING CONSIDERATIONS:
 * - Component reduced from ~780 to ~600 lines via refactoring
 * - ✅ Zoom logic moved to store (cleaner state management)
 * - ✅ Keyboard shortcuts extracted to useKeyboardShortcuts hook
 * - Zoom controls could still be extracted to separate component
 * - IntersectionObserver logic could be extracted to custom hook
 * - Consider using virtual scrolling library (react-window) for very large PDFs
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
  // canvasHostRefs: Array of divs that hold rendered canvas elements
  // Canvases are created by store, mounted here via MobX reaction
  const canvasHostRefs = useRef<(HTMLDivElement | null)[]>([]);
  // trackerRef: Coarse visibility tracker (IntersectionObserver wrapper)
  const trackerRef = useRef<ReturnType<typeof makeVisibilityTracker> | null>(
    null,
  );
  // currentPageObserver: Fine-grained observer for current page tracking
  const currentPageObserverRef = useRef<IntersectionObserver | null>(null);
  // Flag to prevent intersection observer from updating page during programmatic scrolls
  const isProgrammaticScrollRef = useRef(false);

  // ═══════════════════════════════════════════════════════════════
  // DEVICE PIXEL RATIO TRACKING
  // ═══════════════════════════════════════════════════════════════
  // devicePixelRatio is now tracked in store, but we read it here for rendering
  const devicePixelRatio = store.devicePixelRatio;

  // Track container width for responsive maxPpi calculation
  const [containerWidth, setContainerWidth] = useState(0);

  // Calculate the fit-to-width PPI as max zoom
  const maxPpi = useMemo(() => {
    if (!containerWidth) return 192;
    return store.getMaxPpi(containerWidth, devicePixelRatio);
  }, [
    store,
    store.currentPage,
    store.pages,
    store.ppi,
    devicePixelRatio,
    containerWidth,
  ]);

  // Calculate current position within the current page (0.0 = top, 1.0 = bottom)
  const calculateCurrentPosition = useCallback((): number => {
    if (!containerRef.current) return 0;

    const index0 = store.currentPageIndex;
    const slot = slotRefs.current[index0];
    if (!slot) return 0;

    const containerRect = containerRef.current.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();

    // Calculate offset within page
    const pageTopOffset = slotRect.top - containerRect.top;
    const offsetWithinPage = -pageTopOffset;
    const slotHeight = slotRect.height;

    // Return as ratio, clamped to [0, 1]
    return slotHeight > 0
      ? Math.max(0, Math.min(1, offsetWithinPage / slotHeight))
      : 0;
  }, [store.currentPageIndex]);

  // Restore scroll position based on page and position percentage
  const restoreScrollPosition = (pageIndex: number, position: number) => {
    const slot = slotRefs.current[pageIndex];
    if (!slot || !containerRef.current) return;

    // Calculate absolute scroll position directly (avoids layout thrashing from scrollIntoView)
    const container = containerRef.current;
    const slotTop = slot.offsetTop;
    const slotHeight = slot.offsetHeight;

    // Set scroll position to page top + position percentage
    container.scrollTop = slotTop + slotHeight * position;
  };

  const fitCurrentWidth = useCallback(() => {
    if (!containerRef.current) return;
    const cssWidth = containerRef.current.clientWidth;
    const position = calculateCurrentPosition();
    const dpr = window.devicePixelRatio || 1;
    store.fitToWidth(cssWidth, position, dpr);
  }, [store, calculateCurrentPosition]);

  useEffect(() => {
    slotRefs.current.length = store.pageCount;
    canvasHostRefs.current.length = store.pageCount;
  }, [store.pageCount]);

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

    // Scroll to the page
    const slot = slotRefs.current[store.currentPageIndex];
    if (slot && containerRef.current) {
      slot.scrollIntoView({ behavior: "auto", block: "start" });
    }

    // Clear flag after scroll settles
    const timer = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 100);

    return () => clearTimeout(timer);
  }, [store.currentPage, store.currentPageIndex]);

  // ResizeObserver for container size changes
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const newWidth = entry.contentRect.width;
        setContainerWidth(newWidth);
        if (store.zoomMode === "fit") {
          fitCurrentWidth();
        }
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [store.zoomMode, fitCurrentWidth]);

  // Keyboard shortcuts for zoom and navigation
  useKeyboardShortcuts({
    store,
    containerRef,
    calculateCurrentPosition,
    maxPpi,
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

    const tracker = makeVisibilityTracker((visible) => {
      store.onPagesVisible(visible);
    });
    trackerRef.current = tracker;

    // Track intersection ratios for all pages
    const pageRatios = new Map<number, number>();

    // Observer for current page tracking
    // Page with highest visibility becomes the current page
    const currentPageObserver = new IntersectionObserver(
      (entries) => {
        // Skip updates during programmatic scrolls to prevent race conditions
        if (isProgrammaticScrollRef.current) return;

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

        // Find the page with the highest visibility
        let maxRatio = 0;
        let maxIndex = -1;

        for (const [index, ratio] of pageRatios.entries()) {
          if (ratio > maxRatio) {
            maxRatio = ratio;
            maxIndex = index;
          }
        }

        // Update current page to the most visible page
        if (maxIndex >= 0) {
          const newPage = maxIndex + 1;
          if (newPage !== store.currentPage) {
            store.setCurrentPage(newPage);
            // Update the ref so we don't trigger scroll on natural page changes
            lastManualPageRef.current = newPage;
          }
        }
      },
      {
        root: containerRef.current,
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0],
      },
    );
    currentPageObserverRef.current = currentPageObserver;

    // Observe existing slots
    for (const el of slotRefs.current) {
      if (el) {
        tracker.observe(el);
        currentPageObserver.observe(el);
      }
    }

    return () => {
      if (trackerRef.current === tracker) {
        trackerRef.current = null;
      }
      if (currentPageObserverRef.current === currentPageObserver) {
        currentPageObserverRef.current = null;
      }
      store.onPagesVisible([]);
      tracker.disconnect();
      currentPageObserver.disconnect();
    };
  }, [store]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!containerRef.current) return;
    if (store.pageCount === 0) return;

    const container = containerRef.current;
    let rafIdForFit: number | null = null;
    const prevDprRef = { current: window.devicePixelRatio || 1 };

    // Update position immediately on scroll (no RAF delay)
    const updatePosition = () => {
      // Don't update position/URL until initial restoration is complete
      if (!hasRestoredRef.current) return;

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
      store.onScroll();
      // Update URL with throttling to reduce noise
      throttledUpdatePosition();
    };

    // Handle resize and DPR changes with RAF for fit mode
    const onResizeOrDpr = () => {
      if (rafIdForFit !== null) return;
      rafIdForFit = window.requestAnimationFrame(() => {
        rafIdForFit = null;
        const nowDpr = window.devicePixelRatio || 1;
        const dprChanged = Math.abs(nowDpr - prevDprRef.current) > 0.001;
        if (dprChanged) {
          prevDprRef.current = nowDpr;
          // Update store DPR (triggers re-render via dimensionRevision)
          store.updateDevicePixelRatio(nowDpr);
        }
        if (store.zoomMode === "fit" && containerRef.current) {
          fitCurrentWidth();
        }
        // Update position after potential fit changes
        updatePosition();
      });
    };

    // Listen to scroll on the actual container, not window
    container.addEventListener("scroll", onScrollEvent, { passive: true });
    window.addEventListener("resize", onResizeOrDpr, { passive: true });

    // Some browsers won't emit resize on DPR changes; listen to MQ as a backup
    // Use a generic media query that always matches to detect any resolution change
    const mq = window.matchMedia("(min-resolution: 0.001dppx)");
    const mqListener = () => onResizeOrDpr();
    if (mq?.addEventListener) mq.addEventListener("change", mqListener);
    else if ((mq as any)?.addListener) (mq as any).addListener(mqListener);

    // Trigger initial position update (only after restoration completes)
    updatePosition();

    return () => {
      if (rafIdForFit !== null) {
        window.cancelAnimationFrame(rafIdForFit);
        rafIdForFit = null;
      }
      container.removeEventListener("scroll", onScrollEvent);
      window.removeEventListener("resize", onResizeOrDpr);
      if (mq?.removeEventListener) mq.removeEventListener("change", mqListener);
      else if ((mq as any)?.removeListener)
        (mq as any).removeListener(mqListener);
    };
  }, [store, calculateCurrentPosition, store.pageCount]);

  // ═══════════════════════════════════════════════════════════════
  // INITIAL PAGE RESTORATION FROM URL
  // ═══════════════════════════════════════════════════════════════
  /**
   * CRITICAL TIMING SEQUENCE:
   * 1. Component mounts
   * 2. Store loads PDF and page dimensions
   * 3. dimensionRevision increments (triggers this effect)
   * 4. Read URL params (page, ppi, position)
   * 5. Set store.preventUrlWrite = true (CRITICAL!)
   * 6. Apply PPI and page without writing URL
   * 7. Show loading overlay if page > 1
   * 8. Scroll to target position (triggers render via IntersectionObserver)
   * 9. Wait for target page to render (MobX reaction on page.status)
   * 10. Hide overlay, set preventUrlWrite = false
   *
   * WHY EVENT-BASED (not timeouts):
   * - Waits for actual page rendering, not arbitrary delays
   * - Handles slow rendering gracefully (large/complex pages)
   * - Prevents flickering by keeping overlay until page is ready
   *
   * preventUrlWrite FLAG:
   * - Without this, URL would flicker: ?page=5 → ?page=1 → ?page=5
   * - This happens because setCurrentPage() triggers writeUrl()
   * - preventUrlWrite blocks writeUrl() until restoration completes
   *
   * EDGE CASES:
   * - page=1: No loading overlay (fast path)
   * - Invalid page number: Restore completes immediately
   * - dimensionRevision=0: Wait for page sizes to load
   * - Page already rendered: Complete immediately
   */
  const hasRestoredRef = useRef(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const restorationDisposerRef = useRef<(() => void) | null>(null);
  const restorationTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (store.pageCount === 0) return;
    if (hasRestoredRef.current) return;

    const url = new URL(window.location.href);
    const targetPage = Number(url.searchParams.get("page") ?? 1);
    const targetPosition = Number(url.searchParams.get("position") ?? 0);
    const targetPpi = Number(url.searchParams.get("ppi") ?? 0);

    // Prevent URL writes during restoration to avoid flickering
    store.preventUrlWrite = true;

    // Apply PPI first if specified
    if (targetPpi > 0 && targetPpi !== store.ppi) {
      store.setPpi(targetPpi);
    }

    // Wait for page dimensions to be loaded before restoring scroll
    if (store.dimensionRevision > 0) {
      if (targetPage > 0 && targetPage <= store.pageCount) {
        // Set position first to prevent URL reset when setting page
        store.currentPosition = targetPosition;

        // Then set the current page
        store.setCurrentPage(targetPage);

        // If navigating to page > 1, show loading briefly during scroll restoration
        if (targetPage > 1) {
          setIsRestoring(true);
        }

        // Scroll to target position immediately (after DOM settles)
        requestAnimationFrame(() => {
          restoreScrollPosition(targetPage - 1, targetPosition);

          // Set up reaction to wait for page to render
          const targetPageIndex = targetPage - 1;
          restorationDisposerRef.current = reaction(
            () => store.pages[targetPageIndex]?.status,
            (status) => {
              // Wait for page to be rendered (or if there's an error, complete anyway)
              if (status === "rendered" || status === "error") {
                // Hide loading overlay and re-enable URL writes
                setIsRestoring(false);
                hasRestoredRef.current = true;
                store.preventUrlWrite = false;
                if (restorationTimeoutRef.current !== null) {
                  clearTimeout(restorationTimeoutRef.current);
                  restorationTimeoutRef.current = null;
                }
                if (restorationDisposerRef.current) {
                  restorationDisposerRef.current();
                  restorationDisposerRef.current = null;
                }
              }
            },
            {
              // Fire immediately if page is already rendered
              fireImmediately: true,
            },
          );

          // Safety timeout: complete after 2 seconds even if page doesn't render
          restorationTimeoutRef.current = window.setTimeout(() => {
            if (!hasRestoredRef.current) {
              setIsRestoring(false);
              hasRestoredRef.current = true;
              store.preventUrlWrite = false;
              if (restorationDisposerRef.current) {
                restorationDisposerRef.current();
                restorationDisposerRef.current = null;
              }
            }
          }, 2000);
        });
      } else {
        // No special restoration needed, mark as done immediately
        hasRestoredRef.current = true;
        store.preventUrlWrite = false;
      }
    }

    // Cleanup function
    return () => {
      if (restorationDisposerRef.current) {
        restorationDisposerRef.current();
        restorationDisposerRef.current = null;
      }
      if (restorationTimeoutRef.current !== null) {
        clearTimeout(restorationTimeoutRef.current);
        restorationTimeoutRef.current = null;
      }
    };
  }, [store, store.pageCount, store.dimensionRevision]);

  // Handle pending scroll restoration after dimension changes (zoom)
  useEffect(() => {
    if (store.pendingScrollRestore && store.dimensionRevision > 0) {
      const { pageIndex, position } = store.pendingScrollRestore;
      store.clearPendingScrollRestore();

      // Use double RAF to ensure layout has settled
      // First RAF: after style/layout calculation
      // Second RAF: after paint (ensures container width has updated)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          restoreScrollPosition(pageIndex, position);
        });
      });
    }
  }, [store, store.dimensionRevision, store.pendingScrollRestore]);

  // ═══════════════════════════════════════════════════════════════
  // CANVAS MOUNTING - Store to DOM Synchronization
  // ═══════════════════════════════════════════════════════════════
  /**
   * CRITICAL: This effect syncs canvas elements from store to DOM
   *
   * ARCHITECTURE:
   * - Store creates/owns canvas elements (via PageRecord.ensureCanvas())
   * - Component mounts canvases to DOM via refs
   * - MobX reaction tracks canvas changes per page
   * - Canvases persist across re-renders (not recreated)
   *
   * PERFORMANCE OPTIMIZATIONS:
   * - Local cache (lastByIndex) prevents redundant DOM operations
   * - Only update DOM when canvas identity changes
   * - fireImmediately: true ensures existing canvases mount on first render
   *
   * CANVAS LIFECYCLE:
   * 1. Page becomes visible → performRenderCycle() → renderPage()
   * 2. renderPage() creates canvas → page.ensureCanvas()
   * 3. Canvas rendered to by PDF engine
   * 4. This reaction detects new canvas → mounts to DOM
   * 5. Page leaves viewport → cache.enforce() → canvas may be evicted
   * 6. Canvas eviction → this reaction detects null → removes from DOM
   *
   * EDGE CASES:
   * - host not yet mounted: Skip (will mount on next cycle)
   * - existing canvas replacement: Remove old before adding new
   * - canvas styling: Applied once before mount for consistency
   *
   * REFACTOR CONSIDERATIONS:
   * - Could use React portals instead of direct DOM manipulation
   * - Could extract to useCanvasSync custom hook
   * - Could batch DOM updates with requestAnimationFrame
   */
  useEffect(() => {
    // Local cache to diff canvases by index
    const lastByIndex = new Map<number, HTMLCanvasElement | null>();

    const dispose = reaction(
      () => store.pages.map((p) => [p.index0, p.canvas] as const),
      (pairs) => {
        for (const [index, canvas] of pairs) {
          const prev = lastByIndex.get(index) ?? null;
          if (prev === canvas) continue; // no change → skip work

          lastByIndex.set(index, canvas ?? null);
          const host = canvasHostRefs.current[index];
          if (!host) continue;

          // Remove any old DOM only when needed
          const existing = host.querySelector("canvas");
          if (existing && existing !== canvas) {
            existing.parentElement?.removeChild(existing);
          }

          if (canvas && existing !== canvas) {
            // Style once before mount
            canvas.style.maxWidth = "100%";
            canvas.style.height = "auto";
            canvas.style.display = "block";
            host.appendChild(canvas);
          }
        }
      },
      { fireImmediately: true },
    );

    return dispose;
  }, [store]);

  // Calculate maximum page width to size container
  const maxPageWidth = useMemo(() => {
    return store.pages.reduce((max, page) => {
      if (!page.wPx) return max;
      const cssWidth = Math.floor(page.wPx / devicePixelRatio);
      return Math.max(max, cssWidth);
    }, 0);
    // Depend on dimensionRevision to recalculate when zoom/dimensions change
  }, [store, devicePixelRatio, store.dimensionRevision]);

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
    maxPageWidth > 0
      ? `min(${maxPageWidth + 32}px, 100vw - 2rem)`
      : "min(100vw - 2rem, 1200px)";

  return (
    <div
      ref={containerRef}
      className="h-screen bg-gray-100 relative overflow-auto outline-none"
    >
      {/* Loading overlay during page restoration */}
      {isRestoring && (
        <div className="absolute inset-0 z-50 bg-gray-100 flex items-center justify-center">
          <div className="text-gray-500">Loading PDF…</div>
        </div>
      )}
      {/* Page indicator */}
      {/* {pageCount > 0 && (
        <div className="fixed bottom-4 right-4 z-10 bg-white rounded-lg shadow px-3 py-2 text-sm text-gray-600">
          Page {store.currentPage} of {pageCount}
        </div>
      )} */}

      {/* Zoom controls */}
      {pageCount > 0 && (
        <div className="fixed bottom-4 left-4 z-10 bg-white rounded-lg shadow px-2 py-2 flex items-center gap-2">
          <button
            onClick={() => {
              const position = calculateCurrentPosition();
              store.zoomOut(position, ZOOM_PPI_LEVELS);
            }}
            disabled={!store.canZoomOut(ZOOM_PPI_LEVELS)}
            className="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100"
          >
            −
          </button>

          <span className="text-sm text-gray-600 min-w-[60px] text-center">
            {Math.round((store.ppi / 96) * 100)}%
          </span>

          <button
            onClick={() => {
              const position = calculateCurrentPosition();
              store.zoomIn(position, ZOOM_PPI_LEVELS, maxPpi);
            }}
            disabled={!store.canZoomIn(ZOOM_PPI_LEVELS, maxPpi)}
            className="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100"
          >
            +
          </button>

          <button
            onClick={() => {
              fitCurrentWidth();
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
      )}

      {/* Page slider navigation */}
      {pageCount > 0 && (
        <div className="fixed top-0 right-0 h-screen pr-4 pt-8 pb-8 flex items-center z-10">
          <PageSlider
            currentPage={store.currentPage}
            totalPages={pageCount}
            onPageChange={handlePageSliderChange}
            height="calc(100vh - 4rem)"
            enableKeyboard={false}
          />
        </div>
      )}

      <div
        className="pdf-scroll-container mx-auto px-4 py-8"
        style={{ maxWidth: containerMaxWidth }}
      >
        {Array.from({ length: pageCount }).map((_, index0) => {
          // Access dimensionRevision to trigger re-render when dimensions change
          const _dimensionRevision = store.dimensionRevision;
          const { width, height } = store.getPageLayout(index0);
          const cssWidth = Math.max(1, Math.floor(width / devicePixelRatio));
          const cssHeight = Math.max(1, Math.floor(height / devicePixelRatio));
          const hasCanvas = Boolean(store.pages[index0]?.canvas);
          const pageKey = store.pages[index0]?.index0 ?? index0;
          const isVisible = store.visibleSet.has(index0);
          const page1 = index0 + 1;

          return (
            <div
              key={`page-${pageKey}`}
              data-index={index0}
              data-page={page1}
              id={`page-${page1}`}
              className="pdf-page-slot mb-4 flex justify-center items-start"
              style={{
                height: cssHeight,
                position: "relative",
              }}
              ref={(el) => {
                const prev = slotRefs.current[index0];
                if (prev) {
                  if (trackerRef.current) {
                    trackerRef.current.unobserve(prev);
                  }
                  if (currentPageObserverRef.current) {
                    currentPageObserverRef.current.unobserve(prev);
                  }
                }
                slotRefs.current[index0] = el;
                if (el) {
                  if (trackerRef.current) {
                    trackerRef.current.observe(el);
                  }
                  if (currentPageObserverRef.current) {
                    currentPageObserverRef.current.observe(el);
                  }
                }
              }}
            >
              {/* Page number label */}
              <div className="absolute top-2 left-2 z-20 px-2 py-1 rounded text-xs font-mono bg-gray-800 text-white">
                {index0 + 1}
              </div>

              {isVisible ? (
                <div
                  ref={(el) => {
                    canvasHostRefs.current[index0] = el;

                    // Fix #1: ensure existing canvas gets mounted even if reaction doesn't fire
                    if (el) {
                      const canvas = store.pages[index0]?.canvas ?? null;
                      if (canvas && !el.contains(canvas)) {
                        canvas.style.maxWidth = "100%";
                        canvas.style.height = "auto";
                        canvas.style.display = "block";
                        el.appendChild(canvas);
                      }
                    }
                  }}
                  className="relative bg-white shadow-sm"
                  style={{
                    width: cssWidth,
                    height: cssHeight,
                    maxWidth: "100%",
                  }}
                >
                  {!hasCanvas && (
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{
                        background: "#f5f5f5",
                        border: "1px solid #ddd",
                      }}
                    >
                      <span className="text-gray-400 text-sm">Loading...</span>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  ref={() => {
                    // Clear the host ref when not visible
                    canvasHostRefs.current[index0] = null;
                  }}
                  style={{
                    width: cssWidth,
                    height: cssHeight,
                    maxWidth: "100%",
                  }}
                  className="bg-white shadow-sm"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default PdfViewer;
