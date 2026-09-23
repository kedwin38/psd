import { BadRequestException, Body, Controller, Get, Param, Post, Put, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ProjectsService } from "./projects.service";
import { CreateProjectSchema, PatchFieldValueSchema, type CreateProjectDto, type PatchFieldValueDto } from "./dto/project.dto";
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
