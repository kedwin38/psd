import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";

/** The "Diverges from server" notes in render.ts, as checks an editor can surface for a node. */
export type ExportDivergence = "text-tracking" | "text-opacity" | "text-blend" | "top-level-clipping";

export function exportDivergences(graph: SceneGraph, node: SceneNode): ExportDivergence[] {
  const found: ExportDivergence[] = [];
  if (node.type === "text") {
    if (node.runs.some((r) => (r.tracking ?? 0) !== 0)) found.push("text-tracking");
    if (node.opacity < 1) found.push("text-opacity");
    if (node.blendMode !== "normal") found.push("text-blend");
  }
  if (node.clipping && graph.root.some((n) => n.id === node.id)) found.push("top-level-clipping");
  return found;
}
