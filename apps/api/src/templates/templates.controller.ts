import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { TemplatesService, MAX_PSD_UPLOAD_BYTES } from "./templates.service";
import { CreateFieldSchema, CreateTemplateSchema, UpdateFieldSchema, UpdateTemplateSchema, type CreateFieldDto, type CreateTemplateDto, type UpdateFieldDto, type UpdateTemplateDto } from "./dto/template.dto";
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
