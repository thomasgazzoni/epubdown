import { useState } from "react";
import { PageSlider } from "../../src/slider/PageSlider";

export const PageSliderDemo = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(500);
  const [inputValue, setInputValue] = useState("500");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [fineAdjustMode, setFineAdjustMode] = useState(false);
  const [enableKeyboard, setEnableKeyboard] = useState(true);
  const [bookmarks, setBookmarks] = useState(
    new Set<number>([1, 50, 125, 250, 375, 500]),
  );

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handleTotalPagesChange = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number.parseInt(inputValue, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 10000) {
      setTotalPages(n);
      if (currentPage > n) {
        setCurrentPage(n);
      }
    }
  };

  const toggleBookmark = (page: number) => {
    const newBookmarks = new Set(bookmarks);
    if (newBookmarks.has(page)) {
      newBookmarks.delete(page);
    } else {
      newBookmarks.add(page);
    }
    setBookmarks(newBookmarks);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Main content area */}
      <div className="p-8 pr-80">
        <div className="max-w-3xl">
          <h1 className="text-3xl font-bold mb-4">
            Page Slider Demo (Enhanced)
          </h1>

          <div className="bg-white p-6 rounded-lg shadow mb-4">
            <h2 className="text-xl font-semibold mb-2">Current Position</h2>
            <p className="text-5xl font-bold text-blue-600">{currentPage}</p>
            <p className="text-gray-600 mt-2">of {totalPages} pages</p>
            <button
              type="button"
              onClick={() => toggleBookmark(currentPage)}
              className={`mt-3 px-4 py-2 rounded text-sm ${
                bookmarks.has(currentPage)
                  ? "bg-amber-500 text-white hover:bg-amber-600"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              {bookmarks.has(currentPage) ? "Remove Bookmark" : "Add Bookmark"}
            </button>
          </div>

          <div className="bg-white p-6 rounded-lg shadow mb-4">
            <h2 className="text-xl font-semibold mb-4">Demo Controls</h2>
            <form
              onSubmit={handleTotalPagesChange}
              className="flex items-center gap-3 mb-4"
            >
              <label className="text-sm text-gray-700">Total pages:</label>
              <input
                type="number"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className="w-24 px-3 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                min="1"
                max="10000"
              />
              <button
                type="submit"
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition"
              >
                Set
              </button>
            </form>

            <div className="space-y-2 mb-4">
              <p className="text-sm text-gray-600 mb-2">Quick presets:</p>
              <button
                type="button"
                onClick={() => {
                  setTotalPages(20);
                  setInputValue("20");
                  if (currentPage > 20) setCurrentPage(20);
                }}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 mr-2"
              >
                20 pages
              </button>
              <button
                type="button"
                onClick={() => {
                  setTotalPages(100);
                  setInputValue("100");
                  if (currentPage > 100) setCurrentPage(100);
                }}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 mr-2"
              >
                100 pages
              </button>
              <button
                type="button"
                onClick={() => {
                  setTotalPages(250);
                  setInputValue("250");
                  if (currentPage > 250) setCurrentPage(250);
                }}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 mr-2"
              >
                250 pages
              </button>
              <button
                type="button"
                onClick={() => {
                  setTotalPages(500);
                  setInputValue("500");
                  if (currentPage > 500) setCurrentPage(500);
                }}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 mr-2"
              >
                500 pages
              </button>
              <button
                type="button"
                onClick={() => {
                  setTotalPages(1000);
                  setInputValue("1000");
                  if (currentPage > 1000) setCurrentPage(1000);
                }}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                1000 pages
              </button>
            </div>

            <div className="flex flex-col gap-2 pt-4 border-t border-gray-200">
              <p className="text-sm font-semibold text-gray-700 mb-1">
                Options:
              </p>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={snapEnabled}
                  onChange={() => setSnapEnabled(!snapEnabled)}
                  className="rounded"
                />
                <span>Snap to major ticks</span>
              </label>

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={fineAdjustMode}
                  onChange={() => setFineAdjustMode(!fineAdjustMode)}
                  className="rounded"
                />
                <span>Fine adjust (1-step)</span>
              </label>

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBookmarks}
                  onChange={() => setShowBookmarks(!showBookmarks)}
                  className="rounded"
                />
                <span>Show bookmarks</span>
              </label>

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableKeyboard}
                  onChange={() => setEnableKeyboard(!enableKeyboard)}
                  className="rounded"
                />
                <span>Enable keyboard navigation</span>
              </label>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-2">Features</h2>
            <ul className="list-disc pl-5 space-y-2 text-gray-700">
              <li>
                <strong>Adaptive tick density</strong> - Automatically
                calculates optimal spacing based on viewport height
              </li>
              <li>
                <strong>Hover preview</strong> - See tooltip and hairline before
                clicking
              </li>
              <li>
                <strong>Drag navigation</strong> - Smooth dragging with optional
                snap
              </li>
              <li>
                <strong>Click tick labels</strong> - Jump to page by clicking
                numbers
              </li>
              <li>
                <strong>Wheel/scroll support</strong> - Scroll over the track to
                navigate
              </li>
              <li>
                <strong>Keyboard navigation</strong> - Arrow keys, Page Up/Down,
                Home/End
              </li>
              <li>
                <strong>Smart snapping</strong> - Only snaps within pixel
                threshold
              </li>
              <li>
                <strong>Bookmark support</strong> - Visual markers for important
                pages
              </li>
              <li>
                <strong>Bracket-style handle</strong> - Professional design with
                red position indicator
              </li>
            </ul>
          </div>

          <div className="bg-white p-6 rounded-lg shadow mt-4">
            <h2 className="text-xl font-semibold mb-2">Usage Example</h2>
            <pre className="bg-gray-100 p-4 rounded text-sm overflow-x-auto">
              <code>{`import { PageSlider } from "./PageSlider";

const [currentPage, setCurrentPage] = useState(1);
const [bookmarks, setBookmarks] = useState(new Set([1, 50, 100]));

<PageSlider
  currentPage={currentPage}
  totalPages={500}
  onPageChange={(page) => setCurrentPage(page)}
  height="calc(100vh - 4rem)"
  snapEnabled={true}
  showBookmarks={true}
  bookmarks={bookmarks}
  enableKeyboard={true}
  fineAdjustMode={false}
/>`}</code>
            </pre>
          </div>

          {showBookmarks && bookmarks.size > 0 && (
            <div className="bg-white p-6 rounded-lg shadow mt-4">
              <h2 className="text-xl font-semibold mb-2">Bookmarks</h2>
              <div className="flex flex-wrap gap-2">
                {Array.from(bookmarks)
                  .sort((a, b) => a - b)
                  .map((bookmark) => (
                    <button
                      key={bookmark}
                      type="button"
                      onClick={() => setCurrentPage(bookmark)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-100 text-amber-900 text-sm rounded cursor-pointer hover:bg-amber-200"
                    >
                      <span className="w-2 h-2 bg-amber-500 rounded-full" />
                      Page {bookmark}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="bg-blue-50 p-6 rounded-lg border border-blue-200 mt-4">
            <h3 className="font-semibold text-blue-900 mb-2">
              Keyboard Shortcuts
            </h3>
            <div className="grid grid-cols-2 gap-3 text-sm text-blue-900">
              <div>
                <kbd className="px-2 py-1 bg-white rounded border border-blue-300">
                  ↑/↓
                </kbd>{" "}
                Navigate by step
              </div>
              <div>
                <kbd className="px-2 py-1 bg-white rounded border border-blue-300">
                  PgUp/PgDn
                </kbd>{" "}
                Jump 5 steps
              </div>
              <div>
                <kbd className="px-2 py-1 bg-white rounded border border-blue-300">
                  Home
                </kbd>{" "}
                Go to first page
              </div>
              <div>
                <kbd className="px-2 py-1 bg-white rounded border border-blue-300">
                  End
                </kbd>{" "}
                Go to last page
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Page slider on the right - Fixed position */}
      <div className="fixed top-0 right-0 h-screen pr-8 pt-8 flex items-center">
        <PageSlider
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          height="calc(100vh - 4rem)"
          snapEnabled={snapEnabled}
          showBookmarks={showBookmarks}
          bookmarks={bookmarks}
          enableKeyboard={enableKeyboard}
          fineAdjustMode={fineAdjustMode}
        />
      </div>
    </div>
  );
};

export default PageSliderDemo;
