import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { idFromPath, type SceneGraph } from "@psd-studio/scene-graph";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { StorageService as StorageServiceType } from "../src/storage/storage.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { StorageService } = requireDist("../dist/storage/storage.service") as { StorageService: new (...args: never[]) => StorageServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { AssetOwnerType, IngestStatus, RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

/** A single unlocked pixel layer — the minimum scene graph publish() will accept (it needs at
 *  least one unlocked layer, or there'd be nothing for an end user to edit). */
function publishableSceneGraph(layerAssetId: string): SceneGraph {
  return {
    formatVersion: 1,
    width: 200,
    height: 100,
    dpi: 72,
    colorMode: "rgb",
    root: [
      {
        id: idFromPath("Photo"),
        path: "Photo",
        name: "Photo",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        clipping: false,
        locked: false,
        bounds: { left: 0, top: 0, right: 200, bottom: 100 },
        type: "pixel",
        imageAssetId: layerAssetId,
      },
    ],
  };
}

// Only the signature is checked synchronously by uploadVersion; real parsing happens async in the
// ingestion worker, which these tests don't need to wait on — they're testing the bulk endpoints'
// own transactional behavior (rows created, results reported), not ingestion itself.
const FAKE_PSD = Buffer.from("8BPS" + "rest of a fake psd body");

describe("Admin bulk template operations", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let adminToken: string;
  let stepUpToken: string;
  let categoryId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);

    const admin = await prisma.user.create({ data: { email: "bulk-admin@example.com", displayName: "Admin", status: "ACTIVE", mfaEnrolled: true, roles: { create: { role: RoleName.SUPER_ADMIN } } } });
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
    stepUpToken = tokens.issueStepUpToken(admin.id);

    const category = await prisma.templateCategory.create({ data: { name: "Bulk Ops Test" } });
    categoryId = category.id;
  });

  /** A template with one READY, publishable version (one unlocked pixel layer). */
  const createPublishableTemplate = async (name: string) => {
    const layerAsset = await app
      .get(StorageService)
      .storeAsset({ data: Buffer.from("layer"), mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: "layer.png" });
    const template = await prisma.template.create({ data: { name, categoryId } });
    const psd = await app.get(StorageService).storeAsset({ data: Buffer.from("8BPS"), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: publishableSceneGraph(layerAsset.id) as object },
    });
    return template.id;
  };

  afterAll(async () => {
    await app.close();
  });

  it("creates one template per uploaded file, named from its filename", async () => {
    const res = await http()
      .post("/api/v1/templates/bulk-upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("categoryId", categoryId)
      .attach("files", FAKE_PSD, "Business Card.psd")
      .attach("files", FAKE_PSD, "Flyer.psd");

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((r: { error?: string }) => !r.error)).toBe(true);

    const names = res.body.map((r: { filename: string }) => r.filename).sort();
    expect(names).toEqual(["Business Card.psd", "Flyer.psd"]);

    const created = await prisma.template.findMany({ where: { categoryId }, orderBy: { name: "asc" } });
    expect(created.map((t) => t.name)).toEqual(["Business Card", "Flyer"]);
    expect(created.every((t) => t.status === "DRAFT")).toBe(true);
  });

  it("reports one file's failure without failing the rest of the batch", async () => {
    const res = await http()
      .post("/api/v1/templates/bulk-upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("categoryId", categoryId)
      .attach("files", FAKE_PSD, "Good.psd")
      .attach("files", Buffer.from("not a psd"), "Bad.psd");

    expect(res.status).toBe(201);
    const good = res.body.find((r: { filename: string }) => r.filename === "Good.psd");
    const bad = res.body.find((r: { filename: string }) => r.filename === "Bad.psd");
    expect(good.error).toBeUndefined();
    expect(good.templateId).toBeTruthy();
    expect(bad.error).toBeTruthy();
  });

  it("rejects bulk upload for a non-admin", async () => {
    const user = await prisma.user.create({ data: { email: "bulk-nonadmin@example.com", displayName: "User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const tokens = app.get(TokenService);
    const userToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });

    const res = await http().post("/api/v1/templates/bulk-upload").set("Authorization", `Bearer ${userToken}`).field("categoryId", categoryId).attach("files", FAKE_PSD, "X.psd");
    expect(res.status).toBe(403);
  });

  it("bulk-deletes templates, refusing without a step-up token", async () => {
    const t1 = await prisma.template.create({ data: { name: "Delete Me 1", categoryId } });
    const t2 = await prisma.template.create({ data: { name: "Delete Me 2", categoryId } });

    const noStepUp = await http().post("/api/v1/templates/bulk-delete").set("Authorization", `Bearer ${adminToken}`).send({ ids: [t1.id, t2.id] });
    expect(noStepUp.status).toBe(403);

    const res = await http()
      .post("/api/v1/templates/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-step-up-token", stepUpToken)
      .send({ ids: [t1.id, t2.id] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: t1.id, ok: true }), expect.objectContaining({ id: t2.id, ok: true })]));

    expect(await prisma.template.findUnique({ where: { id: t1.id } })).toBeNull();
    expect(await prisma.template.findUnique({ where: { id: t2.id } })).toBeNull();
  });

  it("reports a per-id error for an unknown template without failing the rest of the batch", async () => {
    const t = await prisma.template.create({ data: { name: "Real Template", categoryId } });
    const res = await http()
      .post("/api/v1/templates/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-step-up-token", stepUpToken)
      .send({ ids: [t.id, "00000000-0000-0000-0000-000000000000"] });
    expect(res.status).toBe(201);
    const ok = res.body.find((r: { id: string }) => r.id === t.id);
    const missing = res.body.find((r: { id: string }) => r.id === "00000000-0000-0000-0000-000000000000");
    expect(ok.ok).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();
  });

  it("bulk-publishes each selected template's own latest ready version, refusing without a step-up token", async () => {
    const t1 = await createPublishableTemplate("Publish Me 1");
    const t2 = await createPublishableTemplate("Publish Me 2");

    const noStepUp = await http().post("/api/v1/templates/bulk-publish").set("Authorization", `Bearer ${adminToken}`).send({ ids: [t1, t2] });
    expect(noStepUp.status).toBe(403);

    const res = await http().post("/api/v1/templates/bulk-publish").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ ids: [t1, t2] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: t1, ok: true }), expect.objectContaining({ id: t2, ok: true })]));

    const published1 = await prisma.template.findUniqueOrThrow({ where: { id: t1 } });
    const published2 = await prisma.template.findUniqueOrThrow({ where: { id: t2 } });
    expect(published1.status).toBe("PUBLISHED");
    expect(published1.currentVersionId).toBeTruthy();
    expect(published2.status).toBe("PUBLISHED");
  });

  it("reports an already-published template as ok without re-publishing it", async () => {
    const t = await createPublishableTemplate("Publish Twice");
    await http().post("/api/v1/templates/bulk-publish").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ ids: [t] });
    const before = await prisma.template.findUniqueOrThrow({ where: { id: t } });

    const res = await http().post("/api/v1/templates/bulk-publish").set("Authorization", `Bearer ${adminToken}`).set("x-step-up-token", stepUpToken).send({ ids: [t] });
    expect(res.status).toBe(201);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: t, ok: true, alreadyPublished: true }));

    const after = await prisma.template.findUniqueOrThrow({ where: { id: t } });
    expect(after.currentVersionId).toBe(before.currentVersionId);
  });

  it("reports a per-template error when there's no ingested version to publish, without failing the rest of the batch", async () => {
    const empty = await prisma.template.create({ data: { name: "No Version Yet", categoryId } });
    const good = await createPublishableTemplate("Publish Me 3");

    const res = await http()
      .post("/api/v1/templates/bulk-publish")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-step-up-token", stepUpToken)
      .send({ ids: [empty.id, good] });
    expect(res.status).toBe(201);
    const emptyResult = res.body.find((r: { id: string }) => r.id === empty.id);
    const goodResult = res.body.find((r: { id: string }) => r.id === good);
    expect(emptyResult.ok).toBe(false);
    expect(emptyResult.error).toBeTruthy();
    expect(goodResult.ok).toBe(true);
  });
});
