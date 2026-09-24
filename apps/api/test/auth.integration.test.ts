import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";
import type { TotpService as TotpServiceType } from "../src/auth/totp.service";
import { Secret, TOTP } from "otpauth";

// Runtime classes come from the compiled dist build (see test-app.ts for why);
// these `type`-only imports just give the test file real autocomplete/checking.
const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { TotpService } = requireDist("../dist/auth/totp.service") as { TotpService: new (...args: never[]) => TotpServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

describe("Auth & RBAC integration", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an unauthenticated request to a protected route", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("allows an unauthenticated request to a @Public() route", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/categories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects registration with an invalid email via the zod validation pipe", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", displayName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]).toContain("email");
  });

  it("refuses to enroll a passkey on an account that already has a credential (account-takeover guard)", async () => {
    const prisma = app.get(PrismaService);
    const user = await prisma.user.create({
      data: { email: "already-credentialed@example.com", displayName: "Existing User", status: "ACTIVE", passwordHash: "not-a-real-hash-just-non-null" },
    });

    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/webauthn/register/options")
      .send({ email: user.email });

    expect(res.status).toBe(403);
    expect(res.body.detail ?? res.body.title).toContain("already has a credential");
  });

  it("allows passkey enrollment on a genuinely fresh account with no credentials yet", async () => {
    const prisma = app.get(PrismaService);
    const user = await prisma.user.create({
      data: { email: "brand-new@example.com", displayName: "New User", status: "ACTIVE" },
    });

    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/webauthn/register/options")
      .send({ email: user.email });

    expect(res.status).toBe(201);
    expect(res.body.challenge).toBeDefined();
  });

  it("rejects a category creation attempt from an END_USER (RBAC)", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const user = await prisma.user.create({
      data: { email: "enduser@example.com", displayName: "End User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    const accessToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });

    const res = await request(app.getHttpServer())
      .post("/api/v1/categories")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Should Not Be Created" });
    expect(res.status).toBe(403);
  });

  it("allows a SUPER_ADMIN to create a category", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const admin = await prisma.user.create({
      data: { email: "admin-rbac@example.com", displayName: "Admin", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } },
    });
    const accessToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });

    const res = await request(app.getHttpServer())
      .post("/api/v1/categories")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Certificates" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Certificates");
  });

  it("rejects a category delete without a step-up token even for a SUPER_ADMIN", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin-rbac@example.com" } });
    const category = await prisma.templateCategory.findFirstOrThrow({ where: { name: "Certificates" } });
    const accessToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/categories/${category.id}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it("accepts the delete once a valid step-up token is attached", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin-rbac@example.com" } });
    const category = await prisma.templateCategory.findFirstOrThrow({ where: { name: "Certificates" } });
    const accessToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
    const stepUpToken = tokens.issueStepUpToken(admin.id);

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/categories/${category.id}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(200);
  });

  it("doesn't take an access token as a step-up token", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin-rbac@example.com" } });
    const accessToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });

    const res = await request(app.getHttpServer()).get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`).set("x-step-up-token", accessToken);
    expect(res.body.steppedUp).toBe(false);
  });

  it("doesn't take a password-only pending-MFA token, or a step-up token, as an access token", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin-rbac@example.com" } });

    for (const token of [tokens.issuePendingMfaToken(admin.id), tokens.issueStepUpToken(admin.id)]) {
      const res = await request(app.getHttpServer()).post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
    expect(await prisma.totpCredential.count({ where: { userId: admin.id } })).toBe(0);
  });
});

describe("Step-up with an authenticator code (accounts without a passkey)", () => {
  let app: INestApplication;
  let adminId: string;
  let accessToken: string;
  let secretBase32: string;
  const http = () => request(app.getHttpServer());
  const code = () => new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate();

  beforeAll(async () => {
    app = await createTestApp();
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const totp = app.get(TotpService);
    const admin = await prisma.user.create({
      data: { email: "totp-only-admin@example.com", displayName: "TOTP Admin", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } },
    });
    adminId = admin.id;
    ({ secretBase32 } = await totp.beginEnrollment(admin.id, admin.email));
    await totp.confirmEnrollment(admin.id, code());
    accessToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
  });

  afterAll(async () => {
    await app.close();
  });

  it("offers TOTP, not a passkey, as the account's step-up method", async () => {
    const res = await http().get("/api/v1/auth/step-up/methods").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ methods: ["totp"] });
  });

  it("answers a passkey step-up attempt with a plain client error, not a session 401", async () => {
    const res = await http().post("/api/v1/auth/step-up/options").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("No passkeys registered for this account.");
  });

  it("rejects a wrong code with a 403 that doesn't ask for a new access token", async () => {
    const res = await http().post("/api/v1/auth/step-up/totp").set("Authorization", `Bearer ${accessToken}`).send({ code: "000000" });
    expect(res.status).toBe(403);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    const prisma = app.get(PrismaService);
    expect(await prisma.auditLogEntry.count({ where: { actorId: adminId, action: "auth.stepup.totp.failed" } })).toBe(1);
  });

  it("issues a step-up token for a valid code that unlocks a step-up-protected action", async () => {
    const prisma = app.get(PrismaService);
    const category = await prisma.templateCategory.create({ data: { name: "Step-up TOTP" } });

    const res = await http().post("/api/v1/auth/step-up/totp").set("Authorization", `Bearer ${accessToken}`).send({ code: code() });
    expect(res.status).toBe(201);
    const del = await http().delete(`/api/v1/categories/${category.id}`).set("Authorization", `Bearer ${accessToken}`).set("x-step-up-token", res.body.stepUpToken);
    expect(del.status).toBe(200);
    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { actorId: adminId, action: "auth.stepup.verified" } });
    expect(audit.metadata).toEqual({ method: "totp" });
  });

  it("marks only access-token failures with a bearer challenge", async () => {
    const missing = await http().get("/api/v1/auth/me");
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    const invalid = await http().get("/api/v1/auth/me").set("Authorization", "Bearer expired");
    expect(invalid.status).toBe(401);
    expect(invalid.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
  });
});

describe("Refresh token rotation & reuse detection", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rotates a refresh token and revokes the whole family on reuse", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const user = await prisma.user.create({
      data: { email: "rotation@example.com", displayName: "Rotation", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });

    const first = await tokens.issueRefreshToken(user.id, {});
    const rotated = await tokens.rotateRefreshToken(first.raw, {});
    expect(rotated.userId).toBe(user.id);
    expect(rotated.issued.raw).not.toBe(first.raw);

    // The rotated-away token is now used a second time -> reuse detected.
    await expect(tokens.rotateRefreshToken(first.raw, {})).rejects.toThrow(/reuse detected/i);

    // Reuse detection must have burned the successor too, not just the reused one.
    await expect(tokens.rotateRefreshToken(rotated.issued.raw, {})).rejects.toThrow();
  });

  it("lets only one of several simultaneous presentations of a token through, and treats the rest as reuse", async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const user = await prisma.user.create({
      data: { email: "simultaneous@example.com", displayName: "Simultaneous", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });

    const first = await tokens.issueRefreshToken(user.id, {});
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => tokens.rotateRefreshToken(first.raw, {})));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => String(r.reason))).toEqual(Array(3).fill(expect.stringMatching(/reuse detected/i)));
    expect(await prisma.refreshToken.count({ where: { familyId: first.familyId, revokedAt: null } })).toBe(0);
  });
});

describe("Rate limiting on auth endpoints", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 429 after exceeding the login endpoint's per-IP limit", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer()).post("/api/v1/auth/login/password").send({ email: "nobody@example.com", password: "wrong-password" }),
      ),
    );
    const statuses = attempts.map((r) => r.status);
    expect(statuses).toContain(429);
  });
});
