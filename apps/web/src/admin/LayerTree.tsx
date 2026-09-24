import { useEffect, useMemo, useRef, useState } from "react";
import { rasterAssetId, type LayerImageStore } from "@psd-studio/canvas-renderer";
import type { SceneNode, TextLayerNode } from "@psd-studio/scene-graph";
import { Box, ChevronRight, Eye, EyeOff, Folder, FolderOpen, Lock, LockOpen, PenLine, Search, SearchX, SlidersHorizontal, Type } from "lucide-react";
import { ancestorIds, matchingIds } from "../canvas/sceneTree";
import { BitmapThumb } from "../canvas/BitmapThumb";
import { EmptyState } from "../components/workspace";

export const TYPE_LABEL: Record<SceneNode["type"], string> = {
  group: "Group",
  text: "Text",
  smartObject: "Smart Object",
  pixel: "Pixel",
  shape: "Shape",
  adjustment: "Adjustment",
};

const THUMB_W = 30;
const THUMB_H = 24;
const INDENT = 12;

interface LayerTreeProps {
  nodes: SceneNode[];
  selectedId: string | null;
  mappedNodeIds: Set<string>;
  onSelect: (node: SceneNode) => void;
  isVisible: (node: SceneNode) => boolean;
  onToggleVisible: (node: SceneNode) => void;
  onToggleLocked: (node: SceneNode) => void;
  images: LayerImageStore | null;
}

/** Photoshop-style layers panel: topmost layer first, with thumbnails, visibility, locks, search and collapsible groups. */
export function LayerTree(props: LayerTreeProps) {
  const { nodes, selectedId } = props;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const filter = useMemo(() => (query.trim() ? matchingIds(nodes, query) : null), [nodes, query]);

  useEffect(() => {
    if (!selectedId) return;
    const ancestors = ancestorIds(nodes, selectedId) ?? [];
    if (ancestors.some((id) => collapsed.has(id))) {
      setCollapsed((prev) => new Set([...prev].filter((id) => !ancestors.includes(id))));
    }
    // Only react to selection changes (e.g. a canvas click), not to the user collapsing a group afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nodes]);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, collapsed]);

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="layers-panel">
      <div className="layers-toolbar">
        <div className="search-field">
          <Search size={14} aria-hidden="true" />
          <input type="search" className="layers-search" placeholder="Filter layers" aria-label="Filter layers" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div ref={listRef} className="layer-tree" role="tree" aria-label="Layers">
        <LayerRows {...props} nodes={nodes} depth={0} ancestorHidden={false} filter={filter} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        {filter?.size === 0 && (
          <EmptyState icon={<SearchX size={20} />} title="No matching layers">
            Nothing is named “{query}”.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function LayerRows(
  props: LayerTreeProps & {
    depth: number;
    ancestorHidden: boolean;
    filter: Set<string> | null;
    collapsed: Set<string>;
    onToggleCollapsed: (id: string) => void;
  },
) {
  const { nodes, depth, ancestorHidden, filter, collapsed, selectedId, mappedNodeIds, onSelect, isVisible, onToggleVisible, onToggleLocked, onToggleCollapsed } = props;
  return (
    <>
      {[...nodes].reverse().map((node) => {
        if (filter && !filter.has(node.id)) return null;
        const visible = isVisible(node);
        const isGroup = node.type === "group";
        const expanded = isGroup && (filter !== null || !collapsed.has(node.id));
        const locked = !!node.locked;
        return (
          <div key={node.id} role="none">
            <div
              className={`layer-row${node.id === selectedId ? " selected" : ""}${!visible || ancestorHidden ? " is-hidden" : ""}`}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={node.id === selectedId}
              aria-expanded={isGroup ? expanded : undefined}
              data-node-id={node.id}
              tabIndex={node.id === selectedId ? 0 : -1}
              title={`${TYPE_LABEL[node.type]} layer`}
              onClick={() => onSelect(node)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(node);
                }
              }}
            >
              <span className="layer-eye-col">
                <button
                  type="button"
                  className="layer-icon-btn"
                  aria-pressed={visible}
                  aria-label={visible ? `Hide ${node.name}` : `Show ${node.name}`}
                  title={visible ? "Hide layer (view only)" : "Show layer (view only)"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisible(node);
                  }}
                >
                  {visible ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
                </button>
              </span>
              <span className="layer-indent" style={{ width: depth * INDENT }} />
              {isGroup ? (
                <button
                  type="button"
                  className="layer-caret"
                  aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCollapsed(node.id);
                  }}
                  disabled={filter !== null}
                >
                  <ChevronRight size={14} aria-hidden="true" style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
                </button>
              ) : (
                <span className="layer-caret" />
              )}
              <LayerThumb node={node} images={props.images} expanded={expanded} />
              <span className="layer-label">
                <span className="layer-name">{node.name}</span>
                {node.type === "text" && <FontBadge node={node} />}
              </span>
              {mappedNodeIds.has(node.id) && (
                <span className="badge field-pill" title="Mapped as an editable field">
                  <PenLine size={11} strokeWidth={2.4} aria-hidden="true" />
                  <span className="visually-hidden">Field</span>
                </span>
              )}
              <button
                type="button"
                className={`layer-icon-btn layer-lock${locked ? " active" : ""}`}
                aria-pressed={locked}
                aria-label={locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                title={locked ? "Locked: canvas clicks pass through this layer" : "Lock (canvas clicks will pass through)"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLocked(node);
                }}
              >
                {locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
              </button>
            </div>
            {isGroup && expanded && <LayerRows {...props} nodes={node.children} depth={depth + 1} ancestorHidden={ancestorHidden || !visible} />}
          </div>
        );
      })}
    </>
  );
}

function FontBadge({ node }: { node: TextLayerNode }) {
  const fonts = [...new Set(node.runs.map((r) => r.fontName))];
  const label = fonts.length === 1 ? fonts[0]! : "Mixed fonts";
  return (
    <span className="font-badge" title={`Detected from PSD: ${fonts.join(", ")}`}>
      {label}
    </span>
  );
}

function LayerThumb({ node, images, expanded }: { node: SceneNode; images: LayerImageStore | null; expanded: boolean }) {
  const assetId = rasterAssetId(node);
  const image = assetId && images ? images.get(assetId) : undefined;

  if (node.type === "group") return <span className="layer-thumb icon group">{expanded ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}</span>;
  if (node.type === "text")
    return (
      <span className="layer-thumb icon">
        <Type size={14} aria-hidden="true" />
      </span>
    );
  if (node.type === "adjustment")
    return (
      <span className="layer-thumb icon">
        <SlidersHorizontal size={14} aria-hidden="true" />
      </span>
    );
  return (
    <span className="layer-thumb-wrap">
      <BitmapThumb className="layer-thumb checkerboard" image={image} width={THUMB_W} height={THUMB_H} />
      {node.type === "smartObject" && (
        <span className="layer-thumb-badge" title="Smart Object">
          <Box size={9} strokeWidth={2.5} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
