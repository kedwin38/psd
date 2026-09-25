import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { AssetOwnerType } from "../generated/prisma";
import { sniffImageMime } from "../common/image-sniff";
import type { UpdateWatermarkOpacityDto, UploadWatermarkDto } from "./dto/settings.dto";

export const MAX_WATERMARK_BYTES = 5 * 1024 * 1024;
const SETTINGS_ID = "singleton";

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  private async getOrCreate() {
    return this.prisma.appSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
  }

  /** Read by every editing surface (admin workspace and end-user editor alike) — no admin gate. */
  async getPublic(): Promise<{ watermark: null } | { url: string; opacity: number }> {
    const settings = await this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings?.watermarkAssetId) return { watermark: null };
    return { url: "/settings/watermark/image", opacity: settings.watermarkOpacity };
  }

  async getImage(): Promise<{ bytes: Buffer; mimeType: string }> {
    const settings = await this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings?.watermarkAssetId) throw new NotFoundException("No watermark is configured.");
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: settings.watermarkAssetId } });
    return { bytes: await this.storage.getAssetBytes(asset.storageKey), mimeType: asset.mimeType };
  }

  /** Uploads (or replaces) the site-wide watermark; the previous asset, if any, is detached and deleted. */
  async upload(file: { buffer: Buffer }, dto: UploadWatermarkDto, actorId: string) {
    if (!file.buffer.length) throw new BadRequestException("Empty file.");
    if (file.buffer.length > MAX_WATERMARK_BYTES) throw new BadRequestException(`Image exceeds the ${MAX_WATERMARK_BYTES} byte limit.`);
    if (sniffImageMime(file.buffer) !== "image/png") throw new BadRequestException("The watermark must be a PNG image.");

    const previous = await this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } });
    const asset = await this.storage.storeAsset({ data: file.buffer, mimeType: "image/png", ownerType: AssetOwnerType.WATERMARK, hint: "watermark" });
    const settings = await this.prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, watermarkAssetId: asset.id, ...(dto.opacity !== undefined ? { watermarkOpacity: dto.opacity } : {}) },
      update: { watermarkAssetId: asset.id, ...(dto.opacity !== undefined ? { watermarkOpacity: dto.opacity } : {}) },
    });
    await this.detachPreviousAsset(previous?.watermarkAssetId ?? null);

    await this.audit.record({
      actorId,
      action: "admin.watermark.updated",
      resourceType: "AppSettings",
      resourceId: SETTINGS_ID,
      metadata: { assetId: asset.id, opacity: settings.watermarkOpacity, previousAssetId: previous?.watermarkAssetId ?? null },
    });
    return { opacity: settings.watermarkOpacity, url: "/settings/watermark/image" };
  }

  async setOpacity(dto: UpdateWatermarkOpacityDto, actorId: string) {
    const settings = await this.getOrCreate();
    if (!settings.watermarkAssetId) throw new BadRequestException("No watermark is configured yet — upload one first.");
    const updated = await this.prisma.appSettings.update({ where: { id: SETTINGS_ID }, data: { watermarkOpacity: dto.opacity } });
    await this.audit.record({ actorId, action: "admin.watermark.updated", resourceType: "AppSettings", resourceId: SETTINGS_ID, metadata: { opacity: updated.watermarkOpacity } });
    return { opacity: updated.watermarkOpacity, url: "/settings/watermark/image" };
  }

  async remove(actorId: string) {
    const settings = await this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings?.watermarkAssetId) return { ok: true };
    const previousAssetId = settings.watermarkAssetId;
    await this.prisma.appSettings.update({ where: { id: SETTINGS_ID }, data: { watermarkAssetId: null } });
    await this.detachPreviousAsset(previousAssetId);
    await this.audit.record({ actorId, action: "admin.watermark.removed", resourceType: "AppSettings", resourceId: SETTINGS_ID, metadata: { previousAssetId } });
    return { ok: true };
  }

  /** Once nothing points at the old asset any more, its bytes are freed too — never left orphaned in storage. */
  private async detachPreviousAsset(assetId: string | null): Promise<void> {
    if (!assetId) return;
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) return;
    await this.storage.deleteByKey(asset.storageKey);
    await this.prisma.asset.delete({ where: { id: assetId } });
  }
}
