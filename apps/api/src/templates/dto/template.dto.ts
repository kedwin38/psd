import { z } from "zod";
import { FieldConstraintsSchema } from "@psd-studio/scene-graph";

export const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  categoryId: z.string().uuid(),
  visibilityScope: z.enum(["PUBLIC", "ORG_RESTRICTED", "PLAN_TIER"]).default("PUBLIC"),
});
export type CreateTemplateDto = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  categoryId: z.string().uuid().optional(),
  visibilityScope: z.enum(["PUBLIC", "ORG_RESTRICTED", "PLAN_TIER"]).optional(),
});
export type UpdateTemplateDto = z.infer<typeof UpdateTemplateSchema>;

// multipart/form-data delivers every non-file field as a string, so this mirrors CreateTemplateSchema
// minus `name` (one bulk upload makes many templates, one per file, named from each filename).
export const BulkUploadTemplatesSchema = z.object({
  categoryId: z.string().uuid(),
  visibilityScope: z.enum(["PUBLIC", "ORG_RESTRICTED", "PLAN_TIER"]).default("PUBLIC"),
});
export type BulkUploadTemplatesDto = z.infer<typeof BulkUploadTemplatesSchema>;

// Shared by bulk-delete and bulk-publish — both just act on a list of template ids.
export const BulkTemplateIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export type BulkTemplateIdsDto = z.infer<typeof BulkTemplateIdsSchema>;

export const CreateFieldSchema = z.object({
  nodeId: z.string().min(1),
  layerPath: z.string().min(1),
  fieldType: z.enum(["TEXT", "IMAGE", "VISIBILITY", "SMART_OBJECT"]),
  label: z.string().min(1).max(200),
  order: z.number().int().default(0),
  constraints: FieldConstraintsSchema,
});
export type CreateFieldDto = z.infer<typeof CreateFieldSchema>;

export const UpdateFieldSchema = CreateFieldSchema.partial();
export type UpdateFieldDto = z.infer<typeof UpdateFieldSchema>;

export const UpdateNodeSchema = z
  .object({
    locked: z.boolean().optional(),
    /** Re-points a pixel/smart-object layer at an existing layer raster, e.g. to undo an image replacement. */
    imageAssetId: z.string().uuid().optional(),
  })
  .refine((dto) => dto.locked !== undefined || dto.imageAssetId !== undefined, { message: "Provide locked and/or imageAssetId." });
export type UpdateNodeDto = z.infer<typeof UpdateNodeSchema>;
