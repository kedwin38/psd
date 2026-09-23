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
    /** Normalized crop window (0..1) within the uploaded image. */
    crop: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    }),
  }),
  z.object({
    type: z.literal("visibility"),
    nodeId: z.string(),
    visible: z.boolean(),
  }),
]);
export type FieldOverride = z.infer<typeof FieldOverrideSchema>;
