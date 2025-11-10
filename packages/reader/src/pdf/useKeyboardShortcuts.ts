import { useEffect, type RefObject } from "react";
import type { PdfReaderStore } from "../stores/PdfReaderStore";
import { ZOOM_PPI_LEVELS } from "./pdfConstants";

interface UseKeyboardShortcutsOptions {
  store: PdfReaderStore;
  containerRef: RefObject<HTMLDivElement | null>;
  calculateCurrentPosition: () => number;
  onNavigateToPage: (page: number) => void;
}

/**
 * Custom hook for PDF viewer keyboard shortcuts
 *
 * SHORTCUTS:
 * - +/= : Zoom in
 * - -/_ : Zoom out
 * - 0   : Reset to 100%
 * - f/F : Fit to width
 * - PageUp   : Previous page
 * - PageDown : Next page
 *
 * REQUIREMENTS:
 * - Container must be focused (tabindex="0")
 * - Shortcuts disabled when focus is in input/textarea
 */
export function useKeyboardShortcuts({
  store,
  containerRef,
  calculateCurrentPosition,
  onNavigateToPage,
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    if (!containerRef.current) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts if not in an input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.key) {
        case "+":
        case "=": {
          // Zoom in
          e.preventDefault();
          if (!containerRef.current) return;
          const position = calculateCurrentPosition();
          const containerWidth = containerRef.current.clientWidth;
          const dpr = window.devicePixelRatio || 1;
          const maxPpi = store.getMaxPpi(containerWidth, dpr);
          store.zoomIn(position, ZOOM_PPI_LEVELS, maxPpi);
          break;
        }
        case "-":
        case "_": {
          // Zoom out
          e.preventDefault();
          const position = calculateCurrentPosition();
          store.zoomOut(position, ZOOM_PPI_LEVELS);
          break;
        }
        case "0": {
          // Reset to 100%
          e.preventDefault();
          const position = calculateCurrentPosition();
          store.resetZoom(position);
          break;
        }
        case "f":
        case "F": {
          // Fit to width
          e.preventDefault();
          if (!containerRef.current) return;
          const cssWidth = containerRef.current.clientWidth;
          const position = calculateCurrentPosition();
          const dpr = window.devicePixelRatio || 1;
          store.fitToWidth(cssWidth, position, dpr);
          break;
        }
        case "PageUp": {
          // Previous page
          e.preventDefault();
          const prevPage = Math.max(1, store.currentPage - 1);
          if (prevPage !== store.currentPage) {
            onNavigateToPage(prevPage);
          }
          break;
        }
        case "PageDown": {
          // Next page
          e.preventDefault();
          const nextPage = Math.min(store.pageCount, store.currentPage + 1);
          if (nextPage !== store.currentPage) {
            onNavigateToPage(nextPage);
          }
          break;
        }
      }
    };

    const container = containerRef.current;
    container.addEventListener("keydown", handleKeyDown);

    // Make container focusable to receive keyboard events
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "0");
    }

    return () => {
      container.removeEventListener("keydown", handleKeyDown);
    };
  }, [store, containerRef, calculateCurrentPosition, onNavigateToPage]);
}
