import type { SceneNode } from "@psd-studio/scene-graph";

const TYPE_LABEL: Record<SceneNode["type"], string> = {
  group: "Group",
  text: "Text",
  smartObject: "Smart Object",
  pixel: "Pixel",
  shape: "Shape",
  adjustment: "Adjustment",
};

export function LayerTree({
  nodes,
  selectedId,
  mappedNodeIds,
  onSelect,
  depth = 0,
}: {
  nodes: SceneNode[];
  selectedId: string | null;
  mappedNodeIds: Set<string>;
  onSelect: (node: SceneNode) => void;
  depth?: number;
}) {
  return (
    <div className="layer-tree">
      {nodes.map((node) => (
        <div key={node.id}>
          <div
            className={`layer-row${node.id === selectedId ? " selected" : ""}`}
            onClick={() => onSelect(node)}
            style={{ paddingLeft: 8 + depth * 16 }}
          >
            <span>{node.name}</span>
            <span className="type-tag">{TYPE_LABEL[node.type]}</span>
            {mappedNodeIds.has(node.id) && <span className="badge PUBLISHED">field</span>}
            {!node.visible && <span className="hint">(hidden)</span>}
          </div>
          {node.type === "group" && (
            <LayerTree nodes={node.children} selectedId={selectedId} mappedNodeIds={mappedNodeIds} onSelect={onSelect} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}
