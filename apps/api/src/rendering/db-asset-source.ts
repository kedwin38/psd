import { NotFoundException } from "@nestjs/common";
import type { AssetSource } from "@psd-studio/psd-engine";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";

/**
 * Bridges the psd-engine compositor's AssetSource port to real storage: scene
 * graph nodes reference layer/photo assets by their Asset row id, this
 * resolves that id to a storage key and fetches the bytes (spec §5 — the
 * editor preview and the export worker share this same resolution path).
 */
export class DbBackedAssetSource implements AssetSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getImage(assetId: string): Promise<Buffer> {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found.`);
    return this.storage.getAssetBytes(asset.storageKey);
  }
}
