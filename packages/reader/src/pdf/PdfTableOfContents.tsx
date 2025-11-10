import { ChevronLeft, ChevronDown, ChevronRight, Search } from "lucide-react";
import { observer } from "mobx-react-lite";
import type React from "react";
import { useState } from "react";
import type { TocNode, PdfTocStore } from "@epubdown/pdf-render";

interface PdfTableOfContentsProps {
  tocStore: PdfTocStore;
  onPageSelect: (pageNumber: number) => void;
  onClose: () => void;
}

interface TocTreeNodeProps {
  node: TocNode;
  tocStore: PdfTocStore;
  onPageSelect: (pageNumber: number) => void;
  activeNodeId: string | null;
  expanded: Set<string>;
}

const TocTreeNode: React.FC<TocTreeNodeProps> = observer(
  ({ node, tocStore, onPageSelect, activeNodeId, expanded }) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    const isActive = node.id === activeNodeId;

    const handleToggle = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (hasChildren) {
        tocStore.toggleNode(node.id);
      }
    };

    const handleItemClick = () => {
      onPageSelect(node.pageNumber);
    };

    return (
      <li
        role="treeitem"
        aria-level={node.level + 1}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isActive}
      >
        <div
          className={`flex items-center py-1 px-2 rounded hover:bg-gray-100 transition-colors cursor-pointer ${
            isActive ? "bg-blue-50 text-blue-600 font-medium" : "text-gray-700"
          }`}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={handleToggle}
              className="mr-1 p-0.5 hover:bg-gray-200 rounded"
              aria-label={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          ) : (
            <span className="w-5 mr-1" />
          )}
          <button
            type="button"
            onClick={handleItemClick}
            className="flex-1 text-left truncate"
          >
            {node.title}
          </button>
          <span className="ml-auto text-xs tabular-nums text-gray-400">
            {node.pageNumber}
          </span>
        </div>

        {hasChildren && isExpanded && (
          <ul className="ml-4">
            {node.children.map((child) => (
              <TocTreeNode
                key={child.id}
                node={child}
                tocStore={tocStore}
                onPageSelect={onPageSelect}
                activeNodeId={activeNodeId}
                expanded={expanded}
              />
            ))}
          </ul>
        )}
      </li>
    );
  },
);

export const PdfTableOfContents: React.FC<PdfTableOfContentsProps> = observer(
  ({ tocStore, onPageSelect, onClose }) => {
    const [searchQuery, setSearchQuery] = useState("");
    const tocTree = tocStore.tree;
    const activeNodeId = tocStore.activeItemId;
    const expanded = tocStore.expanded;

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value;
      setSearchQuery(query);
      tocStore.setFilter(query);
    };

    const handleExpandToActive = () => {
      tocStore.expandToActive();
    };

    if (tocStore.items.length === 0) {
      return (
        <div className="p-4 text-gray-500">No table of contents available</div>
      );
    }

    return (
      <div className="h-full flex flex-col bg-white">
        <div className="flex items-center justify-between p-2 bg-white border-b">
          <button
            type="button"
            onClick={handleExpandToActive}
            className="text-xs px-2 py-1 hover:bg-gray-100 rounded transition-colors text-gray-600"
            title="Expand to current chapter"
          >
            Expand to current
          </button>
          <button
            type="button"
            onClick={onClose}
            className="lg:hidden p-1 hover:bg-gray-100 rounded transition-colors"
            aria-label="Close table of contents"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        </div>

        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder="Search chapters..."
              className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 bg-white">
          <ul role="tree" aria-label="Table of contents">
            {tocTree.map((node) => (
              <TocTreeNode
                key={node.id}
                node={node}
                tocStore={tocStore}
                onPageSelect={onPageSelect}
                activeNodeId={activeNodeId}
                expanded={expanded}
              />
            ))}
          </ul>
        </div>
      </div>
    );
  },
);
