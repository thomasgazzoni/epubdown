import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import type { PdfReaderStore } from "../stores/PdfReaderStore";

interface PerformanceMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory;
}

interface PdfDebugOverlayProps {
  store: PdfReaderStore;
  isOpen: boolean;
  onToggle: () => void;
}

/**
 * Debug overlay showing real-time performance metrics
 *
 * Displays:
 * - FPS (frames per second)
 * - Canvas memory usage
 * - JS heap memory (Chrome only)
 * - Rendered page count
 * - Render window bounds
 * - Running render tasks
 */
export const PdfDebugOverlay = observer(
  ({ store, isOpen, onToggle }: PdfDebugOverlayProps) => {
    const [fps, setFps] = useState(0);
    const [jsHeapMB, setJsHeapMB] = useState(0);
    const [jsHeapLimitMB, setJsHeapLimitMB] = useState(0);
    // Memory stats (polled because they're non-observable)
    const [bitmapMB, setBitmapMB] = useState(0);
    const [canvasMB, setCanvasMB] = useState(0);
    const [fullBitmapCount, setFullBitmapCount] = useState(0);

    // FPS counter
    useEffect(() => {
      let frameCount = 0;
      let lastTime = performance.now();
      let animationFrameId: number;

      const measureFps = (currentTime: number) => {
        frameCount++;

        if (currentTime >= lastTime + 1000) {
          setFps(Math.round((frameCount * 1000) / (currentTime - lastTime)));
          frameCount = 0;
          lastTime = currentTime;
        }

        animationFrameId = requestAnimationFrame(measureFps);
      };

      animationFrameId = requestAnimationFrame(measureFps);

      return () => {
        cancelAnimationFrame(animationFrameId);
      };
    }, []);

    // Memory usage polling (for non-observable memory stats)
    useEffect(() => {
      const updateMemoryStats = () => {
        setBitmapMB(store.bitmapMemoryBytes / 1024 / 1024);
        // Guard against negative values due to accounting races
        setCanvasMB(
          Math.max(
            0,
            (store.canvasBytes - store.bitmapMemoryBytes) / 1024 / 1024,
          ),
        );
        setFullBitmapCount(store.fullBitmapCount);
      };

      // Initial update
      updateMemoryStats();

      // Poll every 500ms
      const interval = setInterval(updateMemoryStats, 500);

      return () => clearInterval(interval);
    }, [store]);

    // JS Heap Memory (Chrome only)
    useEffect(() => {
      const perf = performance as PerformanceWithMemory;
      if (!perf.memory) return;

      const interval = setInterval(() => {
        if (perf.memory) {
          setJsHeapMB(Math.round(perf.memory.usedJSHeapSize / 1024 / 1024));
          setJsHeapLimitMB(
            Math.round(perf.memory.jsHeapSizeLimit / 1024 / 1024),
          );
        }
      }, 1000);

      return () => clearInterval(interval);
    }, []);

    const totalMemoryMB = bitmapMB + canvasMB;
    const canvasBudgetMB = store.memoryBudgetBytes / 1024 / 1024;
    const renderedPages = store.renderedPageCount;
    const runningTasks = store.getRunningCount();
    const windowStart = store.renderWindow.start;
    const windowEnd = store.renderWindow.end;

    // Toggle button (always visible)
    const toggleButton = (
      <button
        onClick={onToggle}
        className="fixed top-4 right-20 z-50 bg-gray-800 text-white px-3 py-2 rounded-lg shadow-lg text-xs font-mono hover:bg-gray-700 transition-colors"
        title={isOpen ? "Hide debug overlay" : "Show debug overlay"}
      >
        {isOpen ? "Debug ✕" : "Debug"}
      </button>
    );

    if (!isOpen) {
      return toggleButton;
    }

    return (
      <>
        {toggleButton}
        <div className="fixed top-16 right-4 z-40 bg-gray-900 bg-opacity-95 text-white p-4 rounded-lg shadow-xl text-xs font-mono min-w-[280px]">
          <div className="space-y-3">
            {/* FPS */}
            <div>
              <div className="text-gray-400 mb-1">Frame Rate</div>
              <div className="flex justify-between items-center">
                <span className="text-lg font-bold">
                  {fps}{" "}
                  <span className="text-sm text-gray-400 font-normal">FPS</span>
                </span>
                <div
                  className={`h-2 w-2 rounded-full ${fps >= 55 ? "bg-green-500" : fps >= 30 ? "bg-yellow-500" : "bg-red-500"}`}
                />
              </div>
            </div>

            <div className="border-t border-gray-700" />

            {/* PDF Memory Usage */}
            <div>
              <div className="text-gray-400 mb-1">PDF Memory (Total)</div>
              <div className="text-lg font-bold">
                {totalMemoryMB.toFixed(1)}{" "}
                <span className="text-sm text-gray-400 font-normal">
                  / {canvasBudgetMB} MB
                </span>
              </div>
              <div className="mt-2 bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    totalMemoryMB / canvasBudgetMB > 0.9
                      ? "bg-red-500"
                      : totalMemoryMB / canvasBudgetMB > 0.7
                        ? "bg-yellow-500"
                        : "bg-green-500"
                  }`}
                  style={{
                    width: `${Math.min(100, (totalMemoryMB / canvasBudgetMB) * 100)}%`,
                  }}
                />
              </div>
              <div className="mt-2 text-xs space-y-1">
                <div className="flex justify-between text-gray-400">
                  <span>Bitmaps:</span>
                  <span className="text-white">
                    {bitmapMB.toFixed(1)} MB ({fullBitmapCount} full)
                  </span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Canvases:</span>
                  <span className="text-white">{canvasMB.toFixed(1)} MB</span>
                </div>
              </div>
            </div>

            {/* JS Heap Memory (Chrome only) */}
            {jsHeapLimitMB > 0 && (
              <>
                <div className="border-t border-gray-700" />
                <div>
                  <div className="text-gray-400 mb-1">JS Heap Memory</div>
                  <div className="text-lg font-bold">
                    {jsHeapMB}{" "}
                    <span className="text-sm text-gray-400 font-normal">
                      / {jsHeapLimitMB} MB
                    </span>
                  </div>
                  <div className="mt-2 bg-gray-700 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        jsHeapMB / jsHeapLimitMB > 0.9
                          ? "bg-red-500"
                          : jsHeapMB / jsHeapLimitMB > 0.7
                            ? "bg-yellow-500"
                            : "bg-blue-500"
                      }`}
                      style={{
                        width: `${Math.min(100, (jsHeapMB / jsHeapLimitMB) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </>
            )}

            <div className="border-t border-gray-700" />

            {/* Render Stats */}
            <div>
              <div className="text-gray-400 mb-2">Render Stats</div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">Pages cached:</span>
                  <span className="font-bold">{renderedPages}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Active renders:</span>
                  <span
                    className={`font-bold ${runningTasks > 0 ? "text-yellow-400" : ""}`}
                  >
                    {runningTasks}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Current page:</span>
                  <span className="font-bold">{store.currentPage}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Render window:</span>
                  <span className="font-bold">
                    [{windowStart}-{windowEnd}]
                  </span>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-700" />

            {/* Worker Status */}
            <div>
              <div className="text-gray-400 mb-2">Worker Rendering</div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">Status:</span>
                  <span
                    className={`font-bold ${store.isWorkerActive ? "text-green-400" : "text-gray-500"}`}
                  >
                    {store.isWorkerActive ? "Active" : "Inactive"}
                  </span>
                </div>
                {store.isWorkerActive && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Pending tasks:</span>
                      <span className="font-bold">
                        {store.workerPendingCount}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Responsive:</span>
                      <span
                        className={`font-bold ${store.isWorkerResponsive ? "text-green-400" : "text-red-400"}`}
                      >
                        {store.isWorkerResponsive ? "Yes" : "No"}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="border-t border-gray-700" />

            {/* PPI / Zoom */}
            <div>
              <div className="text-gray-400 mb-2">Display</div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">Zoom:</span>
                  <span className="font-bold">
                    {Math.round(store.zoomPercent * 100)}%{(() => {
                      // Calculate effective PPI for current page
                      const current = store.getPageData(store.currentPage);
                      if (current?.wPt && current?.wCss) {
                        const effPpi = (current.wCss * 72) / current.wPt;
                        return (
                          <span className="text-gray-400 ml-2 font-normal">
                            (~{Math.round(effPpi)} ppi)
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Device pixel ratio:</span>
                  <span className="font-bold">
                    {store.devicePixelRatio.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  },
);
