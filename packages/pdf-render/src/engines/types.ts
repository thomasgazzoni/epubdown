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

export interface PageHandle {
  renderToCanvas(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    ppi: number,
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
