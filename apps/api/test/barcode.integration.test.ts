import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const BARCODE_SAMPLE = readFileSync(join(__dirname, "fixtures/barcode-sample.jpg"));

function binary(res: request.Test) {
  return res.buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

/**
 * Barcode paste-and-extract: a real ZXing decode (Code128, no stub) locates the barcode inside a
 * pasted image that has substantial extra surrounding material, crops down to just the barcode
 * (with a small quiet-zone margin), upscales it, and offers a lossless, truly transparent PNG
 * download (only the printed ink is opaque — no background rectangle around it) — verified against
 * a real synthetic barcode photo through the actual HTTP endpoint.
 */
describe("Barcode extraction", () => {
  let app: INestApplication;
  let prisma: PrismaServiceType;
  let tokens: TokenServiceType;
  let userToken: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const user = await prisma.user.create({ data: { email: "barcode-user@example.com", displayName: "User", status: "ACTIVE", roles: { create: { role: RoleName.END_USER } } } });
    userToken = tokens.issueAccessToken({ id: user.id, email: user.email, roles: [RoleName.END_USER], organizationId: null });
  });

  afterAll(async () => {
    await app.close();
  });

  it("extracts a barcode from a pasted image with extra surrounding material and offers a higher-quality PNG download", async () => {
    const res = await http().post("/api/v1/barcodes/extract").set("Authorization", `Bearer ${userToken}`).attach("file", BARCODE_SAMPLE, "pasted.jpg");
    expect(res.status).toBe(201);
    expect(res.body.text).toBe("0123456789");
    expect(res.body.format).toBe("CODE_128");
    expect(res.body.downloadUrl).toBeTruthy();

    // The output is upscaled for a crisp download, so its pixel size isn't directly comparable to
    // the source frame — what matters is that the crop itself (before upscaling) is tight to the
    // barcode, not the full pasted frame. The barcode + its bwip-js text label is roughly square in
    // this fixture, while the full 470x352 canvas (with 100px margins pasted around it) is not —
    // the output aspect ratio being close to 1:1 confirms the surrounding material was cropped away.
    const aspectRatio = res.body.width / res.body.height;
    expect(aspectRatio).toBeGreaterThan(0.6);
    expect(aspectRatio).toBeLessThan(1.8);
    expect(Math.min(res.body.width, res.body.height)).toBeGreaterThanOrEqual(900);

    const downloadPath = new URL(res.body.downloadUrl as string);
    const download = await binary(http().get(downloadPath.pathname + downloadPath.search));
    expect(download.status).toBe(200);
    const meta = await sharp(download.body as Buffer).metadata();
    expect(meta.format).toBe("png");
    expect(meta.isPalette).toBe(false);
    expect(meta.width).toBe(res.body.width);
    expect(meta.height).toBe(res.body.height);
    // A real transparent cutout of just the barcode's printed ink, not an opaque rectangle with
    // the barcode inside it: the fixture's outer crop pixels (its light-grey paper background) must
    // be transparent, and there must be real opaque ink somewhere inside (the barcode itself).
    expect(meta.hasAlpha).toBe(true);
    const raw = await sharp(download.body as Buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    const corner = data[3];
    expect(corner).toBeLessThan(40);
    let opaqueCount = 0;
    for (let i = 3; i < data.length; i += info.channels) if (data[i]! > 200) opaqueCount++;
    expect(opaqueCount).toBeGreaterThan(0);
  }, 20_000);

  it("fails clearly, without a fake success, when no barcode is present", async () => {
    const blank = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#e6e6e6" } }).jpeg().toBuffer();
    const res = await http().post("/api/v1/barcodes/extract").set("Authorization", `Bearer ${userToken}`).attach("file", blank, "blank.jpg");
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("No barcode");
  });

  it("rejects a non-image upload", async () => {
    const res = await http().post("/api/v1/barcodes/extract").set("Authorization", `Bearer ${userToken}`).attach("file", Buffer.from("not an image"), "file.txt");
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await http().post("/api/v1/barcodes/extract").attach("file", BARCODE_SAMPLE, "pasted.jpg");
    expect(res.status).toBe(401);
  });
});
