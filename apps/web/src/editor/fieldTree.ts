import type { GroupNode, SceneNode } from "@psd-studio/scene-graph";
import type { TemplateField } from "../lib/types";

export type FieldEntry = { kind: "field"; field: TemplateField } | FieldGroupEntry;

export interface FieldGroupEntry {
  kind: "group";
  node: GroupNode;
  entries: FieldEntry[];
  /** Fields anywhere inside, the group's own show/hide field included. */
  count: number;
}

export interface FieldTree {
  entries: FieldEntry[];
  /** Ids of the group sections enclosing each field's card, outermost first. */
  groupsOf: ReadonlyMap<string, readonly string[]>;
}

const firstOrder = (e: FieldEntry): number => (e.kind === "field" ? e.field.order : Math.min(...e.entries.map(firstOrder)));

/**
 * The fields laid out in the PSD's own group structure, topmost layer first. Only groups holding at least one field
 * get a section; a group that is itself a (show/hide) field leads its section with that field's card, or is a plain
 * card when nothing inside it is editable. Siblings follow the admin's field order, each group placed by its first field.
 */
export function buildFieldTree(root: readonly SceneNode[], fields: readonly TemplateField[]): FieldTree {
  const byNode = new Map(fields.map((f) => [f.nodeId, f]));
  const groupsOf = new Map<string, string[]>();
  const place = (field: TemplateField, groups: string[]): FieldEntry => {
    groupsOf.set(field.id, groups);
    return { kind: "field", field };
  };
  const visit = (nodes: readonly SceneNode[], groups: string[]): FieldEntry[] => {
    const entries: FieldEntry[] = [];
    for (const node of [...nodes].reverse()) {
      const own = byNode.get(node.id);
      if (node.type === "group") {
        const inner = [...groups, node.id];
        const children = visit(node.children, inner);
        if (children.length > 0) {
          const all = own ? [place(own, inner), ...children] : children;
          entries.push({ kind: "group", node, entries: all, count: all.reduce((n, e) => n + (e.kind === "field" ? 1 : e.count), 0) });
          continue;
        }
      }
      if (own) entries.push(place(own, groups));
    }
    return entries.sort((a, b) => firstOrder(a) - firstOrder(b));
  };
  const entries = visit(root, []);
  // A field whose layer is missing from the graph still gets its card, as before grouping.
  for (const f of fields) if (!groupsOf.has(f.id)) entries.push(place(f, []));
  return { entries, groupsOf };
}
