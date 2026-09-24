import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { TemplatesService, MAX_LAYER_IMAGE_BYTES, MAX_PSD_UPLOAD_BYTES } from "./templates.service";
import {
  CreateFieldSchema,
  CreateTemplateSchema,
  UpdateFieldSchema,
  UpdateNodeSchema,
  UpdateTemplateSchema,
  type CreateFieldDto,
  type CreateTemplateDto,
  type UpdateFieldDto,
  type UpdateNodeDto,
  type UpdateTemplateDto,
} from "./dto/template.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { StepUp } from "../auth/decorators/step-up.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RoleName } from "../generated/prisma";
import type { AuthenticatedUser } from "../auth/auth.types";

const ADMIN_ROLES = [RoleName.SUPER_ADMIN, RoleName.CONTENT_ADMIN] as const;

@Controller("templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Public()
  @Get()
  list(@Query("categoryId") categoryId?: string) {
    return this.templates.listPublished(categoryId);
  }

  @Roles(...ADMIN_ROLES)
  @Get("admin/all")
  listAllForAdmin() {
    return this.templates.listAllForAdmin();
  }

  @Public()
  @Get(":id")
  get(@Param("id") id: string) {
    return this.templates.get(id);
  }

  @Roles(...ADMIN_ROLES)
  @Post()
  create(@Body(new ZodValidationPipe(CreateTemplateSchema)) body: CreateTemplateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.templates.create(body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Patch(":id")
  update(@Param("id") id: string, @Body(new ZodValidationPipe(UpdateTemplateSchema)) body: UpdateTemplateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.templates.update(id, body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Post(":id/versions")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_PSD_UPLOAD_BYTES } }))
  uploadVersion(@Param("id") id: string, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file").');
    return this.templates.uploadVersion(id, { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype }, user.id);
  }

  @Get(":id/versions/:versionId")
  getVersion(@Param("id") id: string, @Param("versionId") versionId: string) {
    return this.templates.getVersion(id, versionId);
  }

  @Get(":id/versions/:versionId/scene-graph")
  getSceneGraph(@Param("id") id: string, @Param("versionId") versionId: string) {
    return this.templates.getSceneGraph(id, versionId);
  }

  @Get(":id/versions/:versionId/fields")
  listFields(@Param("id") id: string, @Param("versionId") versionId: string) {
    return this.templates.listFields(id, versionId);
  }

  // A template can have hundreds of layers, so this route gets its own budget instead of draining the global one.
  @Throttle({ default: { limit: 3000, ttl: 60_000 } })
  @Get(":id/versions/:versionId/layer-assets/:assetId")
  async layerAsset(@Param("id") id: string, @Param("versionId") versionId: string, @Param("assetId") assetId: string, @Res() res: Response) {
    const { bytes, mimeType } = await this.templates.getLayerAsset(id, versionId, assetId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(bytes);
  }

  @Roles(...ADMIN_ROLES)
  @Patch(":id/versions/:versionId/nodes/:nodeId")
  updateNode(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Param("nodeId") nodeId: string,
    @Body(new ZodValidationPipe(UpdateNodeSchema)) body: UpdateNodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.templates.updateNode(id, versionId, nodeId, body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Post(":id/versions/:versionId/nodes/:nodeId/image")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_LAYER_IMAGE_BYTES } }))
  replaceNodeImage(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Param("nodeId") nodeId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file").');
    return this.templates.replaceNodeImage(id, versionId, nodeId, { buffer: file.buffer }, user.id);
  }

  @Get(":id/versions/:versionId/preview")
  preview(@Param("id") id: string, @Param("versionId") versionId: string) {
    return this.templates.preview(id, versionId);
  }

  @Roles(...ADMIN_ROLES)
  @Post(":id/versions/:versionId/fields")
  createField(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Body(new ZodValidationPipe(CreateFieldSchema)) body: CreateFieldDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.templates.createField(id, versionId, body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Patch(":id/versions/:versionId/fields/:fieldId")
  updateField(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Param("fieldId") fieldId: string,
    @Body(new ZodValidationPipe(UpdateFieldSchema)) body: UpdateFieldDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.templates.updateField(id, versionId, fieldId, body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Delete(":id/versions/:versionId/fields/:fieldId")
  async removeField(@Param("id") id: string, @Param("versionId") versionId: string, @Param("fieldId") fieldId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.templates.removeField(id, versionId, fieldId, user.id);
    return { ok: true };
  }

  @Roles(...ADMIN_ROLES)
  @StepUp()
  @Post(":id/versions/:versionId/publish")
  publish(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.templates.publish(id, versionId, user.id);
  }
}
