import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { MessagesService, MAX_MESSAGE_IMAGE_BYTES } from "./messages.service";
import { SendMessageSchema, type SendMessageDto } from "./dto/message.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RoleName } from "../generated/prisma";

const ADMIN_ROLES = [RoleName.SUPER_ADMIN, RoleName.CONTENT_ADMIN, RoleName.ORG_ADMIN] as const;

/** The admin side of the communication tab — every admin shares one inbox of per-user threads. */
@Controller("admin/messages")
export class AdminMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Roles(...ADMIN_ROLES)
  @Get()
  listThreads() {
    return this.messages.listThreadsForAdmin();
  }

  @Roles(...ADMIN_ROLES)
  @Get(":userId")
  getThread(@Param("userId") userId: string) {
    return this.messages.getThreadForAdmin(userId);
  }

  @Roles(...ADMIN_ROLES)
  @Post(":userId")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_MESSAGE_IMAGE_BYTES } }))
  reply(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(SendMessageSchema)) body: SendMessageDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.messages.sendFromAdmin(userId, admin.id, body, file ? { buffer: file.buffer } : undefined);
  }
}
