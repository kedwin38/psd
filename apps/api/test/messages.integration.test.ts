import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const solidPng = (color: string) => sharp({ create: { width: 20, height: 20, channels: 4, background: color } }).png().toBuffer();

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

describe("Admin<->user communication tab", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let tokens: TokenServiceType;
  let userAId: string;
  let userAToken: string;
  let userBToken: string;
  let adminToken: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const userA = await prisma.user.create({ data: { email: "thread-a@example.com", displayName: "A", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const userB = await prisma.user.create({ data: { email: "thread-b@example.com", displayName: "B", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const admin = await prisma.user.create({ data: { email: "support-admin@example.com", displayName: "Support", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } } });
    userAId = userA.id;
    userAToken = tokens.issueAccessToken({ id: userA.id, email: userA.email, roles: [RoleName.END_USER], organizationId: null });
    userBToken = tokens.issueAccessToken({ id: userB.id, email: userB.email, roles: [RoleName.END_USER], organizationId: null });
    adminToken = tokens.issueAccessToken({ id: admin.id, email: admin.email, roles: [RoleName.SUPER_ADMIN], organizationId: null });
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets a user start a thread and an admin see and reply to it", async () => {
    const sent = await http().post("/api/v1/messages/mine").set("Authorization", `Bearer ${userAToken}`).send({ body: "My download isn't working." });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ authorRole: "END_USER", body: "My download isn't working." });

    const threads = await http().get("/api/v1/admin/messages").set("Authorization", `Bearer ${adminToken}`);
    expect(threads.status).toBe(200);
    const thread = threads.body.find((t: { user: { id: string } }) => t.user.id === userAId);
    expect(thread).toMatchObject({ unreadCount: 1, lastMessage: { body: "My download isn't working." } });

    const opened = await http().get(`/api/v1/admin/messages/${userAId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(opened.status).toBe(200);
    expect(opened.body.messages).toHaveLength(1);

    // Opening the thread marked the user's message read; it no longer counts as unread.
    const threadsAfter = await http().get("/api/v1/admin/messages").set("Authorization", `Bearer ${adminToken}`);
    expect(threadsAfter.body.find((t: { user: { id: string } }) => t.user.id === userAId)).toMatchObject({ unreadCount: 0 });

    const reply = await http().post(`/api/v1/admin/messages/${userAId}`).set("Authorization", `Bearer ${adminToken}`).send({ body: "Looking into it now." });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ authorRole: "ADMIN", body: "Looking into it now." });

    const mine = await http().get("/api/v1/messages/mine").set("Authorization", `Bearer ${userAToken}`);
    expect(mine.body.map((m: { body: string }) => m.body)).toEqual(["My download isn't working.", "Looking into it now."]);
  });

  it("never lets an END_USER reach another user's thread or the admin inbox", async () => {
    expect((await http().get("/api/v1/admin/messages").set("Authorization", `Bearer ${userBToken}`)).status).toBe(403);
    expect((await http().get(`/api/v1/admin/messages/${userAId}`).set("Authorization", `Bearer ${userBToken}`)).status).toBe(403);
    expect((await http().post(`/api/v1/admin/messages/${userAId}`).set("Authorization", `Bearer ${userBToken}`).send({ body: "hi" })).status).toBe(403);
    // B's own "mine" never shows A's messages: each user only ever sees their own thread.
    const mineB = await http().get("/api/v1/messages/mine").set("Authorization", `Bearer ${userBToken}`);
    expect(mineB.body).toEqual([]);
  });

  it("rejects an empty message with neither text nor an image", async () => {
    const res = await http().post("/api/v1/messages/mine").set("Authorization", `Bearer ${userBToken}`).send({});
    expect(res.status).toBe(400);
  });

  it("carries a full-quality image from admin to user, downloadable by the user but not by a stranger", async () => {
    const png = await solidPng("#123456");
    const reply = await http()
      .post(`/api/v1/admin/messages/${userAId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("body", "Here's a high-res proof.")
      .attach("file", png, "proof.png");
    expect(reply.status).toBe(201);
    expect(reply.body.imageAssetId).toBeTruthy();

    const asOwner = await binary(http().get(`/api/v1/messages/${reply.body.id}/image`).set("Authorization", `Bearer ${userAToken}`));
    expect(asOwner.status).toBe(200);
    expect(Buffer.compare(asOwner.body as Buffer, png)).toBe(0);

    const asAdmin = await binary(http().get(`/api/v1/messages/${reply.body.id}/image`).set("Authorization", `Bearer ${adminToken}`));
    expect(asAdmin.status).toBe(200);

    const asStranger = await http().get(`/api/v1/messages/${reply.body.id}/image`).set("Authorization", `Bearer ${userBToken}`);
    expect(asStranger.status).toBe(403);
  });

  it("rejects a non-image file disguised with an image field name", async () => {
    const res = await http()
      .post("/api/v1/messages/mine")
      .set("Authorization", `Bearer ${userBToken}`)
      .field("body", "not really a photo")
      .attach("file", Buffer.from("not an image"), "fake.png");
    expect(res.status).toBe(400);
  });
});
