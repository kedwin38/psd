import { z } from "zod";

export const CreateProjectSchema = z.object({
  templateId: z.string().uuid(),
  name: z.string().min(1).max(200).default("Untitled project"),
});
export type CreateProjectDto = z.infer<typeof CreateProjectSchema>;

export const PatchFieldValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    imageAssetId: z.string().min(1),
    crop: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    }),
  }),
  z.object({ type: z.literal("visibility"), visible: z.boolean() }),
]);
export type PatchFieldValueDto = z.infer<typeof PatchFieldValueSchema>;
