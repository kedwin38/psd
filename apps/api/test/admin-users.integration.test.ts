import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";
import type { TotpService as TotpServiceType } from "../src/auth/totp.service";
import type { AuthService as AuthServiceType } from "../src/auth/auth.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { TotpService } = requireDist("../dist/auth/totp.service") as { TotpService: new (...args: never[]) => TotpServiceType };
const { AuthService } = requireDist("../dist/auth/auth.service") as { AuthService: new (...args: never[]) => AuthServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const PASSWORD = "member-password-not-secret";

describe("Admin user management", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let tokens: TokenServiceType;
  let adminId: string;
  let adminToken: string;
  let stepUpToken: string;
  let member: { id: string; email: string; secretBase32: string };
  const http = () => request(app.getHttpServer());
  const code = () => new TOTP({ secret: Secret.fromBase32(member.secretBase32) }).generate();
  const setStatus = (id: string, status: string) =>
    http().patch(`/api/v1/admin/users/${id}/status`).set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ status });
  const memberAccessToken = () => tokens.issueAccessToken({ id: member.id, email: member.email, roles: [RoleName.END_USER], organizationId: null });

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const admin = await prisma.user.create({
      data: { email: "users-admin@example.com", displayName: "Users Admin", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } },
    });
    adminId = admin.id;
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
    stepUpToken = tokens.issueStepUpToken(admin.id);

    const user = await prisma.user.create({
      data: { email: "member@example.com", displayName: "Member", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    await app.get(AuthService).setPassword(user.id, PASSWORD, true);
    const totp = app.get(TotpService);
    const { secretBase32 } = await totp.beginEnrollment(user.id, user.email);
    member = { id: user.id, email: user.email, secretBase32 };
    await totp.confirmEnrollment(user.id, code());
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists users without any credential material", async () => {
    const res = await http().get("/api/v1/admin/users").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const listed = res.body.find((u: { id: string }) => u.id === member.id);
    expect(Object.keys(listed).sort()).toEqual([
      "createdAt",
      "displayName",
      "downloadsAllowed",
      "downloadsUsed",
      "email",
      "id",
      "mfaEnrolled",
      "mfaSetupRequired",
      "roles",
      "status",
    ]);
    expect(listed).toMatchObject({ email: member.email, displayName: "Member", status: "ACTIVE", mfaEnrolled: true, mfaSetupRequired: false, roles: [{ role: "END_USER" }] });
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("$argon2");
  });

  it("keeps the user list and status changes to SUPER_ADMINs", async () => {
    const list = await http().get("/api/v1/admin/users").set("Authorization", `Bearer ${memberAccessToken()}`);
    expect(list.status).toBe(403);
    const patch = await http()
      .patch(`/api/v1/admin/users/${adminId}/status`)
      .set("Authorization", `Bearer ${memberAccessToken()}`)
      .set("x-step-up-token", tokens.issueStepUpToken(member.id))
      .send({ status: "SUSPENDED" });
    expect(patch.status).toBe(403);
  });

  it("requires a step-up token to change a user's status", async () => {
    const res = await http().patch(`/api/v1/admin/users/${member.id}/status`).set("Authorization", `Bearer ${adminToken}`).send({ status: "SUSPENDED" });
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).status).toBe("ACTIVE");
  });

  it("validates the requested status", async () => {
    for (const status of ["PENDING_VERIFICATION", "BANNED", undefined]) {
      const res = await setStatus(member.id, status as string);
      expect(res.status).toBe(400);
    }
  });

  it("refuses to let an admin suspend their own account", async () => {
    const res = await setStatus(adminId, "SUSPENDED");
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("You cannot change the status of your own account.");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).status).toBe("ACTIVE");
  });

  it("answers an unknown user with a 404", async () => {
    const res = await setStatus("00000000-0000-4000-8000-000000000000", "SUSPENDED");
    expect(res.status).toBe(404);
  });

  it("suspends a user, ends their sessions and records who did it", async () => {
    const session = await tokens.issueRefreshToken(member.id, {});
    const before = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${memberAccessToken()}`);
    expect(before.status).toBe(200);

    const res = await setStatus(member.id, "SUSPENDED");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: member.id, status: "SUSPENDED" });
    expect(res.body.passwordHash).toBeUndefined();

    expect(await prisma.refreshToken.count({ where: { userId: member.id, revokedAt: null } })).toBe(0);
    const refresh = await http().post("/api/v1/auth/refresh").send({ refreshToken: session.raw });
    expect(refresh.status).toBe(401);

    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "admin.user.status_changed", resourceId: member.id } });
    expect(audit.actorId).toBe(adminId);
    expect(audit.metadata).toEqual({ from: "ACTIVE", to: "SUSPENDED" });
  });

  it("rejects a suspended user's still-unexpired access token with a bearer challenge", async () => {
    const res = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${memberAccessToken()}`);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    expect(res.body.detail).toBe("This account is suspended.");
  });

  it("won't mint a new access token for a suspended user from a refresh token", async () => {
    const session = await tokens.issueRefreshToken(member.id, {});
    const res = await http().post("/api/v1/auth/refresh").send({ refreshToken: session.raw });
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe("This account is suspended.");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("refuses a suspended user's password login, but only once the password checks out", async () => {
    const wrong = await http().post("/api/v1/auth/login/password").send({ email: member.email, password: "not-the-password" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.detail).toBe("Invalid email or password.");

    const right = await http().post("/api/v1/auth/login/password").send({ email: member.email, password: PASSWORD });
    expect(right.status).toBe(403);
    expect(right.body.detail).toBe("This account is suspended.");
    expect(right.body.pendingToken).toBeUndefined();
  });

  it("refuses the second login step for a user suspended after passing the first", async () => {
    const pendingToken = tokens.issuePendingMfaToken(member.id);
    const res = await http().post("/api/v1/auth/login/totp").send({ pendingToken, code: code() });
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe("This account is suspended.");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("reactivates a user so they can sign in again", async () => {
    const res = await setStatus(member.id, "ACTIVE");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");

    const start = await http().post("/api/v1/auth/login/password").send({ email: member.email, password: PASSWORD });
    expect(start.status).toBe(201);
    const finish = await http().post("/api/v1/auth/login/totp").send({ pendingToken: start.body.pendingToken, code: code() });
    expect(finish.status).toBe(201);
    const me = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${finish.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(member.id);
  });
});
