import { z } from "zod";
import { CropRectSchema } from "@psd-studio/scene-graph";

export const CreateProjectSchema = z.object({
  templateId: z.string().uuid(),
  name: z.string().min(1).max(200).default("Untitled project"),
});
export type CreateProjectDto = z.infer<typeof CreateProjectSchema>;

export const RenameProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(200, "Name must be 200 characters or fewer."),
});
export type RenameProjectDto = z.infer<typeof RenameProjectSchema>;

export const PatchFieldValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    imageAssetId: z.string().min(1),
    crop: CropRectSchema,
  }),
  z.object({ type: z.literal("visibility"), visible: z.boolean() }),
]);
export type PatchFieldValueDto = z.infer<typeof PatchFieldValueSchema>;
