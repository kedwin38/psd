import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IdPhotoService, MAX_ID_PHOTO_UPLOAD_BYTES } from "./id-photo.service";
import { CreateIdPhotoJobSchema, type CreateIdPhotoJobDto } from "./dto/id-photo.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("id-photos")
export class IdPhotoController {
  constructor(private readonly idPhotos: IdPhotoService) {}

  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_ID_PHOTO_UPLOAD_BYTES } }))
  create(@UploadedFile() file: Express.Multer.File | undefined, @Body(new ZodValidationPipe(CreateIdPhotoJobSchema)) body: CreateIdPhotoJobDto, @CurrentUser() user: AuthenticatedUser) {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file").');
    return this.idPhotos.create({ buffer: file.buffer }, body, user.id);
  }

  @Get()
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.idPhotos.listMine(user.id);
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.idPhotos.get(id, user.id);
  }
}
