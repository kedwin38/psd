import { z } from "zod";

export const CreateIdPhotoJobSchema = z.object({
  standard: z.enum(["US_PASSPORT", "ICAO"]),
});
export type CreateIdPhotoJobDto = z.infer<typeof CreateIdPhotoJobSchema>;
