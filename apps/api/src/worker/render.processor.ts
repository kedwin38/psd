import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import { SceneCompositor } from "@psd-studio/psd-engine";
import type { SceneGraph } from "@psd-studio/scene-graph";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { DbBackedAssetSource } from "../rendering/db-asset-source";
import { loadFieldOverrides } from "../rendering/field-overrides";
import { convertToExportFormat } from "../rendering/format-converter";
import { RENDER_QUEUE, type RenderJobData } from "../queue/queue.constants";
import { AssetOwnerType, ExportStatus } from "../generated/prisma";

function connectionFromUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined };
}

/**
 * Export/render worker (spec §5, §13): recomposites the SAME scene graph the
 * editor previewed, with the project's field overrides merged in, at the
 * requested output DPI — never limited by whatever shortcuts the low-res
 * preview took (preview/export parity is the architecture's central bet).
 */
@Injectable()
export class RenderProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RenderProcessorService.name);
  private worker?: Worker<RenderJobData>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<RenderJobData>(
      RENDER_QUEUE,
      (job) => this.process(job),
      { connection: connectionFromUrl(this.config.get("REDIS_URL")), concurrency: 2 },
    );
    this.worker.on("failed", (job, err) => this.logger.error(`Render job ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<RenderJobData>): Promise<void> {
    const { exportJobId } = job.data;
    const exportJob = await this.prisma.exportJob.findUniqueOrThrow({ where: { id: exportJobId } });
    await this.prisma.exportJob.update({ where: { id: exportJobId }, data: { status: ExportStatus.RENDERING, startedAt: new Date() } });

    try {
      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: exportJob.projectId } });
      const version = await this.prisma.templateVersion.findUniqueOrThrow({ where: { id: project.templateVersionId } });
      const sceneGraph = version.sceneGraph as unknown as SceneGraph;
      const overrides = await loadFieldOverrides(this.prisma, project.id);

      const nativeDpi = version.nativeDpi ?? 72;
      const scale = exportJob.outputDpi / nativeDpi;

      const compositor = new SceneCompositor(new DbBackedAssetSource(this.prisma, this.storage));
      const result = await compositor.render(sceneGraph, { scale, overrides });

      const converted = await convertToExportFormat(
        { png: result.png, widthPx: result.width, heightPx: result.height, dpi: exportJob.outputDpi },
        exportJob.outputFormat,
      );

      const asset = await this.storage.storeAsset({
        data: converted.buffer,
        mimeType: converted.mimeType,
        ownerType: AssetOwnerType.EXPORT_OUTPUT,
        hint: `export_${exportJobId}.${converted.fileExtension}`,
        width: result.width,
        height: result.height,
      });

      await this.prisma.exportJob.update({
        where: { id: exportJobId },
        data: { status: ExportStatus.COMPLETE, outputAssetId: asset.id, completedAt: new Date() },
      });
      await this.audit.record({
        actorId: exportJob.requestedById,
        action: "export.completed",
        resourceType: "ExportJob",
        resourceId: exportJobId,
        metadata: { format: exportJob.outputFormat, dpi: exportJob.outputDpi, renderWarnings: result.warnings.length },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.exportJob.update({ where: { id: exportJobId }, data: { status: ExportStatus.FAILED, error: message } });
      await this.audit.record({ actorId: exportJob.requestedById, action: "export.failed", resourceType: "ExportJob", resourceId: exportJobId, metadata: { error: message } });
      // Only once retries are exhausted — a job that will still retry hasn't actually failed the user's download
      // yet. attemptsMade counts completed attempts, not including the one currently failing, hence the +1.
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        await this.prisma.$executeRaw`UPDATE users SET "downloadsUsed" = GREATEST("downloadsUsed" - 1, 0) WHERE id = ${exportJob.requestedById}`;
      }
      throw error;
    }
  }
}
