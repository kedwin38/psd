import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { idFromPath, type SceneGraph, type SceneNode } from "@psd-studio/scene-graph";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { StorageService as StorageServiceType } from "../src/storage/storage.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { StorageService } = requireDist("../dist/storage/storage.service") as { StorageService: new (...args: never[]) => StorageServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { AssetOwnerType, IngestStatus, RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const id = idFromPath;
const node = (path: string, locked = false) => ({
  id: id(path),
  path,
  name: path.split("/").pop()!,
  visible: true,
  opacity: 1,
  blendMode: "normal" as const,
  clipping: false,
  locked,
  bounds: { left: 0, top: 0, right: 200, bottom: 100 },
});

function sceneGraph(layerAssetId: string, lockAll = false): SceneGraph {
  const pixel = (path: string, locked = lockAll): SceneNode => ({ ...node(path, locked), type: "pixel", imageAssetId: layerAssetId });
  return {
    formatVersion: 1,
    width: 400,
    height: 300,
    dpi: 72,
    colorMode: "rgb",
    root: [
      pixel("Background", true),
      {
        ...node("Card", lockAll),
        type: "group",
        isPassThrough: true,
        children: [
          { ...node("Card/Name", lockAll), type: "text", runs: [{ text: "Jane Doe", fontName: "ArialMT", fontSize: 28, color: { r: 0, g: 0, b: 0, a: 1 } }], alignment: "left", boxMode: "point" },
          pixel("Card/Photo"),
        ],
      },
      { ...node("Frame", true), type: "group", isPassThrough: true, children: [pixel("Frame/Border")] },
    ],
  };
}

/** A layer is an editable field exactly when it's unlocked, from the lock toggle through publish. */
describe("Fields follow layer lock state", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let adminToken: string;
  let stepUpToken: string;
  let templateId: string;
  let versionId: string;
  let base: string;
  let layerAssetId: string;
  let categoryId: string;
  let adminId: string;

  const http = () => request(app.getHttpServer());
  const asAdmin = (req: request.Test) => req.set("Authorization", `Bearer ${adminToken}`);
  const fields = async () =>
    (await prisma.templateField.findMany({ where: { templateVersionId: versionId }, orderBy: { order: "asc" } })).map((f) => [f.layerPath, f.fieldType, f.label]);
  const lock = (path: string, locked: boolean) => asAdmin(http().patch(`${base}/nodes/${id(path)}`)).send({ locked });

  async function createVersion(graph: SceneGraph, versionNo: number) {
    const psd = await app.get(StorageService).storeAsset({ data: Buffer.from(`8BPS${versionNo}`), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    return prisma.templateVersion.create({ data: { templateId, versionNo, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: graph as object, createdById: adminId } });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const admin = await prisma.user.create({ data: { email: "sync-admin@example.com", displayName: "Admin", status: "ACTIVE", roles: { create: { role: RoleName.CONTENT_ADMIN } } } });
    adminId = admin.id;
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.CONTENT_ADMIN], organizationId: null });
    stepUpToken = tokens.issueStepUpToken(admin.id);

    categoryId = (await prisma.templateCategory.create({ data: { name: "Sync Test" } })).id;
    templateId = (await prisma.template.create({ data: { name: "Sync Template", categoryId } })).id;
    layerAssetId = (await app.get(StorageService).storeAsset({ data: Buffer.from("png"), mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: "layer" })).id;
    versionId = (await createVersion(sceneGraph(layerAssetId), 1)).id;
    base = `/api/v1/templates/${templateId}/versions/${versionId}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("locking or unlocking a layer adds or removes its field, keeping other fields' settings", async () => {
    expect((await lock("Card/Photo", true)).status).toBe(200);
    expect(await fields()).toEqual([
      ["Card", "VISIBILITY", "Card"],
      ["Card/Name", "TEXT", "Name"],
    ]);

    const name = await prisma.templateField.findFirstOrThrow({ where: { templateVersionId: versionId, nodeId: id("Card/Name") } });
    expect((await asAdmin(http().patch(`${base}/fields/${name.id}`)).send({ label: "Your name" })).status).toBe(200);

    expect((await lock("Card/Photo", false)).status).toBe(200);
    expect(await fields()).toEqual([
      ["Card", "VISIBILITY", "Card"],
      ["Card/Photo", "IMAGE", "Photo"],
      ["Card/Name", "TEXT", "Your name"],
    ]);
    const photo = await prisma.templateField.findFirstOrThrow({ where: { templateVersionId: versionId, nodeId: id("Card/Photo") } });
    expect(photo.constraints).toMatchObject({ kind: "image", minWidthPx: 100, minHeightPx: 50, required: false });

    // Locking a group takes everything inside it out; unlocking brings the children back.
    await lock("Card", true);
    expect(await fields()).toEqual([]);
    await lock("Card", false);
    expect((await fields()).map(([path]) => path)).toEqual(["Card", "Card/Photo", "Card/Name"]);
  });

  it("removing a field locks its layer, and creating one unlocks it; layers in locked groups can't become fields", async () => {
    const photo = await prisma.templateField.findFirstOrThrow({ where: { templateVersionId: versionId, nodeId: id("Card/Photo") } });
    expect((await asAdmin(http().delete(`${base}/fields/${photo.id}`))).status).toBe(200);
    const graph = async () => (await prisma.templateVersion.findUniqueOrThrow({ where: { id: versionId } })).sceneGraph as unknown as SceneGraph;
    expect(((await graph()).root[1] as Extract<SceneNode, { type: "group" }>).children[1]!.locked).toBe(true);
    expect((await fields()).map(([path]) => path)).not.toContain("Card/Photo");

    const create = (path: string) =>
      asAdmin(http().post(`${base}/fields`)).send({
        nodeId: id(path),
        layerPath: path,
        fieldType: "SMART_OBJECT",
        label: "Headshot",
        order: 9,
        constraints: { kind: "image", aspectRatioW: 1, aspectRatioH: 1, minWidthPx: 400, minHeightPx: 400, maxUploadBytes: 1_000_000, allowedMimeTypes: ["image/png"], required: true },
      });
    expect((await create("Card/Photo")).status).toBe(201);
    expect(((await graph()).root[1] as Extract<SceneNode, { type: "group" }>).children[1]!.locked).toBe(false);
    expect(await fields()).toContainEqual(["Card/Photo", "SMART_OBJECT", "Headshot"]);

    const duplicate = await create("Card/Photo");
    expect(duplicate.status).toBe(409);
    const inLockedGroup = await create("Frame/Border");
    expect(inLockedGroup.status).toBe(400);
    expect(inLockedGroup.body.detail).toContain("inside the locked group “Frame”");
  });

  it("publishing reconciles fields with the current lock state, whatever rows are lying around", async () => {
    await lock("Card/Name", true);
    // Out of sync on purpose: a field on a locked layer, and an unlocked layer with none.
    await prisma.templateField.create({
      data: { templateVersionId: versionId, nodeId: id("Background"), layerPath: "Background", fieldType: "VISIBILITY", label: "Stale", constraints: { kind: "visibility", defaultVisible: true } },
    });
    await prisma.templateField.deleteMany({ where: { templateVersionId: versionId, nodeId: id("Card") } });

    expect((await asAdmin(http().post(`${base}/publish`))).status).toBe(403);
    const res = await asAdmin(http().post(`${base}/publish`)).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "PUBLISHED", currentVersionId: versionId });
    expect(await fields()).toEqual([
      ["Card", "VISIBILITY", "Card"],
      ["Card/Photo", "SMART_OBJECT", "Headshot"],
    ]);
    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "template.published", resourceId: versionId } });
    expect(audit.metadata).toMatchObject({ fieldCount: 2, fieldsCreated: 1, fieldsRemoved: 1 });
  });

  it("leaves a published version's fields alone: projects are pinned to them", async () => {
    await lock("Card/Photo", true);
    expect((await fields()).map(([path]) => path)).toEqual(["Card", "Card/Photo"]);
    await lock("Card/Photo", false);
  });

  it("refuses to publish a version whose every layer is locked", async () => {
    const version = await createVersion(sceneGraph(layerAssetId, true), 2);
    const res = await asAdmin(http().post(`/api/v1/templates/${templateId}/versions/${version.id}/publish`)).set("x-step-up-token", stepUpToken);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("Every layer is locked");
    expect((await prisma.template.findUniqueOrThrow({ where: { id: templateId } })).currentVersionId).toBe(versionId);
  });
});
