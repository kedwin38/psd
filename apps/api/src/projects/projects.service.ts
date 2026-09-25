import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import sharp from "sharp";
import { SceneCompositor } from "@psd-studio/psd-engine";
import type { ImageFieldConstraints, TextFieldConstraints } from "@psd-studio/scene-graph";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { DbBackedAssetSource } from "../rendering/db-asset-source";
import { loadFieldOverrides } from "../rendering/field-overrides";
import { AssetOwnerType, ProjectStatus, TemplateStatus } from "../generated/prisma";
import { sniffImageMime } from "../common/image-sniff";
import type { CreateProjectDto, PatchFieldValueDto, RenameProjectDto } from "./dto/project.dto";

const PREVIEW_MAX_DIMENSION = 1000;
const MAX_UPLOAD_IMAGE_PIXELS = 100_000_000;

/** End users are limited to this many not-yet-exported projects at once (product decision, gallery §"Your projects"). */
const MAX_PENDING_PROJECTS = 2;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async create(dto: CreateProjectDto, userId: string, organizationId: string | null) {
    const template = await this.prisma.template.findFirst({ where: { id: dto.templateId, deletedAt: null } });
    if (!template || template.status !== TemplateStatus.PUBLISHED || !template.currentVersionId) {
      throw new BadRequestException("Template is not published.");
    }
    const currentVersionId = template.currentVersionId;

    const project = await this.prisma.$transaction(async (tx) => {
      // Serializes this user's count-then-create against a concurrent one (e.g. a double-submit), so two
      // near-simultaneous requests can't both read "1 pending" and both create, over-admitting past the cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('projects.pending_cap'), hashtext(${userId}))`;
      const pendingCount = await tx.project.count({ where: { userId, status: ProjectStatus.IN_PROGRESS } });
      if (pendingCount >= MAX_PENDING_PROJECTS) {
        throw new ConflictException(`You already have ${MAX_PENDING_PROJECTS} pending projects. Clear one to start another.`);
      }
      return tx.project.create({
        data: {
          userId,
          organizationId,
          templateId: template.id,
          templateVersionId: currentVersionId,
          name: dto.name,
        },
      });
    });
    await this.audit.record({ actorId: userId, action: "project.created", resourceType: "Project", resourceId: project.id });
    return project;
  }

  private async getOwned(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (project.userId !== userId) throw new ForbiddenException("You do not own this project.");
    return project;
  }

  async get(projectId: string, userId: string) {
    const project = await this.getOwned(projectId, userId);
    const fieldValues = await this.prisma.projectFieldValue.findMany({ where: { projectId }, include: { templateField: true } });
    return { ...project, fieldValues };
  }

  async listMine(userId: string) {
    return this.prisma.project.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  async uploadImage(projectId: string, fieldId: string, userId: string, file: { buffer: Buffer; mimetype: string }) {
    const project = await this.getOwned(projectId, userId);
    const field = await this.prisma.templateField.findFirst({ where: { id: fieldId, templateVersionId: project.templateVersionId } });
    if (!field || (field.fieldType !== "IMAGE" && field.fieldType !== "SMART_OBJECT")) {
      throw new BadRequestException("Not an image or smart-object field for this project's template.");
    }
    const constraints = field.constraints as unknown as ImageFieldConstraints;

    const sniffed = sniffImageMime(file.buffer);
    if (!sniffed || !constraints.allowedMimeTypes.includes(sniffed as never)) {
      throw new BadRequestException("Unsupported or unrecognized image file type.");
    }
    if (file.buffer.length > constraints.maxUploadBytes) {
      throw new BadRequestException(`Image exceeds the ${constraints.maxUploadBytes} byte limit for this field.`);
    }

    const metadata = await sharp(file.buffer).metadata().catch(() => null);
    if (!metadata?.width || !metadata.height) throw new BadRequestException("Could not read image dimensions.");
    // Browsers decode uploads whole for the live editor canvas, so bound the decoded size like layer images.
    if (metadata.width * metadata.height > MAX_UPLOAD_IMAGE_PIXELS) throw new BadRequestException(`Image exceeds the ${MAX_UPLOAD_IMAGE_PIXELS} pixel limit.`);
    // EXIF orientation swaps the effective dimensions; every renderer draws the upload upright.
    const [width, height] = (metadata.orientation ?? 1) >= 5 ? [metadata.height, metadata.width] : [metadata.width, metadata.height];
    if (width < constraints.minWidthPx || height < constraints.minHeightPx) {
      throw new BadRequestException(`Image must be at least ${constraints.minWidthPx}x${constraints.minHeightPx}px.`);
    }

    const asset = await this.storage.storeAsset({
      data: file.buffer,
      mimeType: sniffed,
      ownerType: AssetOwnerType.USER_UPLOAD,
      hint: `project_${projectId}_field_${fieldId}`,
      width,
      height,
      projectId,
    });
    return { assetId: asset.id, width, height };
  }

  /** Streams one of this project's own uploads to the browser editor's canvas. */
  async getUpload(projectId: string, assetId: string, userId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    await this.getOwned(projectId, userId);
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerType !== AssetOwnerType.USER_UPLOAD || asset.projectId !== projectId) throw new NotFoundException("Upload not found in this project.");
    return { bytes: await this.storage.getAssetBytes(asset.storageKey), mimeType: asset.mimeType };
  }

  async patchField(projectId: string, fieldId: string, dto: PatchFieldValueDto, userId: string) {
    const project = await this.getOwned(projectId, userId);
    const field = await this.prisma.templateField.findFirst({ where: { id: fieldId, templateVersionId: project.templateVersionId } });
    if (!field) throw new NotFoundException("Field not found on this project's template version.");

    this.assertValueMatchesField(field.fieldType, field.constraints, dto);

    if (dto.type === "image") {
      const asset = await this.prisma.asset.findUnique({ where: { id: dto.imageAssetId } });
      // Only this project's own uploads: never another user's photo or a template/export asset.
      if (!asset || asset.ownerType !== AssetOwnerType.USER_UPLOAD || asset.projectId !== projectId) {
        throw new BadRequestException("Unknown uploaded image asset; upload it to this project first via /projects/:id/uploads.");
      }
    }

    const value = await this.prisma.projectFieldValue.upsert({
      where: { projectId_templateFieldId: { projectId, templateFieldId: fieldId } },
      create: { projectId, templateFieldId: fieldId, value: dto as object },
      update: { value: dto as object },
    });
    await this.prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    return value;
  }

  private assertValueMatchesField(fieldType: string, constraintsJson: unknown, dto: PatchFieldValueDto): void {
    if (fieldType === "TEXT" && dto.type === "text") {
      const c = constraintsJson as TextFieldConstraints;
      if (dto.text.length > c.maxLength) throw new BadRequestException(`Text exceeds the ${c.maxLength} character limit for this field.`);
      if (c.required && dto.text.trim().length === 0) throw new BadRequestException("This field is required.");
      return;
    }
    if ((fieldType === "IMAGE" || fieldType === "SMART_OBJECT") && dto.type === "image") return;
    if (fieldType === "VISIBILITY" && dto.type === "visibility") return;
    throw new BadRequestException(`Value type "${dto.type}" does not match field type "${fieldType}".`);
  }

  async preview(projectId: string, userId: string): Promise<{ dataUrl: string }> {
    const project = await this.getOwned(projectId, userId);
    const version = await this.prisma.templateVersion.findUniqueOrThrow({ where: { id: project.templateVersionId } });
    const sceneGraph = version.sceneGraph as unknown as import("@psd-studio/scene-graph").SceneGraph;
    const overrides = await loadFieldOverrides(this.prisma, projectId);

    const scale = Math.min(1, PREVIEW_MAX_DIMENSION / Math.max(sceneGraph.width, sceneGraph.height));
    const compositor = new SceneCompositor(new DbBackedAssetSource(this.prisma, this.storage));
    const result = await compositor.render(sceneGraph, { scale, overrides });
    return { dataUrl: `data:image/png;base64,${result.png.toString("base64")}` };
  }

  /** Lets an end user tell their pending projects apart in the gallery. */
  async rename(projectId: string, dto: RenameProjectDto, userId: string) {
    await this.getOwned(projectId, userId);
    const project = await this.prisma.project.update({ where: { id: projectId }, data: { name: dto.name } });
    await this.audit.record({ actorId: userId, action: "project.renamed", resourceType: "Project", resourceId: projectId, metadata: { name: dto.name } });
    return project;
  }

  /**
   * Frees up a pending slot. Deletes the project (its field values and export-job rows cascade in the schema) along
   * with its uploaded-photo assets, including their real storage bytes — not just the DB rows. A completed export's
   * output file is deliberately left alone: it's a finished, possibly already-downloaded artifact, not a draft, and
   * the export-job row that would let anyone re-derive its download link is gone the moment the project is (cascade),
   * so nothing can serve it going forward either way.
   */
  async remove(projectId: string, userId: string): Promise<void> {
    await this.getOwned(projectId, userId);
    const uploads = await this.prisma.asset.findMany({ where: { projectId, ownerType: AssetOwnerType.USER_UPLOAD } });

    await this.prisma.$transaction([
      this.prisma.asset.deleteMany({ where: { id: { in: uploads.map((a) => a.id) } } }),
      this.prisma.project.delete({ where: { id: projectId } }),
    ]);

    // Best-effort: the DB rows are already gone (the source of truth for "does this project still exist"), so a
    // storage hiccup here leaves orphaned bytes rather than an inconsistent, half-deleted project.
    await Promise.all(uploads.map((asset) => this.storage.deleteByKey(asset.storageKey).catch(() => undefined)));

    await this.audit.record({ actorId: userId, action: "project.deleted", resourceType: "Project", resourceId: projectId });
  }
}
