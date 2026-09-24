import { z } from "zod";
import { RgbaSchema } from "./nodes.js";

/**
 * What an admin defines when tagging a scene-graph node as an editable field
 * during template authoring (spec §10). Stored as TemplateField.constraints_json.
 */

export const FieldTypeSchema = z.enum(["text", "image", "visibility", "smart_object"]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const TextFieldConstraintsSchema = z.object({
  kind: z.literal("text"),
  maxLength: z.number().int().positive().max(10_000),
  allowedFonts: z.array(z.string()).min(1),
  minFontSizePt: z.number().positive(),
  maxFontSizePt: z.number().positive(),
  colorLocked: z.boolean(),
  allowedColors: z.array(RgbaSchema).optional(),
  allowedAlignments: z.array(z.enum(["left", "center", "right", "justify"])).min(1),
  required: z.boolean(),
});
export type TextFieldConstraints = z.infer<typeof TextFieldConstraintsSchema>;

export const ImageFieldConstraintsSchema = z.object({
  kind: z.literal("image"),
  aspectRatioW: z.number().positive(),
  aspectRatioH: z.number().positive(),
  aspectTolerancePct: z.number().min(0).max(100).default(5),
  minWidthPx: z.number().int().positive(),
  minHeightPx: z.number().int().positive(),
  maxUploadBytes: z.number().int().positive().max(200 * 1024 * 1024),
  allowedMimeTypes: z.array(z.enum(["image/png", "image/jpeg", "image/webp"])).min(1),
  required: z.boolean(),
});
export type ImageFieldConstraints = z.infer<typeof ImageFieldConstraintsSchema>;

export const VisibilityFieldConstraintsSchema = z.object({
  kind: z.literal("visibility"),
  defaultVisible: z.boolean(),
  /** If part of a mutually-exclusive toggle group (e.g. logo variant A/B/C). */
  exclusiveGroup: z.string().nullable().optional(),
});
export type VisibilityFieldConstraints = z.infer<typeof VisibilityFieldConstraintsSchema>;

export const FieldConstraintsSchema = z.discriminatedUnion("kind", [
  TextFieldConstraintsSchema,
  ImageFieldConstraintsSchema,
  VisibilityFieldConstraintsSchema,
]);
export type FieldConstraints = z.infer<typeof FieldConstraintsSchema>;

/** Rounding slack for crop windows computed in floating point by the editor. */
const CROP_EPSILON = 1e-6;

/** Normalized crop window (0..1) within an uploaded image; it must lie inside the image. */
export const CropRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((c) => c.x + c.width <= 1 + CROP_EPSILON && c.y + c.height <= 1 + CROP_EPSILON, "Crop window must lie inside the image.");
export type CropRect = z.infer<typeof CropRectSchema>;

/**
 * A single field-value edit stored per Project (ProjectFieldValue.value_json),
 * and what gets merged into the scene graph at preview/export time.
 */
export const FieldOverrideSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    nodeId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    nodeId: z.string(),
    /** Asset id of the user-uploaded replacement image, at its original resolution. */
    imageAssetId: z.string(),
    crop: CropRectSchema,
  }),
  z.object({
    type: z.literal("visibility"),
    nodeId: z.string(),
    visible: z.boolean(),
  }),
]);
export type FieldOverride = z.infer<typeof FieldOverrideSchema>;

/**
 * Turns a project's saved field values (stored without their node id) into the override list every
 * compositor paints with — the server preview/export and the browser editor share this one merge.
 * Values that don't parse as an override are skipped rather than painted half-applied.
 */
export function toFieldOverrides(values: readonly { nodeId: string; value: unknown }[]): FieldOverride[] {
  const overrides: FieldOverride[] = [];
  for (const { nodeId, value } of values) {
    const parsed = FieldOverrideSchema.safeParse({ ...(value as object), nodeId });
    if (parsed.success) overrides.push(parsed.data);
  }
  return overrides;
}
