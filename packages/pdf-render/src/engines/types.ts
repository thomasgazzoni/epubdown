export type RendererKind = "PDFium" | "PDFJS";

export interface EngineInitOptions {
  wasmUrl?: string;
  disableWorker?: boolean;
}

export interface PageSizePt {
  wPt: number;
  hPt: number;
}

export interface OutlineItem {
  title: string;
  pageNumber: number; // 1-based page number
  level: number; // 0-based nesting level
}

export interface TileRect {
  srcX: number; // Source X in PDF points
  srcY: number; // Source Y in PDF points
  srcWidth: number; // Source width in PDF points
  srcHeight: number; // Source height in PDF points
}

export interface PageHandle {
  renderToCanvas(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    ppi: number,
  ): Promise<void>;
  renderTileToCanvas(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    ppi: number,
    tile: TileRect,
  ): Promise<void>;
  destroy(): void;
}

export interface DocumentHandle {
  pageCount(): number;
  getPageSize(pageIndex0: number): Promise<PageSizePt>;
  loadPage(pageIndex0: number): Promise<PageHandle>;
  getOutline(): Promise<OutlineItem[]>;
  destroy(): void;
}

export interface PDFEngine {
  readonly name: RendererKind;
  init(opts?: EngineInitOptions): Promise<void>;
  loadDocument(data: Uint8Array): Promise<DocumentHandle>;
}
