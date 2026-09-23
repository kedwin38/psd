import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { Inject } from "@nestjs/common";
import { findNodeById, type SceneGraph } from "@psd-studio/scene-graph";
import { SceneCompositor } from "@psd-studio/psd-engine";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { DbBackedAssetSource } from "../rendering/db-asset-source";
import { INGESTION_QUEUE_TOKEN } from "../queue/queue.module";
import type { IngestionJobData } from "../queue/queue.constants";
import { AssetOwnerType, IngestStatus, TemplateStatus } from "../generated/prisma";
import type { CreateFieldDto, CreateTemplateDto, UpdateFieldDto, UpdateTemplateDto } from "./dto/template.dto";

const ADMIN_PREVIEW_MAX_DIMENSION = 1000;

const PSD_MAGIC = Buffer.from("8BPS", "ascii");
export const MAX_PSD_UPLOAD_BYTES = 200 * 1024 * 1024;

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
      include: { currentVersion: { select: { id: true, versionNo: true, nativeDpi: true } }, versions: { select: { id: true, versionNo: true, ingestStatus: true }, orderBy: { versionNo: "desc" } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async listPublished(categoryId?: string) {
    return this.prisma.template.findMany({
      where: { status: TemplateStatus.PUBLISHED, ...(categoryId ? { categoryId } : {}) },
      include: { currentVersion: { select: { id: true, versionNo: true, nativeDpi: true } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async get(id: string) {
    const template = await this.prisma.template.findUnique({
      where: { id },
      include: { currentVersion: true },
    });
    if (!template) throw new NotFoundException("Template not found.");
    return template;
  }

  async create(dto: CreateTemplateDto, actorId: string) {
    const category = await this.prisma.templateCategory.findUnique({ where: { id: dto.categoryId } });
    if (!category) throw new BadRequestException("Unknown category.");
    const template = await this.prisma.template.create({
      data: { name: dto.name, categoryId: dto.categoryId, visibilityScope: dto.visibilityScope, status: TemplateStatus.DRAFT },
    });
    await this.audit.record({ actorId, action: "template.created", resourceType: "Template", resourceId: template.id });
    return template;
  }

  async update(id: string, dto: UpdateTemplateDto, actorId: string) {
    await this.get(id);
    const template = await this.prisma.template.update({ where: { id }, data: dto });
    await this.audit.record({ actorId, action: "template.updated", resourceType: "Template", resourceId: id, metadata: dto });
    return template;
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

  /** Renders the template exactly as authored, no field overrides — the admin's field-mapping preview. */
  async preview(templateId: string, versionId: string): Promise<{ dataUrl: string }> {
    const sceneGraph = await this.getSceneGraph(templateId, versionId);
    const scale = Math.min(1, ADMIN_PREVIEW_MAX_DIMENSION / Math.max(sceneGraph.width, sceneGraph.height));
    const compositor = new SceneCompositor(new DbBackedAssetSource(this.prisma, this.storage));
    const result = await compositor.render(sceneGraph, { scale });
    return { dataUrl: `data:image/png;base64,${result.png.toString("base64")}` };
  }

  async listFields(templateId: string, versionId: string) {
    await this.getVersion(templateId, versionId);
    return this.prisma.templateField.findMany({ where: { templateVersionId: versionId }, orderBy: { order: "asc" } });
  }

  async createField(templateId: string, versionId: string, dto: CreateFieldDto, actorId: string) {
    const sceneGraph = await this.getSceneGraph(templateId, versionId);
    if (!findNodeById(sceneGraph, dto.nodeId)) {
      throw new BadRequestException(`Node ${dto.nodeId} does not exist in this template version's scene graph.`);
    }
    const field = await this.prisma.templateField.create({
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
    await this.audit.record({ actorId, action: "template.field.created", resourceType: "TemplateField", resourceId: field.id, metadata: { templateId, versionId } });
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

  async removeField(templateId: string, versionId: string, fieldId: string, actorId: string) {
    await this.getVersion(templateId, versionId);
    const existing = await this.prisma.templateField.findFirst({ where: { id: fieldId, templateVersionId: versionId } });
    if (!existing) throw new NotFoundException("Field not found.");
    await this.prisma.templateField.delete({ where: { id: fieldId } });
    await this.audit.record({ actorId, action: "template.field.deleted", resourceType: "TemplateField", resourceId: fieldId });
  }

  async publish(templateId: string, versionId: string, actorId: string) {
    const version = await this.getVersion(templateId, versionId);
    if (version.ingestStatus !== IngestStatus.READY) {
      throw new BadRequestException(`Cannot publish: ingestion status is "${version.ingestStatus}".`);
    }
    const fields = await this.prisma.templateField.findMany({ where: { templateVersionId: versionId } });
    if (fields.length === 0) {
      throw new BadRequestException("Cannot publish a template version with no editable fields mapped.");
    }

    await this.prisma.$transaction([
      this.prisma.templateVersion.update({ where: { id: versionId }, data: { publishedAt: new Date() } }),
      this.prisma.template.update({
        where: { id: templateId },
        data: { currentVersionId: versionId, status: TemplateStatus.PUBLISHED },
      }),
    ]);

    await this.audit.record({ actorId, action: "template.published", resourceType: "TemplateVersion", resourceId: versionId, metadata: { templateId, fieldCount: fields.length } });
    return this.get(templateId);
  }
}
