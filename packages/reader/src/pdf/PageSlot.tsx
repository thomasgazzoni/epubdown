import type { PageData } from "@epubdown/pdf-render";
import { observer } from "mobx-react-lite";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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
  const bitmapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  // Track if content is ready to display (waits for paint)
  const [isContentReady, setIsContentReady] = useState(false);
  // Track previous bitmap/canvas to detect actual changes
  const prevBitmapRef = useRef<ImageBitmap | null>(null);
  const prevCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Check if bitmap/canvas actually changed (not just re-rendered)
  const bitmapChanged = bitmap !== prevBitmapRef.current;
  const canvasChanged = canvas !== prevCanvasRef.current;
  prevBitmapRef.current = bitmap;
  prevCanvasRef.current = canvas;

  // Render bitmap to canvas when bitmap or dimensions change
  useEffect(() => {
    if (!bitmap) return;

    // Create or reuse bitmap canvas
    if (!bitmapCanvasRef.current) {
      bitmapCanvasRef.current = document.createElement("canvas");
    }

    const bmCanvas = bitmapCanvasRef.current;
    bmCanvas.style.display = "block";

    // Get device pixel ratio for HiDPI rendering
    const dpr = window.devicePixelRatio || 1;

    // Always size the *backing store* to device pixels,
    // and the *CSS size* to layout pixels for crisp rendering
    const targetW = Math.max(1, Math.round(width * dpr));
    const targetH = Math.max(1, Math.round(height * dpr));

    const sizeChanged =
      bmCanvas.width !== targetW || bmCanvas.height !== targetH;
    if (sizeChanged) {
      bmCanvas.width = targetW;
      bmCanvas.height = targetH;
      bmCanvas.style.width = `${width}px`;
      bmCanvas.style.height = `${height}px`;
    }

    // Update canvas content when bitmap changes or size changes
    const ctx2d = bmCanvas.getContext("2d");
    if (ctx2d && (bitmapChanged || sizeChanged)) {
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.clearRect(0, 0, targetW, targetH);
      ctx2d.drawImage(bitmap, 0, 0, targetW, targetH);
    }

    // Only show loading overlay if we actually need a repaint
    if (bitmapChanged || sizeChanged) {
      setIsContentReady(false);
      // Use double RAF to ensure canvas is actually painted
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsContentReady(true);
        });
      });
    } else {
      setIsContentReady(true);
    }
  }, [bitmap, width, height, bitmapChanged]);

  // Mount bitmap canvas to container
  useEffect(() => {
    const container = canvasContainerRef.current;
    const bmCanvas = bitmapCanvasRef.current;
    if (!container || !bitmap || !bmCanvas) return;

    // Safely append canvas if not already a child
    if (!container.contains(bmCanvas)) {
      // Clear any existing children first
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      container.appendChild(bmCanvas);
    }

    return () => {
      // Cleanup: remove canvas when unmounting or when bitmap becomes null
      if (container.contains(bmCanvas)) {
        container.removeChild(bmCanvas);
      }
    };
  }, [bitmap]);

  // Mount external canvas to container
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container || !canvas) return;

    canvas.style.display = "block";

    // Safely append canvas if not already a child
    if (!container.contains(canvas)) {
      // Clear any existing children first
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      container.appendChild(canvas);
    }

    // Only show loading overlay if canvas actually changed
    if (canvasChanged) {
      setIsContentReady(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsContentReady(true);
        });
      });
    } else {
      setIsContentReady(true);
    }

    return () => {
      // Cleanup: remove canvas when unmounting or when canvas changes
      if (container.contains(canvas)) {
        container.removeChild(canvas);
      }
    };
  }, [canvas, canvasChanged]);

  // Determine what to display
  const hasContent = bitmap || canvas;
  const showPlaceholder = !hasContent;

  return (
    <div className="relative bg-white shadow-sm" style={{ width, height }}>
      {/* Canvas container - React manages this div, we manage its children imperatively */}
      <div ref={canvasContainerRef} className="relative" />

      {/* Placeholder */}
      {showPlaceholder && (
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

      {/* Loading overlay - stays visible until content is painted */}
      {!isContentReady && hasContent && (
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
 * TiledPageDisplay: Component for rendering tiled pages
 * Displays multiple tiles stacked vertically
 */
const TiledPageDisplay: React.FC<{
  pageData: PageData;
  store: PdfReaderStore;
  width: number;
}> = observer(({ pageData, store, width }) => {
  if (!pageData.tiles) return null;

  const height = pageData.hCss ?? 792;

  return (
    <div className="relative bg-white shadow-sm" style={{ width, height }}>
      {/* Stack tiles vertically */}
      {pageData.tiles.map((tile) => {
        // Trigger re-render when tiles are loaded (access .size to create MobX dependency)
        void pageData.tilesLoaded?.size;

        const bitmap = store.getTileBitmap(pageData.pageNumber, tile.tileIndex);
        const canvas = store.getTileCanvas(pageData.pageNumber, tile.tileIndex);

        return (
          <div
            key={`tile-${tile.tileIndex}`}
            style={{
              height: tile.displayCss.h,
              position: "relative",
            }}
          >
            <CanvasHost
              bitmap={bitmap ?? null}
              canvas={canvas ?? null}
              width={tile.displayCss.w}
              height={tile.displayCss.h}
            />
          </div>
        );
      })}
    </div>
  );
});

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
    void pageData.hasFull;
    // For tiled pages, also observe tilesLoaded to trigger re-renders when tiles finish
    void pageData.tilesLoaded?.size;

    // Check if page is tiled
    if (pageData.isTiled && pageData.tiles) {
      // Render tiled page
      const width = pageData.wCss ?? 612;
      const height = pageData.hCss ?? 792;

      return (
        <div
          data-index={pageData.pageNumber - 1}
          data-page={pageData.pageNumber}
          id={`page-${pageData.pageNumber}`}
          className="pdf-page-slot mb-4 flex justify-center items-start"
          style={{
            minWidth: width,
            height,
            position: "relative",
            contain: "content",
            contentVisibility: "auto" as any,
          }}
          ref={slotRef}
        >
          {/* Page number label with tile info */}
          <div className="absolute top-2 left-2 z-20 px-2 py-1 rounded text-xs font-mono bg-gray-800 text-white flex gap-2 items-center">
            <span>{pageData.pageNumber}</span>
            <span className="text-gray-400">
              ({pageData.tiles.length} tiles)
            </span>
          </div>

          <TiledPageDisplay pageData={pageData} store={store} width={width} />
        </div>
      );
    }

    // Fetch bitmap and canvas from store (these Maps are non-observable)
    // But since this component re-renders when hasFull changes,
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
          minWidth: width,
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
 * Export PageSlotComponent as PageSlot.
 * Note: We don't wrap in memo() because observer() components are already
 * efficient and memo() would block MobX reactivity when observable properties
 * change (since the pageData object reference stays the same).
 */
export const PageSlot = PageSlotComponent;
