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

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

describe("Catalog: category tree, template rename/delete and thumbnails", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let storage: StorageServiceType;
  let adminToken: string;
  let stepUpToken: string;
  let endUserId: string;
  let endUserToken: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (req: request.Test) => req.set("Authorization", `Bearer ${adminToken}`);
  const createCategory = async (name: string, parentId: string | null = null) => {
    const res = await asAdmin(http().post("/api/v1/categories")).send({ name, parentId });
    expect(res.status).toBe(201);
    return res.body as { id: string; parentId: string | null };
  };
  const moveCategory = (id: string, parentId: string | null) => asAdmin(http().patch(`/api/v1/categories/${id}`)).send({ parentId });
  const deleteCategory = (id: string) => asAdmin(http().delete(`/api/v1/categories/${id}`)).set("x-step-up-token", stepUpToken);

  /** A published, renderable template: one 400x300 solid-red pixel layer. */
  async function publishedTemplate(name: string, categoryId: string) {
    const layer = await sharp({ create: { width: 400, height: 300, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const layerAsset = await storage.storeAsset({ data: layer, mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: "Art", width: 400, height: 300 });
    const psd = await storage.storeAsset({ data: Buffer.from("8BPS"), mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "src.psd" });
    const sceneGraph: SceneGraph = {
      formatVersion: 1,
      width: 1600,
      height: 1200,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "pixel",
          id: "n_art",
          path: "Art",
          name: "Art",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 1600, bottom: 1200 },
          imageAssetId: layerAsset.id,
        },
      ],
    };
    const template = await prisma.template.create({ data: { name, categoryId, status: TemplateStatus.PUBLISHED } });
    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: psd.id, ingestStatus: IngestStatus.READY, sceneGraph: sceneGraph as object, publishedAt: new Date() },
    });
    await prisma.template.update({ where: { id: template.id }, data: { currentVersionId: version.id } });
    return { templateId: template.id, versionId: version.id };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    const tokens = app.get(TokenService);

    const admin = await prisma.user.create({
      data: { email: "catalog-admin@example.com", displayName: "Admin", status: "ACTIVE", roles: { create: { role: RoleName.CONTENT_ADMIN } } },
    });
    const endUser = await prisma.user.create({
      data: { email: "catalog-user@example.com", displayName: "User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } },
    });
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.CONTENT_ADMIN], organizationId: null });
    stepUpToken = tokens.issueStepUpToken(admin.id);
    endUserId = endUser.id;
    endUserToken = tokens.issueAccessToken({ id: endUser.id, email: endUser.email, roles: [RoleName.END_USER], organizationId: null });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("category tree", () => {
    it("lists categories flat, each with the parentId a client nests them by", async () => {
      const cards = await createCategory("Cards");
      const birthday = await createCategory("Birthday", cards.id);
      const res = await http().get("/api/v1/categories");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: cards.id, parentId: null }), expect.objectContaining({ id: birthday.id, parentId: cards.id })]),
      );
    });

    it("refuses an unknown parent", async () => {
      const res = await asAdmin(http().post("/api/v1/categories")).send({ name: "Orphan", parentId: "00000000-0000-4000-8000-000000000000" });
      expect(res.status).toBe(404);
    });

    it("refuses to make a category its own parent or ancestor", async () => {
      const root = await createCategory("Root");
      const child = await createCategory("Child", root.id);
      const grandchild = await createCategory("Grandchild", child.id);

      const self = await moveCategory(root.id, root.id);
      expect(self.status).toBe(400);
      for (const descendant of [child.id, grandchild.id]) {
        const res = await moveCategory(root.id, descendant);
        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("A category cannot be moved into one of its own subcategories.");
      }
      expect((await prisma.templateCategory.findUniqueOrThrow({ where: { id: root.id } })).parentId).toBeNull();
    });

    it("re-parents and renames a category, and moves it back to the top level", async () => {
      const a = await createCategory("A");
      const b = await createCategory("B");
      const moved = await asAdmin(http().patch(`/api/v1/categories/${b.id}`)).send({ name: "B renamed", parentId: a.id });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ name: "B renamed", parentId: a.id });
      const top = await moveCategory(b.id, null);
      expect(top.status).toBe(200);
      expect(top.body.parentId).toBeNull();
    });

    it("keeps category writes to content admins", async () => {
      const res = await http().post("/api/v1/categories").set("Authorization", `Bearer ${endUserToken}`).send({ name: "Nope" });
      expect(res.status).toBe(403);
    });

    it("requires step-up to delete a category", async () => {
      const lonely = await createCategory("Lonely");
      const res = await asAdmin(http().delete(`/api/v1/categories/${lonely.id}`));
      expect(res.status).toBe(403);
      expect(await prisma.templateCategory.count({ where: { id: lonely.id } })).toBe(1);
    });

    it("refuses to delete a category that has subcategories or templates, and deletes an empty one", async () => {
      const parent = await createCategory("Parent");
      const leaf = await createCategory("Leaf", parent.id);
      await prisma.template.create({ data: { name: "In leaf", categoryId: leaf.id } });

      const withChildren = await deleteCategory(parent.id);
      expect(withChildren.status).toBe(400);
      expect(withChildren.body.detail).toBe("This category still has subcategories. Move or delete them first.");

      const withTemplates = await deleteCategory(leaf.id);
      expect(withTemplates.status).toBe(400);
      expect(withTemplates.body.detail).toBe("This category still has templates. Move them to another category or delete them first.");
      expect(await prisma.template.count({ where: { categoryId: leaf.id } })).toBe(1);

      await prisma.template.deleteMany({ where: { categoryId: leaf.id } });
      expect((await deleteCategory(leaf.id)).status).toBe(200);
      expect((await deleteCategory(parent.id)).status).toBe(200);
      expect(await prisma.templateCategory.count({ where: { id: { in: [parent.id, leaf.id] } } })).toBe(0);
      expect(await prisma.auditLogEntry.count({ where: { action: "category.deleted", resourceId: parent.id } })).toBe(1);
    });
  });

  describe("templates", () => {
    it("renames a template and moves it to another category", async () => {
      const from = await createCategory("From");
      const to = await createCategory("To");
      const { templateId } = await publishedTemplate("Old name", from.id);

      const res = await asAdmin(http().patch(`/api/v1/templates/${templateId}`)).send({ name: "New name", categoryId: to.id });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "New name", categoryId: to.id });
      const unknown = await asAdmin(http().patch(`/api/v1/templates/${templateId}`)).send({ categoryId: "00000000-0000-4000-8000-000000000000" });
      expect(unknown.status).toBe(400);
      const listed = await http().get(`/api/v1/templates?categoryId=${to.id}`);
      expect(listed.body.map((t: { name: string }) => t.name)).toEqual(["New name"]);
    });

    it("keeps template deletion to step-up'd content admins", async () => {
      const category = await createCategory("Guarded");
      const { templateId } = await publishedTemplate("Guarded", category.id);
      const noStepUp = await asAdmin(http().delete(`/api/v1/templates/${templateId}`));
      expect(noStepUp.status).toBe(403);
      const endUser = await http().delete(`/api/v1/templates/${templateId}`).set("Authorization", `Bearer ${endUserToken}`).set("x-step-up-token", stepUpToken);
      expect(endUser.status).toBe(403);
      expect(await prisma.template.count({ where: { id: templateId, deletedAt: null } })).toBe(1);
    });

    it("removes a template nobody has used, with its versions", async () => {
      const category = await createCategory("Unused");
      const { templateId, versionId } = await publishedTemplate("Unused", category.id);
      const res = await asAdmin(http().delete(`/api/v1/templates/${templateId}`)).set("x-step-up-token", stepUpToken);
      expect(res.status).toBe(200);
      expect(await prisma.template.count({ where: { id: templateId } })).toBe(0);
      expect(await prisma.templateVersion.count({ where: { id: versionId } })).toBe(0);
      const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: "template.deleted", resourceId: templateId } });
      expect(audit.metadata).toMatchObject({ name: "Unused", projectCount: 0 });
      expect((await deleteCategory(category.id)).status).toBe(200);
    });

    it("takes a template projects use out of the catalog while those projects keep working", async () => {
      const category = await createCategory("Used");
      const { templateId, versionId } = await publishedTemplate("Used", category.id);
      const project = await http().post("/api/v1/projects").set("Authorization", `Bearer ${endUserToken}`).send({ templateId, name: "Mine" });
      expect(project.status).toBe(201);

      const res = await asAdmin(http().delete(`/api/v1/templates/${templateId}`)).set("x-step-up-token", stepUpToken);
      expect(res.status).toBe(200);
      expect((await prisma.template.findUniqueOrThrow({ where: { id: templateId } })).deletedAt).not.toBeNull();

      expect((await http().get("/api/v1/templates")).body.map((t: { id: string }) => t.id)).not.toContain(templateId);
      expect((await asAdmin(http().get("/api/v1/templates/admin/all"))).body.map((t: { id: string }) => t.id)).not.toContain(templateId);
      expect((await http().get(`/api/v1/templates/${templateId}`)).status).toBe(404);
      expect((await asAdmin(http().patch(`/api/v1/templates/${templateId}`)).send({ name: "Back" })).status).toBe(404);
      expect((await asAdmin(http().delete(`/api/v1/templates/${templateId}`)).set("x-step-up-token", stepUpToken)).status).toBe(404);
      const another = await http().post("/api/v1/projects").set("Authorization", `Bearer ${endUserToken}`).send({ templateId, name: "Another" });
      expect(another.status).toBe(400);

      const asUser = (path: string) => http().get(path).set("Authorization", `Bearer ${endUserToken}`);
      expect((await asUser(`/api/v1/projects/${project.body.id}`)).status).toBe(200);
      expect((await asUser(`/api/v1/templates/${templateId}/versions/${versionId}/scene-graph`)).status).toBe(200);
      expect((await asUser(`/api/v1/templates/${templateId}/versions/${versionId}/fields`)).status).toBe(200);
      expect(await prisma.project.count({ where: { userId: endUserId, templateId } })).toBe(1);

      const categoryDelete = await deleteCategory(category.id);
      expect(categoryDelete.status).toBe(400);
      expect(categoryDelete.body.detail).toBe("Templates deleted from this category are still used by end users' projects, so it can't be removed.");
    });
  });

  describe("thumbnails", () => {
    it("renders a published version once, as a small WebP, and serves the kept copy after", async () => {
      const category = await createCategory("Thumbs");
      const { templateId, versionId } = await publishedTemplate("Thumb", category.id);
      const path = `/api/v1/templates/${templateId}/versions/${versionId}/thumbnail`;

      const first = await binary(http().get(path).set("Authorization", `Bearer ${endUserToken}`));
      expect(first.status).toBe(200);
      expect(first.headers["content-type"]).toBe("image/webp");
      expect(first.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      const meta = await sharp(first.body as Buffer).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", 640, 480]);
      const { data } = await sharp(first.body as Buffer).raw().toBuffer({ resolveWithObject: true });
      expect([data[0], data[1], data[2]]).toEqual([255, 0, 0]);

      const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id: versionId } });
      expect(version.thumbnailAssetId).not.toBeNull();
      const second = await binary(http().get(path).set("Authorization", `Bearer ${endUserToken}`));
      expect(Buffer.compare(second.body as Buffer, first.body as Buffer)).toBe(0);
      expect(await prisma.asset.count({ where: { ownerType: AssetOwnerType.TEMPLATE_THUMBNAIL } })).toBe(1);
    });

    it("has none for an unpublished version, and needs a signed-in user", async () => {
      const category = await createCategory("Drafts");
      const { templateId, versionId } = await publishedTemplate("Draft", category.id);
      await prisma.templateVersion.update({ where: { id: versionId }, data: { publishedAt: null } });
      const path = `/api/v1/templates/${templateId}/versions/${versionId}/thumbnail`;
      expect((await http().get(path).set("Authorization", `Bearer ${endUserToken}`)).status).toBe(404);
      expect((await http().get(path)).status).toBe(401);
    });
  });
});
