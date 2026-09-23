import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { TokenService } from "../token.service";
import type { AuthenticatedUser } from "../auth.types";

/**
 * Global guard: every route requires a valid access token unless marked
 * @Public(). Populates request.user for downstream guards/decorators.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest();

    const header = request.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException("Missing access token.");
    }

    const claims = this.tokens.verifyAccessToken(token);
    const user: AuthenticatedUser = {
      id: claims.sub,
      email: claims.email,
      roles: claims.roles,
      organizationId: claims.organizationId,
      steppedUp: false,
    };

    const stepUpHeader = request.headers["x-step-up-token"];
    if (typeof stepUpHeader === "string") {
      try {
        const stepUpClaims = this.tokens.verifyStepUpToken(stepUpHeader);
        user.steppedUp = stepUpClaims.sub === user.id;
      } catch {
        user.steppedUp = false;
      }
    }

    request.user = user;
    return true;
  }
}
