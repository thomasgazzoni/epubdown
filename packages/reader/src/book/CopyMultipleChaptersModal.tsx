import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FlatNavItem } from "@epubdown/core";

interface CopyMultipleChaptersModalProps {
  isOpen: boolean;
  navItems: FlatNavItem[];
  onClose: () => void;
  onCopy: (selectedIndices: number[]) => Promise<void>;
}

export const CopyMultipleChaptersModal = observer(
  ({ isOpen, navItems, onClose, onCopy }: CopyMultipleChaptersModalProps) => {
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
    const [focusedIndex, setFocusedIndex] = useState<number>(0);
    const [isCopying, setIsCopying] = useState(false);
    const listContainerRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<number, HTMLLabelElement>>(new Map());

    // Reset selection and focus when modal opens
    useEffect(() => {
      if (isOpen) {
        setSelected(new Set());
        setAnchorIndex(null);
        setFocusedIndex(0);
        // Focus on the list container after a brief delay
        setTimeout(() => {
          listContainerRef.current?.focus();
        }, 100);
      }
    }, [isOpen]);

    // Prevent background scrolling when modal is open
    useEffect(() => {
      if (!isOpen) return;

      // Save original overflow style
      const originalOverflow = document.body.style.overflow;

      // Prevent body scroll
      document.body.style.overflow = "hidden";

      return () => {
        // Restore original overflow
        document.body.style.overflow = originalOverflow;
      };
    }, [isOpen]);

    // Scroll focused item into view
    useEffect(() => {
      if (!isOpen) return;
      const itemElement = itemRefs.current.get(focusedIndex);
      if (itemElement) {
        itemElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, [focusedIndex, isOpen]);

    // Handle keyboard shortcuts and prevent propagation to background
    useEffect(() => {
      if (!isOpen) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        // Stop propagation to prevent background from handling any keys
        e.stopPropagation();

        // Escape to close
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return;
        }

        // Cmd+Enter to copy
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          if (selected.size > 0 && !isCopying) {
            handleCopy();
          }
          return;
        }

        // Arrow key navigation
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, navItems.length - 1));
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }

        // Space to toggle selection
        if (e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          handleCheckboxClick(focusedIndex, e.shiftKey);
          return;
        }

        // Enter to toggle selection
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          handleCheckboxClick(focusedIndex, e.shiftKey);
          return;
        }
      };

      // Use capture phase to intercept all keyboard events before they reach other handlers
      document.addEventListener("keydown", handleKeyDown, true);
      return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, [isOpen, selected, isCopying, focusedIndex, navItems.length]);

    const handleCheckboxClick = (idx: number, isShift: boolean) => {
      const newSelected = new Set(selected);

      if (!isShift || anchorIndex === null) {
        // Normal click: toggle single item
        if (newSelected.has(idx)) {
          newSelected.delete(idx);
        } else {
          newSelected.add(idx);
        }
        setAnchorIndex(idx);
      } else {
        // Shift-click: range selection
        const start = Math.min(anchorIndex, idx);
        const end = Math.max(anchorIndex, idx);

        // Determine the new state based on clicked item's current state
        const clickedNewValue = !newSelected.has(idx);

        // Apply to entire range
        for (let i = start; i <= end; i++) {
          if (clickedNewValue) {
            newSelected.add(i);
          } else {
            newSelected.delete(i);
          }
        }

        setAnchorIndex(idx);
      }

      setFocusedIndex(idx);
      setSelected(newSelected);
    };

    const handleCopy = async () => {
      if (selected.size === 0 || isCopying) return;

      setIsCopying(true);
      try {
        const selectedIndices = Array.from(selected).sort((a, b) => a - b);
        console.log("Modal: Selected indices from Set:", selectedIndices);
        console.log("Modal: Selected Set contents:", Array.from(selected));
        await onCopy(selectedIndices);
        onClose();
      } catch (error) {
        console.error("Failed to copy chapters:", error);
      } finally {
        setIsCopying(false);
      }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && !isCopying) {
        onClose();
      }
    };

    const handleBackdropWheel = (e: React.WheelEvent) => {
      // Prevent scroll events from propagating to background
      e.stopPropagation();
    };

    if (!isOpen) return null;

    return createPortal(
      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center"
        style={{ zIndex: 9998 }}
        onClick={handleBackdropClick}
        onWheel={handleBackdropWheel}
      >
        <div
          className="bg-white rounded-lg shadow-xl w-full mx-4"
          style={{ maxWidth: "700px", maxHeight: "80vh", zIndex: 9999 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              Copy Multiple Chapters
            </h2>
          </div>

          {/* Tips */}
          <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 text-sm text-gray-600">
            <div className="flex flex-col gap-1">
              <div>
                <strong>Navigation:</strong> ↑↓ arrows to move, Space/Enter to
                toggle
              </div>
              <div>
                <strong>Shift+Space:</strong> Select or deselect a range
              </div>
              <div>
                <strong>⌘+Enter:</strong> Copy selected chapters
              </div>
            </div>
          </div>

          {/* Chapter List */}
          <div
            ref={listContainerRef}
            tabIndex={0}
            className="overflow-y-auto px-6 py-4 outline-none"
            style={{
              maxHeight: "calc(80vh - 220px)",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          >
            {navItems.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                No chapters available
              </div>
            ) : (
              <div className="space-y-0.5">
                {navItems.map((item, idx) => {
                  const isSelected = selected.has(idx);
                  const isFocused = focusedIndex === idx;
                  const indentPx = Math.max(0, item.level - 1) * 16;

                  return (
                    <label
                      key={idx}
                      ref={(el) => {
                        if (el) {
                          itemRefs.current.set(idx, el);
                        } else {
                          itemRefs.current.delete(idx);
                        }
                      }}
                      className={`flex items-center gap-3 px-3 py-1.5 rounded cursor-pointer hover:bg-gray-100 transition-colors ${
                        isSelected ? "bg-blue-50" : ""
                      } ${isFocused ? "ring-2 ring-blue-400 ring-inset" : ""}`}
                      onClick={(e) => {
                        e.preventDefault();
                        handleCheckboxClick(idx, e.shiftKey);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer"
                        tabIndex={-1}
                      />
                      <span
                        className="text-sm text-gray-900 flex-1 truncate"
                        style={{ marginLeft: `${indentPx}px` }}
                        title={item.label}
                      >
                        {item.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-600">
              {selected.size === 0 ? (
                "No chapters selected"
              ) : (
                <span className="font-medium text-gray-900">
                  {selected.size} {selected.size === 1 ? "chapter" : "chapters"}{" "}
                  selected
                </span>
              )}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isCopying}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCopy}
                disabled={selected.size === 0 || isCopying}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isCopying ? (
                  <>
                    <svg
                      className="animate-spin h-4 w-4 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Copying...
                  </>
                ) : (
                  "Copy selection"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  },
);
