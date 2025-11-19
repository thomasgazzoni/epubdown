import { Menu } from "lucide-react";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { CommandPalette } from "../command/CommandPalette";
import { ChapterContent } from "./book/ChapterContent";
import { ChapterNavigation } from "./book/ChapterNavigation";
import { CopyMultipleChaptersModal } from "./book/CopyMultipleChaptersModal";
import { Sidebar } from "./book/Sidebar";
import { TableOfContents } from "./book/TableOfContents";
import { OpenOnDrop } from "./components/OpenOnDrop";
import { useReadingProgress } from "./stores/ReadingProgressStore";
import { useReaderStore } from "./stores/RootStore";

export const ReaderPage = observer(() => {
  const readerStore = useReaderStore();
  const readingProgress = useReadingProgress();
  const [location, navigate] = useLocation();
  const [match, params] = useRoute("/book/:bookId/:chapterIndex?");
  const [isMobile, setIsMobile] = useState(false);
  const lastProcessedUrl = useRef<string>("");
  const readerContainerRef = useRef<HTMLDivElement>(null);

  // Check if mobile on mount and window resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024); // lg breakpoint
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);
  const { epub, currentChapterIndex, chapters, metadata } = readerStore;

  const bookId = match ? params?.bookId : null;
  const initialChapter = match ? Number(params?.chapterIndex ?? 0) : 0;

  // Set navigate function on ReaderStore
  useEffect(() => {
    readerStore.setNavigate(navigate);
  }, [readerStore, navigate]);

  // Setup event bindings for reader view
  useEffect(() => {
    // Only set up bindings if we have both the container ref and epub loaded
    if (!readerContainerRef.current || !epub) return;

    const dispose = readerStore.setupBindings(
      "view",
      readerContainerRef.current,
    );
    return dispose;
  }, [readerStore, epub]); // Re-setup bindings when epub loads

  // Handle URL changes
  useEffect(() => {
    // Use full URL including query params and hash
    const fullUrl =
      window.location.pathname + window.location.search + window.location.hash;
    if (match && params?.bookId && fullUrl !== lastProcessedUrl.current) {
      lastProcessedUrl.current = fullUrl;
      readerStore.handleUrlChange(fullUrl);
    }
  }, [match, params?.bookId, location, readerStore]);

  // Not a reader route
  if (!match) {
    return null;
  }

  if (epub && bookId) {
    const currentChapter = chapters[currentChapterIndex];

    const handleDrop = async (files: File[]) => {
      if (!files || files.length === 0) return;

      // Requirement: if multiple files, just use the first one
      const file = files[0];
      if (!file) return;

      try {
        await readerStore.openBookInNewTab(file);
      } catch (err) {
        console.error("Failed to open book from drop:", err);
      }
    };

    return (
      <OpenOnDrop onDrop={handleDrop} overlayText="Drop to open in a new tab">
        <div className="min-h-screen bg-gray-50">
          {/* Main content - scrollable full screen */}
          <div className="min-h-screen">
            {/* Fixed container for centering content */}
            <div className="min-h-full flex justify-center relative">
              <div className="max-w-4xl w-full relative">
                {/* Sticky anchor for sidebar positioning */}
                <div className="sticky top-0 h-0 relative z-50">
                  <Sidebar>
                    <TableOfContents />
                  </Sidebar>
                </div>

                <div className="p-4 sm:p-6 lg:p-8">
                  {/* Mobile menu button */}
                  {isMobile && (
                    <div className="fixed top-4 left-4 z-50">
                      <button
                        type="button"
                        onClick={() => readerStore.setSidebarOpen(true)}
                        className="p-2 bg-white shadow-md rounded-lg hover:shadow-lg transition-shadow"
                        aria-label="Open menu"
                      >
                        <Menu className="w-6 h-6" />
                      </button>
                    </div>
                  )}

                  <div className="book-reader" ref={readerContainerRef}>
                    {/* Chapter Navigation Widget */}
                    <ChapterNavigation />

                    {/* Current chapter */}
                    {currentChapter && (
                      <ChapterContent className="current-chapter" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Command Palette */}
          <CommandPalette />

          {/* Copy Multiple Chapters Modal */}
          <CopyMultipleChaptersModal
            isOpen={readerStore.showCopyMultipleModal}
            navItems={readerStore.navItems || []}
            onClose={() => readerStore.closeCopyMultipleModal()}
            onCopy={(selectedIndices) =>
              readerStore.copyMultipleChapters(selectedIndices)
            }
          />
        </div>
      </OpenOnDrop>
    );
  }

  // Still loading or no book selected
  return null;
});
