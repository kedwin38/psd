import { z } from "zod";

export const CreateExportSchema = z.object({
  projectId: z.string().uuid(),
  format: z.enum(["PNG", "JPEG", "PDF", "TIFF"]).default("PNG"),
  /** Multiplier over the template's native DPI; 1 = native (spec §13). */
  dpiScale: z.number().min(0.25).max(4).default(1),
});
export type CreateExportDto = z.infer<typeof CreateExportSchema>;
