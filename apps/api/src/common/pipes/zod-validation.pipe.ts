import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Validates a request body/query/param against a zod schema (spec §12: every
 * API boundary is strictly validated server-side, never trusting the client).
 * Usage: @Body(new ZodValidationPipe(CreateCategorySchema)) body: CreateCategoryDto
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: "ValidationError",
        message: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      });
    }
    return result.data;
  }
}
