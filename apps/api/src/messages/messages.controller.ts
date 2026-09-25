import { Body, Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { MessagesService, MAX_MESSAGE_IMAGE_BYTES } from "./messages.service";
import { SendMessageSchema, type SendMessageDto } from "./dto/message.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RoleName } from "../generated/prisma";

const isAdmin = (roles: RoleName[]) => roles.some((r) => r !== RoleName.END_USER);

/** The end user's own side of the admin<->user communication tab. */
@Controller("messages")
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get("mine")
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.listMine(user.id);
  }

  @Post("mine")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_MESSAGE_IMAGE_BYTES } }))
  send(@Body(new ZodValidationPipe(SendMessageSchema)) body: SendMessageDto, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.messages.sendFromUser(user.id, body, file ? { buffer: file.buffer } : undefined);
  }

  /** Full-quality bytes with a download-friendly filename, for a message either side of the thread can see. */
  @Get(":id/image")
  async image(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    const { bytes, mimeType } = await this.messages.getImage(id, { id: user.id, isAdmin: isAdmin(user.roles) });
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(bytes);
  }
}
