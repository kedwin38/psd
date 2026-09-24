import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
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

const solidPng = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: "#00ff00" } }).png().toBuffer();

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

/** The end-user editor's canvas reads a project's own uploads back; nobody else's, and nothing else. */
describe("Project uploads for the live editor canvas", () => {
  let app: INestApplication;
  let ownerToken: string;
  let otherToken: string;
  let projectId: string;
  let otherProjectId: string;
  let photoFieldId: string;
  let layerAssetId: string;

  const http = () => request(app.getHttpServer());
  const upload = (project: string, token: string, png: Buffer, fieldId = photoFieldId) =>
    http().post(`/api/v1/projects/${project}/uploads`).set("Authorization", `Bearer ${token}`).field("fieldId", fieldId).attach("file", png, "photo.png");

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    const prisma = app.get(PrismaService);
    const storage = app.get(StorageService);
    const tokens = app.get(TokenService);

    const owner = await prisma.user.create({ data: { email: "owner@example.com", displayName: "Owner", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const other = await prisma.user.create({ data: { email: "other@example.com", displayName: "Other", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    ownerToken = tokens.issueAccessToken({ id: owner.id, email: owner.email, roles: [RoleName.END_USER], organizationId: null });
    otherToken = tokens.issueAccessToken({ id: other.id, email: other.email, roles: [RoleName.END_USER], organizationId: null });

    const category = await prisma.templateCategory.create({ data: { name: "Uploads Test" } });
    const template = await prisma.template.create({ data: { name: "Uploads Template", categoryId: category.id } });
    const psd = await storage.storeAsset({ data: Buffer.from("8BPS"), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    layerAssetId = (await storage.storeAsset({ data: await solidPng(40, 40), mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: "Photo" })).id;
    const sceneGraph: SceneGraph = {
      formatVersion: 1,
      width: 100,
      height: 100,
      dpi: 72,
      colorMode: "rgb",
      root: [
        { type: "pixel", id: "n_photo", path: "Photo", name: "Photo", visible: true, opacity: 1, blendMode: "normal", clipping: false, bounds: { left: 0, top: 0, right: 40, bottom: 40 }, imageAssetId: layerAssetId },
      ],
    };
    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, createdById: owner.id, publishedAt: new Date() },
    });
    await prisma.template.update({ where: { id: template.id }, data: { status: TemplateStatus.PUBLISHED, currentVersionId: version.id } });
    photoFieldId = (
      await prisma.templateField.create({
        data: {
          templateVersionId: version.id,
          nodeId: "n_photo",
          layerPath: "Photo",
          fieldType: "IMAGE",
          label: "Photo",
          constraints: { kind: "image", aspectRatioW: 1, aspectRatioH: 1, aspectTolerancePct: 5, minWidthPx: 30, minHeightPx: 10, maxUploadBytes: 1_000_000, allowedMimeTypes: ["image/png", "image/jpeg"], required: false },
        },
      })
    ).id;

    const create = (token: string) => http().post("/api/v1/projects").set("Authorization", `Bearer ${token}`).send({ templateId: template.id, name: "Mine" });
    projectId = (await create(ownerToken)).body.id;
    otherProjectId = (await create(otherToken)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("binds an upload to its project and streams it back to the owner, cacheably", async () => {
    const png = await solidPng(60, 30);
    const res = await upload(projectId, ownerToken, png);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ width: 60, height: 30 });
    const asset = await app.get(PrismaService).asset.findUniqueOrThrow({ where: { id: res.body.assetId } });
    expect(asset.projectId).toBe(projectId);

    const read = await binary(http().get(`/api/v1/projects/${projectId}/assets/${res.body.assetId}`).set("Authorization", `Bearer ${ownerToken}`));
    expect(read.status).toBe(200);
    expect(read.headers["content-type"]).toContain("image/png");
    expect(read.headers["cache-control"]).toContain("immutable");
    expect(Buffer.compare(read.body as Buffer, png)).toBe(0);
  });

  it("never serves or accepts another project's upload, a template layer, or an anonymous read", async () => {
    const theirs = (await upload(otherProjectId, otherToken, await solidPng(60, 30))).body.assetId as string;
    const crop = { x: 0, y: 0, width: 1, height: 1 };

    expect((await http().get(`/api/v1/projects/${otherProjectId}/assets/${theirs}`).set("Authorization", `Bearer ${ownerToken}`)).status).toBe(403);
    expect((await http().get(`/api/v1/projects/${projectId}/assets/${theirs}`).set("Authorization", `Bearer ${ownerToken}`)).status).toBe(404);
    expect((await http().get(`/api/v1/projects/${projectId}/assets/${layerAssetId}`).set("Authorization", `Bearer ${ownerToken}`)).status).toBe(404);
    expect((await http().get(`/api/v1/projects/${otherProjectId}/assets/${theirs}`)).status).toBe(401);

    const put = await http().put(`/api/v1/projects/${projectId}/fields/${photoFieldId}`).set("Authorization", `Bearer ${ownerToken}`).send({ type: "image", imageAssetId: theirs, crop });
    expect(put.status).toBe(400);
    expect(put.body.detail).toContain("upload it to this project first");
  });

  it("saves a crop window only if it lies inside the image", async () => {
    const assetId = (await upload(projectId, ownerToken, await solidPng(80, 40))).body.assetId as string;
    const put = (crop: object) => http().put(`/api/v1/projects/${projectId}/fields/${photoFieldId}`).set("Authorization", `Bearer ${ownerToken}`).send({ type: "image", imageAssetId: assetId, crop });

    expect((await put({ x: 0.6, y: 0, width: 0.5, height: 1 })).status).toBe(400);
    expect((await put({ x: 0, y: 0, width: 0, height: 1 })).status).toBe(400);
    expect((await put({ x: 0.25, y: 0, width: 0.5, height: 1 })).status).toBe(200);

    const project = await http().get(`/api/v1/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(project.body.fieldValues[0].value).toEqual({ type: "image", imageAssetId: assetId, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } });
  });

  it("checks minimum dimensions after EXIF orientation, as every renderer draws the photo upright", async () => {
    // Stored 40x20 but tagged "rotate 90°": it displays 20 wide, under the field's 30px minimum.
    const rotated = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ff0000" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const res = await upload(projectId, ownerToken, rotated);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("at least 30x10px");
  });
});
