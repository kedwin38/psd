import type { SceneNode } from "@psd-studio/scene-graph";

export function findNode(nodes: readonly SceneNode[], id: string): SceneNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === "group") {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Ids of the groups enclosing `id`, outermost first; null if the node isn't in the tree. */
export function ancestorIds(nodes: readonly SceneNode[], id: string): string[] | null {
  for (const n of nodes) {
    if (n.id === id) return [];
    if (n.type === "group") {
      const inner = ancestorIds(n.children, id);
      if (inner) return [n.id, ...inner];
    }
  }
  return null;
}

/** Nodes whose name matches the query, plus every ancestor needed to reach them. */
export function matchingIds(nodes: readonly SceneNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const ids = new Set<string>();
  const visit = (list: readonly SceneNode[]): boolean => {
    let any = false;
    for (const n of list) {
      const childMatch = n.type === "group" && visit(n.children);
      if (childMatch || n.name.toLowerCase().includes(q)) {
        ids.add(n.id);
        any = true;
      }
    }
    return any;
  };
  visit(nodes);
  return ids;
}

export function withNodeUpdate<T extends { root: SceneNode[] }>(graph: T, id: string, patch: Partial<Pick<SceneNode, "locked">>): T {
  const update = (nodes: SceneNode[]): SceneNode[] =>
    nodes.map((n) => (n.id === id ? { ...n, ...patch } : n.type === "group" ? { ...n, children: update(n.children) } : n));
  return { ...graph, root: update(graph.root) };
}
