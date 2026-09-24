import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { TokenService } from "../token.service";
import { ACCOUNT_SUSPENDED } from "../auth.service";
import { PrismaService } from "../../prisma/prisma.service";
import { UserStatus } from "../../generated/prisma";
import type { Response } from "express";
import type { AccessTokenClaims, AuthenticatedUser } from "../auth.types";

/**
 * Global guard: every route requires a valid access token unless marked
 * @Public(). Populates request.user for downstream guards/decorators.
 * Access tokens are stateless, so the account's status is re-read on every
 * request: a suspension takes effect at once, not when the token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest();
    // The RFC 6750 challenge marks the 401s a fresh access token fixes, unlike an action's own rejections.
    const response = context.switchToHttp().getResponse<Response>();

    const header = request.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;

    if (!token) {
      if (isPublic) return true;
      response.setHeader("WWW-Authenticate", "Bearer");
      throw new UnauthorizedException("Missing access token.");
    }

    let claims: AccessTokenClaims;
    try {
      claims = this.tokens.verifyAccessToken(token);
    } catch (err) {
      response.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      throw err;
    }
    const account = await this.prisma.user.findUnique({ where: { id: claims.sub }, select: { status: true } });
    if (!account || account.status === UserStatus.SUSPENDED) {
      response.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      throw new UnauthorizedException(account ? ACCOUNT_SUSPENDED : "Invalid or expired access token.");
    }
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
