import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";
import type { AuthService as AuthServiceType } from "../src/auth/auth.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { AuthService } = requireDist("../dist/auth/auth.service") as { AuthService: new (...args: never[]) => AuthServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const PASSWORD = "admin-chosen-password-not-secret";
const MFA_SETUP_PENDING = "Set up an authenticator app to finish activating this account.";
const MFA_SETUP_OVERDUE = "This account's 15 minutes to set up an authenticator app have passed. Set one up to use it again.";

/** A SUPER_ADMIN session with a fresh step-up, as the Users page holds one when it creates an account. */
async function superAdmin(app: INestApplication, email: string) {
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);
  const admin = await prisma.user.create({ data: { email, displayName: "Super", status: "ACTIVE", mfaEnrolled: true, roles: { create: { role: RoleName.SUPER_ADMIN } } } });
  return {
    id: admin.id,
    accessToken: tokens.issueAccessToken({ id: admin.id, email, roles: [RoleName.SUPER_ADMIN], organizationId: null }),
    stepUpToken: tokens.issueStepUpToken(admin.id),
  };
}

const refreshCookie = (res: request.Response) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("rt="));

describe("POST /admin/users", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let admin: Awaited<ReturnType<typeof superAdmin>>;
  const http = () => request(app.getHttpServer());
  const create = (body: object, stepUpToken: string | null = admin.stepUpToken, accessToken = admin.accessToken) => {
    const req = http().post("/api/v1/admin/users").set("Authorization", `Bearer ${accessToken}`);
    return (stepUpToken ? req.set("x-step-up-token", stepUpToken) : req).send(body);
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    admin = await superAdmin(app, "creator@example.com");
  });

  afterAll(async () => {
    await app.close();
  });

  it("is kept to SUPER_ADMINs", async () => {
    const tokens = app.get(TokenService);
    const member = await prisma.user.create({ data: { email: "not-an-admin@example.com", displayName: "Member", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const memberToken = tokens.issueAccessToken({ id: member.id, email: member.email, roles: [RoleName.END_USER], organizationId: null });
    const res = await create({ email: "x@example.com", displayName: "X", role: "SUPER_ADMIN", password: PASSWORD }, tokens.issueStepUpToken(member.id), memberToken);
    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email: "x@example.com" } })).toBe(0);
  });

  it("requires a step-up token", async () => {
    const res = await create({ email: "x@example.com", displayName: "X", role: "END_USER", password: PASSWORD }, null);
    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email: "x@example.com" } })).toBe(0);
  });

  it("validates the email, name, role and a 12+ character password", async () => {
    const valid = { email: "x@example.com", displayName: "X", role: "END_USER", password: PASSWORD };
    for (const body of [
      { ...valid, email: "nope" },
      { ...valid, displayName: "  " },
      { ...valid, role: "OWNER" },
      { ...valid, password: "short" },
      { email: valid.email, displayName: "X", role: "END_USER" },
    ]) {
      expect((await create(body)).status).toBe(400);
    }
  });

  it("creates an active account with the chosen role and records who did it, without leaking the password", async () => {
    const res = await create({ email: "new-member@example.com", displayName: "New Member", role: "END_USER", password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "new-member@example.com", displayName: "New Member", status: "ACTIVE", mfaEnrolled: false, mfaSetupRequired: false, roles: [{ role: "END_USER" }] });
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain("$argon2");

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "admin.user.created", resourceId: res.body.id } });
    expect(audit.actorId).toBe(admin.id);
    expect(audit.metadata).toEqual({ role: "END_USER" });
  });

  it("marks an account created with an admin role as owing a TOTP enrollment, with no deadline until it signs in", async () => {
    const res = await create({ email: "new-auditor@example.com", displayName: "New Auditor", role: "AUDITOR", password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mfaSetupRequired: true, roles: [{ role: "AUDITOR" }] });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: res.body.id } })).mfaSetupDeadline).toBeNull();
  });

  it("refuses an email that already has an account", async () => {
    const res = await create({ email: "new-member@example.com", displayName: "Again", role: "END_USER", password: PASSWORD });
    expect(res.status).toBe(409);
    expect(await prisma.user.count({ where: { email: "new-member@example.com" } })).toBe(1);
  });
});

describe("Password-only sign-in for accounts without an admin role", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let admin: Awaited<ReturnType<typeof superAdmin>>;
  const http = () => request(app.getHttpServer());
  const login = (email: string, password: string) => http().post("/api/v1/auth/login/password").send({ email, password });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await superAdmin(app, "creator-2@example.com");
  });

  afterAll(async () => {
    await app.close();
  });

  it("signs an admin-created END_USER straight in with the password the admin set, and still refuses a wrong one", async () => {
    const created = await http()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .set("x-step-up-token", admin.stepUpToken)
      .send({ email: "handed-over@example.com", displayName: "Handed Over", role: "END_USER", password: PASSWORD });
    expect(created.status).toBe(201);

    const wrong = await login("handed-over@example.com", "not-the-admin-set-password");
    expect(wrong.status).toBe(401);
    expect(wrong.body.accessToken).toBeUndefined();
    expect(refreshCookie(wrong)).toBeUndefined();

    const res = await login("handed-over@example.com", PASSWORD);
    expect(res.status).toBe(201);
    expect(res.body.mfaRequired).toBe(false);
    expect(res.body.pendingToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(refreshCookie(res)).toMatch(/HttpOnly/);

    const me = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: created.body.id, roles: ["END_USER"], mfaSetupRequired: false, mfaSetupDeadline: null });
    const projects = await http().get("/api/v1/projects").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(projects.status).toBe(200);

    const refreshed = await http().post("/api/v1/auth/refresh").set("Cookie", refreshCookie(res)!.split(";")[0]!);
    expect(refreshed.status).toBe(201);
    expect(await prisma.auditLogEntry.count({ where: { actorId: created.body.id, action: "auth.login.password" } })).toBe(1);
  });

  it("signs a self-registered END_USER in with a password alone once they've set one", async () => {
    const reg = await http().post("/api/v1/auth/register").send({ email: "self-signup@example.com", displayName: "Self Signup" });
    expect(reg.status).toBe(201);
    await app.get(AuthService).setPassword(reg.body.userId, PASSWORD, true);

    const res = await login("self-signup@example.com", PASSWORD);
    expect(res.status).toBe(201);
    expect(res.body.mfaRequired).toBe(false);
    const me = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.body).toMatchObject({ id: reg.body.userId, roles: ["END_USER"] });
  });

  it("still asks an admin-role account without TOTP for it, and hands out nothing", async () => {
    const tokens = app.get(TokenService);
    const legacy = await prisma.user.create({
      data: { email: "legacy-admin@example.com", displayName: "Legacy", status: "ACTIVE", roles: { create: [{ role: RoleName.END_USER }, { role: RoleName.CONTENT_ADMIN }] } },
    });
    await app.get(AuthService).setPassword(legacy.id, PASSWORD, true);

    const res = await login(legacy.email, PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe("Password login requires TOTP to be enrolled on this account. Enroll TOTP or use a passkey.");
    expect(res.body.accessToken).toBeUndefined();
    expect(refreshCookie(res)).toBeUndefined();
    expect(await tokens.listActiveSessions(legacy.id)).toHaveLength(0);
  });

  it("re-reads roles at sign-in: an END_USER given an admin role loses password-only access and is held to TOTP enrollment", async () => {
    const tokens = app.get(TokenService);
    const member = await prisma.user.findUniqueOrThrow({ where: { email: "handed-over@example.com" } });
    const memberToken = tokens.issueAccessToken({ id: member.id, email: member.email, roles: [RoleName.END_USER], organizationId: null });

    const granted = await http()
      .post(`/api/v1/admin/users/${member.id}/roles`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .set("x-step-up-token", admin.stepUpToken)
      .send({ role: "CONTENT_ADMIN" });
    expect(granted.status).toBe(201);

    // The session it already had, from a password alone, stops at once — not when its token next refreshes.
    const blocked = await http().get("/api/v1/projects").set("Authorization", `Bearer ${memberToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("MFA_SETUP_REQUIRED");

    const res = await login(member.email, PASSWORD);
    expect(res.status).toBe(201);
    const me = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.body).toMatchObject({ roles: expect.arrayContaining(["CONTENT_ADMIN"]), mfaSetupRequired: true });
    const adminRoute = await http().get("/api/v1/templates/admin/all").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(adminRoute.status).toBe(403);
    expect(adminRoute.body.code).toBe("MFA_SETUP_REQUIRED");

    const assignment = await prisma.userRoleAssignment.findFirstOrThrow({ where: { userId: member.id, role: RoleName.CONTENT_ADMIN } });
    const revoked = await http().delete(`/api/v1/admin/roles/${assignment.id}`).set("Authorization", `Bearer ${admin.accessToken}`).set("x-step-up-token", admin.stepUpToken);
    expect(revoked.status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ mfaSetupRequired: false, mfaSetupDeadline: null });
    const unblocked = await http().get("/api/v1/projects").set("Authorization", `Bearer ${memberToken}`);
    expect(unblocked.status).toBe(200);
  });
});

describe("An admin-created admin account's forced TOTP enrollment", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let admin: Awaited<ReturnType<typeof superAdmin>>;
  let userId: string;
  let accessToken: string;
  let secretBase32: string;
  const email = "new-super@example.com";
  const http = () => request(app.getHttpServer());
  const as = (method: "get" | "post", path: string) => http()[method](`/api/v1${path}`).set("Authorization", `Bearer ${accessToken}`);
  const code = () => new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await superAdmin(app, "creator-3@example.com");
    const created = await http()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .set("x-step-up-token", admin.stepUpToken)
      .send({ email, displayName: "New Super", role: "SUPER_ADMIN", password: PASSWORD });
    expect(created.status).toBe(201);
    userId = created.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses a wrong password exactly as for anyone else", async () => {
    const res = await http().post("/api/v1/auth/login/password").send({ email, password: "wrong-password-entirely" });
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Invalid email or password.");
    expect(refreshCookie(res)).toBeUndefined();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mfaSetupDeadline).toBeNull();
  });

  it("signs in with the admin-set password alone, and starts a 15-minute setup window at that first sign-in", async () => {
    const before = Date.now();
    const res = await http().post("/api/v1/auth/login/password").send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.mfaRequired).toBe(false);
    accessToken = res.body.accessToken;

    const { mfaSetupDeadline } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(mfaSetupDeadline!.getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(mfaSetupDeadline!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(await prisma.auditLogEntry.count({ where: { actorId: userId, action: "auth.login.password.mfa_setup" } })).toBe(1);

    const me = await as("get", "/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ roles: ["SUPER_ADMIN"], mfaSetupRequired: true, mfaSetupDeadline: mfaSetupDeadline!.toISOString() });
  });

  it("answers every route but enrollment, sign-out and /auth/me with a distinct 403 that doesn't ask for a new token", async () => {
    for (const [method, path] of [
      ["get", "/admin/users"],
      ["get", "/projects"],
      ["get", "/templates/admin/all"],
      ["get", "/auth/sessions"],
      ["get", "/auth/step-up/methods"],
      ["post", "/auth/step-up/totp"],
      ["post", "/auth/password"],
    ] as const) {
      const res = await as(method, path).send({ code: "000000", password: "another-password-here" });
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe("MFA_SETUP_REQUIRED");
      expect(res.body.detail).toBe(MFA_SETUP_PENDING);
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
    // Held even with a step-up token: the guard answers before role and step-up checks.
    const withStepUp = await as("get", "/admin/users").set("x-step-up-token", app.get(TokenService).issueStepUpToken(userId));
    expect(withStepUp.status).toBe(403);
    expect(withStepUp.body.code).toBe("MFA_SETUP_REQUIRED");
  });

  it("keeps holding the account once the deadline passes, and says so", async () => {
    await prisma.user.update({ where: { id: userId }, data: { mfaSetupDeadline: new Date(Date.now() - 1000) } });
    const res = await as("get", "/admin/users");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MFA_SETUP_REQUIRED");
    expect(res.body.detail).toBe(MFA_SETUP_OVERDUE);

    // A token minted after the deadline from the refresh cookie is held just the same.
    const session = await app.get(TokenService).issueRefreshToken(userId, {});
    const refreshed = await http().post("/api/v1/auth/refresh").send({ refreshToken: session.raw });
    expect(refreshed.status).toBe(201);
    const again = await http().get("/api/v1/admin/users").set("Authorization", `Bearer ${refreshed.body.accessToken}`);
    expect(again.status).toBe(403);
    expect(again.body.detail).toBe(MFA_SETUP_OVERDUE);
  });

  it("lifts the hold the moment TOTP enrollment completes, on the same access token", async () => {
    const options = await as("post", "/auth/totp/enroll/options");
    expect(options.status).toBe(201);
    secretBase32 = options.body.secretBase32;

    const wrong = await as("post", "/auth/totp/enroll/verify").send({ code: "000000" });
    expect(wrong.status).toBe(401);
    expect((await as("get", "/admin/users")).status).toBe(403);

    const verify = await as("post", "/auth/totp/enroll/verify").send({ code: code() });
    expect(verify.status).toBe(201);
    expect(verify.body.recoveryCodes).toHaveLength(8);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ mfaEnrolled: true, mfaSetupRequired: false, mfaSetupDeadline: null });

    const users = await as("get", "/admin/users");
    expect(users.status).toBe(200);
    expect((await as("get", "/auth/me")).body).toMatchObject({ mfaSetupRequired: false, mfaSetupDeadline: null });
    expect((await as("get", "/auth/step-up/methods")).body).toEqual({ methods: ["totp"] });
  });

  it("asks for the authenticator code at every sign-in from then on", async () => {
    const start = await http().post("/api/v1/auth/login/password").send({ email, password: PASSWORD });
    expect(start.status).toBe(201);
    expect(start.body).toEqual({ mfaRequired: true, pendingToken: expect.any(String) });
    expect(refreshCookie(start)).toBeUndefined();

    const wrong = await http().post("/api/v1/auth/login/totp").send({ pendingToken: start.body.pendingToken, code: "000000" });
    expect(wrong.status).toBe(401);
    const finish = await http().post("/api/v1/auth/login/totp").send({ pendingToken: start.body.pendingToken, code: code() });
    expect(finish.status).toBe(201);
    expect((await http().get("/api/v1/admin/users").set("Authorization", `Bearer ${finish.body.accessToken}`)).status).toBe(200);
  });

  it("lets suspension win over a pending setup", async () => {
    const other = await http()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .set("x-step-up-token", admin.stepUpToken)
      .send({ email: "suspended-before-setup@example.com", displayName: "Suspended", role: "ORG_ADMIN", password: PASSWORD });
    const login = await http().post("/api/v1/auth/login/password").send({ email: "suspended-before-setup@example.com", password: PASSWORD });
    expect(login.status).toBe(201);
    await http().patch(`/api/v1/admin/users/${other.body.id}/status`).set("Authorization", `Bearer ${admin.accessToken}`).set("x-step-up-token", admin.stepUpToken).send({ status: "SUSPENDED" });

    const enroll = await http().post("/api/v1/auth/totp/enroll/options").set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(enroll.status).toBe(401);
    expect(enroll.body.detail).toBe("This account is suspended.");
    const again = await http().post("/api/v1/auth/login/password").send({ email: "suspended-before-setup@example.com", password: PASSWORD });
    expect(again.status).toBe(403);
    expect(again.body.detail).toBe("This account is suspended.");
    expect(again.body.accessToken).toBeUndefined();
  });
});
