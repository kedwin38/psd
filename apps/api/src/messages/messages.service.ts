import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { sniffImageMime } from "../common/image-sniff";
import { AssetOwnerType, MessageAuthorRole } from "../generated/prisma";
import type { SendMessageDto } from "./dto/message.dto";

export const MAX_MESSAGE_IMAGE_BYTES = 15 * 1024 * 1024;

const MESSAGE_SUMMARY = {
  id: true,
  threadUserId: true,
  authorId: true,
  authorRole: true,
  body: true,
  imageAssetId: true,
  createdAt: true,
  readAt: true,
  author: { select: { displayName: true, email: true } },
} as const;

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** The end user's own thread with the admin team, oldest first; opening it marks every admin reply as read. */
  async listMine(userId: string) {
    const messages = await this.prisma.message.findMany({ where: { threadUserId: userId }, orderBy: { createdAt: "asc" }, select: MESSAGE_SUMMARY });
    await this.markRead(userId, MessageAuthorRole.ADMIN);
    return messages;
  }

  async sendFromUser(userId: string, dto: SendMessageDto, file: { buffer: Buffer } | undefined) {
    return this.send({ threadUserId: userId, authorId: userId, authorRole: MessageAuthorRole.END_USER }, dto, file);
  }

  /** Any admin may answer any user's thread; the thread is keyed by the user, not by which admin replies. */
  async sendFromAdmin(threadUserId: string, adminId: string, dto: SendMessageDto, file: { buffer: Buffer } | undefined) {
    const user = await this.prisma.user.findUnique({ where: { id: threadUserId } });
    if (!user) throw new NotFoundException("User not found.");
    return this.send({ threadUserId, authorId: adminId, authorRole: MessageAuthorRole.ADMIN }, dto, file);
  }

  private async send(who: { threadUserId: string; authorId: string; authorRole: MessageAuthorRole }, dto: SendMessageDto, file: { buffer: Buffer } | undefined) {
    if (!dto.body && !file) throw new BadRequestException("A message needs text, an image, or both.");

    let imageAssetId: string | undefined;
    if (file) {
      if (file.buffer.length > MAX_MESSAGE_IMAGE_BYTES) throw new BadRequestException(`Image exceeds the ${MAX_MESSAGE_IMAGE_BYTES} byte limit.`);
      const mimeType = sniffImageMime(file.buffer);
      if (!mimeType) throw new BadRequestException("The attached file isn't a PNG, JPEG, or WebP image.");
      const asset = await this.storage.storeAsset({ data: file.buffer, mimeType, ownerType: AssetOwnerType.MESSAGE_IMAGE, hint: "message" });
      imageAssetId = asset.id;
    }

    const message = await this.prisma.message.create({
      data: { threadUserId: who.threadUserId, authorId: who.authorId, authorRole: who.authorRole, body: dto.body, imageAssetId },
      select: MESSAGE_SUMMARY,
    });
    return message;
  }

  private async markRead(threadUserId: string, whoseMessagesGotRead: MessageAuthorRole): Promise<void> {
    await this.prisma.message.updateMany({
      where: { threadUserId, authorRole: whoseMessagesGotRead, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Every thread with its last message and how many are still unread by an admin — the admin inbox list. */
  async listThreadsForAdmin() {
    const threadUserIds = await this.prisma.message.findMany({ distinct: ["threadUserId"], select: { threadUserId: true } });
    const threads = await Promise.all(
      threadUserIds.map(async ({ threadUserId }) => {
        const [user, last, unread] = await Promise.all([
          this.prisma.user.findUnique({ where: { id: threadUserId }, select: { id: true, email: true, displayName: true } }),
          this.prisma.message.findFirst({ where: { threadUserId }, orderBy: { createdAt: "desc" }, select: MESSAGE_SUMMARY }),
          this.prisma.message.count({ where: { threadUserId, authorRole: MessageAuthorRole.END_USER, readAt: null } }),
        ]);
        return { user, lastMessage: last, unreadCount: unread };
      }),
    );
    return threads.filter((t) => t.user).sort((a, b) => (b.lastMessage?.createdAt.getTime() ?? 0) - (a.lastMessage?.createdAt.getTime() ?? 0));
  }

  /** Opening a thread in the admin console marks every message the user sent as read. */
  async getThreadForAdmin(threadUserId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: threadUserId }, select: { id: true, email: true, displayName: true } });
    if (!user) throw new NotFoundException("User not found.");
    const messages = await this.prisma.message.findMany({ where: { threadUserId }, orderBy: { createdAt: "asc" }, select: MESSAGE_SUMMARY });
    await this.markRead(threadUserId, MessageAuthorRole.END_USER);
    return { user, messages };
  }

  /** The image's full-quality bytes; only the thread's own user or an admin (any admin, matching read access) may fetch them. */
  async getImage(messageId: string, caller: { id: string; isAdmin: boolean }) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || !message.imageAssetId) throw new NotFoundException("Message image not found.");
    if (message.threadUserId !== caller.id && !caller.isAdmin) throw new ForbiddenException("You cannot view this image.");
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { id: message.imageAssetId } });
    return { bytes: await this.storage.getAssetBytes(asset.storageKey), mimeType: asset.mimeType };
  }
}
