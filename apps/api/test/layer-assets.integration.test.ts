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
const { AssetOwnerType, IngestStatus, RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const LAYER_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

describe("Per-layer assets and node updates for the browser compositor", () => {
  let app: INestApplication;
  let base: string;
  let adminToken: string;
  let endUserToken: string;
  let layerAssetId: string;
  let foreignAssetId: string;
  let versionId: string;

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
          ],
        },
      ],
    };
    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, createdById: admin.id },
    });
    versionId = version.id;
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
    expect(res.body).toEqual({ id: "n_photo", locked: true });

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
});
