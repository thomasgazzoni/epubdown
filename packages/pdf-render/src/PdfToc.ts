import { makeAutoObservable, runInAction, computed } from "mobx";
import type { DocumentHandle, OutlineItem } from "./engines";

/**
 * Tree node representation of a ToC item with nested children
 */
export interface TocNode {
  id: string;
  title: string;
  pageNumber: number;
  level: number;
  children: TocNode[];
  parentId: string | null;
}

/**
 * PdfTocStore manages table of contents functionality for PDF documents as a MobX store.
 *
 * Responsibilities:
 * - Loading and parsing PDF outline/bookmarks
 * - Building hierarchical tree structure from flat outline
 * - Managing expansion state
 * - Filtering ToC based on search query
 * - Tracking active item based on current page
 *
 * REACTIVITY PATTERN:
 * - MobX observable state for automatic UI updates
 * - All ToC state changes trigger observable reactions
 * - Integrates seamlessly with MobX components
 */
export class PdfTocStore {
  private outline: OutlineItem[] = [];
  expanded = new Set<string>();
  activeItemId: string | null = null;
  filterQuery = "";
  loaded = false;

  constructor() {
    makeAutoObservable(
      this,
      {
        tree: computed,
        activeNode: computed,
      },
      { autoBind: true },
    );
  }

  /**
   * Load outline from PDF document
   */
  async load(doc: DocumentHandle): Promise<void> {
    try {
      const outline = await doc.getOutline();
      runInAction(() => {
        this.outline = outline;
        this.loaded = true;
      });
    } catch (err) {
      console.warn("Failed to load PDF outline:", err);
      runInAction(() => {
        this.outline = [];
        this.loaded = true;
      });
    }
  }

  /**
   * Check if ToC has been loaded
   */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get flat outline items
   */
  get items(): OutlineItem[] {
    return this.outline;
  }

  /**
   * Generate a stable ID for a ToC node based on its content
   * Uses level, pageNumber, and title hash for stability across reloads
   * Avoids using index to prevent ID churn when outline is regenerated
   */
  private generateNodeId(item: OutlineItem): string {
    // Simple hash: sanitized portion of title for uniqueness
    const titleHash = item.title.slice(0, 64).replace(/[^a-zA-Z0-9]/g, "_");
    return `${item.level}/${item.pageNumber}/${titleHash}`;
  }

  /**
   * Build a tree structure from the flat outline list
   *
   * ALGORITHM: Stack-based tree construction
   * - PDF outline is flat with level indicators (0=top, 1=child, etc.)
   * - Use stack to track potential parent nodes
   * - For each item, pop stack until we find a parent at lower level
   * - This handles arbitrary nesting and sibling relationships
   *
   * TIME COMPLEXITY: O(n) where n = number of outline items
   * SPACE COMPLEXITY: O(d) for stack where d = max depth
   *
   * EDGE CASES:
   * - Empty outline → empty tree
   * - Non-sequential levels (e.g., 0→2) → treated as direct child
   * - Multiple root nodes (level 0) → all added to root array
   */
  private buildTree(items: OutlineItem[]): TocNode[] {
    if (items.length === 0) return [];

    const nodes: TocNode[] = [];
    const stack: { node: TocNode; level: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      const node: TocNode = {
        id: this.generateNodeId(item),
        title: item.title,
        pageNumber: item.pageNumber,
        level: item.level,
        children: [],
        parentId: null,
      };

      // Pop stack until we find a parent at lower level
      while (stack.length > 0) {
        const stackTop = stack[stack.length - 1];
        if (!stackTop || stackTop.level >= item.level) {
          stack.pop();
        } else {
          break;
        }
      }

      // If there's a parent on the stack, add this node as a child
      if (stack.length > 0) {
        const stackTop = stack[stack.length - 1];
        if (stackTop) {
          const parent = stackTop.node;
          node.parentId = parent.id;
          parent.children.push(node);
        }
      } else {
        // This is a root node
        nodes.push(node);
      }

      // Push this node onto the stack
      stack.push({ node, level: item.level });
    }

    return nodes;
  }

  /**
   * Filter the tree based on the query string
   */
  private filterTree(nodes: TocNode[], query: string): TocNode[] {
    if (!query) return nodes;

    const lowercaseQuery = query.toLowerCase();
    const filtered: TocNode[] = [];

    for (const node of nodes) {
      const matches = node.title.toLowerCase().includes(lowercaseQuery);
      const filteredChildren = this.filterTree(node.children, query);

      if (matches || filteredChildren.length > 0) {
        filtered.push({
          ...node,
          children: filteredChildren,
        });
      }
    }

    return filtered;
  }

  /**
   * Get the ToC tree structure (with filtering applied)
   */
  get tree(): TocNode[] {
    const tree = this.buildTree(this.outline);
    return this.filterTree(tree, this.filterQuery);
  }

  /**
   * Get the active node (nearest to current page)
   */
  get activeNode(): TocNode | null {
    const activeId = this.activeItemId;
    if (!activeId) return null;

    // Find the node with the matching ID
    const findNode = (nodes: TocNode[]): TocNode | null => {
      for (const node of nodes) {
        if (node.id === activeId) return node;
        const found = findNode(node.children);
        if (found) return found;
      }
      return null;
    };

    return findNode(this.tree);
  }

  /**
   * Find the nearest node for a given page number
   */
  selectNearestNodeForPage(page: number): TocNode | null {
    if (this.outline.length === 0) return null;

    // Find the item with the greatest pageNumber <= page
    // Don't assume outline is sorted - scan all items
    let nearestItem: OutlineItem | null = null;
    let nearestIndex = -1;

    for (let i = 0; i < this.outline.length; i++) {
      const item = this.outline[i];
      if (!item) continue;

      if (
        item.pageNumber <= page &&
        (!nearestItem || item.pageNumber >= nearestItem.pageNumber)
      ) {
        nearestItem = item;
        nearestIndex = i;
      }
    }

    if (!nearestItem || nearestIndex === -1) return null;

    // Generate the ID and find the node in the tree
    const id = this.generateNodeId(nearestItem);
    const findNode = (nodes: TocNode[]): TocNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = findNode(node.children);
        if (found) return found;
      }
      return null;
    };

    return findNode(this.tree);
  }

  /**
   * Get current ToC item for a page number
   */
  getCurrentTocItem(page: number): OutlineItem | null {
    if (this.outline.length === 0) return null;

    // Find the item with the greatest pageNumber <= page
    // Don't assume outline is sorted - scan all items
    let current: OutlineItem | null = null;
    for (const item of this.outline) {
      if (
        item.pageNumber <= page &&
        (!current || item.pageNumber >= current.pageNumber)
      ) {
        current = item;
      }
    }
    return current;
  }

  /**
   * Update the active item ID based on current page
   */
  updateActiveItem(page: number): void {
    const nearest = this.selectNearestNodeForPage(page);
    const newActiveId = nearest?.id ?? null;
    if (newActiveId !== this.activeItemId) {
      this.activeItemId = newActiveId;
    }
  }

  /**
   * Toggle node expansion
   */
  toggleNode(id: string): void {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
    }
  }

  /**
   * Expand all parent nodes of the active item
   */
  expandToActive(): void {
    if (!this.activeItemId) return;

    // Build from the full outline when computing parents
    // to avoid issues when a filter is active
    const fullTree = this.buildTree(this.outline);

    // Find all parent IDs by walking up the tree
    const parentIds: string[] = [];
    const findParents = (nodes: TocNode[], targetId: string): boolean => {
      for (const node of nodes) {
        if (node.id === targetId) {
          return true;
        }
        if (findParents(node.children, targetId)) {
          parentIds.push(node.id);
          return true;
        }
      }
      return false;
    };

    findParents(fullTree, this.activeItemId);

    // Expand all parent nodes
    for (const id of parentIds) {
      if (!this.expanded.has(id)) {
        this.expanded.add(id);
      }
    }
  }

  /**
   * Filter ToC by query string
   */
  setFilter(query: string): void {
    this.filterQuery = query;
    // When filtering, expand all nodes to show matches
    if (query) {
      this.expandAll();
    }
  }

  /**
   * Expand all nodes
   */
  private expandAll(): void {
    const collectIds = (nodes: TocNode[]): void => {
      for (const node of nodes) {
        this.expanded.add(node.id);
        collectIds(node.children);
      }
    };
    collectIds(this.tree);
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.outline = [];
    this.expanded = new Set();
    this.activeItemId = null;
    this.filterQuery = "";
    this.loaded = false;
  }
}

/**
 * Legacy alias for backwards compatibility
 * @deprecated Use PdfTocStore instead
 */
export const PdfToc = PdfTocStore;
