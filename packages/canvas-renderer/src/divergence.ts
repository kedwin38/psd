import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";

/** The "Diverges from server" notes in render.ts, as checks an editor can surface for a node (fonts: see isFontAvailable). */
export type ExportDivergence = "text-tracking";

export function exportDivergences(graph: SceneGraph, node: SceneNode): ExportDivergence[] {
  const found: ExportDivergence[] = [];
  if (node.type === "text" && node.runs.some((r) => (r.tracking ?? 0) !== 0)) found.push("text-tracking");
  return found;
}
