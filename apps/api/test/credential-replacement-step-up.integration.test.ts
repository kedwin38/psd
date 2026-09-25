import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const PASSWORD = "original-password-not-secret";

/**
 * A leaked/stolen access token must not be able to silently replace an existing password or TOTP
 * secret and keep permanent access — that requires step-up re-authentication. First-time password
 * set / TOTP enrollment (no existing credential yet) must keep working without step-up, since a
 * brand-new account has no passkey/TOTP to step up with in the first place.
 */
describe("Replacing an existing password or TOTP secret requires step-up", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let tokens: TokenServiceType;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets a brand-new account set its first password with no step-up token", async () => {
    const user = await prisma.user.create({
      data: { email: "first-password@example.com", displayName: "First Password", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });

    const res = await http().post("/api/v1/auth/password").set("Authorization", `Bearer ${accessToken}`).send({ password: PASSWORD });
    expect(res.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).not.toBeNull();
  });

  it("refuses to overwrite an existing password without a step-up token, even with a valid access token", async () => {
    const user = await prisma.user.create({
      data: { email: "existing-password@example.com", displayName: "Existing Password", status: "ACTIVE", passwordHash: "already-set", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });

    const res = await http().post("/api/v1/auth/password").set("Authorization", `Bearer ${accessToken}`).send({ password: "attacker-chosen-password" });
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe("already-set");
  });

  it("allows overwriting an existing password with a valid step-up token", async () => {
    const user = await prisma.user.create({
      data: { email: "step-up-password@example.com", displayName: "Step Up Password", status: "ACTIVE", passwordHash: "already-set", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });
    const stepUpToken = tokens.issueStepUpToken(user.id);

    const res = await http().post("/api/v1/auth/password").set("Authorization", `Bearer ${accessToken}`).set("x-step-up-token", stepUpToken).send({ password: "new-legit-password" });
    expect(res.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).not.toBe("already-set");
  });

  it("lets a brand-new account enroll TOTP for the first time with no step-up token", async () => {
    const user = await prisma.user.create({
      data: { email: "first-totp@example.com", displayName: "First TOTP", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });

    const options = await http().post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${accessToken}`);
    expect(options.status).toBe(201);
    const totp = new TOTP({ secret: Secret.fromBase32(options.body.secretBase32) });
    const verify = await http().post("/api/v1/auth/totp/enroll/verify").set("Authorization", `Bearer ${accessToken}`).send({ code: totp.generate() });
    expect(verify.status).toBe(201);
  });

  it("refuses to replace an already-verified TOTP secret without a step-up token", async () => {
    const user = await prisma.user.create({
      data: { email: "existing-totp@example.com", displayName: "Existing TOTP", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });
    const stepUpToken = tokens.issueStepUpToken(user.id);

    const firstOptions = await http().post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${accessToken}`).set("x-step-up-token", stepUpToken);
    const firstSecret = firstOptions.body.secretBase32 as string;
    const firstVerify = await http()
      .post("/api/v1/auth/totp/enroll/verify")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("x-step-up-token", stepUpToken)
      .send({ code: new TOTP({ secret: Secret.fromBase32(firstSecret) }).generate() });
    expect(firstVerify.status).toBe(201);

    // No step-up token this time: the account already has a verified TOTP secret.
    const replaceOptions = await http().post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${accessToken}`);
    expect(replaceOptions.status).toBe(403);

    // The original secret must still be intact and usable — beginEnrollment must never have run.
    const stillWorks = await http()
      .post("/api/v1/auth/totp/enroll/verify")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("x-step-up-token", stepUpToken)
      .send({ code: new TOTP({ secret: Secret.fromBase32(firstSecret) }).generate() });
    // Re-verifying with the same still-valid secret and a step-up token succeeds again (idempotent re-confirm).
    expect(stillWorks.status).toBe(201);
  });

  it("allows replacing an already-verified TOTP secret with a valid step-up token", async () => {
    const user = await prisma.user.create({
      data: { email: "step-up-totp@example.com", displayName: "Step Up TOTP", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });
    const stepUpToken = tokens.issueStepUpToken(user.id);

    const firstOptions = await http().post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${accessToken}`).set("x-step-up-token", stepUpToken);
    await http()
      .post("/api/v1/auth/totp/enroll/verify")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("x-step-up-token", stepUpToken)
      .send({ code: new TOTP({ secret: Secret.fromBase32(firstOptions.body.secretBase32) }).generate() });

    const secondStepUp = tokens.issueStepUpToken(user.id);
    const secondOptions = await http().post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${accessToken}`).set("x-step-up-token", secondStepUp);
    expect(secondOptions.status).toBe(201);
    expect(secondOptions.body.secretBase32).not.toBe(firstOptions.body.secretBase32);

    const secondVerify = await http()
      .post("/api/v1/auth/totp/enroll/verify")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("x-step-up-token", secondStepUp)
      .send({ code: new TOTP({ secret: Secret.fromBase32(secondOptions.body.secretBase32) }).generate() });
    expect(secondVerify.status).toBe(201);
  });
});
