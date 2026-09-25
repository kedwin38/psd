import type { Category } from "./types";

export interface CategoryNode extends Category {
  children: CategoryNode[];
}

/** Nests the API's flat, name-ordered list; a category whose parent is missing shows at the top level. */
export function categoryTree(categories: Category[]): CategoryNode[] {
  const nodes = new Map(categories.map((c) => [c.id, { ...c, children: [] as CategoryNode[] }]));
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) ((node.parentId && nodes.get(node.parentId)?.children) || roots).push(node);
  return roots;
}

/** Depth-first, so each category directly follows its parent. */
export function flattenTree(nodes: CategoryNode[], depth = 0): { category: CategoryNode; depth: number }[] {
  return nodes.flatMap((category) => [{ category, depth }, ...flattenTree(category.children, depth + 1)]);
}

/** The chain from the top-level category down to `id`. */
export function categoryPath(categories: Category[], id: string | null): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path: Category[] = [];
  for (let c = id ? byId.get(id) : undefined; c && !path.includes(c); c = c.parentId ? byId.get(c.parentId) : undefined) path.unshift(c);
  return path;
}

export const categoryLabel = (categories: Category[], id: string | null) =>
  categoryPath(categories, id)
    .map((c) => c.name)
    .join(" › ");

/** `id` and every category nested under it. */
export function subtreeIds(categories: Category[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of categories) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        grew = true;
      }
    }
  }
  return ids;
}
