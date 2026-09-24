import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { STORAGE_DRIVER, type StorageDriver } from "./storage.types";
import type { AssetOwnerType } from "../generated/prisma";

export interface StoreAssetInput {
  data: Buffer;
  mimeType: string;
  ownerType: AssetOwnerType;
  /** Human-readable path fragment used only to make storage keys legible. */
  hint?: string;
  width?: number;
  height?: number;
  /** The project a USER_UPLOAD belongs to. */
  projectId?: string;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Persists bytes to the object store and records a matching Asset row. */
  async storeAsset(input: StoreAssetInput): Promise<{ id: string; storageKey: string }> {
    const safeHint = (input.hint ?? "asset").replace(/[^a-zA-Z0-9/_-]/g, "_").slice(0, 120);
    const key = `${input.ownerType.toLowerCase()}/${randomUUID()}_${safeHint}`;
    const result = await this.driver.put(key, input.data, input.mimeType);
    const asset = await this.prisma.asset.create({
      data: {
        ownerType: input.ownerType,
        storageKey: result.key,
        mimeType: input.mimeType,
        checksumSha256: result.checksumSha256,
        sizeBytes: result.sizeBytes,
        width: input.width,
        height: input.height,
        projectId: input.projectId,
      },
    });
    return { id: asset.id, storageKey: asset.storageKey };
  }

  async getAssetBytes(storageKey: string): Promise<Buffer> {
    return this.driver.get(storageKey);
  }

  async getSignedDownloadUrl(storageKey: string, expiresInSeconds = 300): Promise<string> {
    return this.driver.getSignedDownloadUrl(storageKey, expiresInSeconds);
  }

  async deleteByKey(storageKey: string): Promise<void> {
    await this.driver.delete(storageKey);
  }
}
