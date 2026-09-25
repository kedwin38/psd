import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import type { INestApplication } from "@nestjs/common";
import type { SceneGraph } from "@psd-studio/scene-graph";
import { createTestApp, createWorkerTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { StorageService as StorageServiceType } from "../src/storage/storage.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { StorageService } = requireDist("../dist/storage/storage.service") as { StorageService: new (...args: never[]) => StorageServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { AssetOwnerType, IngestStatus, RoleName, TemplateStatus, ExportStatus } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const solidPng = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: "#00ff00" } }).png().toBuffer();

describe("Download quota: two per new user, admin-grantable, refunded on a genuinely failed export", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let tokens: TokenServiceType;
  let templateId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    const storage = app.get(StorageService);

    const owner = await prisma.user.create({ data: { email: "dl-template-owner@example.com", displayName: "Owner", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } } });
    const category = await prisma.templateCategory.create({ data: { name: "Downloads Test" } });
    const template = await prisma.template.create({ data: { name: "Downloads Template", categoryId: category.id } });
    const psd = await storage.storeAsset({ data: Buffer.from("8BPS"), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    const layer = await storage.storeAsset({ data: await solidPng(20, 20), mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: "Bg" });
    const sceneGraph: SceneGraph = {
      formatVersion: 1,
      width: 50,
      height: 50,
      dpi: 72,
      colorMode: "rgb",
      root: [{ type: "pixel", id: "n_bg", path: "Bg", name: "Bg", visible: true, opacity: 1, blendMode: "normal", clipping: false, bounds: { left: 0, top: 0, right: 50, bottom: 50 }, imageAssetId: layer.id }],
    };
    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, createdById: owner.id, publishedAt: new Date() },
    });
    await prisma.template.update({ where: { id: template.id }, data: { status: TemplateStatus.PUBLISHED, currentVersionId: version.id } });
    templateId = template.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const newUser = async (email: string) => {
    const user = await prisma.user.create({ data: { email, displayName: email, status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const accessToken = tokens.issueAccessToken({ id: user.id, email, roles: [RoleName.END_USER], organizationId: null });
    const project = await http().post("/api/v1/projects").set("Authorization", `Bearer ${accessToken}`).send({ templateId, name: "Mine" });
    return { userId: user.id, accessToken, projectId: project.body.id as string };
  };

  it("starts a new account at 0/2, and 2 exports use up the whole allowance", async () => {
    const { userId, accessToken, projectId } = await newUser("two-downloads@example.com");
    const me0 = await http().get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(me0.body).toMatchObject({ downloadsAllowed: 2, downloadsUsed: 0 });

    const first = await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });
    expect(first.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).downloadsUsed).toBe(1);

    const second = await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });
    expect(second.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).downloadsUsed).toBe(2);
  });

  it("blocks a 3rd export with a clear, actionable message once the allowance is spent", async () => {
    const { accessToken, projectId } = await newUser("exhausted@example.com");
    for (let i = 0; i < 2; i++) expect((await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 })).status).toBe(201);

    const third = await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });
    expect(third.status).toBe(403);
    expect(third.body.detail).toBe("You've used all your downloads. Contact an admin to get more.");
  });

  it("never lets two concurrent requests both slip through the last remaining slot", async () => {
    const { userId, accessToken, projectId } = await newUser("race@example.com");
    // Spend one of the two up front, leaving exactly one slot for the concurrent pair to race over.
    await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });

    const [a, b] = await Promise.all([
      http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 }),
      http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 403]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).downloadsUsed).toBe(2);
  });

  it("lets a SUPER_ADMIN grant more downloads, additively, step-up gated", async () => {
    const { userId, accessToken, projectId } = await newUser("grantee@example.com");
    for (let i = 0; i < 2; i++) await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });

    const admin = await prisma.user.create({ data: { email: "downloads-admin@example.com", displayName: "Admin", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } } });
    const adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
    const stepUpToken = tokens.issueStepUpToken(admin.id);

    const withoutStepUp = await http().patch(`/api/v1/admin/users/${userId}/downloads`).set("Authorization", `Bearer ${adminToken}`).send({ add: 3 });
    expect(withoutStepUp.status).toBe(403);

    const granted = await http().patch(`/api/v1/admin/users/${userId}/downloads`).set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ add: 3 });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ downloadsAllowed: 5, downloadsUsed: 2 });

    const canDownloadAgain = await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });
    expect(canDownloadAgain.status).toBe(201);
  });

  it("refuses a non-admin's attempt to grant downloads", async () => {
    const { userId, accessToken } = await newUser("cant-grant-self@example.com");
    const res = await http().patch(`/api/v1/admin/users/${userId}/downloads`).set("Authorization", `Bearer ${accessToken}`).send({ add: 100 });
    expect(res.status).toBe(403);
  });

  it("refunds the download when the export ultimately fails after exhausting retries, not on a mid-retry blip", async () => {
    const { userId, accessToken, projectId } = await newUser("refund-me@example.com");

    // Corrupt this project's template version so the render worker's compositor genuinely throws (a null
    // `root` isn't iterable), rather than degrading gracefully the way a missing image asset would.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    await prisma.templateVersion.update({ where: { id: project.templateVersionId }, data: { sceneGraph: { formatVersion: 1, width: 50, height: 50, dpi: 72, colorMode: "rgb", root: null } as object } });

    const exportRes = await http().post("/api/v1/exports").set("Authorization", `Bearer ${accessToken}`).send({ projectId, format: "PNG", dpiScale: 1 });
    expect(exportRes.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).downloadsUsed).toBe(1);

    const workerApp = await createWorkerTestApp();
    try {
      const { RenderProcessorService } = requireDist("../dist/worker/render.processor");
      const processor: { onModuleInit: () => void } = workerApp.get(RenderProcessorService);
      processor.onModuleInit();

      // FAILED is transient here: with attempts:2 and a 3s backoff, the job's status bounces back to RENDERING
      // for a real second attempt before landing on FAILED for good, so an early break on the first FAILED would
      // catch it mid-retry. Only COMPLETE is unambiguously terminal; otherwise just outlast the whole retry cycle.
      let finalStatus: string = "QUEUED";
      for (let i = 0; i < 30; i++) {
        const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: exportRes.body.id } });
        finalStatus = job.status;
        if (finalStatus === ExportStatus.COMPLETE) break;
        await sleep(500);
      }
      expect(finalStatus).toBe(ExportStatus.FAILED);
      // Retries are exhausted by the time it lands on FAILED, so the refund has already landed too.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).downloadsUsed).toBe(0);
    } finally {
      await workerApp.close();
    }
  }, 60_000);
});
