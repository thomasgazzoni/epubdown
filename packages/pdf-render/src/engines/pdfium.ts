import { init as initPdfium, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import type {
  DocumentHandle,
  OutlineItem,
  PageHandle,
  PageSizePt,
  PDFEngine,
} from "./types";

async function fetchWasmChecked(wasmUrl: string): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to load PDFium WASM from ${wasmUrl} (${response.status} ${response.statusText})`,
    );
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new Error(
      `Invalid PDFium WASM binary at ${wasmUrl}; expected magic word 00 61 73 6d.`,
    );
  }
  return buffer;
}

class PdfiumEngine implements PDFEngine {
  readonly name = "PDFium" as const;
  private instance: WrappedPdfiumModule | null = null;
  private core: any = null;

  async init({ wasmUrl = "/pdfium.wasm" } = {}) {
    if (this.instance) return;
    const buffer = await fetchWasmChecked(wasmUrl);
    const wrapper = await initPdfium({ wasmBinary: buffer });
    this.instance = wrapper;
    this.core = wrapper.pdfium || wrapper;
    if (typeof this.instance.PDFiumExt_Init === "function") {
      this.instance.PDFiumExt_Init();
    }
  }

  async loadDocument(data: Uint8Array): Promise<DocumentHandle> {
    this.ensureInit();
    const { core, instance } = this;
    if (!instance) {
      throw new Error("PDFium instance not initialized");
    }

    const ptr = core.ccall?.("malloc", "number", ["number"], [data.length]);
    if (!ptr) throw new Error("malloc failed");
    (core.HEAPU8 as Uint8Array).set(data, ptr);
    const doc = core.ccall(
      "FPDF_LoadMemDocument",
      "number",
      ["number", "number", "number"],
      [ptr, data.length, 0],
    );
    if (!doc) {
      core.ccall?.("free", null, ["number"], [ptr]);
      throw new Error("FPDF_LoadMemDocument failed");
    }

    const pageCount = () => instance.FPDF_GetPageCount(doc);

    const getPageSize = async (index0: number): Promise<PageSizePt> => {
      const page = instance.FPDF_LoadPage(doc, index0);
      const wPt = instance.FPDF_GetPageWidthF(page);
      const hPt = instance.FPDF_GetPageHeightF(page);
      instance.FPDF_ClosePage(page);
      return { wPt, hPt };
    };

    const getOutline = async (): Promise<OutlineItem[]> => {
      const result: OutlineItem[] = [];

      const getBookmarkTitle = (bookmark: number): string => {
        // Get title length (in bytes for UTF-16LE)
        const titleLen = instance.FPDFBookmark_GetTitle(bookmark, 0, 0);
        if (!titleLen || titleLen <= 2) return "";

        // Allocate buffer for title
        const titleBuf = core.ccall?.(
          "malloc",
          "number",
          ["number"],
          [titleLen],
        );
        if (!titleBuf) return "";

        try {
          instance.FPDFBookmark_GetTitle(bookmark, titleBuf, titleLen);
          // Read UTF-16LE string
          const heap = core.HEAPU8 as Uint8Array;
          const titleBytes = new Uint8Array(
            heap.buffer,
            heap.byteOffset + titleBuf,
            titleLen - 2,
          ); // Exclude null terminator
          const decoder = new TextDecoder("utf-16le");
          return decoder.decode(titleBytes);
        } finally {
          core.ccall?.("free", null, ["number"], [titleBuf]);
        }
      };

      const getBookmarkPageNumber = (bookmark: number): number | null => {
        const dest = instance.FPDFBookmark_GetDest(doc, bookmark);
        if (!dest) return null;

        const pageIndex = instance.FPDFDest_GetDestPageIndex(doc, dest);
        if (pageIndex < 0) return null;

        return pageIndex + 1; // Convert to 1-based
      };

      const traverseBookmarks = (bookmark: number, level: number) => {
        if (!bookmark) return;

        const title = getBookmarkTitle(bookmark);
        const pageNumber = getBookmarkPageNumber(bookmark);

        if (title && pageNumber !== null) {
          result.push({ title, pageNumber, level });
        }

        // Process children
        const child = instance.FPDFBookmark_GetFirstChild(doc, bookmark);
        if (child) {
          traverseBookmarks(child, level + 1);
        }

        // Process siblings
        const sibling = instance.FPDFBookmark_GetNextSibling(doc, bookmark);
        if (sibling) {
          traverseBookmarks(sibling, level);
        }
      };

      // Start with root bookmarks (pass null/0 as first bookmark)
      const firstBookmark = instance.FPDFBookmark_GetFirstChild(doc, 0);
      if (firstBookmark) {
        traverseBookmarks(firstBookmark, 0);
      }

      return result;
    };

    return {
      pageCount,
      getPageSize,
      getOutline,
      async loadPage(index0): Promise<PageHandle> {
        const page = instance.FPDF_LoadPage(doc, index0);
        const wPt = instance.FPDF_GetPageWidthF(page);
        const hPt = instance.FPDF_GetPageHeightF(page);
        return {
          async renderToCanvas(canvas, ppi) {
            const scale = (ppi ?? 96) / 72;
            const wPx = Math.max(1, Math.floor(wPt * scale));
            const hPx = Math.max(1, Math.floor(hPt * scale));
            const bmp = instance.FPDFBitmap_Create(wPx, hPx, 0);
            instance.FPDFBitmap_FillRect(bmp, 0, 0, wPx, hPx, 0xffffffff);
            instance.FPDF_RenderPageBitmap(bmp, page, 0, 0, wPx, hPx, 0, 16);
            const len = wPx * hPx * 4;
            const bufPtr = instance.FPDFBitmap_GetBuffer(bmp);
            const heap = core.HEAPU8 as Uint8Array;
            canvas.width = wPx;
            canvas.height = hPx;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              instance.FPDFBitmap_Destroy(bmp);
              throw new Error("Canvas 2D context unavailable");
            }
            const img = ctx.createImageData(wPx, hPx);
            img.data.set(
              new Uint8ClampedArray(heap.buffer, heap.byteOffset + bufPtr, len),
            );
            ctx.putImageData(img, 0, 0);
            instance.FPDFBitmap_Destroy(bmp);
          },
          async renderTileToCanvas(canvas, ppi, tile) {
            const scale = (ppi ?? 96) / 72;
            // Calculate tile dimensions in pixels
            const tileWPx = Math.max(1, Math.floor(tile.srcWidth * scale));
            const tileHPx = Math.max(1, Math.floor(tile.srcHeight * scale));

            // Create bitmap for just the tile region
            const bmp = instance.FPDFBitmap_Create(tileWPx, tileHPx, 0);
            instance.FPDFBitmap_FillRect(
              bmp,
              0,
              0,
              tileWPx,
              tileHPx,
              0xffffffff,
            );

            // Render with offset - translate the page to bring tile region to origin
            // offsetY is negative to move the page content up
            const offsetX = 0;
            const offsetY = -Math.floor(tile.srcY * scale);

            // Full page dimensions in pixels for rendering context
            const fullWPx = Math.floor(wPt * scale);
            const fullHPx = Math.floor(hPt * scale);

            // Render the page with offset so the tile region appears at (0,0)
            instance.FPDF_RenderPageBitmap(
              bmp,
              page,
              offsetX,
              offsetY,
              fullWPx,
              fullHPx,
              0,
              16,
            );

            // Copy bitmap to canvas
            const len = tileWPx * tileHPx * 4;
            const bufPtr = instance.FPDFBitmap_GetBuffer(bmp);
            const heap = core.HEAPU8 as Uint8Array;
            canvas.width = tileWPx;
            canvas.height = tileHPx;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              instance.FPDFBitmap_Destroy(bmp);
              throw new Error("Canvas 2D context unavailable");
            }
            const img = ctx.createImageData(tileWPx, tileHPx);
            img.data.set(
              new Uint8ClampedArray(heap.buffer, heap.byteOffset + bufPtr, len),
            );
            ctx.putImageData(img, 0, 0);
            instance.FPDFBitmap_Destroy(bmp);
          },
          destroy() {
            instance.FPDF_ClosePage(page);
          },
        };
      },
      destroy() {
        instance.FPDF_CloseDocument(doc);
        core.ccall?.("free", null, ["number"], [ptr]);
      },
    };
  }

  private ensureInit() {
    if (!this.instance || !this.core) {
      throw new Error("PDFium not initialized");
    }
  }
}

export function createPdfiumEngine(): PDFEngine {
  return new PdfiumEngine();
}
