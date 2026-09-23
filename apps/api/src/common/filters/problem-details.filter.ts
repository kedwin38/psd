import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";

/**
 * Normalizes every error response to RFC 7807 (application/problem+json),
 * per spec §9 API cross-cutting rules. Never leaks stack traces or internal
 * error details to the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = "Internal Server Error";
    let detail: string | undefined;
    let errors: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        title = exception.name;
        detail = body;
      } else if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        title = (b.error as string) ?? exception.name;
        detail = Array.isArray(b.message) ? undefined : ((b.message as string) ?? undefined);
        if (Array.isArray(b.message)) errors = b.message;
      }
    } else {
      this.logger.error("Unhandled exception", exception as Error);
    }

    response.status(status).contentType("application/problem+json").json({
      type: "about:blank",
      title,
      status,
      detail,
      ...(errors ? { errors } : {}),
    });
  }
}
