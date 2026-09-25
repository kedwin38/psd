import { BadRequestException, Body, Controller, Delete, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { SettingsService, MAX_WATERMARK_BYTES } from "./settings.service";
import { UpdateWatermarkOpacitySchema, UploadWatermarkSchema, type UpdateWatermarkOpacityDto, type UploadWatermarkDto } from "./dto/settings.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { StepUp } from "../auth/decorators/step-up.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RoleName } from "../generated/prisma";
import type { AuthenticatedUser } from "../auth/auth.types";

const ADMIN_ROLES = [RoleName.SUPER_ADMIN, RoleName.CONTENT_ADMIN] as const;

@Controller("admin/settings")
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Roles(...ADMIN_ROLES)
  @StepUp()
  @Post("watermark")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_WATERMARK_BYTES } }))
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(UploadWatermarkSchema)) body: UploadWatermarkDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file").');
    return this.settings.upload({ buffer: file.buffer }, body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @StepUp()
  @Patch("watermark")
  setOpacity(@Body(new ZodValidationPipe(UpdateWatermarkOpacitySchema)) body: UpdateWatermarkOpacityDto, @CurrentUser() user: AuthenticatedUser) {
    return this.settings.setOpacity(body, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @StepUp()
  @Delete("watermark")
  remove(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.remove(user.id);
  }
}
