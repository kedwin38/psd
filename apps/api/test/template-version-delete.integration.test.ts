import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { SceneGraph } from "@psd-studio/scene-graph";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { StorageService as StorageServiceType } from "../src/storage/storage.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { StorageService } = requireDist("../dist/storage/storage.service") as { StorageService: new (...args: never[]) => StorageServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { AssetOwnerType, IngestStatus, RoleName, TemplateStatus } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

describe("Admin deletes a previous template version", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let storage: StorageServiceType;
  let adminToken: string;
  let stepUpToken: string;
  let templateId: string;
  let v1Id: string;
  let v1AssetKey: string;
  let v2Id: string;
  const http = () => request(app.getHttpServer());

  const sceneGraph: SceneGraph = { formatVersion: 1, width: 10, height: 10, dpi: 72, colorMode: "rgb", root: [] };

  const makeVersion = async (versionNo: number) => {
    const psd = await storage.storeAsset({ data: Buffer.from(`8BPSv${versionNo}`), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: `v${versionNo}.psd` });
    const version = await prisma.templateVersion.create({
      data: { templateId, versionNo, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, publishedAt: new Date() },
    });
    return { id: version.id, assetKey: psd.storageKey };
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    const tokens = app.get(TokenService);

    const admin = await prisma.user.create({ data: { email: "version-admin@example.com", displayName: "Admin", status: "ACTIVE", mfaEnrolled: true, roles: { create: { role: RoleName.SUPER_ADMIN } } } });
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
    stepUpToken = tokens.issueStepUpToken(admin.id);

    const category = await prisma.templateCategory.create({ data: { name: "Version Delete Test" } });
    const template = await prisma.template.create({ data: { name: "Versioned Template", categoryId: category.id } });
    templateId = template.id;

    const v1 = await makeVersion(1);
    v1Id = v1.id;
    v1AssetKey = v1.assetKey;
    const v2 = await makeVersion(2);
    v2Id = v2.id;
    await prisma.template.update({ where: { id: templateId }, data: { currentVersionId: v2Id, status: TemplateStatus.PUBLISHED } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses without a step-up token, even for a SUPER_ADMIN", async () => {
    const res = await http().delete(`/api/v1/templates/${templateId}/versions/${v1Id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it("refuses to delete the current published version", async () => {
    const res = await http().delete(`/api/v1/templates/${templateId}/versions/${v2Id}`).set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("current published version");
  });

  it("refuses to delete a version a project still points at", async () => {
    const user = await prisma.user.create({ data: { email: "version-project-user@example.com", displayName: "User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    await prisma.project.create({ data: { userId: user.id, templateId, templateVersionId: v1Id, name: "Pinned to v1" } });

    const res = await http().delete(`/api/v1/templates/${templateId}/versions/${v1Id}`).set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("1 project(s)");

    await prisma.project.deleteMany({ where: { templateVersionId: v1Id } });
  });

  it("deletes an unused, non-current version and cleans up its stored PSD bytes", async () => {
    await expect(storage.getAssetBytes(v1AssetKey)).resolves.toBeInstanceOf(Buffer);

    const res = await http().delete(`/api/v1/templates/${templateId}/versions/${v1Id}`).set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(200);

    expect(await prisma.templateVersion.findUnique({ where: { id: v1Id } })).toBeNull();
    await expect(storage.getAssetBytes(v1AssetKey)).rejects.toBeTruthy();

    const audited = await prisma.auditLogEntry.findFirst({ where: { action: "template.version.deleted", resourceId: v1Id } });
    expect(audited).toBeTruthy();
  });

  it("404s for a version that doesn't belong to the given template", async () => {
    const otherCategory = await prisma.templateCategory.create({ data: { name: "Other Category" } });
    const otherTemplate = await prisma.template.create({ data: { name: "Other Template", categoryId: otherCategory.id } });
    const res = await http().delete(`/api/v1/templates/${otherTemplate.id}/versions/${v2Id}`).set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(404);
  });
});
