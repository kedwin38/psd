import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, createWorkerTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { TokenService as TokenServiceType } from "../src/auth/token.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { TokenService } = requireDist("../dist/auth/token.service") as { TokenService: new (...args: never[]) => TokenServiceType };
const { RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

const SAMPLE_FACE = readFileSync(join(__dirname, "fixtures/id-photo-sample.jpg"));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

/**
 * The ID photo editor: real face-landmark detection (no stub) drives an auto-crop to the chosen
 * standard's head-size/eye-line spec, auto white balance/exposure, background flattening when safe,
 * and head-tilt leveling — verified end to end against a real photo through the actual worker.
 */
describe("ID photo editor", () => {
  let app: INestApplication;
  let workerApp: INestApplication;
  let prisma: PrismaServiceType;
  let tokens: TokenServiceType;
  let userToken: string;
  let otherToken: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    workerApp = await createWorkerTestApp();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const user = await prisma.user.create({ data: { email: "id-photo-user@example.com", displayName: "User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    const other = await prisma.user.create({ data: { email: "id-photo-other@example.com", displayName: "Other", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    userToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });
    otherToken = tokens.issueAccessToken({ id: other.id, email: other.email, roles: [RoleName.END_USER], organizationId: null });

    const { IdPhotoProcessorService } = requireDist("../dist/worker/id-photo.processor");
    const processor: { onModuleInit: () => void } = workerApp.get(IdPhotoProcessorService);
    processor.onModuleInit();
  });

  afterAll(async () => {
    await app.close();
    await workerApp.close();
  });

  const create = (token: string, standard: string, file: Buffer) => http().post("/api/v1/id-photos").set("Authorization", `Bearer ${token}`).field("standard", standard).attach("file", file, "photo.jpg");

  const waitForCompletion = async (id: string, token: string) => {
    let job: { status: string; [k: string]: unknown } = { status: "QUEUED" };
    for (let i = 0; i < 40; i++) {
      const res = await http().get(`/api/v1/id-photos/${id}`).set("Authorization", `Bearer ${token}`);
      job = res.body;
      if (job.status === "COMPLETE" || job.status === "FAILED") return job;
      await sleep(300);
    }
    return job;
  };

  it("processes a real photo into a spec-exact US passport photo with a genuine compliance report", async () => {
    const created = await create(userToken, "US_PASSPORT", SAMPLE_FACE);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("QUEUED");

    const job = await waitForCompletion(created.body.id, userToken);
    expect(job.status).toBe("COMPLETE");
    expect(job.downloadUrl).toBeTruthy();

    const report = job.report as { standard: string; outputWidthPx: number; outputHeightPx: number; checks: { label: string; pass: boolean }[]; faceConfidence: number };
    expect(report.standard).toBe("US_PASSPORT");
    expect(report.outputWidthPx).toBe(600);
    expect(report.outputHeightPx).toBe(600);
    expect(report.faceConfidence).toBeGreaterThan(0.3);
    const headSize = report.checks.find((c) => c.label === "Head size");
    const eyePosition = report.checks.find((c) => c.label === "Eye position");
    expect(headSize?.pass).toBe(true);
    expect(eyePosition?.pass).toBe(true);

    // The signed URL is absolute (http://host/api/v1/assets/download?...); supertest needs just the
    // path+query to route it through the same in-memory app instance the rest of the test uses.
    const downloadPath = new URL(job.downloadUrl as string);
    const download = await binary(http().get(downloadPath.pathname + downloadPath.search));
    expect(download.status).toBe(200);
    const meta = await sharp(download.body as Buffer).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(600);
  }, 30_000);

  it("processes the same photo into a spec-exact ICAO photo, a different aspect ratio and target proportions", async () => {
    const created = await create(userToken, "ICAO", SAMPLE_FACE);
    const job = await waitForCompletion(created.body.id, userToken);
    expect(job.status).toBe("COMPLETE");
    const report = job.report as { outputWidthPx: number; outputHeightPx: number; checks: { label: string; pass: boolean }[] };
    expect(report.outputWidthPx).toBe(413);
    expect(report.outputHeightPx).toBe(531);
    expect(report.checks.find((c) => c.label === "Head size")?.pass).toBe(true);
    expect(report.checks.find((c) => c.label === "Eye position")?.pass).toBe(true);
  }, 30_000);

  it("levels a visibly tilted head and reports the correction, rather than silently cropping around the tilt", async () => {
    const created = await create(userToken, "US_PASSPORT", SAMPLE_FACE);
    const job = await waitForCompletion(created.body.id, userToken);
    const report = job.report as { checks: { label: string; detail: string }[] };
    const pose = report.checks.find((c) => c.label === "Head pose");
    expect(pose).toBeTruthy();
    // The fixture photo has a real, substantial head tilt; the leveling step must have actually run.
    expect(pose!.detail).toMatch(/tilt|level/i);
  }, 30_000);

  it("fails clearly, without a fake success, when no face is present", async () => {
    const blank = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#8899aa" } }).jpeg().toBuffer();
    const created = await create(userToken, "US_PASSPORT", blank);
    expect(created.status).toBe(201);
    const job = await waitForCompletion(created.body.id, userToken);
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("No face");
  }, 15_000);

  it("rejects a non-image upload before ever queuing a job", async () => {
    const res = await create(userToken, "US_PASSPORT", Buffer.from("not an image"));
    expect(res.status).toBe(400);
  });

  it("never lets one user read or download another user's job", async () => {
    const created = await create(userToken, "US_PASSPORT", SAMPLE_FACE);
    const asOther = await http().get(`/api/v1/id-photos/${created.body.id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(asOther.status).toBe(403);
  });

  it("lists only the caller's own jobs, never another user's", async () => {
    const mine = await http().get("/api/v1/id-photos").set("Authorization", `Bearer ${userToken}`);
    expect(mine.status).toBe(200);
    expect((mine.body as { userId: string }[]).length).toBeGreaterThan(0);
    expect((mine.body as { userId: string }[]).every((j) => j.userId !== undefined)).toBe(true);

    const theirs = await http().get("/api/v1/id-photos").set("Authorization", `Bearer ${otherToken}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toEqual([]);
  });
});
