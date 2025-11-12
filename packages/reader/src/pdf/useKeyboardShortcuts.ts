import { useEffect, type RefObject } from "react";
import type { PdfReaderStore } from "../stores/PdfReaderStore";
import { ZOOM_PERCENT_LEVELS } from "./pdfConstants";

interface UseKeyboardShortcutsOptions {
  store: PdfReaderStore;
  containerRef: RefObject<HTMLDivElement | null>;
  calculateCurrentPositionWithPage: () => { pageNum: number; position: number };
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
 * - Home : Jump to first page
 * - End  : Jump to last page
 * - PageUp   : Previous page (Shift+PageUp: -10 pages)
 * - PageDown : Next page (Shift+PageDown: +10 pages)
 *
 * REQUIREMENTS:
 * - Container must be focused (tabindex="0")
 * - Shortcuts disabled when focus is in input/textarea
 */
export function useKeyboardShortcuts({
  store,
  containerRef,
  calculateCurrentPositionWithPage,
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
          const { pageNum, position } = calculateCurrentPositionWithPage();
          store.setPendingScrollRestore(pageNum, position);
          store.zoomIn(ZOOM_PERCENT_LEVELS);
          break;
        }
        case "-":
        case "_": {
          // Zoom out
          e.preventDefault();
          const { pageNum, position } = calculateCurrentPositionWithPage();
          store.setPendingScrollRestore(pageNum, position);
          store.zoomOut(ZOOM_PERCENT_LEVELS);
          break;
        }
        case "0": {
          // Reset to 100%
          e.preventDefault();
          const { pageNum, position } = calculateCurrentPositionWithPage();
          store.setPendingScrollRestore(pageNum, position);
          store.resetZoom();
          break;
        }
        case "f":
        case "F": {
          // Fit to width
          e.preventDefault();
          const { pageNum, position } = calculateCurrentPositionWithPage();
          store.setPendingScrollRestore(pageNum, position);
          store.fitToWidth();
          break;
        }
        case "Home": {
          // Jump to first page
          e.preventDefault();
          onNavigateToPage(1);
          break;
        }
        case "End": {
          // Jump to last page
          e.preventDefault();
          onNavigateToPage(store.pageCount);
          break;
        }
        case "PageUp": {
          // Previous page (Shift+PageUp: -10 pages)
          e.preventDefault();
          const prevPage = e.shiftKey
            ? Math.max(1, store.currentPage - 10)
            : Math.max(1, store.currentPage - 1);
          if (prevPage !== store.currentPage) {
            onNavigateToPage(prevPage);
          }
          break;
        }
        case "PageDown": {
          // Next page (Shift+PageDown: +10 pages)
          e.preventDefault();
          const nextPage = e.shiftKey
            ? Math.min(store.pageCount, store.currentPage + 10)
            : Math.min(store.pageCount, store.currentPage + 1);
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
  }, [store, containerRef, calculateCurrentPositionWithPage, onNavigateToPage]);
}
