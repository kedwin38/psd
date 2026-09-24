import { useEffect, useMemo, useRef, useState } from "react";
import { rasterAssetId, type LayerImageStore } from "@psd-studio/canvas-renderer";
import type { SceneNode, TextLayerNode } from "@psd-studio/scene-graph";
import { ancestorIds, matchingIds } from "../canvas/sceneTree";

const TYPE_LABEL: Record<SceneNode["type"], string> = {
  group: "Group",
  text: "Text",
  smartObject: "Smart Object",
  pixel: "Pixel",
  shape: "Shape",
  adjustment: "Adjustment",
};

const THUMB_W = 34;
const THUMB_H = 26;

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
      <input type="search" className="layers-search" placeholder="Filter layers by name" aria-label="Filter layers" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div ref={listRef} className="layer-tree" role="tree" aria-label="Layers">
        <LayerRows {...props} nodes={nodes} depth={0} ancestorHidden={false} filter={filter} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        {filter?.size === 0 && <p className="hint">No layers match “{query}”.</p>}
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
        return (
          <div key={node.id} role="none">
            <div
              className={`layer-row${node.id === selectedId ? " selected" : ""}${!visible || ancestorHidden ? " is-hidden" : ""}`}
              role="treeitem"
              aria-selected={node.id === selectedId}
              aria-expanded={isGroup ? expanded : undefined}
              data-node-id={node.id}
              tabIndex={node.id === selectedId ? 0 : -1}
              onClick={() => onSelect(node)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(node);
                }
              }}
            >
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
                {visible ? <EyeIcon /> : <span className="icon-placeholder" />}
              </button>
              <button
                type="button"
                className={`layer-icon-btn${node.locked ? " active" : ""}`}
                aria-pressed={!!node.locked}
                aria-label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                title={node.locked ? "Locked: canvas clicks pass through this layer" : "Lock (canvas clicks will pass through)"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLocked(node);
                }}
              >
                <LockIcon locked={!!node.locked} />
              </button>
              <span className="layer-indent" style={{ width: depth * 14 }} />
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
                  <svg viewBox="0 0 10 10" width="10" height="10" style={{ transform: expanded ? "rotate(90deg)" : undefined }}>
                    <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
              ) : (
                <span className="layer-caret" />
              )}
              <LayerThumb node={node} images={props.images} />
              <span className="layer-label">
                <span className="layer-name">{node.name}</span>
                {node.type === "text" && <FontBadge node={node} />}
              </span>
              <span className="type-tag">{TYPE_LABEL[node.type]}</span>
              {mappedNodeIds.has(node.id) && <span className="badge PUBLISHED">field</span>}
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
      <span className="font-badge-caption">PSD font</span> {label}
    </span>
  );
}

function LayerThumb({ node, images }: { node: SceneNode; images: LayerImageStore | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const assetId = rasterAssetId(node);
  const image = assetId && images ? images.get(assetId) : undefined;

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx || !image) return;
    const dpr = window.devicePixelRatio || 1;
    const w = THUMB_W * dpr;
    const h = THUMB_H * dpr;
    const k = Math.min(w / image.width, h / image.height);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, (w - image.width * k) / 2, (h - image.height * k) / 2, image.width * k, image.height * k);
  }, [image]);

  if (node.type === "group") return <span className="layer-thumb icon">{FOLDER_ICON}</span>;
  if (node.type === "text") return <span className="layer-thumb icon text">T</span>;
  if (node.type === "adjustment") return <span className="layer-thumb icon">◐</span>;
  const dpr = window.devicePixelRatio || 1;
  return <canvas ref={ref} className="layer-thumb checkerboard" width={THUMB_W * dpr} height={THUMB_H * dpr} aria-hidden="true" />;
}

const FOLDER_ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1" fill={locked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" />
      <path d={locked ? "M5 7V5a3 3 0 0 1 6 0v2" : "M5 7V5a3 3 0 0 1 5.8-1"} fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
