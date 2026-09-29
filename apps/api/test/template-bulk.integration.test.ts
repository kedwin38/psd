import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

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
});
