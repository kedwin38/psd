import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { sniffImageMime } from "../common/image-sniff";
import { ID_PHOTO_QUEUE_TOKEN } from "../queue/queue.module";
import type { IdPhotoJobData } from "../queue/queue.constants";
import { AssetOwnerType, IdPhotoStatus } from "../generated/prisma";
import type { CreateIdPhotoJobDto } from "./dto/id-photo.dto";

export const MAX_ID_PHOTO_UPLOAD_BYTES = 20 * 1024 * 1024;

@Injectable()
export class IdPhotoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(ID_PHOTO_QUEUE_TOKEN) private readonly queue: Queue<IdPhotoJobData>,
  ) {}

  async create(file: { buffer: Buffer }, dto: CreateIdPhotoJobDto, userId: string) {
    if (!file.buffer.length) throw new BadRequestException("Empty file.");
    if (file.buffer.length > MAX_ID_PHOTO_UPLOAD_BYTES) throw new BadRequestException(`Image exceeds the ${MAX_ID_PHOTO_UPLOAD_BYTES} byte limit.`);
    const mimeType = sniffImageMime(file.buffer);
    if (!mimeType) throw new BadRequestException("The uploaded file isn't a PNG, JPEG, or WebP image.");

    const asset = await this.storage.storeAsset({ data: file.buffer, mimeType, ownerType: AssetOwnerType.ID_PHOTO_SOURCE, hint: "id-photo-source" });
    const job = await this.prisma.idPhotoJob.create({
      data: { userId, standard: dto.standard, status: IdPhotoStatus.QUEUED, sourceAssetId: asset.id },
    });
    await this.queue.add("process", { idPhotoJobId: job.id }, { attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
    return job;
  }

  async get(id: string, userId: string) {
    const job = await this.prisma.idPhotoJob.findUnique({ where: { id }, include: { outputAsset: true } });
    if (!job) throw new NotFoundException("ID photo job not found.");
    if (job.userId !== userId) throw new ForbiddenException("You do not own this job.");

    if (job.status === IdPhotoStatus.COMPLETE && job.outputAsset) {
      const filename = `id-photo-${job.standard.toLowerCase()}.png`;
      const downloadUrl = await this.storage.getSignedDownloadUrl(job.outputAsset.storageKey, 600, filename);
      return { ...job, downloadUrl };
    }
    return job;
  }

  async listMine(userId: string) {
    return this.prisma.idPhotoJob.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }
}
