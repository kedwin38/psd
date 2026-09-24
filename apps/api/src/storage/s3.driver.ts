import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NotFoundException } from "@nestjs/common";
import type { PutResult, StorageDriver } from "./storage.types";

export interface S3DriverConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * Production driver: any S3-compatible endpoint, in particular Cloudflare R2
 * (spec §6, §14) — no egress fees on repeated template asset delivery.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;

  constructor(private readonly config: S3DriverConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<PutResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
    return {
      key,
      sizeBytes: data.length,
      checksumSha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new Error("empty body");
      return Buffer.from(bytes);
    } catch {
      throw new NotFoundException(`Asset ${key} not found.`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async getSignedDownloadUrl(key: string, expiresInSeconds: number, filename?: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/"/g, "")}"` : undefined,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}
