import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { Inject } from "@nestjs/common";
import sharp from "sharp";
import { findNodeById, lockingNode, referencedAssetIds, type PixelLayerNode, type SceneGraph, type SceneNode, type SmartObjectLayerNode } from "@psd-studio/scene-graph";
import { SceneCompositor } from "@psd-studio/psd-engine";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { DbBackedAssetSource } from "../rendering/db-asset-source";
import { INGESTION_QUEUE_TOKEN } from "../queue/queue.module";
import type { IngestionJobData } from "../queue/queue.constants";
import { AssetOwnerType, IngestStatus, TemplateStatus, type Prisma, type TemplateVersion } from "../generated/prisma";
import { sniffImageMime } from "../common/image-sniff";
import type { CreateFieldDto, CreateTemplateDto, UpdateFieldDto, UpdateNodeDto, UpdateTemplateDto } from "./dto/template.dto";
import { syncFieldsWithLocks, type FieldSyncResult } from "./field-sync";

const ADMIN_PREVIEW_MAX_DIMENSION = 1000;
const THUMBNAIL_MAX_DIMENSION = 640;

const PSD_MAGIC = Buffer.from("8BPS", "ascii");
export const MAX_PSD_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_LAYER_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_LAYER_IMAGE_PIXELS = 100_000_000;

function rasterImageAssetId(node: SceneNode): string | null {
  return node.type === "pixel" || node.type === "shape" || node.type === "smartObject" ? node.imageAssetId : null;
}

function nodeIn(sceneGraph: SceneGraph, nodeId: string): SceneNode {
  const node = findNodeById(sceneGraph, nodeId);
  if (!node) throw new NotFoundException(`Node ${nodeId} does not exist in this template version's scene graph.`);
  return node;
}

const syncMetadata = (sync: FieldSyncResult | null) => (sync ? { fieldsCreated: sync.created, fieldsRemoved: sync.removed } : {});

function assertImageReplaceable(node: SceneNode, publishedAt: Date | null): asserts node is PixelLayerNode | SmartObjectLayerNode {
  // Projects pin a version, so swapping art under a published one would silently change users' designs and exports.
  if (publishedAt) throw new BadRequestException("This version is published, so its layer images are frozen. Upload a new version to change them.");
  if (node.type !== "pixel" && node.type !== "smartObject") {
    throw new BadRequestException(`Only image and smart object layers accept a replacement image ("${node.name}" is a ${node.type} layer).`);
  }
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(INGESTION_QUEUE_TOKEN) private readonly ingestionQueue: Queue<IngestionJobData>,
  ) {}

  async listAllForAdmin() {
    return this.prisma.template.findMany({
      where: { deletedAt: null },
      include: {
        currentVersion: { select: { id: true, versionNo: true, nativeDpi: true } },
        versions: { select: { id: true, versionNo: true, ingestStatus: true, publishedAt: true, _count: { select: { fields: true } } }, orderBy: { versionNo: "desc" } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async listPublished(categoryId?: string) {
    return this.prisma.template.findMany({
      where: { status: TemplateStatus.PUBLISHED, deletedAt: null, ...(categoryId ? { categoryId } : {}) },
      include: { currentVersion: { select: { id: true, versionNo: true, nativeDpi: true } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async get(id: string) {
    const template = await this.prisma.template.findFirst({
      where: { id, deletedAt: null },
      include: { currentVersion: true },
    });
    if (!template) throw new NotFoundException("Template not found.");
    return template;
  }

  private async assertCategoryExists(categoryId: string) {
    if (!(await this.prisma.templateCategory.findUnique({ where: { id: categoryId } }))) throw new BadRequestException("Unknown category.");
  }

  async create(dto: CreateTemplateDto, actorId: string) {
    await this.assertCategoryExists(dto.categoryId);
    const template = await this.prisma.template.create({
      data: { name: dto.name, categoryId: dto.categoryId, visibilityScope: dto.visibilityScope, status: TemplateStatus.DRAFT },
    });
    await this.audit.record({ actorId, action: "template.created", resourceType: "Template", resourceId: template.id });
    return template;
  }

  async update(id: string, dto: UpdateTemplateDto, actorId: string) {
    await this.get(id);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);
    const template = await this.prisma.template.update({ where: { id }, data: dto });
    await this.audit.record({ actorId, action: "template.updated", resourceType: "Template", resourceId: id, metadata: dto });
    return template;
  }

  /**
   * Projects pin a version and render from its scene graph and fields, so a template they use only leaves the catalog
   * (they keep opening and exporting); one nobody used is removed with its versions.
   */
  async remove(id: string, actorId: string) {
    const template = await this.get(id);
    const projectCount = await this.prisma.project.count({ where: { templateId: id } });
    if (projectCount > 0) {
      await this.prisma.template.update({ where: { id }, data: { deletedAt: new Date() } });
    } else {
      await this.prisma.template.delete({ where: { id } });
    }
    await this.audit.record({ actorId, action: "template.deleted", resourceType: "Template", resourceId: id, metadata: { name: template.name, projectCount } });
  }

  async uploadVersion(templateId: string, file: { buffer: Buffer; originalname: string; mimetype: string }, actorId: string) {
    await this.get(templateId);

    if (file.buffer.length === 0) throw new BadRequestException("Empty file.");
    if (file.buffer.length > MAX_PSD_UPLOAD_BYTES) throw new BadRequestException(`File exceeds the ${MAX_PSD_UPLOAD_BYTES} byte limit.`);
    // Sniff real content instead of trusting the extension/declared mimetype (spec §12).
    if (!file.buffer.subarray(0, 4).equals(PSD_MAGIC)) {
      throw new BadRequestException("File is not a valid PSD/PSB (bad signature).");
    }

    const asset = await this.storage.storeAsset({
      data: file.buffer,
      mimeType: "image/vnd.adobe.photoshop",
      ownerType: AssetOwnerType.TEMPLATE_SOURCE,
      hint: file.originalname,
    });

    const lastVersion = await this.prisma.templateVersion.findFirst({
      where: { templateId },
      orderBy: { versionNo: "desc" },
    });
    const versionNo = (lastVersion?.versionNo ?? 0) + 1;

    const version = await this.prisma.templateVersion.create({
      data: {
        templateId,
        versionNo,
        psdAssetId: asset.id,
        ingestStatus: IngestStatus.PENDING,
        createdById: actorId,
      },
    });

    await this.ingestionQueue.add(
      "ingest",
      { templateVersionId: version.id },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 },
    );

    await this.audit.record({ actorId, action: "template.version.uploaded", resourceType: "TemplateVersion", resourceId: version.id, metadata: { templateId, versionNo } });
    return version;
  }

  async getVersion(templateId: string, versionId: string) {
    const version = await this.prisma.templateVersion.findFirst({ where: { id: versionId, templateId } });
    if (!version) throw new NotFoundException("Template version not found.");
    return version;
  }

  async getSceneGraph(templateId: string, versionId: string): Promise<SceneGraph> {
    const version = await this.getVersion(templateId, versionId);
    if (version.ingestStatus !== IngestStatus.READY || !version.sceneGraph) {
      throw new BadRequestException(`Template version is not ready (status: ${version.ingestStatus}).`);
    }
    return version.sceneGraph as unknown as SceneGraph;
  }

  /** Streams one per-layer raster to the browser compositor; only assets this version's graph references are servable. */
  async getLayerAsset(templateId: string, versionId: string, assetId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const sceneGraph = await this.getSceneGraph(templateId, versionId);
    if (!referencedAssetIds(sceneGraph).has(assetId)) throw new NotFoundException("Asset not found in this template version.");
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerType !== AssetOwnerType.TEMPLATE_LAYER) throw new NotFoundException("Asset not found in this template version.");
    return { bytes: await this.storage.getAssetBytes(asset.storageKey), mimeType: asset.mimeType };
  }

  async updateNode(templateId: string, versionId: string, nodeId: string, dto: UpdateNodeDto, actorId: string) {
    await this.getVersion(templateId, versionId);
    if (dto.imageAssetId !== undefined) {
      const asset = await this.prisma.asset.findUnique({ where: { id: dto.imageAssetId } });
      // Only layer rasters: never let a template point at an end user's upload or an export.
      if (!asset || asset.ownerType !== AssetOwnerType.TEMPLATE_LAYER) throw new BadRequestException("Unknown layer image asset.");
    }
    const { node, previousImageAssetId, sync } = await this.withVersion(versionId, async (tx, version, sceneGraph) => {
      const target = nodeIn(sceneGraph, nodeId);
      const previous = rasterImageAssetId(target);
      if (dto.imageAssetId !== undefined) {
        assertImageReplaceable(target, version.publishedAt);
        target.imageAssetId = dto.imageAssetId;
      }
      if (dto.locked !== undefined) target.locked = dto.locked;
      const locksChanged = dto.locked !== undefined && !version.publishedAt;
      return { node: target, previousImageAssetId: previous, sync: locksChanged ? await syncFieldsWithLocks(tx, versionId, sceneGraph) : null };
    });
    await this.audit.record({
      actorId,
      action: "template.node.updated",
      resourceType: "TemplateVersion",
      resourceId: versionId,
      metadata: { templateId, nodeId, ...dto, ...(dto.imageAssetId !== undefined ? { previousImageAssetId } : {}), ...syncMetadata(sync) },
    });
    return { id: node.id, locked: node.locked ?? false, imageAssetId: rasterImageAssetId(node) };
  }

  /** Replaces a pixel/smart-object layer's own raster (the template's placeholder art), cover-fitted to the layer's bounds. */
  async replaceNodeImage(templateId: string, versionId: string, nodeId: string, file: { buffer: Buffer }, actorId: string) {
    const version = await this.getVersion(templateId, versionId);
    const sceneGraph = await this.getSceneGraph(templateId, versionId);
    const node = findNodeById(sceneGraph, nodeId);
    if (!node) throw new NotFoundException(`Node ${nodeId} does not exist in this template version's scene graph.`);
    assertImageReplaceable(node, version.publishedAt);

    if (file.buffer.length === 0) throw new BadRequestException("Empty file.");
    if (file.buffer.length > MAX_LAYER_IMAGE_BYTES) throw new BadRequestException(`Image exceeds the ${MAX_LAYER_IMAGE_BYTES} byte limit.`);
    const sniffed = sniffImageMime(file.buffer);
    if (!sniffed) throw new BadRequestException("Unsupported or unrecognized image file type (PNG, JPEG or WebP only).");

    const metadata = await sharp(file.buffer).metadata().catch(() => null);
    if (!metadata?.width || !metadata.height) throw new BadRequestException("Could not read image dimensions.");
    if (metadata.width * metadata.height > MAX_LAYER_IMAGE_PIXELS) throw new BadRequestException(`Image exceeds the ${MAX_LAYER_IMAGE_PIXELS} pixel limit.`);
    const { left, top, right, bottom } = node.bounds;
    const width = Math.max(1, Math.round(right - left));
    const height = Math.max(1, Math.round(bottom - top));
    // EXIF orientation swaps the effective dimensions.
    const [imageW, imageH] = (metadata.orientation ?? 1) >= 5 ? [metadata.height, metadata.width] : [metadata.width, metadata.height];
    // Placeholder art ships in print exports, so it may be cropped to fit but never upscaled.
    if (imageW < width || imageH < height) {
      throw new BadRequestException(`Image must be at least ${width}x${height}px to fill this layer without upscaling (got ${imageW}x${imageH}).`);
    }

    const png = await sharp(file.buffer).rotate().resize(width, height, { fit: "cover" }).png().toBuffer();
    const asset = await this.storage.storeAsset({ data: png, mimeType: "image/png", ownerType: AssetOwnerType.TEMPLATE_LAYER, hint: `layer_${nodeId}`, width, height });

    const previousImageAssetId = await this.withVersion(versionId, async (_tx, current, graph) => {
      const target = nodeIn(graph, nodeId);
      assertImageReplaceable(target, current.publishedAt);
      const previous = target.imageAssetId;
      target.imageAssetId = asset.id;
      return previous;
    });
    await this.audit.record({
      actorId,
      action: "template.node.image_replaced",
      resourceType: "TemplateVersion",
      resourceId: versionId,
      metadata: { templateId, nodeId, imageAssetId: asset.id, previousImageAssetId, width, height },
    });
    return { id: nodeId, imageAssetId: asset.id, previousImageAssetId, width, height };
  }

  /** Runs `work` on a ready version's scene graph and fields in one transaction, then saves the graph it may have edited. */
  private async withVersion<T>(versionId: string, work: (tx: Prisma.TransactionClient, version: TemplateVersion, sceneGraph: SceneGraph) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Row lock so concurrent edits on the same version can't overwrite each other's JSON or field edits.
      await tx.$queryRaw`SELECT id FROM template_versions WHERE id = ${versionId} FOR UPDATE`;
      const version = await tx.templateVersion.findUniqueOrThrow({ where: { id: versionId } });
      if (version.ingestStatus !== IngestStatus.READY || !version.sceneGraph) {
        throw new BadRequestException(`Template version is not ready (status: ${version.ingestStatus}).`);
      }
      const sceneGraph = version.sceneGraph as unknown as SceneGraph;
      const result = await work(tx, version, sceneGraph);
      await tx.templateVersion.update({ where: { id: versionId }, data: { sceneGraph: sceneGraph as object } });
      return result;
    });
  }

  /** Renders the template exactly as authored, no field overrides, as a PNG no larger than `maxDimension` on either side. */
  private async renderAsAuthored(templateId: string, versionId: string, maxDimension: number): Promise<Buffer> {
    const sceneGraph = await this.getSceneGraph(templateId, versionId);
    const scale = Math.min(1, maxDimension / Math.max(sceneGraph.width, sceneGraph.height));
    const compositor = new SceneCompositor(new DbBackedAssetSource(this.prisma, this.storage));
    return (await compositor.render(sceneGraph, { scale })).png;
  }

  /** The admin's field-mapping preview. */
  async preview(templateId: string, versionId: string): Promise<{ dataUrl: string }> {
    const png = await this.renderAsAuthored(templateId, versionId, ADMIN_PREVIEW_MAX_DIMENSION);
    return { dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  }

  /** The catalog card image. A published version's artwork can't change, so it's rendered once and kept. */
  async thumbnail(templateId: string, versionId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const version = await this.getVersion(templateId, versionId);
    if (!version.publishedAt) throw new NotFoundException("Only published template versions have a thumbnail.");
    if (version.thumbnailAssetId) {
      const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: version.thumbnailAssetId } });
      return { bytes: await this.storage.getAssetBytes(asset.storageKey), mimeType: asset.mimeType };
    }

    const png = await this.renderAsAuthored(templateId, versionId, THUMBNAIL_MAX_DIMENSION);
    const { data, info } = await sharp(png).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    const asset = await this.storage.storeAsset({ data, mimeType: "image/webp", ownerType: AssetOwnerType.TEMPLATE_THUMBNAIL, hint: `thumb_${versionId}`, width: info.width, height: info.height });
    // Concurrent first views each render one: the first saved is kept and the rest are discarded.
    const { count } = await this.prisma.templateVersion.updateMany({ where: { id: versionId, thumbnailAssetId: null }, data: { thumbnailAssetId: asset.id } });
    if (count === 0) {
      await this.prisma.asset.delete({ where: { id: asset.id } });
      await this.storage.deleteByKey(asset.storageKey);
    }
    return { bytes: data, mimeType: "image/webp" };
  }

  async listFields(templateId: string, versionId: string) {
    await this.getVersion(templateId, versionId);
    return this.prisma.templateField.findMany({ where: { templateVersionId: versionId }, orderBy: { order: "asc" } });
  }

  // Until a version is published, a layer is a field exactly when it's unlocked: creating a field unlocks its layer.
  async createField(templateId: string, versionId: string, dto: CreateFieldDto, actorId: string) {
    await this.getSceneGraph(templateId, versionId);
    const { field, sync } = await this.withVersion(versionId, async (tx, version, sceneGraph) => {
      const node = findNodeById(sceneGraph, dto.nodeId);
      if (!node) throw new BadRequestException(`Node ${dto.nodeId} does not exist in this template version's scene graph.`);
      if (await tx.templateField.findUnique({ where: { templateVersionId_nodeId: { templateVersionId: versionId, nodeId: dto.nodeId } } })) {
        throw new ConflictException(`“${node.name}” is already a field; update it instead.`);
      }
      if (!version.publishedAt) {
        const lock = lockingNode(sceneGraph, node.id);
        if (lock && lock !== node) throw new BadRequestException(`“${node.name}” is inside the locked group “${lock.name}”; unlock the group to make it editable.`);
        node.locked = false;
      }
      const field = await tx.templateField.create({
        data: {
          templateVersionId: versionId,
          nodeId: dto.nodeId,
          layerPath: dto.layerPath,
          fieldType: dto.fieldType,
          label: dto.label,
          order: dto.order,
          constraints: dto.constraints,
        },
      });
      return { field, sync: version.publishedAt ? null : await syncFieldsWithLocks(tx, versionId, sceneGraph) };
    });
    await this.audit.record({ actorId, action: "template.field.created", resourceType: "TemplateField", resourceId: field.id, metadata: { templateId, versionId, ...syncMetadata(sync) } });
    return field;
  }

  async updateField(templateId: string, versionId: string, fieldId: string, dto: UpdateFieldDto, actorId: string) {
    await this.getVersion(templateId, versionId);
    const existing = await this.prisma.templateField.findFirst({ where: { id: fieldId, templateVersionId: versionId } });
    if (!existing) throw new NotFoundException("Field not found.");
    const field = await this.prisma.templateField.update({ where: { id: fieldId }, data: dto });
    await this.audit.record({ actorId, action: "template.field.updated", resourceType: "TemplateField", resourceId: fieldId, metadata: dto });
    return field;
  }

  /** Removing a field from an unpublished version locks its layer, so the next sync doesn't bring the field back. */
  async removeField(templateId: string, versionId: string, fieldId: string, actorId: string) {
    await this.getVersion(templateId, versionId);
    const existing = await this.prisma.templateField.findFirst({ where: { id: fieldId, templateVersionId: versionId } });
    if (!existing) throw new NotFoundException("Field not found.");
    const sync = await this.withVersion(versionId, async (tx, version, sceneGraph) => {
      await tx.templateField.delete({ where: { id: fieldId } });
      if (version.publishedAt) return null;
      const node = findNodeById(sceneGraph, existing.nodeId);
      if (node) node.locked = true;
      return syncFieldsWithLocks(tx, versionId, sceneGraph);
    });
    await this.audit.record({ actorId, action: "template.field.deleted", resourceType: "TemplateField", resourceId: fieldId, metadata: { templateId, versionId, nodeId: existing.nodeId, ...syncMetadata(sync) } });
  }

  /** Publishing a version for the first time first syncs its fields with its lock state: every unlocked layer ships editable. */
  async publish(templateId: string, versionId: string, actorId: string) {
    const version = await this.getVersion(templateId, versionId);
    if (version.ingestStatus !== IngestStatus.READY) {
      throw new BadRequestException(`Cannot publish: ingestion status is "${version.ingestStatus}".`);
    }

    const { fieldCount, sync } = await this.withVersion(versionId, async (tx, current, sceneGraph) => {
      const sync = current.publishedAt ? null : await syncFieldsWithLocks(tx, versionId, sceneGraph);
      const fieldCount = await tx.templateField.count({ where: { templateVersionId: versionId } });
      if (fieldCount === 0) {
        throw new BadRequestException("Every layer is locked, so end users would have nothing to edit. Unlock at least one layer before publishing.");
      }
      await tx.templateVersion.update({ where: { id: versionId }, data: { publishedAt: new Date() } });
      await tx.template.update({ where: { id: templateId }, data: { currentVersionId: versionId, status: TemplateStatus.PUBLISHED } });
      return { fieldCount, sync };
    });

    await this.audit.record({ actorId, action: "template.published", resourceType: "TemplateVersion", resourceId: versionId, metadata: { templateId, fieldCount, ...syncMetadata(sync) } });
    return this.get(templateId);
  }
}
