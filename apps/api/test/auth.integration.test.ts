import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

// Runtime classes come from the compiled dist build (see test-app.ts for why);
// these `type`-only imports just give the test file real autocomplete/checking.
const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
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
