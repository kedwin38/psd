import { randomBytes, createHash } from "node:crypto";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import ms from "./ms";
import type { Env } from "../config/env";
import type { Prisma } from "../generated/prisma";
import { PrismaService } from "../prisma/prisma.service";
import type { AccessTokenClaims, AuthenticatedUser, StepUpTokenClaims } from "./auth.types";

export interface IssuedRefreshToken {
  raw: string;
  expiresAt: Date;
  familyId: string;
}

/**
 * Short-lived JWT access tokens + rotating, DB-backed opaque refresh tokens
 * with reuse detection (spec §12): a replayed, already-rotated refresh token
 * revokes its entire family and forces re-authentication on every device
 * that shared it.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  issueAccessToken(user: Pick<AuthenticatedUser, "id" | "email" | "roles" | "organizationId">): string {
    const claims: AccessTokenClaims = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      organizationId: user.organizationId,
    };
    return this.jwt.sign(claims, {
      secret: this.config.get("JWT_ACCESS_SECRET"),
      expiresIn: this.config.get("JWT_ACCESS_TTL"),
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      return this.jwt.verify<AccessTokenClaims>(token, { secret: this.config.get("JWT_ACCESS_SECRET") });
    } catch {
      throw new UnauthorizedException("Invalid or expired access token.");
    }
  }

  /** Bridges step 1 (password) to step 2 (TOTP) of the password login fallback (spec §12). */
  issuePendingMfaToken(userId: string): string {
    return this.jwt.sign({ sub: userId, mfaPending: true }, { secret: this.config.get("JWT_ACCESS_SECRET"), expiresIn: "5m" });
  }

  verifyPendingMfaToken(token: string): { sub: string } {
    try {
      const claims = this.jwt.verify<{ sub: string; mfaPending?: boolean }>(token, { secret: this.config.get("JWT_ACCESS_SECRET") });
      if (!claims.mfaPending) throw new Error("not an mfa-pending token");
      return { sub: claims.sub };
    } catch {
      throw new UnauthorizedException("Invalid or expired MFA session; start login again.");
    }
  }

  issueStepUpToken(userId: string): string {
    const claims: StepUpTokenClaims = { sub: userId, stepUp: true };
    return this.jwt.sign(claims, { secret: this.config.get("JWT_ACCESS_SECRET"), expiresIn: "5m" });
  }

  verifyStepUpToken(token: string): StepUpTokenClaims {
    try {
      return this.jwt.verify<StepUpTokenClaims>(token, { secret: this.config.get("JWT_ACCESS_SECRET") });
    } catch {
      throw new UnauthorizedException("Invalid or expired step-up token.");
    }
  }

  private hashOpaqueToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  async issueRefreshToken(
    userId: string,
    opts: { familyId?: string; ip?: string; userAgent?: string },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<IssuedRefreshToken> {
    const raw = randomBytes(48).toString("base64url");
    const familyId = opts.familyId ?? randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + ms(this.config.get("JWT_REFRESH_TTL")));
    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: this.hashOpaqueToken(raw),
        expiresAt,
        ip: opts.ip,
        userAgent: opts.userAgent,
      },
    });
    return { raw, expiresAt, familyId };
  }

  /**
   * Verifies + rotates a refresh token in one atomic step. Throws on reuse of
   * an already-rotated token, after revoking the rest of its family.
   */
  async rotateRefreshToken(rawToken: string, opts: { ip?: string; userAgent?: string }): Promise<{ userId: string; issued: IssuedRefreshToken }> {
    const tokenHash = this.hashOpaqueToken(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) throw new UnauthorizedException("Invalid refresh token.");

    // The token is claimed with one conditional write, so of two simultaneous presentations exactly one wins and the
    // other counts as reuse. A losing claim waits on the winner's row lock until it commits, so the family it then
    // revokes already includes the winner's successor.
    const now = new Date();
    const issued =
      existing.expiresAt >= now
        ? await this.prisma.$transaction(async (tx) => {
            const claim = await tx.refreshToken.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: now } });
            if (claim.count !== 1) return null;
            const successor = await this.issueRefreshToken(existing.userId, { familyId: existing.familyId, ip: opts.ip, userAgent: opts.userAgent }, tx);
            await tx.refreshToken.update({ where: { id: existing.id }, data: { replacedByHash: this.hashOpaqueToken(successor.raw) } });
            return successor;
          })
        : null;

    if (!issued) {
      // Reuse of a token that was already rotated away (or has expired) — treat as
      // possible theft and burn the whole family so every derived session is killed.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException("Refresh token reuse detected; all sessions in this family were revoked.");
    }
    return { userId: existing.userId, issued };
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    const tokenHash = this.hashOpaqueToken(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeSessionById(userId: string, sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllSessionsForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listActiveSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { issuedAt: "desc" },
      select: { id: true, issuedAt: true, expiresAt: true, ip: true, userAgent: true },
    });
  }
}
