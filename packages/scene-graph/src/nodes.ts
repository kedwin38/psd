import { z } from "zod";

/**
 * The canonical "Scene Graph" — a portable, PSD-binary-agnostic representation
 * of a template's layer tree. It is produced once by the PSD ingestion worker
 * (packages/psd-engine) and is the ONLY thing the interactive editor and the
 * server-side render/export worker ever read. Both render the same graph
 * through the same compositor at different resolutions, which is what
 * guarantees preview/export parity (see spec §5, §7).
 */

export const BlendModeSchema = z.enum([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
export type BlendMode = z.infer<typeof BlendModeSchema>;

export const RectSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

export const RgbaSchema = z.object({
  r: z.number().min(0).max(255),
  g: z.number().min(0).max(255),
  b: z.number().min(0).max(255),
  a: z.number().min(0).max(1),
});
export type Rgba = z.infer<typeof RgbaSchema>;

export const AffineTransformSchema = z.object({
  m00: z.number(),
  m01: z.number(),
  m10: z.number(),
  m11: z.number(),
  m02: z.number(),
  m12: z.number(),
});
export type AffineTransform = z.infer<typeof AffineTransformSchema>;

export const IdentityTransform: AffineTransform = {
  m00: 1,
  m01: 0,
  m10: 0,
  m11: 1,
  m02: 0,
  m12: 0,
};

const BaseNodeSchema = z.object({
  /** Stable, content-derived id (see idFromPath). Used by field mappings. */
  id: z.string().min(1),
  /** Human-readable "Group 1/Photo" path, unique within the scene graph. */
  path: z.string().min(1),
  name: z.string(),
  visible: z.boolean(),
  /** 0..1 */
  opacity: z.number().min(0).max(1),
  blendMode: BlendModeSchema,
  bounds: RectSchema,
  /** PSD "clip to layer below" flag. */
  clipping: z.boolean(),
  /** Optional grayscale layer-mask raster, stored as an Asset id. */
  maskAssetId: z.string().nullable().optional(),
});

export const PixelLayerNodeSchema = BaseNodeSchema.extend({
  type: z.literal("pixel"),
  imageAssetId: z.string().min(1),
});
export type PixelLayerNode = z.infer<typeof PixelLayerNodeSchema>;

export const TextRunSchema = z.object({
  text: z.string(),
  fontName: z.string(),
  fontSize: z.number().positive(),
  color: RgbaSchema,
  tracking: z.number().optional(),
  leadingPt: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});
export type TextRun = z.infer<typeof TextRunSchema>;

export const TextLayerNodeSchema = BaseNodeSchema.extend({
  type: z.literal("text"),
  runs: z.array(TextRunSchema).min(1),
  alignment: z.enum(["left", "center", "right", "justify"]),
  /** Original PSD point-text bounds used for reflow on edit. */
  boxMode: z.enum(["point", "paragraph"]),
});
export type TextLayerNode = z.infer<typeof TextLayerNodeSchema>;

export const SmartObjectLayerNodeSchema = BaseNodeSchema.extend({
  type: z.literal("smartObject"),
  /** Baked preview raster of the smart object exactly as authored. */
  imageAssetId: z.string().min(1),
  /** Maps a unit-square replacement image onto the layer's placed position. */
  placement: AffineTransformSchema,
  intrinsicWidth: z.number().positive(),
  intrinsicHeight: z.number().positive(),
  /** True if template authoring marked this as an end-user replacement target. */
  replaceable: z.boolean(),
});
export type SmartObjectLayerNode = z.infer<typeof SmartObjectLayerNodeSchema>;

export const AdjustmentLayerNodeSchema = BaseNodeSchema.extend({
  type: z.literal("adjustment"),
  adjustmentKind: z.string(),
  /** Pre-baked preview of this adjustment's effect for the compositor's fast path. */
  previewAssetId: z.string().nullable().optional(),
});
export type AdjustmentLayerNode = z.infer<typeof AdjustmentLayerNodeSchema>;

export const ShapeLayerNodeSchema = BaseNodeSchema.extend({
  type: z.literal("shape"),
  imageAssetId: z.string().min(1),
});
export type ShapeLayerNode = z.infer<typeof ShapeLayerNodeSchema>;

export interface GroupNode extends z.infer<typeof BaseNodeSchema> {
  type: "group";
  isPassThrough: boolean;
  children: SceneNode[];
}

export type SceneNode =
  | PixelLayerNode
  | TextLayerNode
  | SmartObjectLayerNode
  | AdjustmentLayerNode
  | ShapeLayerNode
  | GroupNode;

// GroupNode must be a plain ZodObject (not z.lazy(...) and not cast to an opaque ZodType) so
// z.discriminatedUnion below can statically read its `type` literal and shape; only the
// recursive `children` field itself is deferred via z.lazy.
export const GroupNodeSchema = BaseNodeSchema.extend({
  type: z.literal("group"),
  isPassThrough: z.boolean(),
  children: z.lazy(() => z.array(SceneNodeSchema)),
});

// zod's inference across a recursive discriminated union doesn't fully collapse to our
// hand-written SceneNode type, so we assert it here once, at the single boundary where the
// two are declared equivalent; every consumer of SceneNodeSchema still gets full type safety.
export const SceneNodeSchema: z.ZodType<SceneNode> = z.discriminatedUnion("type", [
  PixelLayerNodeSchema,
  TextLayerNodeSchema,
  SmartObjectLayerNodeSchema,
  AdjustmentLayerNodeSchema,
  ShapeLayerNodeSchema,
  GroupNodeSchema,
]) as unknown as z.ZodType<SceneNode>;

export const ColorModeSchema = z.enum(["rgb", "cmyk", "grayscale", "bitmap"]);
export type ColorMode = z.infer<typeof ColorModeSchema>;

export const SceneGraphSchema = z.object({
  formatVersion: z.literal(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Native resolution the PSD was authored at (e.g. 300 for print). */
  dpi: z.number().positive(),
  colorMode: ColorModeSchema,
  iccProfileName: z.string().nullable().optional(),
  /** Top-level layers/groups, in paint order: index 0 paints first (bottom). */
  root: z.array(SceneNodeSchema),
});
export type SceneGraph = z.infer<typeof SceneGraphSchema>;

/** Deterministic, filesystem/URL-safe id derived from a layer's path. */
export function idFromPath(path: string): string {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `n_${hex}`;
}

/** Depth-first walk over every node in the graph (groups included). */
export function* walkSceneGraph(graph: SceneGraph): Generator<SceneNode> {
  function* walk(nodes: SceneNode[]): Generator<SceneNode> {
    for (const node of nodes) {
      yield node;
      if (node.type === "group") {
        yield* walk(node.children);
      }
    }
  }
  yield* walk(graph.root);
}

export function findNodeById(graph: SceneGraph, id: string): SceneNode | undefined {
  for (const node of walkSceneGraph(graph)) {
    if (node.id === id) return node;
  }
  return undefined;
}
