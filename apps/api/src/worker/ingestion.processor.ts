import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import { parsePsdBuffer, type AssetSink } from "@psd-studio/psd-engine";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { INGESTION_QUEUE, type IngestionJobData } from "../queue/queue.constants";
import { AssetOwnerType, IngestStatus } from "../generated/prisma";

function connectionFromUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined };
}

/** Stores each extracted layer raster as a real Asset row + object-storage blob. */
class PrismaAssetSink implements AssetSink {
  constructor(
    private readonly storage: StorageService,
    private readonly templateVersionId: string,
  ) {}

  async putImage(png: Buffer, hint: string): Promise<string> {
    const asset = await this.storage.storeAsset({
      data: png,
      mimeType: "image/png",
      ownerType: AssetOwnerType.TEMPLATE_LAYER,
      hint: `${this.templateVersionId}_${hint}`,
    });
    return asset.id;
  }
}

/**
 * Ingestion worker (spec §5, §10): parses an uploaded PSD into the scene
 * graph and rasterized layer assets, entirely via @psd-studio/psd-engine —
 * the same engine the compositor and export worker use, so a template's
 * field-mapping preview and its final export are guaranteed to agree.
 */
@Injectable()
export class IngestionProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionProcessorService.name);
  private worker?: Worker<IngestionJobData>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<IngestionJobData>(
      INGESTION_QUEUE,
      (job) => this.process(job),
      { connection: connectionFromUrl(this.config.get("REDIS_URL")), concurrency: 2 },
    );
    this.worker.on("failed", (job, err) => this.logger.error(`Ingestion job ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<IngestionJobData>): Promise<void> {
    const { templateVersionId } = job.data;
    const version = await this.prisma.templateVersion.findUniqueOrThrow({
      where: { id: templateVersionId },
      include: { psdAsset: true },
    });

    await this.prisma.templateVersion.update({ where: { id: templateVersionId }, data: { ingestStatus: IngestStatus.PARSING } });

    try {
      const bytes = await this.storage.getAssetBytes(version.psdAsset.storageKey);
      const sink = new PrismaAssetSink(this.storage, templateVersionId);
      const { sceneGraph, warnings } = await parsePsdBuffer(bytes, sink);

      await this.prisma.templateVersion.update({
        where: { id: templateVersionId },
        data: {
          sceneGraph: sceneGraph as object,
          nativeDpi: sceneGraph.dpi,
          colorProfile: sceneGraph.colorMode,
          ingestStatus: IngestStatus.READY,
          ingestWarnings: warnings as unknown as object,
          ingestError: null,
        },
      });
      await this.audit.record({
        action: "template.version.ingested",
        resourceType: "TemplateVersion",
        resourceId: templateVersionId,
        metadata: { warningCount: warnings.length },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.templateVersion.update({
        where: { id: templateVersionId },
        data: { ingestStatus: IngestStatus.FAILED, ingestError: message },
      });
      await this.audit.record({
        action: "template.version.ingest_failed",
        resourceType: "TemplateVersion",
        resourceId: templateVersionId,
        metadata: { error: message },
      });
      throw error;
    }
  }
}
