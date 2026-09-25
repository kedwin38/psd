import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const solidPng = (width: number, height: number, background = "#ff00ff") => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

/**
 * The site-wide watermark: admin-only, step-up-gated mutations; a public (any authenticated user) read of the
 * current config; opacity bounds; and that replacing/removing detaches the old Asset row rather than leaving it
 * orphaned in storage.
 */
describe("Site watermark settings", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let adminToken: string;
  let stepUpToken: string;
  let memberToken: string;

  const http = () => request(app.getHttpServer());
  const upload = (token: string, stepUp: string | undefined, png: Buffer, opacity?: number) => {
    const req = http().post("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${token}`);
    if (stepUp) req.set("x-step-up-token", stepUp);
    if (opacity !== undefined) req.field("opacity", String(opacity));
    return req.attach("file", png, "watermark.png");
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);

    const admin = await prisma.user.create({
      data: { email: "settings-admin@example.com", displayName: "Settings Admin", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } },
    });
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
    stepUpToken = tokens.issueStepUpToken(admin.id);

    const member = await prisma.user.create({
      data: { email: "settings-member@example.com", displayName: "Member", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    memberToken = tokens.issueAccessToken({ id: member.id, email: member.email, roles: [RoleName.END_USER], organizationId: null });
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports no watermark until one is configured, to any authenticated user", async () => {
    const admin = await http().get("/api/v1/settings/watermark").set("Authorization", `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ watermark: null });

    const member = await http().get("/api/v1/settings/watermark").set("Authorization", `Bearer ${memberToken}`);
    expect(member.status).toBe(200);
    expect(member.body).toEqual({ watermark: null });

    expect((await http().get("/api/v1/settings/watermark")).status).toBe(401);
    expect((await http().get("/api/v1/settings/watermark/image").set("Authorization", `Bearer ${memberToken}`)).status).toBe(404);
  });

  it("refuses an end user's attempt to upload, patch or delete the watermark", async () => {
    const png = await solidPng(20, 20);
    expect((await upload(memberToken, undefined, png)).status).toBe(403);
    expect((await http().patch("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${memberToken}`).send({ opacity: 0.2 })).status).toBe(403);
    expect((await http().delete("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${memberToken}`)).status).toBe(403);
  });

  it("requires a step-up token even for a SUPER_ADMIN", async () => {
    const png = await solidPng(20, 20);
    const res = await upload(adminToken, undefined, png);
    expect(res.status).toBe(403);
    expect(await prisma.appSettings.findUnique({ where: { id: "singleton" } })).toBeNull();
  });

  it("rejects a non-PNG file even with a valid step-up token", async () => {
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).jpeg().toBuffer();
    const res = await upload(adminToken, stepUpToken, jpeg);
    expect(res.status).toBe(400);
  });

  it("rejects an opacity outside the allowed range", async () => {
    const png = await solidPng(20, 20);
    expect((await upload(adminToken, stepUpToken, png, 0.01)).status).toBe(400);
    expect((await upload(adminToken, stepUpToken, png, 0.9)).status).toBe(400);
    expect((await http().patch("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ opacity: 0.5 })).status).toBe(400);
  });

  it("uploads a watermark, serves it back to any authenticated user, and audits the change", async () => {
    const png = await solidPng(32, 32, "#00ffaa");
    const res = await upload(adminToken, stepUpToken, png, 0.2);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ opacity: 0.2, url: "/settings/watermark/image" });

    const config = await http().get("/api/v1/settings/watermark").set("Authorization", `Bearer ${memberToken}`);
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ url: "/settings/watermark/image", opacity: 0.2 });

    const image = await binary(http().get("/api/v1/settings/watermark/image").set("Authorization", `Bearer ${memberToken}`));
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(image.body as Buffer, png)).toBe(0);

    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "admin.watermark.updated" } });
    expect(audit.metadata).toMatchObject({ opacity: 0.2 });
  });

  it("adjusts opacity alone without touching the stored image", async () => {
    const before = await binary(http().get("/api/v1/settings/watermark/image").set("Authorization", `Bearer ${memberToken}`));
    const res = await http().patch("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ opacity: 0.3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opacity: 0.3, url: "/settings/watermark/image" });

    const after = await binary(http().get("/api/v1/settings/watermark/image").set("Authorization", `Bearer ${memberToken}`));
    expect(Buffer.compare(before.body as Buffer, after.body as Buffer)).toBe(0);
  });

  it("replacing the watermark detaches (and deletes) the previous Asset row", async () => {
    const settingsBefore = await prisma.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const previousAssetId = settingsBefore.watermarkAssetId!;

    const png = await solidPng(16, 16, "#123456");
    const res = await upload(adminToken, stepUpToken, png);
    expect(res.status).toBe(201);

    expect(await prisma.asset.findUnique({ where: { id: previousAssetId } })).toBeNull();
    const settingsAfter = await prisma.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(settingsAfter.watermarkAssetId).not.toBe(previousAssetId);
  });

  it("removes the watermark, detaches its Asset row, and audits the removal", async () => {
    const settingsBefore = await prisma.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const assetId = settingsBefore.watermarkAssetId!;

    const res = await http().delete("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const config = await http().get("/api/v1/settings/watermark").set("Authorization", `Bearer ${memberToken}`);
    expect(config.body).toEqual({ watermark: null });
    expect((await http().get("/api/v1/settings/watermark/image").set("Authorization", `Bearer ${memberToken}`)).status).toBe(404);
    expect(await prisma.asset.findUnique({ where: { id: assetId } })).toBeNull();

    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "admin.watermark.removed" } });
    expect(audit.metadata).toMatchObject({ previousAssetId: assetId });
  });

  it("refuses to set an opacity before any watermark is configured", async () => {
    const res = await http().patch("/api/v1/admin/settings/watermark").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ opacity: 0.2 });
    expect(res.status).toBe(400);
  });
});
