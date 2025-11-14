import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  DocumentHandle,
  OutlineItem,
  PageHandle,
  PageSizePt,
  PDFEngine,
} from "./types";

export function createPdfjsEngine(): PDFEngine {
  return {
    name: "PDFJS",
    async init({ disableWorker = false } = {}) {
      if (
        !disableWorker &&
        typeof window !== "undefined" &&
        pdfjsLib.GlobalWorkerOptions
      ) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.mjs",
          import.meta.url,
        ).href;
      }
      if (disableWorker) {
        const g: any = pdfjsLib.GlobalWorkerOptions;
        g.workerSrc = undefined;
        g.workerPort = null;
      }
    },
    async loadDocument(data: Uint8Array): Promise<DocumentHandle> {
      const task = pdfjsLib.getDocument({
        data,
        disableStream: true,
        disableAutoFetch: true,
        disableRange: true,
      });
      const pdf = await task.promise;

      const getPageSize = async (index0: number): Promise<PageSizePt> => {
        const page = await pdf.getPage(index0 + 1);
        const viewport = page.getViewport({ scale: 1 });
        page.cleanup();
        return { wPt: viewport.width, hPt: viewport.height };
      };

      const getOutline = async (): Promise<OutlineItem[]> => {
        const outline = await pdf.getOutline();
        if (!outline || outline.length === 0) return [];

        const result: OutlineItem[] = [];

        const flattenOutline = async (
          items: any[],
          level: number,
        ): Promise<void> => {
          for (const item of items) {
            if (item.title && item.dest) {
              try {
                // Get the destination details
                const dest =
                  typeof item.dest === "string"
                    ? await pdf.getDestination(item.dest)
                    : item.dest;

                if (dest && Array.isArray(dest) && dest.length > 0) {
                  // Get page reference from destination
                  const pageRef = dest[0];
                  const pageIndex = await pdf.getPageIndex(pageRef);
                  const pageNumber = pageIndex + 1; // Convert to 1-based

                  result.push({
                    title: item.title,
                    pageNumber,
                    level,
                  });
                }
              } catch (err) {
                // Skip items with invalid destinations
                console.warn(
                  `Failed to resolve outline item "${item.title}":`,
                  err,
                );
              }
            }

            // Recursively process sub-items
            if (item.items && item.items.length > 0) {
              await flattenOutline(item.items, level + 1);
            }
          }
        };

        await flattenOutline(outline, 0);
        return result;
      };

      return {
        pageCount: () => pdf.numPages,
        getPageSize,
        getOutline,
        async loadPage(index0): Promise<PageHandle> {
          const page = await pdf.getPage(index0 + 1);
          return {
            async renderToCanvas(canvas, ppi) {
              const viewport = page.getViewport({ scale: (ppi ?? 96) / 72 });
              canvas.width = Math.max(1, Math.floor(viewport.width));
              canvas.height = Math.max(1, Math.floor(viewport.height));
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("Canvas 2D context unavailable");
              // Cast to CanvasRenderingContext2D - both HTMLCanvas and OffscreenCanvas contexts are compatible
              await page.render({
                canvasContext: ctx as CanvasRenderingContext2D,
                viewport,
              }).promise;
            },
            async renderTileToCanvas(canvas, ppi, tile) {
              const scale = (ppi ?? 96) / 72;

              // Create viewport for the full page
              const fullViewport = page.getViewport({ scale });

              // Calculate tile dimensions in pixels
              const tileWPx = Math.max(1, Math.floor(tile.srcWidth * scale));
              const tileHPx = Math.max(1, Math.floor(tile.srcHeight * scale));

              // Set canvas size to tile dimensions
              canvas.width = tileWPx;
              canvas.height = tileHPx;

              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("Canvas 2D context unavailable");

              // Save context state
              ctx.save();

              // Translate to render only the tile region
              // Move the canvas origin up by tile.srcY to show the correct portion
              ctx.translate(0, -tile.srcY * scale);

              // Render the full page (PDF.js will clip to canvas bounds)
              await page.render({
                canvasContext: ctx as CanvasRenderingContext2D,
                viewport: fullViewport,
              }).promise;

              // Restore context state
              ctx.restore();
            },
            destroy() {
              page.cleanup();
            },
          };
        },
        destroy() {
          pdf.destroy();
        },
      };
    },
  };
}
