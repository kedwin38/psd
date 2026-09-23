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
