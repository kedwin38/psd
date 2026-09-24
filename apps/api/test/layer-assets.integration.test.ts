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
const { AssetOwnerType, IngestStatus, RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const LAYER_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

const solidPng = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: "#00ff00" } }).png().toBuffer();

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

describe("Per-layer assets and node updates for the browser compositor", () => {
  let app: INestApplication;
  let base: string;
  let adminToken: string;
  let endUserToken: string;
  let layerAssetId: string;
  let foreignAssetId: string;
  let versionId: string;
  let templateId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    const prisma = app.get(PrismaService);
    const storage = app.get(StorageService);
    const tokens = app.get(TokenService);

    const admin = await prisma.user.create({
      data: { email: "layers-admin@example.com", displayName: "Admin", status: "ACTIVE", roles: { create: { role: RoleName.CONTENT_ADMIN } } },
    });
    const endUser = await prisma.user.create({
      data: { email: "layers-user@example.com", displayName: "User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.CONTENT_ADMIN], organizationId: null });
    endUserToken = tokens.issueAccessToken({ id: endUser.id, email: endUser.email, roles: [RoleName.END_USER], organizationId: null });

    const category = await prisma.templateCategory.create({ data: { name: "Layers Test" } });
    const template = await prisma.template.create({ data: { name: "Layers Template", categoryId: category.id } });
    const psd = await storage.storeAsset({ data: Buffer.from("8BPS"), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    layerAssetId = (await storage.storeAsset({ data: LAYER_PNG, mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: "Photo" })).id;
    foreignAssetId = (await storage.storeAsset({ data: LAYER_PNG, mimeType: "image/png", ownerType: AssetOwnerType.USER_UPLOAD, hint: "upload" })).id;

    const sceneGraph: SceneGraph = {
      formatVersion: 1,
      width: 100,
      height: 100,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "group",
          id: "n_group",
          path: "Card",
          name: "Card",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          isPassThrough: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          children: [
            {
              type: "pixel",
              id: "n_photo",
              path: "Card/Photo",
              name: "Photo",
              visible: true,
              opacity: 1,
              blendMode: "normal",
              clipping: false,
              bounds: { left: 0, top: 0, right: 1, bottom: 1 },
              imageAssetId: layerAssetId,
            },
            {
              type: "pixel",
              id: "n_banner",
              path: "Card/Banner",
              name: "Banner",
              visible: true,
              opacity: 1,
              blendMode: "normal",
              clipping: false,
              bounds: { left: 10, top: 10, right: 60, bottom: 30 },
              imageAssetId: layerAssetId,
            },
            {
              type: "text",
              id: "n_title",
              path: "Card/Title",
              name: "Title",
              visible: true,
              opacity: 1,
              blendMode: "normal",
              clipping: false,
              bounds: { left: 0, top: 50, right: 100, bottom: 70 },
              runs: [{ text: "Hello", fontName: "ArialMT", fontSize: 16, color: { r: 0, g: 0, b: 0, a: 1 } }],
              alignment: "left",
              boxMode: "point",
            },
          ],
        },
      ],
    };
    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, createdById: admin.id },
    });
    versionId = version.id;
    templateId = template.id;
    base = `/api/v1/templates/${template.id}/versions/${version.id}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("streams a layer raster referenced by the version's scene graph, cacheably", async () => {
    const res = await request(app.getHttpServer())
      .get(`${base}/layer-assets/${layerAssetId}`)
      .set("Authorization", `Bearer ${endUserToken}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(Buffer.compare(res.body as Buffer, LAYER_PNG)).toBe(0);
  });

  it("refuses assets the scene graph doesn't reference, even if they exist", async () => {
    const res = await request(app.getHttpServer()).get(`${base}/layer-assets/${foreignAssetId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("requires authentication for layer assets", async () => {
    const res = await request(app.getHttpServer()).get(`${base}/layer-assets/${layerAssetId}`);
    expect(res.status).toBe(401);
  });

  it("lets an admin lock a nested node and persists it in the scene graph", async () => {
    const res = await request(app.getHttpServer())
      .patch(`${base}/nodes/n_photo`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ locked: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "n_photo", locked: true, imageAssetId: layerAssetId });

    const version = await app.get(PrismaService).templateVersion.findUniqueOrThrow({ where: { id: versionId } });
    const graph = version.sceneGraph as unknown as SceneGraph;
    const group = graph.root[0]!;
    expect(group.type === "group" && group.children[0]!.locked).toBe(true);
  });

  it("rejects node updates from end users, unknown nodes, and malformed bodies", async () => {
    const server = app.getHttpServer();
    expect((await request(server).patch(`${base}/nodes/n_photo`).set("Authorization", `Bearer ${endUserToken}`).send({ locked: false })).status).toBe(403);
    expect((await request(server).patch(`${base}/nodes/n_missing`).set("Authorization", `Bearer ${adminToken}`).send({ locked: false })).status).toBe(404);
    expect((await request(server).patch(`${base}/nodes/n_photo`).set("Authorization", `Bearer ${adminToken}`).send({ locked: "yes" })).status).toBe(400);
  });

  it("replaces a layer's raster with a cover-fitted PNG, serves it, and stops serving the old one", async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post(`${base}/nodes/n_banner/image`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", await solidPng(120, 30), { filename: "art.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "n_banner", previousImageAssetId: layerAssetId, width: 50, height: 20 });
    const newAssetId = res.body.imageAssetId as string;
    expect(newAssetId).not.toBe(layerAssetId);

    const served = await binary(request(server).get(`${base}/layer-assets/${newAssetId}`).set("Authorization", `Bearer ${adminToken}`));
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");
    const meta = await sharp(served.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([50, 20]);

    // n_photo still references the original asset, so it stays servable.
    expect((await request(server).get(`${base}/layer-assets/${layerAssetId}`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);

    const audit = await app.get(PrismaService).auditLogEntry.findFirst({ where: { action: "template.node.image_replaced", resourceId: versionId } });
    expect(audit?.metadata).toMatchObject({ templateId, nodeId: "n_banner", imageAssetId: newAssetId, previousImageAssetId: layerAssetId });

    // Undo path: re-point the node at its previous raster.
    const undo = await request(server).patch(`${base}/nodes/n_banner`).set("Authorization", `Bearer ${adminToken}`).send({ imageAssetId: layerAssetId });
    expect(undo.status).toBe(200);
    expect(undo.body).toEqual({ id: "n_banner", locked: false, imageAssetId: layerAssetId });
    expect((await request(server).get(`${base}/layer-assets/${newAssetId}`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(404);
  });

  it("validates replacement images by content, not by declared type, and refuses upscaling", async () => {
    const server = app.getHttpServer();
    const post = (nodeId: string, data: Buffer, contentType = "image/png") =>
      request(server).post(`${base}/nodes/${nodeId}/image`).set("Authorization", `Bearer ${adminToken}`).attach("file", data, { filename: "x.png", contentType });

    const spoofed = await post("n_banner", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    expect(spoofed.status).toBe(400);
    expect(spoofed.body.detail).toMatch(/unrecognized image file type/i);

    const tooSmall = await post("n_banner", await solidPng(40, 40));
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.detail).toMatch(/at least 50x20px/);

    const textLayer = await post("n_title", await solidPng(200, 200));
    expect(textLayer.status).toBe(400);
    expect(textLayer.body.detail).toMatch(/text layer/);

    expect((await post("n_missing", await solidPng(10, 10))).status).toBe(404);
    expect((await request(server).post(`${base}/nodes/n_banner/image`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(400);
    const endUser = await request(server)
      .post(`${base}/nodes/n_banner/image`)
      .set("Authorization", `Bearer ${endUserToken}`)
      .attach("file", await solidPng(120, 30), { filename: "x.png", contentType: "image/png" });
    expect(endUser.status).toBe(403);
  });

  it("only re-points layers at template layer rasters", async () => {
    const server = app.getHttpServer();
    const patch = (nodeId: string, body: object) => request(server).patch(`${base}/nodes/${nodeId}`).set("Authorization", `Bearer ${adminToken}`).send(body);
    expect((await patch("n_banner", { imageAssetId: foreignAssetId })).status).toBe(400);
    expect((await patch("n_banner", { imageAssetId: "not-a-uuid" })).status).toBe(400);
    expect((await patch("n_title", { imageAssetId: layerAssetId })).status).toBe(400);
    expect((await patch("n_banner", {})).status).toBe(400);
  });

  it("freezes layer images once the version is published", async () => {
    await app.get(PrismaService).templateVersion.update({ where: { id: versionId }, data: { publishedAt: new Date() } });
    const server = app.getHttpServer();
    const res = await request(server)
      .post(`${base}/nodes/n_banner/image`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", await solidPng(120, 30), { filename: "x.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/published/);
    expect((await request(server).patch(`${base}/nodes/n_banner`).set("Authorization", `Bearer ${adminToken}`).send({ imageAssetId: layerAssetId })).status).toBe(400);
    expect((await request(server).patch(`${base}/nodes/n_banner`).set("Authorization", `Bearer ${adminToken}`).send({ locked: true })).status).toBe(200);
  });
});
