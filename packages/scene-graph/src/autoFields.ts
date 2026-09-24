import type { FieldConstraints } from "./fields.js";
import type { SceneGraph, SceneNode } from "./nodes.js";

/** The editable field an unlocked layer becomes without any manual mapping (TemplateField's shape). */
export interface AutoField {
  nodeId: string;
  layerPath: string;
  fieldType: "TEXT" | "IMAGE" | "VISIBILITY";
  label: string;
  order: number;
  constraints: FieldConstraints;
}

const MIN_TEXT_MAX_LENGTH = 200;
const MAX_TEXT_MAX_LENGTH = 10_000;
/** Uploads are cover-fitted to the layer, so this allows at most a 2x upscale. */
const MIN_IMAGE_SCALE = 0.5;
/** The project upload endpoint's own cap. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_LABEL_LENGTH = 200;

/** The first locked node on the path from the root down to this node: locking a group locks everything in it, as in Photoshop. */
export function lockingNode(graph: SceneGraph, nodeId: string): SceneNode | undefined {
  function pathTo(nodes: SceneNode[], chain: SceneNode[]): SceneNode[] | null {
    for (const node of nodes) {
      const path = [...chain, node];
      if (node.id === nodeId) return path;
      if (node.type === "group") {
        const found = pathTo(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }
  return pathTo(graph.root, [])?.find((n) => n.locked);
}

function autoFieldFor(node: SceneNode): Pick<AutoField, "fieldType" | "constraints"> {
  switch (node.type) {
    case "text": {
      const text = node.runs.map((r) => r.text).join("").replace(/\r\n?/g, "\n");
      const sizes = node.runs.map((r) => r.fontSize).filter((size) => size > 0);
      return {
        fieldType: "TEXT",
        constraints: {
          kind: "text",
          maxLength: Math.min(MAX_TEXT_MAX_LENGTH, Math.max(MIN_TEXT_MAX_LENGTH, text.length * 2)),
          allowedFonts: [...new Set(node.runs.map((r) => r.fontName))],
          minFontSizePt: Math.min(8, ...sizes),
          maxFontSizePt: Math.max(72, ...sizes),
          colorLocked: true,
          allowedAlignments: [node.alignment],
          required: false,
        },
      };
    }
    case "pixel":
    case "shape":
    case "smartObject": {
      const width = Math.max(1, Math.round(node.bounds.right - node.bounds.left));
      const height = Math.max(1, Math.round(node.bounds.bottom - node.bounds.top));
      return {
        fieldType: "IMAGE",
        constraints: {
          kind: "image",
          aspectRatioW: width,
          aspectRatioH: height,
          // Any shape is accepted: the editor crops uploads to the layer's frame.
          aspectTolerancePct: 100,
          minWidthPx: Math.ceil(width * MIN_IMAGE_SCALE),
          minHeightPx: Math.ceil(height * MIN_IMAGE_SCALE),
          maxUploadBytes: MAX_UPLOAD_BYTES,
          allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          required: false,
        },
      };
    }
    case "group":
    case "adjustment":
      return { fieldType: "VISIBILITY", constraints: { kind: "visibility", defaultVisible: node.visible } };
  }
}

/**
 * One field per layer that isn't locked (itself or by a locked group), ordered as the Layers panel lists them: topmost
 * first. A field's order is its layer's position among all layers, so it doesn't shift as other layers lock and unlock.
 */
export function autoFields(graph: SceneGraph): AutoField[] {
  const fields: AutoField[] = [];
  let position = 0;
  const visit = (nodes: SceneNode[], locked: boolean) => {
    for (const node of [...nodes].reverse()) {
      const order = position++;
      const isLocked = locked || !!node.locked;
      if (!isLocked) {
        // A PSD may leave layers unnamed; fields still need a label and path.
        const label = node.name.slice(0, MAX_LABEL_LENGTH) || node.type;
        fields.push({ nodeId: node.id, layerPath: node.path || label, label, order, ...autoFieldFor(node) });
      }
      if (node.type === "group") visit(node.children, isLocked);
    }
  };
  visit(graph.root, false);
  return fields;
}
