import { z } from "zod";

// A multipart form: `body` is validated here, the optional `file` field is handled by the controller's
// FileInterceptor. At least one of the two must end up present — checked in the controller, once both are in hand.
export const SendMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type SendMessageDto = z.infer<typeof SendMessageSchema>;
