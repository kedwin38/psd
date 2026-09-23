import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PutResult, StorageDriver } from "./storage.types";

const SAFE_KEY = /^[a-zA-Z0-9/_-]+$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..")) {
    throw new BadRequestException("Invalid storage key.");
  }
}

/**
 * Filesystem-backed storage for local development. Download URLs are still
 * genuinely HMAC-signed and expiring (spec §12 upload hardening) rather than
 * a bare file path, so the same signed-URL contract holds in dev and prod.
 */
export class LocalDiskStorageDriver implements StorageDriver {
  constructor(
    private readonly rootDir: string,
    private readonly publicUrl: string,
    private readonly signingSecret: string,
  ) {}

  private pathFor(key: string): string {
    assertSafeKey(key);
    return resolve(this.rootDir, key);
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<PutResult> {
    const filePath = this.pathFor(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return {
      key,
      sizeBytes: data.length,
      checksumSha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw new NotFoundException(`Asset ${key} not found.`);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertSafeKey(key);
    await stat(this.pathFor(key)).catch(() => {
      throw new NotFoundException(`Asset ${key} not found.`);
    });
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = this.sign(key, exp);
    const url = new URL("/api/v1/assets/download", this.publicUrl);
    url.searchParams.set("key", key);
    url.searchParams.set("exp", String(exp));
    url.searchParams.set("sig", sig);
    return url.toString();
  }

  private sign(key: string, exp: number): string {
    return createHmac("sha256", this.signingSecret).update(`${key}:${exp}`).digest("hex");
  }

  /** Used by AssetsController to validate an incoming signed download request. */
  verifySignature(key: string, exp: number, sig: string): void {
    if (Date.now() / 1000 > exp) {
      throw new ForbiddenException("Signed URL has expired.");
    }
    const expected = Buffer.from(this.sign(key, exp), "hex");
    const provided = Buffer.from(sig, "hex");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new ForbiddenException("Invalid signature.");
    }
  }

  resolvePath(key: string): string {
    return this.pathFor(key);
  }
}
