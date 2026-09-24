import { Body, Controller, Delete, Get, Param, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AuthService, type RequestContext } from "./auth.service";
import { TotpService } from "./totp.service";
import { Public } from "./decorators/public.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  EmailOnlySchema,
  PasswordLoginStartSchema,
  PasswordLoginTotpSchema,
  RegisterSchema,
  SetPasswordSchema,
  StepUpTotpSchema,
  TotpEnrollVerifySchema,
  WebAuthnLoginVerifySchema,
  WebAuthnRegisterVerifySchema,
  type EmailOnlyDto,
  type PasswordLoginStartDto,
  type PasswordLoginTotpDto,
  type RegisterDto,
  type SetPasswordDto,
  type StepUpTotpDto,
  type TotpEnrollVerifyDto,
  type WebAuthnLoginVerifyDto,
  type WebAuthnRegisterVerifyDto,
} from "./dto/auth.dto";
import type { AuthenticatedUser } from "./auth.types";
import type { TokenPair } from "./auth.service";

const REFRESH_COOKIE = "rt";
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly totp: TotpService,
  ) {}

  private ctx(req: Request): RequestContext {
    return { ip: req.ip, userAgent: req.headers["user-agent"] };
  }

  private setRefreshCookie(res: Response, pair: TokenPair): void {
    res.cookie(REFRESH_COOKIE, pair.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/v1/auth",
      expires: pair.refreshTokenExpiresAt,
    });
  }

  // --- Registration --------------------------------------------------------

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("register")
  async register(@Body(new ZodValidationPipe(RegisterSchema)) body: RegisterDto, @Req() req: Request) {
    const { userId } = await this.auth.register(body.email, body.displayName, this.ctx(req));
    return { userId };
  }

  // --- Passkey enrollment (requires an existing, just-registered account) --

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("webauthn/register/options")
  async webauthnRegisterOptions(@Body(new ZodValidationPipe(EmailOnlySchema)) body: EmailOnlyDto) {
    const userId = await this.auth.findUserIdByEmail(body.email);
    const user = await this.auth.loadAuthenticatedUser(userId);
    return this.auth.passkeyRegisterOptions(userId, user.email, user.email);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("webauthn/register/verify")
  async webauthnRegisterVerify(@Body(new ZodValidationPipe(WebAuthnRegisterVerifySchema)) body: WebAuthnRegisterVerifyDto, @Req() req: Request) {
    const userId = await this.auth.findUserIdByEmail(body.email);
    await this.auth.passkeyRegisterVerify(userId, body.response, body.deviceLabel, this.ctx(req));
    return { ok: true };
  }

  // --- Passkey login (primary) ---------------------------------------------

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("webauthn/login/options")
  async webauthnLoginOptions(@Body(new ZodValidationPipe(EmailOnlySchema)) body: EmailOnlyDto) {
    return this.auth.passkeyLoginOptions(body.email);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("webauthn/login/verify")
  async webauthnLoginVerify(@Body(new ZodValidationPipe(WebAuthnLoginVerifySchema)) body: WebAuthnLoginVerifyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const pair = await this.auth.passkeyLoginVerify(body.email, body.response, this.ctx(req));
    this.setRefreshCookie(res, pair);
    return { accessToken: pair.accessToken };
  }

  // --- Password + TOTP login (fallback) -------------------------------------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login/password")
  async passwordLoginStart(@Body(new ZodValidationPipe(PasswordLoginStartSchema)) body: PasswordLoginStartDto, @Req() req: Request) {
    return this.auth.passwordLoginStart(body.email, body.password, this.ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login/totp")
  async passwordLoginTotp(@Body(new ZodValidationPipe(PasswordLoginTotpSchema)) body: PasswordLoginTotpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const pair = await this.auth.passwordLoginVerifyTotp(body.pendingToken, body.code, this.ctx(req));
    this.setRefreshCookie(res, pair);
    return { accessToken: pair.accessToken };
  }

  @Post("password")
  async setPassword(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(SetPasswordSchema)) body: SetPasswordDto) {
    await this.auth.setPassword(user.id, body.password);
    return { ok: true };
  }

  // --- TOTP enrollment (authenticated) --------------------------------------

  @Post("totp/enroll/options")
  async totpEnrollOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.totpEnrollOptions(user.id, user.email);
  }

  @Post("totp/enroll/verify")
  async totpEnrollVerify(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(TotpEnrollVerifySchema)) body: TotpEnrollVerifyDto) {
    return this.auth.totpEnrollVerify(user.id, body.code);
  }

  // --- Step-up re-authentication (spec §12) ---------------------------------

  @Get("step-up/methods")
  async stepUpMethods(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.stepUpMethods(user.id);
  }

  @Post("step-up/options")
  async stepUpOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.stepUpOptions(user.id);
  }

  @Post("step-up/verify")
  async stepUpVerify(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(WebAuthnLoginVerifySchema.omit({ email: true }))) body: { response: object }, @Req() req: Request) {
    return this.auth.stepUpVerify(user.id, body.response, this.ctx(req));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("step-up/totp")
  async stepUpTotp(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(StepUpTotpSchema)) body: StepUpTotpDto, @Req() req: Request) {
    return this.auth.stepUpVerifyTotp(user.id, body.code, this.ctx(req));
  }

  // --- Refresh / logout / sessions ------------------------------------------

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    if (!raw) throw new UnauthorizedException("No refresh token supplied.");
    const pair = await this.auth.refresh(raw, this.ctx(req));
    this.setRefreshCookie(res, pair);
    return { accessToken: pair.accessToken };
  }

  @Post("logout")
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE];
    await this.auth.logout(raw, user.id, this.ctx(req));
    res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  }

  @Post("logout-all")
  async logoutAll(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAllSessions(user.id, this.ctx(req));
    res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  }

  @Get("sessions")
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listSessions(user.id);
  }

  @Delete("sessions/:id")
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request) {
    await this.auth.revokeSession(user.id, id, this.ctx(req));
    return { ok: true };
  }

  @Get("me")
  async me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
