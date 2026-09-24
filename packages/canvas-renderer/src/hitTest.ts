import type { Rect, SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { clipUnits } from "./buffer.js";

export interface HitTestOptions {
  isVisible: (node: SceneNode) => boolean;
  /** Nodes (and, for groups, their whole subtree) that clicks should pass through, e.g. locked layers. */
  isPickable?: (node: SceneNode) => boolean;
  /** Alpha (0..255) of the node's own pixels at a scene point, or undefined to fall back to its bounds. */
  alphaAt?: (node: SceneNode, x: number, y: number) => number | undefined;
  /** Minimum alpha that counts as a hit on a raster layer. */
  alphaThreshold?: number;
  /** Hit area for a leaf layer; defaults to its stored bounds. */
  boundsOf?: (node: SceneNode) => Rect;
}

/** Topmost visible leaf layer whose painted pixels cover the scene point (x, y), in PSD pixels. */
export function hitTest(graph: SceneGraph, x: number, y: number, options: HitTestOptions): SceneNode | null {
  const threshold = options.alphaThreshold ?? 16;
  const pickable = options.isPickable ?? (() => true);

  const boundsOf = options.boundsOf ?? ((node: SceneNode) => node.bounds);

  const covers = (node: SceneNode): boolean => {
    if (!options.isVisible(node) || node.type === "adjustment") return false;
    // A group's stored bounds are a union of its children's, so they inherit any child's stale bounds; ask the children.
    if (node.type === "group") return node.children.some(covers);
    const { left, top, right, bottom } = boundsOf(node);
    if (x < left || x >= right || y < top || y >= bottom) return false;
    const alpha = options.alphaAt?.(node, x, y);
    return alpha === undefined || alpha >= threshold;
  };

  const pickIn = (nodes: readonly SceneNode[]): SceneNode | null => {
    const units = clipUnits(nodes);
    for (let i = units.length - 1; i >= 0; i--) {
      const { base, clipped } = units[i]!;
      if (!options.isVisible(base)) continue;
      for (let j = clipped.length - 1; j >= 0; j--) {
        const hit = pick(clipped[j]!);
        if (hit && covers(base)) return hit;
      }
      const hit = pick(base);
      if (hit) return hit;
    }
    return null;
  };

  const pick = (node: SceneNode): SceneNode | null => {
    if (!pickable(node) || !covers(node)) return null;
    return node.type === "group" ? pickIn(node.children) : node;
  };

  return pickIn(graph.root);
}
