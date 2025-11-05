import { type ReactNode, useEffect, useRef, useState } from "react";

// ============================================================================
// Types
// ============================================================================

export interface PageSliderProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;

  // Content to wrap
  children?: ReactNode;

  // Optional configuration
  height?: number | string;
  className?: string;
  snapEnabled?: boolean;
  showBookmarks?: boolean;
  bookmarks?: Set<number>;
  onBookmarkToggle?: (page: number) => void;
  enableKeyboard?: boolean;
  fineAdjustMode?: boolean;

  // Page elements accessor for scroll detection
  getPageElement?: (pageIndex: number) => HTMLElement | null;
}

interface TickDensity {
  majorInterval: number;
  minorInterval: number;
  numMajors: number;
  majorSpacing: number;
  minorSpacing: number;
  snapThreshold: number;
}

interface TickInfo {
  value: number;
  y: number;
  isMajor: boolean;
  label?: string;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Calculate tick density based on total pages and viewport height
 * Uses optimal spacing algorithm from SliderPrototype
 */
function calculateTickDensity(
  totalPages: number,
  viewportHeight: number,
): TickDensity {
  const targetSpacing = 48; // pixels between major ticks

  // Find optimal major interval from 5/10 family
  const candidates = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

  let bestM = candidates[0] ?? 5;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const M of candidates) {
    if (M > totalPages) continue;
    const numMajors = Math.ceil(totalPages / M);
    const spacing = viewportHeight / numMajors;
    const score = Math.abs(spacing - targetSpacing);

    if (score < bestScore) {
      bestScore = score;
      bestM = M;
    }
  }

  const majorInterval = bestM;
  const minorInterval = majorInterval / 5;
  const numMajors = Math.ceil(totalPages / majorInterval);
  const majorSpacing = viewportHeight / numMajors;
  const minorSpacing = majorSpacing / 5;

  return {
    majorInterval,
    minorInterval,
    numMajors,
    majorSpacing,
    minorSpacing,
    snapThreshold: Math.min(8, majorSpacing / 4),
  };
}

/**
 * Snap value to nearest major tick if within threshold
 */
function snapValue(
  value: number,
  maxValue: number,
  tickDensity: TickDensity,
  snapEnabled: boolean,
  viewportHeight: number,
): number {
  if (!snapEnabled) return value;

  const { majorInterval, snapThreshold } = tickDensity;
  const nearestMajor = Math.round(value / majorInterval) * majorInterval;

  // Calculate pixel distance
  const pixelPerValue = viewportHeight / maxValue;
  const pixelDistance = Math.abs((value - nearestMajor) * pixelPerValue);

  if (pixelDistance <= snapThreshold) {
    return Math.min(nearestMajor, maxValue);
  }

  return value;
}

// ============================================================================
// Subcomponents
// ============================================================================

const ValueTooltip = ({ value, y }: { value: number; y: number }) => {
  return (
    <div
      className="fixed bg-gray-900 text-white px-3 py-1.5 rounded text-sm font-mono pointer-events-none z-30"
      style={{
        right: "280px",
        top: `${y - 16}px`,
      }}
    >
      {value}
    </div>
  );
};

const Hairline = ({ y }: { y: number }) => {
  return (
    <div
      className="fixed right-0 bg-blue-500 pointer-events-none z-20"
      style={{
        top: `${y}px`,
        height: "1px",
        width: "240px",
      }}
    />
  );
};

const TickMark = ({
  value,
  y,
  isMajor,
  label,
  isBookmarked,
  onClick,
  hoverY,
  enableMagnification = false,
  forceHideLabel = false,
}: {
  value: number;
  y: number;
  isMajor: boolean;
  label?: string;
  isBookmarked: boolean;
  onClick?: () => void;
  hoverY: number | null;
  enableMagnification?: boolean;
  forceHideLabel?: boolean;
}) => {
  const [isHovering, setIsHovering] = useState(false);

  // Calculate magnification based on distance from hover position
  let scale = 1;
  let translateY = 0;
  let showLabel = !!label && !forceHideLabel; // Hide labels when cluster overlay is active
  let isInMagnificationZone = false;

  if (enableMagnification && hoverY !== null) {
    const distance = Math.abs(y - hoverY);
    const maxDistance = 80; // broader zone so ticks spread sooner

    if (distance < maxDistance) {
      isInMagnificationZone = true;
      // Smooth easing function for magnification
      const normalizedDistance = distance / maxDistance;
      const easedDistance = 1 - Math.pow(normalizedDistance, 2);

      // Scale from 1.0 to 1.6 based on proximity
      scale = 1 + easedDistance * 0.6;

      // Push items away from center to prevent overlap
      const pushAmount = easedDistance * 34;
      translateY = y < hoverY ? -pushAmount : pushAmount;

      // Only show labels for major ticks or very close minor ticks
      if (!label && scale > 1.3) {
        showLabel = true;
      }
    }
  }

  return (
    <div
      className="absolute right-0 -translate-y-1/2 origin-right transition-transform duration-150 ease-out"
      style={{
        top: `${y}px`,
        transform: `translateY(${translateY}px) scale(${scale})`,
        zIndex: scale > 1 ? 10 : 1,
      }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div
        className={`flex items-center justify-end gap-2 px-2 py-1 -mx-2 -my-1 rounded transition-colors cursor-pointer ${
          isHovering && isInMagnificationZone
            ? "bg-blue-100 ring-2 ring-blue-400"
            : ""
        }`}
        onClick={() => onClick?.()}
      >
        {showLabel && (
          <span
            className={`text-xs font-mono select-none transition-all ${
              isHovering && isInMagnificationZone
                ? "text-blue-900 font-bold"
                : "text-gray-700"
            }`}
          >
            {value}
          </span>
        )}
        <div className="flex items-center pointer-events-none">
          {isBookmarked && (
            <div className="w-2 h-2 bg-amber-500 rounded-full mr-1" />
          )}
          <div
            className={`transition-colors ${
              isHovering && isInMagnificationZone
                ? "bg-blue-600"
                : "bg-gray-400"
            } ${isMajor ? "h-0.5 w-4" : "h-px w-2"}`}
          />
        </div>
      </div>
    </div>
  );
};

const Handle = ({
  y,
  isDragging,
  isBookmarked,
  onMouseDown,
}: {
  y: number;
  isDragging: boolean;
  isBookmarked: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) => {
  return (
    <>
      {/* Red position indicator line */}
      <div
        className="fixed right-0 bg-red-500 pointer-events-none z-20"
        style={{
          top: `${y - 1}px`,
          height: "2px",
          width: "80px",
          right: "0px",
        }}
      />

      {/* Bracket-style handle sitting over the ruler */}
      <div
        className="fixed right-0 cursor-grab active:cursor-grabbing z-30"
        style={{
          top: `${y - 16}px`,
          right: "0px",
        }}
        data-slider-handle="true"
        onMouseDown={onMouseDown}
      >
        <div
          className="relative flex items-center justify-center"
          style={{ width: "80px" }}
        >
          {/* Vertical bracket design - left bracket */}
          <div
            className={`w-1 h-8 rounded-sm transition-colors ${
              isDragging ? "bg-gray-700" : "bg-gray-500"
            }`}
          />

          {/* Top connector */}
          <div
            className={`absolute top-0 left-0 w-full h-1 rounded-sm transition-colors ${
              isDragging ? "bg-gray-700" : "bg-gray-500"
            }`}
          />

          {/* Bottom connector */}
          <div
            className={`absolute bottom-0 left-0 w-full h-1 rounded-sm transition-colors ${
              isDragging ? "bg-gray-700" : "bg-gray-500"
            }`}
          />

          {/* Center gap for content */}
          <div className="flex-1" />

          {/* Right bracket */}
          <div
            className={`w-1 h-8 rounded-sm transition-colors ${
              isDragging ? "bg-gray-700" : "bg-gray-500"
            }`}
          />

          {/* Bookmark indicator */}
          {isBookmarked && (
            <div className="absolute -top-2 -right-2 w-3 h-3 bg-amber-500 rounded-full border-2 border-white" />
          )}
        </div>
      </div>
    </>
  );
};

const HoverCluster = ({
  pages,
  anchorY,
  containerHeight,
  hoveredPage,
  currentPage,
  onSelect,
  bookmarks,
  showBookmarks,
}: {
  pages: number[];
  anchorY: number;
  containerHeight: number;
  hoveredPage: number;
  currentPage: number;
  onSelect: (page: number) => void;
  bookmarks: Set<number>;
  showBookmarks: boolean;
}) => {
  const ITEM_HEIGHT = 32;
  const ITEM_GAP = 8;
  const clusterHeight =
    pages.length * ITEM_HEIGHT + Math.max(0, pages.length - 1) * ITEM_GAP;

  const hoverIndex = Math.max(0, pages.indexOf(hoveredPage));
  const idealTop =
    anchorY - hoverIndex * (ITEM_HEIGHT + ITEM_GAP) - ITEM_HEIGHT / 2;
  const minTop = 8;
  const maxTop = Math.max(minTop, containerHeight - clusterHeight - 8);
  const clampedTop = Math.min(Math.max(idealTop, minTop), maxTop);

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      <div
        className="absolute right-20 flex flex-col gap-2 pointer-events-auto"
        style={{ top: clampedTop }}
      >
        {pages.map((page) => {
          const isHovered = page === hoveredPage;
          const isCurrent = page === currentPage;
          const isBookmarked = showBookmarks && bookmarks.has(page);

          return (
            <button
              key={page}
              type="button"
              className={`relative flex items-center justify-end gap-2 rounded-md border px-3 py-1 text-sm font-mono shadow-sm transition-all ${
                isHovered
                  ? "bg-blue-100 border-blue-400 text-blue-900 font-semibold"
                  : isCurrent
                    ? "bg-gray-900 border-gray-900 text-white"
                    : "bg-white border-gray-200 text-gray-700 hover:bg-gray-100"
              }`}
              style={{ minWidth: "72px" }}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(page);
              }}
            >
              {isBookmarked && (
                <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
              )}
              <span>{page}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const PageSlider = ({
  currentPage,
  totalPages,
  onPageChange,
  children,
  height = 600,
  className = "",
  snapEnabled = true,
  showBookmarks = false,
  bookmarks = new Set(),
  onBookmarkToggle,
  enableKeyboard = true,
  fineAdjustMode = false,
  getPageElement,
}: PageSliderProps) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerTop, setContainerTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof height === "number" ? height : 600,
  );
  const [isDragging, setIsDragging] = useState(false);
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [dragTargetPage, setDragTargetPage] = useState<number | null>(null);
  const dragTargetPageRef = useRef<number | null>(null);
  const isScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<number | null>(null);

  // Update container position and height
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setContainerTop(rect.top);
      setViewportHeight(rect.height);
    }
  }, []);

  // Calculate tick density
  const tickDensity = calculateTickDensity(totalPages, viewportHeight);
  const { majorInterval, minorInterval } = tickDensity;

  // Value <-> Y position conversions
  const valueToY = (value: number): number => {
    // Special case: single page or empty - no range to map
    if (totalPages <= 1) {
      return containerTop;
    }
    return containerTop + (value - 1) * (viewportHeight / (totalPages - 1));
  };

  const yToValue = (y: number): number => {
    // Special case: single page or empty - always return page 1
    if (totalPages <= 1) {
      return 1;
    }
    const relativeY = y - containerTop;
    const ratio = relativeY / viewportHeight;
    return 1 + ratio * (totalPages - 1);
  };

  const hoverValueY = hoverValue !== null ? valueToY(hoverValue) : null;
  const hoverLocalY = hoverValueY !== null ? hoverValueY - containerTop : null;

  // Build a focused window of pages around the hover position so nearby pages stay clickable
  const hoverClusterPages =
    hoverValue !== null && hoverLocalY !== null
      ? (() => {
          const MAX_CLUSTER_SIZE = Math.min(7, totalPages);
          const clusterSize =
            totalPages <= 4 ? totalPages : Math.min(5, MAX_CLUSTER_SIZE);
          const halfWindow = Math.floor(clusterSize / 2);

          let start = hoverValue - halfWindow;
          let end = hoverValue + (clusterSize - halfWindow - 1);

          if (start < 1) {
            end += 1 - start;
            start = 1;
          }
          if (end > totalPages) {
            const shift = end - totalPages;
            start = Math.max(1, start - shift);
            end = totalPages;
          }

          const pages: number[] = [];
          for (let page = start; page <= end; page++) {
            pages.push(page);
          }
          return pages;
        })()
      : [];

  const isClusterActive = hoverClusterPages.length > 0 && hoverValue !== null;

  const setPageFromInteraction = (page: number) => {
    isScrollingRef.current = false;
    if (page !== currentPage) {
      onPageChange(page);
    }
  };

  // Handle drag start
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const clickedHandle =
      target instanceof HTMLElement &&
      target.closest("[data-slider-handle='true']") !== null;

    if (isClusterActive && !clickedHandle && hoverValue !== null) {
      e.preventDefault();
      setIsDragging(false);
      setHoverValue(hoverValue);
      setPageFromInteraction(hoverValue);
      return;
    }

    setIsDragging(true);
    isScrollingRef.current = false; // Clear scroll flag during drag

    const handleValue = (clientY: number) => {
      const rawValue = yToValue(clientY);
      const clampedValue = Math.max(1, Math.min(totalPages, rawValue));
      const snappedValue = snapValue(
        clampedValue,
        totalPages,
        tickDensity,
        snapEnabled,
        viewportHeight,
      );
      const finalValue = Math.round(snappedValue);

      // Update drag target and hover value without triggering page change
      dragTargetPageRef.current = finalValue;
      setDragTargetPage(finalValue);
      setHoverValue(finalValue);
    };

    handleValue(e.clientY);

    const handleMouseMove = (e: MouseEvent) => {
      handleValue(e.clientY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setHoverValue(null);

      // Only trigger page change when user releases the slider
      const targetPage = dragTargetPageRef.current;
      if (targetPage !== null && targetPage !== currentPage) {
        setPageFromInteraction(targetPage);
      }
      dragTargetPageRef.current = null;
      setDragTargetPage(null);

      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // Handle hover
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) return;
    const value = yToValue(e.clientY);
    const clampedValue = Math.max(1, Math.min(totalPages, value));
    setHoverValue(Math.round(clampedValue));
    setHoverY(e.clientY);
  };

  const handleMouseLeave = () => {
    if (!isDragging) {
      setHoverValue(null);
      setHoverY(null);
    }
  };

  // Handle tick click
  const handleTickClick = (value: number) => {
    if (isClusterActive && hoverValue !== null) {
      setPageFromInteraction(hoverValue);
      return;
    }
    setPageFromInteraction(value);
  };

  // Scroll to page when scrollbar is changed (and children are present)
  useEffect(() => {
    if (!children || !scrollContainerRef.current || !getPageElement) return;
    if (isDragging) return; // Handled during drag
    if (isScrollingRef.current) return; // Don't fight user scroll

    const pageElement = getPageElement(currentPage - 1);
    if (pageElement) {
      pageElement.scrollIntoView({ behavior: "auto", block: "start" });
    }
  }, [currentPage, children, getPageElement, isDragging]);

  // Keyboard navigation
  useEffect(() => {
    if (!enableKeyboard) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      const step = fineAdjustMode ? 1 : (minorInterval ?? 1);

      switch (e.key) {
        case "ArrowUp":
        case "ArrowLeft":
          e.preventDefault();
          onPageChange(Math.max(1, currentPage - step));
          break;
        case "ArrowDown":
        case "ArrowRight":
          e.preventDefault();
          onPageChange(Math.min(totalPages, currentPage + step));
          break;
        case "PageUp":
          e.preventDefault();
          onPageChange(Math.max(1, currentPage - step * 5));
          break;
        case "PageDown":
          e.preventDefault();
          onPageChange(Math.min(totalPages, currentPage + step * 5));
          break;
        case "Home":
          e.preventDefault();
          onPageChange(1);
          break;
        case "End":
          e.preventDefault();
          onPageChange(totalPages);
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    currentPage,
    totalPages,
    minorInterval,
    fineAdjustMode,
    enableKeyboard,
    onPageChange,
  ]);

  // Generate ticks
  const ticks: TickInfo[] = [];

  const safeMinorInterval = minorInterval ?? 1;
  const safeMajorInterval = majorInterval ?? 1;

  // Always include page 1 as a major tick
  ticks.push({
    value: 1,
    y: valueToY(1) - containerTop,
    isMajor: true,
    label: "1",
  });

  // Generate remaining ticks
  const firstMinorTick = safeMinorInterval;
  for (
    let value = firstMinorTick;
    value <= totalPages;
    value += safeMinorInterval
  ) {
    const isMajor = value % safeMajorInterval === 0;
    const y = valueToY(value);
    const label = isMajor ? String(value) : undefined;
    ticks.push({ value, y: y - containerTop, isMajor, label });
  }

  // Always include the max value if not already included
  const lastTickValue = ticks[ticks.length - 1]?.value;
  if (lastTickValue !== totalPages) {
    ticks.push({
      value: totalPages,
      y: valueToY(totalPages) - containerTop,
      isMajor: true,
      label: String(totalPages),
    });
  }

  // Use drag target position during drag, otherwise current page
  const displayPage =
    isDragging && dragTargetPage !== null ? dragTargetPage : currentPage;
  const currentY = valueToY(displayPage);

  const heightStyle =
    typeof height === "number" ? `${height}px` : String(height);

  const isBookmarked = bookmarks.has(displayPage);

  // Page slider UI component
  const pageSliderUI = (
    <div className={`w-64 flex-shrink-0 select-none ${className}`}>
      <div
        ref={containerRef}
        className="relative w-full [touch-action:none] [overscroll-behavior:none]"
        style={{
          height: heightStyle,
          cursor: isDragging ? "grabbing" : "crosshair",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Background track */}
        <div className="absolute top-0 bottom-0 right-8 w-px bg-gray-200" />

        {/* Ticks and labels */}
        <div className="absolute inset-0">
          {ticks.map((tick, i) => (
            <TickMark
              key={i}
              value={tick.value}
              y={tick.y}
              isMajor={tick.isMajor}
              label={tick.label}
              isBookmarked={showBookmarks && bookmarks.has(tick.value)}
              onClick={() => handleTickClick(tick.value)}
              hoverY={hoverLocalY}
              enableMagnification={
                !isDragging && totalPages > 20 && hoverClusterPages.length === 0
              }
              forceHideLabel={hoverClusterPages.includes(tick.value)}
            />
          ))}
        </div>

        {/* Hover cluster for precise selection */}
        {hoverClusterPages.length > 0 && hoverLocalY !== null && (
          <HoverCluster
            pages={hoverClusterPages}
            anchorY={hoverLocalY}
            containerHeight={viewportHeight}
            hoveredPage={hoverValue!}
            currentPage={currentPage}
            onSelect={setPageFromInteraction}
            bookmarks={bookmarks}
            showBookmarks={showBookmarks}
          />
        )}

        {/* Hover hairline */}
        {hoverValueY !== null && <Hairline y={hoverValueY} />}

        {/* Hover tooltip */}
        {hoverValueY !== null &&
          hoverValue !== null &&
          hoverClusterPages.length === 0 && (
            <ValueTooltip value={hoverValue} y={hoverValueY} />
          )}

        {/* Handle (includes red position indicator) */}
        <Handle
          y={currentY}
          isDragging={isDragging}
          isBookmarked={showBookmarks && isBookmarked}
          onMouseDown={handleMouseDown}
        />
      </div>
    </div>
  );

  // If children provided, wrap them in a scroll container with fixed scrollbar
  if (children) {
    return (
      <div className="relative w-full h-full">
        {/* Scrollable content */}
        <div
          ref={scrollContainerRef}
          className="h-full overflow-auto"
          style={{ height: heightStyle }}
        >
          {children}
        </div>

        {/* Fixed page slider on the right */}
        <div className="fixed right-0 top-0 bottom-0 z-20 flex items-center pr-4">
          {pageSliderUI}
        </div>
      </div>
    );
  }

  // Otherwise, render just the page slider (backwards compat)
  return pageSliderUI;
};
