import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import sharp from "sharp";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { FaceDetectorService } from "../id-photo/face-detector";
import { SegmentationService } from "../id-photo/segmentation";
import { detectLeveledFace } from "../id-photo/level";
import { processIdPhoto } from "../id-photo/processor";
import { ID_PHOTO_QUEUE, type IdPhotoJobData } from "../queue/queue.constants";
import { AssetOwnerType, IdPhotoStatus } from "../generated/prisma";

function connectionFromUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined };
}

/** Runs the ID-photo correction pipeline (face detection -> crop/white-balance/background) off the request thread. */
@Injectable()
export class IdPhotoProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdPhotoProcessorService.name);
  private worker?: Worker<IdPhotoJobData>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly faceDetector: FaceDetectorService,
    private readonly segmenter: SegmentationService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<IdPhotoJobData>(ID_PHOTO_QUEUE, (job) => this.process(job), {
      connection: connectionFromUrl(this.config.get("REDIS_URL")),
      concurrency: 1, // face detection is CPU-bound; keep it from starving the render worker's cores
    });
    this.worker.on("failed", (job, err) => this.logger.error(`ID photo job ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<IdPhotoJobData>): Promise<void> {
    const { idPhotoJobId } = job.data;
    const record = await this.prisma.idPhotoJob.findUniqueOrThrow({ where: { id: idPhotoJobId } });
    await this.prisma.idPhotoJob.update({ where: { id: idPhotoJobId }, data: { status: IdPhotoStatus.PROCESSING } });

    try {
      const sourceAsset = await this.prisma.asset.findUniqueOrThrow({ where: { id: record.sourceAssetId } });
      const sourceBuffer = await this.storage.getAssetBytes(sourceAsset.storageKey);

      // Auto-orient from EXIF first so every downstream pixel coordinate (face detection, crop,
      // level) is measured against the same upright frame the subject actually sees.
      const uprightSource = await sharp(sourceBuffer).rotate().png().toBuffer();
      const leveled = await detectLeveledFace(uprightSource, this.faceDetector);
      const { png, report } = await processIdPhoto(leveled.png, record.standard, leveled.face, this.segmenter, leveled.rolledDegrees);

      const outputAsset = await this.storage.storeAsset({
        data: png,
        mimeType: "image/png",
        ownerType: AssetOwnerType.ID_PHOTO_OUTPUT,
        hint: `id-photo-${idPhotoJobId}.png`,
        width: report.outputWidthPx,
        height: report.outputHeightPx,
      });

      await this.prisma.idPhotoJob.update({
        where: { id: idPhotoJobId },
        data: { status: IdPhotoStatus.COMPLETE, outputAssetId: outputAsset.id, report: report as unknown as object, completedAt: new Date() },
      });
      await this.audit.record({
        actorId: record.userId,
        action: "id_photo.completed",
        resourceType: "IdPhotoJob",
        resourceId: idPhotoJobId,
        metadata: { standard: record.standard, overallPass: report.overallPass },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.idPhotoJob.update({ where: { id: idPhotoJobId }, data: { status: IdPhotoStatus.FAILED, error: message } });
      await this.audit.record({ actorId: record.userId, action: "id_photo.failed", resourceType: "IdPhotoJob", resourceId: idPhotoJobId, metadata: { error: message } });
      throw error;
    }
  }
}
