import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PasswordService } from "./password.service";
import { TotpService } from "./totp.service";
import { TokenService } from "./token.service";
import { WebAuthnService } from "./webauthn.service";
import type { AuthenticatedUser } from "./auth.types";
import { RoleName, UserStatus } from "../generated/prisma";

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export const ACCOUNT_SUSPENDED = "This account is suspended.";

export const MFA_SETUP_REQUIRED = "MFA_SETUP_REQUIRED";
export const MFA_SETUP_PENDING = "Set up an authenticator app to finish activating this account.";
export const MFA_SETUP_OVERDUE = "This account's 15 minutes to set up an authenticator app have passed. Set one up to use it again.";
export const MFA_SETUP_WINDOW_MS = 15 * 60_000;

export type StepUpMethod = "passkey" | "totp";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export type PasswordLoginResult = { mfaRequired: true; pendingToken: string } | ({ mfaRequired: false } & TokenPair);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly totp: TotpService,
    private readonly tokens: TokenService,
    private readonly webauthn: WebAuthnService,
    private readonly audit: AuditService,
  ) {}

  async loadAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: true },
    });
    return {
      id: user.id,
      email: user.email,
      roles: [...new Set(user.roles.map((r) => r.role))],
      organizationId: user.organizationId,
      steppedUp: false,
      mfaSetupRequired: user.mfaSetupRequired,
      mfaSetupDeadline: user.mfaSetupDeadline,
    };
  }

  /** Suspension is checked only once a credential has verified, so it never tells a stranger which accounts exist. */
  private async loadActiveUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } });
    if (user.status === UserStatus.SUSPENDED) throw new ForbiddenException(ACCOUNT_SUSPENDED);
    return this.loadAuthenticatedUser(userId);
  }

  private isAdminRole(roles: RoleName[]): boolean {
    return roles.some((r) => r !== RoleName.END_USER);
  }

  async register(email: string, displayName: string, ctx: RequestContext): Promise<{ userId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException("An account with this email already exists.");

    // v1 limitation (documented): no SMTP/email provider is wired up in this
    // environment, so there is no email-verification step yet — accounts are
    // created ACTIVE and must add a passkey (or password+TOTP) before any
    // privileged action. Wiring a transactional email provider is tracked as
    // a follow-up, not silently skipped.
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName,
        status: UserStatus.ACTIVE,
        roles: { create: { role: RoleName.END_USER } },
      },
    });
    await this.audit.record({
      actorId: user.id,
      action: "auth.register",
      resourceType: "User",
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { userId: user.id };
  }

  async findUserIdByEmail(email: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new BadRequestException("No account with this email.");
    return user.id;
  }

  // --- Passkey (primary) login -------------------------------------------------

  async passkeyLoginOptions(email: string) {
    const userId = await this.findUserIdByEmail(email);
    return this.webauthn.generateAuthenticationOptionsFor(userId, "authentication");
  }

  async passkeyLoginVerify(email: string, response: object, ctx: RequestContext): Promise<TokenPair> {
    const userId = await this.findUserIdByEmail(email);
    await this.webauthn.verifyAuthentication(userId, response as never, "authentication");
    return this.issueSessionFor(userId, "auth.login.passkey", ctx);
  }

  /**
   * These two endpoints are unauthenticated so a brand-new account can bootstrap its first credential
   * before it can log in at all — but that only holds while the account truly has none yet. Without this
   * check, anyone who knows an existing account's email (nothing secret) could enroll their own passkey
   * on it at any later time and sign in as that user, bypassing its real password/TOTP/passkey entirely.
   */
  private async assertNoCredentialsYet(userId: string): Promise<void> {
    const [passkeyCount, user, totp] = await Promise.all([
      this.prisma.webAuthnCredential.count({ where: { userId } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } }),
      this.prisma.totpCredential.findUnique({ where: { userId }, select: { verifiedAt: true } }),
    ]);
    if (passkeyCount > 0 || user.passwordHash || totp?.verifiedAt) {
      throw new ForbiddenException("This account already has a credential. Sign in and use step-up to add another passkey.");
    }
  }

  async passkeyRegisterOptions(userId: string, email: string, displayName: string) {
    await this.assertNoCredentialsYet(userId);
    return this.webauthn.generateRegistrationOptionsFor(userId, email, displayName);
  }

  async passkeyRegisterVerify(userId: string, response: object, deviceLabel: string | undefined, ctx: RequestContext): Promise<void> {
    await this.assertNoCredentialsYet(userId);
    await this.webauthn.verifyRegistration(userId, response as never, deviceLabel);
    await this.audit.record({
      actorId: userId,
      action: "auth.passkey.registered",
      resourceType: "WebAuthnCredential",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  // --- Password (+ TOTP) login ---------------------------------------------------
  // Policy: an account with TOTP enrolled always has to give a code. Without TOTP, a password alone signs in only an
  // account holding no admin role, or one an admin provisioned with an admin role — and that one gets a session the
  // JwtAuthGuard confines to enrolling TOTP. Roles are read fresh at every sign-in, since they change.

  async setPassword(userId: string, password: string): Promise<void> {
    const hash = await this.password.hash(password);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });
  }

  async passwordLoginStart(email: string, password: string, ctx: RequestContext): Promise<PasswordLoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });
    if (!user || !user.passwordHash) throw new UnauthorizedException("Invalid email or password.");
    const ok = await this.password.verify(user.passwordHash, password);
    if (!ok) {
      await this.audit.record({ actorId: user.id, action: "auth.login.password.failed", resourceType: "User", resourceId: user.id, ip: ctx.ip, userAgent: ctx.userAgent });
      throw new UnauthorizedException("Invalid email or password.");
    }
    if (user.status === UserStatus.SUSPENDED) throw new ForbiddenException(ACCOUNT_SUSPENDED);
    if (await this.totp.isEnrolled(user.id)) {
      return { mfaRequired: true, pendingToken: this.tokens.issuePendingMfaToken(user.id) };
    }
    if (user.mfaSetupRequired) {
      if (!user.mfaSetupDeadline) {
        await this.prisma.user.update({ where: { id: user.id }, data: { mfaSetupDeadline: new Date(Date.now() + MFA_SETUP_WINDOW_MS) } });
      }
      return { mfaRequired: false, ...(await this.issueSessionFor(user.id, "auth.login.password.mfa_setup", ctx)) };
    }
    if (this.isAdminRole(user.roles.map((r) => r.role))) {
      throw new ForbiddenException("Password login requires TOTP to be enrolled on this account. Enroll TOTP or use a passkey.");
    }
    return { mfaRequired: false, ...(await this.issueSessionFor(user.id, "auth.login.password", ctx)) };
  }

  async passwordLoginVerifyTotp(pendingToken: string, code: string, ctx: RequestContext): Promise<TokenPair> {
    const { sub: userId } = this.tokens.verifyPendingMfaToken(pendingToken);
    const ok = await this.totp.verifyCode(userId, code);
    if (!ok) {
      await this.audit.record({ actorId: userId, action: "auth.login.totp.failed", resourceType: "User", resourceId: userId, ip: ctx.ip, userAgent: ctx.userAgent });
      throw new UnauthorizedException("Invalid TOTP code.");
    }
    return this.issueSessionFor(userId, "auth.login.password_totp", ctx);
  }

  // --- Step-up (re-authentication for sensitive admin actions, spec §12) -------
  // Either second factor a user can sign in with re-authenticates them: a passkey or, for accounts without one, TOTP.

  async stepUpMethods(userId: string): Promise<{ methods: StepUpMethod[] }> {
    const [passkeys, totp] = await Promise.all([this.prisma.webAuthnCredential.count({ where: { userId } }), this.totp.isEnrolled(userId)]);
    const methods: StepUpMethod[] = [];
    if (passkeys > 0) methods.push("passkey");
    if (totp) methods.push("totp");
    return { methods };
  }

  async stepUpOptions(userId: string) {
    return this.webauthn.generateAuthenticationOptionsFor(userId, "step-up");
  }

  async stepUpVerify(userId: string, response: object, ctx: RequestContext): Promise<{ stepUpToken: string }> {
    await this.webauthn.verifyAuthentication(userId, response as never, "step-up");
    return this.issueStepUpFor(userId, "passkey", ctx);
  }

  async stepUpVerifyTotp(userId: string, code: string, ctx: RequestContext): Promise<{ stepUpToken: string }> {
    const ok = await this.totp.verifyCode(userId, code);
    if (!ok) {
      await this.audit.record({ actorId: userId, action: "auth.stepup.totp.failed", resourceType: "User", resourceId: userId, ip: ctx.ip, userAgent: ctx.userAgent });
      throw new ForbiddenException("Invalid TOTP code.");
    }
    return this.issueStepUpFor(userId, "totp", ctx);
  }

  private async issueStepUpFor(userId: string, method: StepUpMethod, ctx: RequestContext): Promise<{ stepUpToken: string }> {
    await this.audit.record({ actorId: userId, action: "auth.stepup.verified", resourceType: "User", resourceId: userId, ip: ctx.ip, userAgent: ctx.userAgent, metadata: { method } });
    return { stepUpToken: this.tokens.issueStepUpToken(userId) };
  }

  // --- Session issuance / refresh / logout -------------------------------------

  private async issueSessionFor(userId: string, auditAction: string, ctx: RequestContext): Promise<TokenPair> {
    const authUser = await this.loadActiveUser(userId);
    const accessToken = this.tokens.issueAccessToken(authUser);
    const refresh = await this.tokens.issueRefreshToken(userId, { ip: ctx.ip, userAgent: ctx.userAgent });
    await this.audit.record({ actorId: userId, action: auditAction, resourceType: "User", resourceId: userId, ip: ctx.ip, userAgent: ctx.userAgent });
    return { accessToken, refreshToken: refresh.raw, refreshTokenExpiresAt: refresh.expiresAt };
  }

  async refresh(rawRefreshToken: string, ctx: RequestContext): Promise<TokenPair> {
    const { userId, issued } = await this.tokens.rotateRefreshToken(rawRefreshToken, ctx);
    const authUser = await this.loadActiveUser(userId);
    const accessToken = this.tokens.issueAccessToken(authUser);
    return { accessToken, refreshToken: issued.raw, refreshTokenExpiresAt: issued.expiresAt };
  }

  async logout(rawRefreshToken: string | undefined, userId: string, ctx: RequestContext): Promise<void> {
    if (rawRefreshToken) await this.tokens.revokeRefreshToken(rawRefreshToken);
    await this.audit.record({ actorId: userId, action: "auth.logout", resourceType: "User", resourceId: userId, ip: ctx.ip, userAgent: ctx.userAgent });
  }

  async logoutAllSessions(userId: string, ctx: RequestContext): Promise<void> {
    await this.tokens.revokeAllSessionsForUser(userId);
    await this.audit.record({ actorId: userId, action: "auth.logout_all", resourceType: "User", resourceId: userId, ip: ctx.ip, userAgent: ctx.userAgent });
  }

  async listSessions(userId: string) {
    return this.tokens.listActiveSessions(userId);
  }

  async revokeSession(userId: string, sessionId: string, ctx: RequestContext): Promise<void> {
    await this.tokens.revokeSessionById(userId, sessionId);
    await this.audit.record({ actorId: userId, action: "auth.session.revoked", resourceType: "RefreshToken", resourceId: sessionId, ip: ctx.ip, userAgent: ctx.userAgent });
  }

  // --- TOTP enrollment passthroughs --------------------------------------------

  async totpEnrollOptions(userId: string, email: string) {
    return this.totp.beginEnrollment(userId, email);
  }

  async totpEnrollVerify(userId: string, code: string) {
    return this.totp.confirmEnrollment(userId, code);
  }
}
