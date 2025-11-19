import {
  ContentToMarkdown,
  type DOMFile,
  EPub,
  type FlatNavItem,
  normalizePath,
} from "@epubdown/core";
import {
  action,
  computed,
  makeObservable,
  observable,
  runInAction,
} from "mobx";
import type { CommandPaletteStore } from "../../command/CommandPaletteStore";
import type { Command } from "../../command/types";
import type { AppEventSystem } from "../app/context";
import { ReaderTemplateContext } from "../templates/ReaderTemplateContext";
import type { ReaderTemplates } from "../templates/Template";
import { copyToClipboard } from "../utils/selectionUtils";
import type { BookLibraryStore } from "./BookLibraryStore";

export type NavigateFunction = (path: string) => void;

export class ReaderStore {
  // EPub state
  epub: EPub | null = null;
  chapters: DOMFile[] = [];
  metadata: Record<string, any> = {};
  currentChapterIndex = 0;
  currentBookId: number | null = null;

  // UI state
  isSidebarOpen = false;
  showCopyMultipleModal = false;
  useHtmlMode =
    new URLSearchParams(window.location.search).get("mode") === "html";
  private popoverRef: HTMLElement | null = null;

  // Dependencies
  private navigate: NavigateFunction | null = null;

  // Cached state
  tocInfo: { navItems: FlatNavItem[] } | null = null;
  private labelByIndex: Map<number, string> = new Map();

  private templateContext: ReaderTemplateContext;

  constructor(
    private bookLibraryStore: BookLibraryStore,
    private events: AppEventSystem,
    private palette: CommandPaletteStore,
    private templates: ReaderTemplates,
  ) {
    this.templateContext = new ReaderTemplateContext(this, palette);

    makeObservable(this, {
      epub: observable,
      chapters: observable,
      metadata: observable,
      currentChapterIndex: observable,
      currentBookId: observable,
      isSidebarOpen: observable,
      showCopyMultipleModal: observable,
      useHtmlMode: observable,
      tocInfo: observable.ref,
      handleLoadBook: action,
      setChapter: action,
      nextChapter: action,
      previousChapter: action,
      reset: action,
      loadBookAndChapter: action,
      setSidebarOpen: action,
      toggleSidebar: action,
      openCopyMultipleModal: action,
      closeCopyMultipleModal: action,
      setHtmlMode: action,
      handleUrlChange: action,
      handleChapterChange: action,
      handleTocChapterSelect: action,
      updatePageTitle: action,
      currentChapter: computed,
      hasNextChapter: computed,
      hasPreviousChapter: computed,
      currentChapterTitle: computed,
      navItems: computed,
    });
  }

  setNavigate(navigate: NavigateFunction): void {
    this.navigate = navigate;
  }

  setupBindings(
    scope: "view" | "overlay:selectionPopover" | "overlay:sidebar",
    readerContainer?: HTMLElement,
    sidebarElement?: () => HTMLElement | null,
  ) {
    if (scope === "view") {
      return this.events.register([
        "view:reader", // Push the layer
        {
          id: "reader.selectAll",
          event: { kind: "key", combo: "meta+a" },
          layer: "view:reader",
          when: () => !!this.currentChapter && !!readerContainer,
          run: () => this.selectChapterContent(readerContainer),
        },
        {
          id: "reader.openCommandPalette",
          event: { kind: "key", combo: "meta+k" },
          layer: "view:reader",
          when: () => !!this.currentChapter,
          run: () => {
            const commands = this.buildGlobalCommands();
            this.palette.openPalette(commands);
          },
        },
        {
          id: "reader.copyWithContext",
          event: { kind: "key", combo: "meta+shift+c" },
          layer: "view:reader",
          when: () => !!this.currentChapter,
          run: () => this.copySelectionWithContext(),
        },
        {
          id: "reader.toggleSidebar",
          event: { kind: "key", combo: "meta+shift+s" },
          layer: "view:reader",
          when: () => !!this.epub,
          run: () => this.toggleSidebar(),
        },
        {
          id: "reader.selection.openPalette",
          event: { kind: "textSelect", container: readerContainer },
          layer: "view:reader",
          when: () => !!this.currentChapter && !!readerContainer,
          run: (payload) => {
            if (payload.kind !== "textSelect") return;
            const selected = payload.text.trim();
            if (!selected) return;
            const cmds = this.buildSelectionCommands(selected);
            this.palette.openSelection(cmds, { range: payload.range });
          },
        },
      ]);
    }

    if (scope === "overlay:sidebar" && sidebarElement) {
      return this.events.register([
        "overlay:sidebar",
        {
          id: "sidebar.close.bgClick",
          event: { kind: "bgClick", shield: sidebarElement },
          layer: "overlay:sidebar",
          when: () => this.isSidebarOpen,
          run: () => this.setSidebarOpen(false),
        },
        {
          id: "sidebar.close.escape",
          event: { kind: "key", combo: "Escape" },
          layer: "overlay:sidebar",
          when: () => this.isSidebarOpen,
          run: () => this.setSidebarOpen(false),
        },
      ]);
    }

    if (scope === "overlay:selectionPopover") {
      return this.events.register([
        "overlay:selectionPopover",
        {
          id: "selPopover.close.bgClick",
          event: { kind: "bgClick", shield: () => this.popoverRef },
          layer: "overlay:selectionPopover",
          run: () => {
            this.closePopover();
          },
        },
      ]);
    }

    return () => {};
  }

  private closePopover() {
    // Called from bg click event - currently handled by SelectionPopover component
    // This could be expanded to manage popover state if needed
  }

  setPopoverRef(ref: HTMLElement | null) {
    this.popoverRef = ref;
  }

  private async loadTocOnce() {
    if (!this.epub || this.tocInfo) return;
    this.tocInfo = await this.getTocInfo();

    // Build the spine-index → label cache
    if (this.tocInfo) {
      const { navItems } = this.tocInfo;
      this.labelByIndex.clear();

      for (const navItem of navItems) {
        const chapterIndex = this.findChapterIndexByPath(navItem.path);
        if (chapterIndex !== -1) {
          this.labelByIndex.set(chapterIndex, navItem.label);
        }
      }
    }
  }

  async handleLoadBook(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    const epub = await EPub.fromZip(arrayBuffer);

    // Load chapters
    const chapterArray: DOMFile[] = [];
    for await (const chapter of epub.chapters()) {
      chapterArray.push(chapter);
    }

    runInAction(() => {
      this.epub = epub;
      this.chapters = chapterArray;
      this.metadata = epub.metadata.toJSON();
    });

    // Load TOC once per book
    await this.loadTocOnce();

    // Set initial chapter to first TOC chapter
    const firstTocIndex = await this.firstTocChapterIndex();
    runInAction(() => {
      this.currentChapterIndex = firstTocIndex;
    });
  }

  async setChapter(index: number) {
    if (index >= 0 && index < this.chapters.length) {
      this.currentChapterIndex = index;
      // Update page title when chapter changes
      this.updatePageTitle();
    }
  }

  nextChapter() {
    if (this.currentChapterIndex < this.chapters.length - 1) {
      this.currentChapterIndex++;
    }
  }

  previousChapter() {
    if (this.currentChapterIndex > 0) {
      this.currentChapterIndex--;
    }
  }

  async getFootnote(chapter: DOMFile, href: string): Promise<string> {
    // Decode and split href
    const decoded = decodeURIComponent(href || "");
    const [maybePath, fragment] = decoded.split("#");

    // Determine the absolute file path
    const filePath =
      !maybePath || maybePath === chapter.name
        ? chapter.path
        : maybePath.startsWith("/")
          ? maybePath
          : normalizePath(chapter.base, maybePath);

    // Load the target file content via epub.readDOMFile
    const target =
      filePath === chapter.path
        ? chapter.content
        : (await this.epub?.readDOMFile(filePath))?.content;

    if (!target) {
      throw new Error("Footnote file not found");
    }

    // Extract footnote content from HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(target, "text/html");

    let footnoteContent = "";
    if (fragment) {
      const element = doc.getElementById(fragment);
      if (element) {
        footnoteContent = element.textContent || "";
      }
    } else {
      // Get all text content if no fragment
      footnoteContent = doc.body.textContent || "";
    }

    return footnoteContent.trim();
  }

  reset() {
    this.epub = null;
    this.currentChapterIndex = 0;
    this.chapters = [];
    this.metadata = {};
    this.currentBookId = null;
    this.isSidebarOpen = false;
    this.tocInfo = null;
    this.labelByIndex.clear();
  }

  // UI state management
  setSidebarOpen(isOpen: boolean) {
    this.isSidebarOpen = isOpen;
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  openCopyMultipleModal() {
    this.showCopyMultipleModal = true;
  }

  closeCopyMultipleModal() {
    this.showCopyMultipleModal = false;
  }

  async copyMultipleChapters(selectedNavIndices: number[]): Promise<void> {
    if (!this.navItems || selectedNavIndices.length === 0) return;

    try {
      // Map TOC nav items to chapters, keeping track of which nav items correspond to which chapters
      const chapterMap = new Map<
        number,
        { chapter: DOMFile; navItems: FlatNavItem[] }
      >();

      for (const navIdx of selectedNavIndices) {
        const navItem = this.navItems[navIdx];
        if (navItem) {
          const chapterIdx = this.findChapterIndexByPath(navItem.path);

          if (chapterIdx !== -1) {
            const chapter = this.chapters[chapterIdx];
            if (chapter) {
              if (!chapterMap.has(chapterIdx)) {
                chapterMap.set(chapterIdx, { chapter, navItems: [] });
              }
              chapterMap.get(chapterIdx)!.navItems.push(navItem);
            }
          }
        }
      }

      // Sort by chapter index to maintain order
      const sortedEntries = Array.from(chapterMap.entries()).sort(
        ([a], [b]) => a - b,
      );

      if (sortedEntries.length === 0) return;

      // Convert each chapter to markdown
      const chapterContents: Array<{ title: string; content: string }> = [];
      for (const [chapterIdx, { chapter, navItems }] of sortedEntries) {
        const converter = ContentToMarkdown.create({ basePath: chapter.base });
        const markdown = await converter.convertXMLFile(chapter);

        // Use the first nav item's label as the chapter title
        // If multiple nav items point to the same chapter, we could list them all,
        // but for now we'll just use the first one
        const label = navItems[0]?.label || `Chapter ${chapterIdx + 1}`;
        chapterContents.push({ title: label, content: markdown });
      }

      // Build the combined content string
      const multipleChaptersContent = chapterContents
        .map((ch) => `## ${ch.title}\n\n${ch.content}`)
        .join("\n\n---\n\n");

      // Find the template for multiple chapters
      const template = this.templates.multipleChapters?.[0];
      if (!template) {
        // Fallback: just copy the combined content
        copyToClipboard(multipleChaptersContent);
        return;
      }

      // Create a context with the multiple chapters content
      const context = {
        bookTitle: this.metadata?.title || "Unknown Book",
        bookAuthor:
          this.metadata?.creator || this.metadata?.author || "Unknown Author",
        multipleChaptersContent,
      };

      // Render template with context
      const output = await template.render(context);
      copyToClipboard(output);
    } catch (error) {
      console.error("Failed to copy multiple chapters:", error);
      throw error;
    }
  }

  setHtmlMode(on: boolean) {
    this.useHtmlMode = on;
    // Update URL query param (preserve fragment)
    const u = new URL(window.location.href);
    if (on) u.searchParams.set("mode", "html");
    else u.searchParams.delete("mode");
    this.navigate?.(u.pathname + u.search + u.hash);
  }

  selectChapterContent(readerContainer?: HTMLElement) {
    if (!readerContainer) return;

    // Find the chapter content element within the reader container
    const chapterContent = readerContainer.querySelector(".chapter-content");
    if (!chapterContent) return;

    // Create a range that selects all content in the chapter
    const range = document.createRange();
    range.selectNodeContents(chapterContent);

    // Clear existing selection and add the new range
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  async copySelectionWithContext() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    // Find the "copy-with-context" template in selection templates
    const copyTemplate = this.templates.selection.find(
      (t) => t.id === "copy-with-context",
    );
    if (!copyTemplate) {
      // Fallback to just copying the text
      copyToClipboard(selection.toString());
      return;
    }

    // Create context and render template
    const output = await copyTemplate.render(this.templateContext);
    copyToClipboard(output);
  }

  private buildSelectionCommands(selected: string): Command[] {
    const commands: Command[] = [];

    // Generate commands from selection templates
    for (const def of this.templates.selection) {
      commands.push({
        id: def.id,
        label: def.title,
        scope: "context",
        action: async () => {
          const output = await def.render(this.templateContext);
          copyToClipboard(output);
        },
      });
    }

    return commands;
  }

  private buildGlobalCommands(): Command[] {
    const commands: Command[] = [];

    // Add "Copy multiple chapters" command
    commands.push({
      id: "copy-multiple-chapters",
      label: "Copy multiple chapters",
      scope: "global",
      action: () => {
        this.openCopyMultipleModal();
      },
    });

    // Generate commands from global templates
    for (const def of this.templates.global) {
      commands.push({
        id: def.id,
        label: def.title,
        scope: "global",
        action: async () => {
          const output = await def.render(this.templateContext);
          copyToClipboard(output);
        },
      });
    }

    return commands;
  }

  // Navigation methods
  async handleUrlChange(location: string): Promise<void> {
    // Parse the location to extract bookId, chapterIndex, fragment, and mode
    const [pathWithQuery, fragment] = location.split("#");
    const url = new URL(pathWithQuery || location, window.location.origin);
    this.useHtmlMode = url.searchParams.get("mode") === "html";

    const match = url.pathname?.match(/\/book\/([^\/]+)(?:\/(\d+))?/);
    if (!match || !match[1]) return;

    const bookId = Number(match[1]);
    const chapterIndex = match[2] ? Number(match[2]) : undefined;

    // Load book and chapter
    await this.loadBookAndChapter(bookId, chapterIndex);

    // Close sidebar on mobile after navigation
    this.setSidebarOpen(false);

    // Handle fragment scrolling after chapter loads
    if (fragment) {
      setTimeout(() => {
        const element = document.getElementById(fragment);
        if (element) {
          element.scrollIntoView({ behavior: "smooth" });
        }
      }, 100);
    }
  }

  handleChapterChange(index: number) {
    if (this.currentBookId && this.navigate) {
      const modeParam = this.useHtmlMode ? "?mode=html" : "";
      this.navigate(`/book/${this.currentBookId}/${index}${modeParam}`);
    }
  }

  handleTocChapterSelect(path: string) {
    if (!this.navigate) return;

    // Use the existing method that handles path-to-URL conversion with fragments
    const url = this.rootedHrefToBookHref(path);
    if (url) {
      this.navigate(url);
    }
  }

  async loadBookAndChapter(
    bookId: number,
    chapterIndex?: number,
  ): Promise<void> {
    // Check if we're loading a different book
    const isNewBook = this.currentBookId !== bookId;

    // Only load book if it's different from current
    if (isNewBook) {
      this.reset();

      const bookData = await this.bookLibraryStore.loadBookForReading(bookId);
      if (!bookData) {
        throw new Error("Book not found");
      }

      // Convert Blob to File for ReaderStore
      const file = new File(
        [bookData.blob],
        `${bookData.metadata.title}.epub`,
        {
          type: "application/epub+zip",
        },
      );

      await this.handleLoadBook(file);
      runInAction(() => {
        this.currentBookId = bookId;
      });
    }

    // Determine target chapter index
    const targetChapterIndex =
      chapterIndex !== undefined
        ? chapterIndex
        : await this.firstTocChapterIndex();

    // Check if we're already at the requested book and chapter
    if (!isNewBook && this.currentChapterIndex === targetChapterIndex) {
      return; // No need to update
    }

    // Set chapter only if different
    if (this.currentChapterIndex !== targetChapterIndex) {
      await this.setChapter(targetChapterIndex);
    }

    // Update page title after loading book/chapter
    await this.updatePageTitle();
  }

  // Computed getters
  get currentChapter() {
    return this.chapters[this.currentChapterIndex] || null;
  }

  get hasNextChapter() {
    return this.currentChapterIndex < this.chapters.length - 1;
  }

  get hasPreviousChapter() {
    return this.currentChapterIndex > 0;
  }

  get currentChapterTitle() {
    return this.chapterLabel(this.currentChapterIndex);
  }

  get navItems() {
    return this.tocInfo?.navItems ?? [];
  }

  // TOC-related utilities
  async getTocInfo() {
    if (!this.epub) return null;

    const navItems = await this.epub.toc.flatNavItems();

    return { navItems };
  }

  async getChapterTitleFromToc(chapterPath: string): Promise<string | null> {
    if (!this.epub || !chapterPath) return null;

    const tocInfo = await this.getTocInfo();
    if (!tocInfo) return null;

    const { navItems } = tocInfo;

    // Find matching nav item for the chapter
    const matchingItem = navItems.find((item) => {
      return chapterPath === item.path;
    });

    return matchingItem?.label || null;
  }

  private chapterLabel(idx: number): string | null {
    if (!this.labelByIndex.size) return null;

    // Check for exact match first
    const exactMatch = this.labelByIndex.get(idx);
    if (exactMatch !== undefined) {
      return exactMatch;
    }

    // Walk backwards to find the nearest earlier chapter with a label
    for (let i = idx - 1; i >= 0; i--) {
      const label = this.labelByIndex.get(i);
      if (label !== undefined) {
        // Memoize this result for future lookups
        this.labelByIndex.set(idx, label);
        return label;
      }
    }

    return null;
  }

  findChapterIndexByPath(path: string): number {
    // Strip anchor fragment before comparing
    const pathWithoutAnchor = path.split("#")[0] || path;
    return this.chapters.findIndex(
      (chapter) => chapter.path === pathWithoutAnchor,
    );
  }

  /**
   * Converts an EPUB-rooted absolute path to a reader application URL.
   *
   * EPUB files use absolute paths from the root (e.g., "/OEBPS/chapter1.xhtml#section2")
   * to reference other chapters. This method converts those paths to the reader's
   * URL format which uses book ID and chapter index (e.g., "/book/123/4#section2").
   *
   * @param href - The EPUB-rooted absolute path, possibly URL-encoded and with fragment
   * @returns The reader URL if the chapter is found, null otherwise
   *
   * @example
   * // Input: "/OEBPS/chapter1.xhtml#section2"
   * // Output: "/book/123/4#section2" (where 123 is book ID, 4 is chapter index)
   *
   * @example
   * // Input: "/OEBPS/ch%201.xhtml" (URL-encoded space)
   * // Output: "/book/123/2" (decodes to "/OEBPS/ch 1.xhtml" before lookup)
   */
  rootedHrefToBookHref(href: string): string | null {
    if (!this.currentBookId) return null;

    // Decode the URL first
    const decodedHref = decodeURIComponent(href);

    // Split into path and fragment
    const [pathPart, fragment] = decodedHref.split("#");

    // Find chapter index for the path (findChapterIndexByPath handles anchor stripping internally)
    const chapterIndex = this.findChapterIndexByPath(pathPart || "");

    if (chapterIndex === -1) return null;

    // Build the reader URL with mode parameter if in HTML mode
    const modeParam = this.useHtmlMode ? "?mode=html" : "";
    const fragmentPart = fragment ? `#${fragment}` : "";
    return `/book/${this.currentBookId}/${chapterIndex}${modeParam}${fragmentPart}`;
  }

  private async firstTocChapterIndex(): Promise<number> {
    await this.loadTocOnce();

    if (!this.tocInfo?.navItems?.length) {
      return 0;
    }

    for (const navItem of this.tocInfo.navItems) {
      if (!navItem.path) continue;

      const chapterIndex = this.findChapterIndexByPath(navItem.path);
      if (chapterIndex !== -1) {
        return chapterIndex;
      }
    }

    return 0;
  }

  async updatePageTitle(): Promise<void> {
    if (!this.epub || !this.currentChapter) return;

    // Get chapter title using the new chapterLabel method
    const chapterTitle = this.chapterLabel(this.currentChapterIndex);
    const bookTitle = this.metadata.title || "Unknown Book";

    // Update document title
    if (chapterTitle) {
      document.title = `${chapterTitle} | ${bookTitle}`;
    } else {
      // If no chapter label found, only show book title
      document.title = bookTitle;
    }
  }

  /**
   * Open a book in a new tab/window
   * Centralizes the logic for opening books from various sources (drop, etc.)
   */
  async openBookInNewTab(file: File): Promise<void> {
    const id = await this.bookLibraryStore.ensureBook(file);
    const url = new URL(`/book/${id}`, window.location.href).toString();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /**
   * Convert current chapter to markdown on demand
   * Used by template context for copy operations
   */
  async getCurrentChapterMarkdown(): Promise<string> {
    const chapter = this.currentChapter;
    if (!chapter) return "";

    const converter = ContentToMarkdown.create({ basePath: chapter.base });
    return await converter.convertXMLFile(chapter);
  }
}
