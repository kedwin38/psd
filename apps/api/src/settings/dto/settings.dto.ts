import { z } from "zod";

/** Reduced enough to stay unobtrusive, but never so low a screenshot could pass as clean. */
export const WatermarkOpacitySchema = z.coerce.number().min(0.05).max(0.4);

export const UpdateWatermarkOpacitySchema = z.object({
  opacity: WatermarkOpacitySchema,
});
export type UpdateWatermarkOpacityDto = z.infer<typeof UpdateWatermarkOpacitySchema>;

/** multipart/form-data: `opacity` arrives as a string field alongside the file, so it's optional and coerced. */
export const UploadWatermarkSchema = z.object({
  opacity: WatermarkOpacitySchema.optional(),
});
export type UploadWatermarkDto = z.infer<typeof UploadWatermarkSchema>;
