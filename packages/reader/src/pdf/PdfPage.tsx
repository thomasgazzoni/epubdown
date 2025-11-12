import { Menu } from "lucide-react";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { OpenOnDrop } from "../components/OpenOnDrop";
import { useBookLibraryStore, useEventSystem } from "../stores/RootStore";
import { PdfReaderStore } from "../stores/PdfReaderStore";
import { PdfViewer } from "./PdfViewer";
import { PdfSidebar } from "./PdfSidebar";
import { PdfTableOfContents } from "./PdfTableOfContents";

export const PdfPage = observer(() => {
  const [match, params] = useRoute("/pdf/:bookId");
  const lib = useBookLibraryStore();
  const events = useEventSystem();
  const store = useMemo(
    () => new PdfReaderStore(lib, events, lib.pageSizeCache),
    [lib, events],
  );
  const [isMobile, setIsMobile] = useState(false);

  // Check if mobile on mount and window resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024); // lg breakpoint
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    if (match && params?.bookId) {
      // parseUrlParams is now called inside load() after dispose()
      void store.load(Number(params.bookId));
    }
  }, [match, params?.bookId, store]);

  useEffect(() => {
    return () => {
      store.dispose();
    };
  }, [store]);

  const handleDrop = async (files: File[]) => {
    const pdfFiles = files.filter((file) =>
      file.name.toLowerCase().endsWith(".pdf"),
    );

    if (pdfFiles.length > 0 && pdfFiles[0]) {
      try {
        const id = await lib.ensurePdf(pdfFiles[0]);
        window.open(`/pdf/${id}`, "_blank");
      } catch (error) {
        console.error("Failed to open PDF:", error);
      }
    }
  };

  if (!match) return null;

  return (
    <OpenOnDrop onDrop={handleDrop} overlayText="Drop PDF to open in new tab">
      <div className="min-h-screen bg-gray-50 relative">
        {/* Sticky anchor for sidebar positioning */}
        <div className="sticky top-0 h-0 relative z-50">
          <PdfSidebar store={store}>
            <PdfTableOfContents
              tocStore={store.tocStore}
              onPageSelect={(pageNum) => store.handleTocPageSelect(pageNum)}
              onClose={() => store.setSidebarOpen(false)}
            />
          </PdfSidebar>
        </div>

        {/* Mobile menu button */}
        {isMobile && (
          <div className="fixed top-4 left-4 z-50">
            <button
              type="button"
              onClick={() => store.setSidebarOpen(true)}
              className="p-2 bg-white shadow-md rounded-lg hover:shadow-lg transition-shadow"
              aria-label="Open menu"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
        )}

        <PdfViewer store={store} />
      </div>
    </OpenOnDrop>
  );
});

export default PdfPage;
