import { observer } from "mobx-react-lite";
import type React from "react";
import { useEffect, useRef, useState, memo } from "react";
import type { PageData } from "@epubdown/pdf-render";
import type { PdfReaderStore } from "../stores/PdfReaderStore";

/**
 * Canvas/Bitmap display component with efficient rendering
 *
 * This component handles displaying ImageBitmaps or HTMLCanvasElements:
 * - ImageBitmap: Uses 2D context drawImage to copy pixel data to canvas
 * - HTMLCanvasElement: Reparents the canvas (fallback for engines)
 * - null: Shows loading placeholder
 *
 * We use drawImage instead of transferFromImageBitmap to preserve cached bitmaps
 * for reuse when navigating back and forth between pages.
 */
const CanvasHost: React.FC<{
  bitmap: ImageBitmap | null;
  canvas: HTMLCanvasElement | null;
  width: number;
  height: number;
}> = ({ bitmap, canvas, width, height }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const bitmapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  // Track which element is currently mounted to avoid unnecessary DOM operations
  const mountedElementRef = useRef<HTMLElement | null>(null);
  // Track if content is ready to display (waits for paint)
  const [isContentReady, setIsContentReady] = useState(false);
  // Track previous bitmap/canvas to detect actual changes
  const prevBitmapRef = useRef<ImageBitmap | null>(null);
  const prevCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Check if bitmap/canvas actually changed (not just re-rendered)
    // This prevents loading overlay from flashing when PageSlotWrapper re-renders
    // with the same cached bitmap (e.g., during scroll when hasThumb/hasFull updates)
    const bitmapChanged = bitmap !== prevBitmapRef.current;
    const canvasChanged = canvas !== prevCanvasRef.current;
    prevBitmapRef.current = bitmap;
    prevCanvasRef.current = canvas;

    const mount = (el: HTMLElement, onMounted?: () => void) => {
      // Skip if this exact element is already mounted
      if (mountedElementRef.current === el) {
        onMounted?.();
        return;
      }

      // Remove current child if different
      while (host.firstChild) {
        host.removeChild(host.firstChild);
      }

      // Mount new element
      host.appendChild(el);
      mountedElementRef.current = el;
      onMounted?.();
    };

    // Priority 1: Bitmap via 2D context drawImage
    if (bitmap) {
      // Create or reuse bitmap canvas
      if (!bitmapCanvasRef.current) {
        const bmCanvas = document.createElement("canvas");
        bmCanvas.style.maxWidth = "100%";
        bmCanvas.style.height = "auto";
        bmCanvas.style.display = "block";
        bitmapCanvasRef.current = bmCanvas;
      }

      const bmCanvas = bitmapCanvasRef.current;

      // Get device pixel ratio for HiDPI rendering
      const dpr = window.devicePixelRatio || 1;

      // Always size the *backing store* to device pixels,
      // and the *CSS size* to layout pixels for crisp rendering
      const targetW = Math.max(1, Math.round(width * dpr));
      const targetH = Math.max(1, Math.round(height * dpr));

      if (bmCanvas.width !== targetW || bmCanvas.height !== targetH) {
        bmCanvas.width = targetW;
        bmCanvas.height = targetH;
        bmCanvas.style.width = `${width}px`;
        bmCanvas.style.height = `${height}px`;
      }

      // Update canvas content when bitmap changes or size changes
      const ctx2d = bmCanvas.getContext("2d");
      if (ctx2d && bitmapChanged) {
        ctx2d.imageSmoothingEnabled = true; // default; keep text crisp
        ctx2d.clearRect(0, 0, targetW, targetH);
        // Draw bitmap scaled to device pixels for crisp rendering
        // Note: We use drawImage instead of transferFromImageBitmap because
        // transferFromImageBitmap detaches the bitmap, making it unusable for
        // caching. When navigating back and forth, components may unmount/remount
        // and try to reuse already-detached bitmaps from cache. drawImage copies
        // the pixel data, leaving the cached bitmap intact for reuse.
        ctx2d.drawImage(bitmap, 0, 0, targetW, targetH);
      }

      // Only show loading overlay if bitmap actually changed
      if (bitmapChanged) {
        setIsContentReady(false);
        mount(bmCanvas, () => {
          // Use double RAF to ensure canvas is actually painted
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setIsContentReady(true);
            });
          });
        });
      } else {
        // Same bitmap, just ensure it's mounted (already ready)
        mount(bmCanvas, () => setIsContentReady(true));
      }
      currentCanvasRef.current = null;
      return;
    }

    // Priority 2: Canvas fallback (engine-rendered)
    if (canvas) {
      canvas.style.maxWidth = "100%";
      canvas.style.height = "auto";
      canvas.style.display = "block";

      // Only show loading overlay if canvas actually changed
      if (canvasChanged) {
        setIsContentReady(false);
        mount(canvas, () => {
          // Use double RAF to ensure canvas is actually painted
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setIsContentReady(true);
            });
          });
        });
      } else {
        // Same canvas, just ensure it's mounted (already ready)
        mount(canvas, () => setIsContentReady(true));
      }
      currentCanvasRef.current = canvas;
      return;
    }

    // Priority 3: Loading placeholder
    if (!placeholderRef.current) {
      const ph = document.createElement("div");
      ph.className = "absolute inset-0 flex items-center justify-center";
      ph.style.background = "#f5f5f5";
      ph.style.border = "1px solid #ddd";
      ph.innerHTML = '<span class="text-gray-400 text-sm">Loading...</span>';
      placeholderRef.current = ph;
    }
    setIsContentReady(true); // Placeholder is immediately ready
    mount(placeholderRef.current);
    currentCanvasRef.current = null;
  }, [bitmap, canvas, width, height]);

  return (
    <div
      ref={hostRef}
      className="relative bg-white shadow-sm"
      style={{ width, height, maxWidth: "100%" }}
    >
      {/* Loading overlay - stays visible until content is painted */}
      {!isContentReady && (bitmap || canvas) && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            background: "#f5f5f5",
            border: "1px solid #ddd",
            zIndex: 10,
          }}
        >
          <span className="text-gray-400 text-sm">Loading...</span>
        </div>
      )}
    </div>
  );
};

/**
 * PageSlotWrapper: Observer wrapper that fetches bitmap/canvas from store
 * This component re-renders when hasThumb/hasFull flags change, ensuring
 * that PageSlot receives updated bitmap/canvas props.
 */
export const PageSlotWrapper = observer(
  ({
    store,
    pageData,
    slotRef,
  }: {
    store: PdfReaderStore;
    pageData: PageData;
    slotRef?: (el: HTMLDivElement | null) => void;
  }) => {
    // Access observable flags to create MobX dependencies
    // This causes this wrapper to re-render when bitmaps become available
    void pageData.hasThumb;
    void pageData.hasFull;

    // Fetch bitmap and canvas from store (these Maps are non-observable)
    // But since this component re-renders when hasThumb/hasFull change,
    // we'll fetch the updated bitmap/canvas values
    const bitmap = store.getBitmapForPage(pageData.pageNumber);
    const canvas = store.getPageCanvas(pageData.pageNumber);

    return (
      <PageSlot
        pageData={pageData}
        bitmap={bitmap}
        canvas={canvas}
        slotRef={slotRef}
      />
    );
  },
);

/**
 * PageSlot component: Stable shell for a PDF page.
 *
 * This component only receives specific props to avoid unnecessary re-renders:
 * - pageData: Page dimensions and rendering stats
 * - bitmap: The rendered bitmap (if available)
 * - canvas: The rendered canvas (if available)
 *
 * Canvas display is independent of render scheduling - if we have a canvas, we show it.
 * The RenderQueue handles which pages to render based on visibility and priority.
 *
 * Performance optimizations:
 * - contain: "content" isolates layout/paint
 * - contentVisibility: "auto" skips painting when offscreen
 * - React.memo prevents re-renders when props haven't changed
 */
const PageSlotComponent = observer(
  ({
    pageData,
    bitmap,
    canvas,
    slotRef,
  }: {
    pageData: PageData;
    bitmap?: ImageBitmap | null;
    canvas?: HTMLCanvasElement | null;
    slotRef?: (el: HTMLDivElement | null) => void;
  }) => {
    // Use CSS dimensions from pageData
    const width = pageData.wCss ?? 612;
    const height = pageData.hCss ?? 792;

    return (
      <div
        data-index={pageData.pageNumber - 1}
        data-page={pageData.pageNumber}
        id={`page-${pageData.pageNumber}`}
        className="pdf-page-slot mb-4 flex justify-center items-start"
        style={{
          height,
          position: "relative",
          // Performance wins for offscreen shells:
          contain: "content", // isolate layout/paint
          contentVisibility: "auto" as any, // skip painting when offscreen
        }}
        ref={slotRef}
      >
        {/* Page number label with optional render stats */}
        <div className="absolute top-2 left-2 z-20 px-2 py-1 rounded text-xs font-mono bg-gray-800 text-white flex gap-2 items-center">
          <span>{pageData.pageNumber}</span>
          {pageData.renderDurationMs !== undefined && (
            <span className="text-gray-400">
              {pageData.renderDurationMs.toFixed(0)}ms
            </span>
          )}
        </div>

        <CanvasHost
          bitmap={bitmap ?? null}
          canvas={canvas ?? null}
          width={width}
          height={height}
        />
      </div>
    );
  },
);

/**
 * Memoized PageSlot to prevent re-renders when props haven't changed.
 * This is critical for scroll performance - without memo, PageSlot re-renders
 * every time PageSlotWrapper re-renders (due to MobX reactivity), even if
 * the bitmap/canvas refs are the same.
 */
export const PageSlot = memo(PageSlotComponent);
