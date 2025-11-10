/**
 * Detect OffscreenCanvas and ImageBitmapRenderingContext support
 *
 * These capabilities are required for optimal off-main-thread rendering:
 * - OffscreenCanvas: Allows rendering in a Worker
 * - transferFromImageBitmap: Zero-copy bitmap swap for display
 * - createImageBitmap: Convert canvas to transferable bitmap
 */

let cachedResult: {
  hasOffscreenCanvas: boolean;
  hasBitmapRenderer: boolean;
  hasCreateImageBitmap: boolean;
} | null = null;

export function detectOffscreenCapabilities() {
  if (cachedResult) return cachedResult;

  // Check if we're in a browser environment
  if (typeof window === "undefined") {
    cachedResult = {
      hasOffscreenCanvas: false,
      hasBitmapRenderer: false,
      hasCreateImageBitmap: false,
    };
    return cachedResult;
  }

  // Check OffscreenCanvas support
  const hasOffscreenCanvas =
    typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvas.prototype.getContext === "function";

  // Check ImageBitmapRenderingContext (bitmaprenderer) support
  let hasBitmapRenderer = false;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("bitmaprenderer");
    hasBitmapRenderer =
      ctx !== null && "transferFromImageBitmap" in (ctx as any);
  } catch {
    hasBitmapRenderer = false;
  }

  // Check createImageBitmap support
  const hasCreateImageBitmap =
    typeof createImageBitmap === "function" ||
    (typeof window !== "undefined" &&
      typeof (window as any).createImageBitmap === "function");

  cachedResult = {
    hasOffscreenCanvas,
    hasBitmapRenderer,
    hasCreateImageBitmap,
  };

  return cachedResult;
}

/**
 * Check if we can render in a Worker
 * Requires OffscreenCanvas and createImageBitmap
 */
export function canRenderInWorker(): boolean {
  if (typeof OffscreenCanvas === "undefined") return false;
  // createImageBitmap is used to convert offscreen canvas to ImageBitmap
  const hasCreate =
    typeof createImageBitmap === "function" ||
    (typeof window !== "undefined" &&
      typeof (window as any).createImageBitmap === "function");
  return hasCreate;
}

/**
 * Check if we can use zero-copy bitmap display
 * Requires bitmaprenderer context on main thread
 */
export function canZeroCopyDisplay(): boolean {
  // main-thread bitmaprenderer context
  try {
    const c = document.createElement("canvas").getContext("bitmaprenderer");
    return !!(c && "transferFromImageBitmap" in (c as any));
  } catch {
    return false;
  }
}

/**
 * Check if we can use the full OffscreenCanvas pipeline:
 * Worker rendering + zero-copy bitmap transfer
 */
export function canUseOffscreenPipeline(): boolean {
  const caps = detectOffscreenCapabilities();
  return (
    caps.hasOffscreenCanvas &&
    caps.hasBitmapRenderer &&
    caps.hasCreateImageBitmap
  );
}

/**
 * Log capability detection results for debugging
 */
export function logOffscreenCapabilities(): void {
  const caps = detectOffscreenCapabilities();
  console.log("[OffscreenCanvas] Capabilities:", {
    offscreenCanvas: caps.hasOffscreenCanvas,
    bitmapRenderer: caps.hasBitmapRenderer,
    createImageBitmap: caps.hasCreateImageBitmap,
    fullPipeline: canUseOffscreenPipeline(),
  });
}
