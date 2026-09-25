import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { ProjectsService } from "./projects.service";
import { CreateProjectSchema, PatchFieldValueSchema, RenameProjectSchema, type CreateProjectDto, type PatchFieldValueDto, type RenameProjectDto } from "./dto/project.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

const MAX_UPLOAD_IMAGE_BYTES = 25 * 1024 * 1024;

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.listMine(user.id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateProjectSchema)) body: CreateProjectDto, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.create(body, user.id, user.organizationId);
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.get(id, user.id);
  }

  @Patch(":id")
  rename(@Param("id") id: string, @Body(new ZodValidationPipe(RenameProjectSchema)) body: RenameProjectDto, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.rename(id, body, user.id);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.projects.remove(id, user.id);
    return { ok: true };
  }

  @Post(":id/uploads")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_IMAGE_BYTES } }))
  async upload(
    @Param("id") id: string,
    @Body("fieldId") fieldId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file").');
    if (!fieldId) throw new BadRequestException("fieldId is required.");
    return this.projects.uploadImage(id, fieldId, user.id, { buffer: file.buffer, mimetype: file.mimetype });
  }

  @Get(":id/assets/:assetId")
  async uploadedImage(@Param("id") id: string, @Param("assetId") assetId: string, @CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    const { bytes, mimeType } = await this.projects.getUpload(id, assetId, user.id);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(bytes);
  }

  @Put(":id/fields/:fieldId")
  patchField(
    @Param("id") id: string,
    @Param("fieldId") fieldId: string,
    @Body(new ZodValidationPipe(PatchFieldValueSchema)) body: PatchFieldValueDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.patchField(id, fieldId, body, user.id);
  }

  @Post(":id/preview")
  preview(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.preview(id, user.id);
  }
}
