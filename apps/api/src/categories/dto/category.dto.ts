import { z } from "zod";

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().nullable().optional(),
  visibility: z.enum(["PUBLIC", "ORG_RESTRICTED", "PLAN_TIER"]).default("PUBLIC"),
});
export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = CreateCategorySchema.partial();
export type UpdateCategoryDto = z.infer<typeof UpdateCategorySchema>;
