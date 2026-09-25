import { randomUUID } from "node:crypto";
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

/**
 * The gallery's "Your projects" cap (max 2 pending at once), rename and clear (delete) actions: apps/api/src/projects/*.
 */
describe("Project pending cap, rename, and delete", () => {
  let app: INestApplication;
  let templateId: string;
  let photoFieldId: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  /** A fresh end user with their own token, so each test's pending count starts at zero. */
  const createUser = async (): Promise<{ id: string; token: string }> => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const email = `${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email, displayName: "End User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    return { id: user.id, token: tokens.issueAccessToken({ id: user.id, email, roles: [RoleName.END_USER], organizationId: null }) };
  };

  const createProject = (token: string, name = "My project") => http().post("/api/v1/projects").set("Authorization", auth(token)).send({ templateId, name });

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    const prisma = app.get(PrismaService);
    const storage = app.get(StorageService);

    const category = await prisma.templateCategory.create({ data: { name: "Cap Test" } });
    const template = await prisma.template.create({ data: { name: "Cap Template", categoryId: category.id } });
    const psd = await storage.storeAsset({ data: Buffer.from("8BPS"), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    const sceneGraph: SceneGraph = { formatVersion: 1, width: 100, height: 100, dpi: 72, colorMode: "rgb", root: [] };
    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, publishedAt: new Date() },
    });
    await prisma.template.update({ where: { id: template.id }, data: { status: TemplateStatus.PUBLISHED, currentVersionId: version.id } });
    templateId = template.id;
    photoFieldId = (
      await prisma.templateField.create({
        data: {
          templateVersionId: version.id,
          nodeId: "n_photo",
          layerPath: "Photo",
          fieldType: "IMAGE",
          label: "Photo",
          constraints: { kind: "image", aspectRatioW: 1, aspectRatioH: 1, aspectTolerancePct: 5, minWidthPx: 1, minHeightPx: 1, maxUploadBytes: 1_000_000, allowedMimeTypes: ["image/png"], required: false },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("limits an end user to 2 pending projects at once, and clearing one frees a slot", async () => {
    const { token } = await createUser();

    const first = await createProject(token, "First");
    expect(first.status).toBe(201);
    const second = await createProject(token, "Second");
    expect(second.status).toBe(201);

    const third = await createProject(token, "Third");
    expect(third.status).toBe(409);
    expect(third.body.detail).toBe("You already have 2 pending projects. Clear one to start another.");

    const cleared = await http().delete(`/api/v1/projects/${first.body.id}`).set("Authorization", auth(token));
    expect(cleared.status).toBe(200);

    const fourth = await createProject(token, "Fourth");
    expect(fourth.status).toBe(201);
  });

  it("admits exactly one project when two near-simultaneous requests both find the caller at 1 of 2 pending", async () => {
    const { token } = await createUser();
    const seed = await createProject(token, "Seed");
    expect(seed.status).toBe(201);

    const [a, b] = await Promise.all([createProject(token, "Race A"), createProject(token, "Race B")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const remaining = await http().get("/api/v1/projects").set("Authorization", auth(token));
    expect(remaining.body.filter((p: { status: string }) => p.status === "IN_PROGRESS")).toHaveLength(2);
  });

  it("renames a project, and rejects an empty or too-long name", async () => {
    const { token } = await createUser();
    const project = (await createProject(token, "Original")).body;

    const renamed = await http().patch(`/api/v1/projects/${project.id}`).set("Authorization", auth(token)).send({ name: "  Renamed Project  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Renamed Project");

    expect((await http().patch(`/api/v1/projects/${project.id}`).set("Authorization", auth(token)).send({ name: "" })).status).toBe(400);
    expect((await http().patch(`/api/v1/projects/${project.id}`).set("Authorization", auth(token)).send({ name: "x".repeat(201) })).status).toBe(400);
  });

  it("never renames or deletes another user's project", async () => {
    const { token: ownerToken } = await createUser();
    const { token: otherToken } = await createUser();
    const project = (await createProject(ownerToken, "Owner's")).body;

    const rename = await http().patch(`/api/v1/projects/${project.id}`).set("Authorization", auth(otherToken)).send({ name: "Hijacked" });
    expect(rename.status).toBe(403);

    const remove = await http().delete(`/api/v1/projects/${project.id}`).set("Authorization", auth(otherToken));
    expect(remove.status).toBe(403);

    // A wholly unknown project id is a plain 404, not a 403.
    expect((await http().delete(`/api/v1/projects/${randomUUID()}`).set("Authorization", auth(ownerToken))).status).toBe(404);
  });

  it("deletes a project along with its uploaded-photo assets, including their real storage bytes", async () => {
    const { token } = await createUser();
    const project = (await createProject(token, "With an upload")).body;

    const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#00ff00" } }).png().toBuffer();
    const upload = await http()
      .post(`/api/v1/projects/${project.id}/uploads`)
      .set("Authorization", auth(token))
      .field("fieldId", photoFieldId)
      .attach("file", png, "photo.png");
    expect(upload.status).toBe(201);
    const assetId = upload.body.assetId as string;

    const prisma = app.get(PrismaService);
    const storage = app.get(StorageService);
    const storageKey = (await prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).storageKey;

    // Confirm the bytes are really there before deleting, so the post-delete assertion means something.
    await expect(storage.getAssetBytes(storageKey)).resolves.toBeInstanceOf(Buffer);

    const remove = await http().delete(`/api/v1/projects/${project.id}`).set("Authorization", auth(token));
    expect(remove.status).toBe(200);

    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.asset.findUnique({ where: { id: assetId } })).toBeNull();
    await expect(storage.getAssetBytes(storageKey)).rejects.toThrow();

    expect((await http().get(`/api/v1/projects/${project.id}`).set("Authorization", auth(token))).status).toBe(404);
  });
});
