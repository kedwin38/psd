import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { RENDER_QUEUE_TOKEN } from "../queue/queue.module";
import type { RenderJobData } from "../queue/queue.constants";
import { ExportFormat, ExportStatus } from "../generated/prisma";
import type { CreateExportDto } from "./dto/export.dto";

const EXTENSION: Record<ExportFormat, string> = {
  [ExportFormat.PNG]: "png",
  [ExportFormat.JPEG]: "jpg",
  [ExportFormat.PDF]: "pdf",
  [ExportFormat.TIFF]: "tiff",
};

@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(RENDER_QUEUE_TOKEN) private readonly renderQueue: Queue<RenderJobData>,
  ) {}

  async create(dto: CreateExportDto, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (project.userId !== userId) throw new ForbiddenException("You do not own this project.");

    // Atomic increment-with-guard: only succeeds while downloadsUsed is still under the allowance, so two
    // concurrent export requests can't both slip through and over-spend the same last slot.
    const [claimed] = await this.prisma.$queryRaw<{ downloadsUsed: number; downloadsAllowed: number }[]>`
      UPDATE users SET "downloadsUsed" = "downloadsUsed" + 1
      WHERE id = ${userId} AND "downloadsUsed" < "downloadsAllowed"
      RETURNING "downloadsUsed", "downloadsAllowed"
    `;
    if (!claimed) {
      throw new ForbiddenException("You've used all your downloads. Contact an admin to get more.");
    }

    try {
      const version = await this.prisma.templateVersion.findUniqueOrThrow({ where: { id: project.templateVersionId } });
      const nativeDpi = version.nativeDpi ?? 72;
      const outputDpi = Math.round(nativeDpi * dto.dpiScale);

      const job = await this.prisma.exportJob.create({
        data: {
          projectId: project.id,
          requestedById: userId,
          status: ExportStatus.QUEUED,
          outputFormat: dto.format,
          outputDpi,
        },
      });

      await this.renderQueue.add(
        "render",
        { exportJobId: job.id },
        { attempts: 2, backoff: { type: "exponential", delay: 3000 }, removeOnComplete: 100, removeOnFail: 100 },
      );

      await this.audit.record({ actorId: userId, action: "export.requested", resourceType: "ExportJob", resourceId: job.id, metadata: { format: dto.format, outputDpi } });
      return job;
    } catch (error) {
      // The download was never actually queued for rendering, so it never cost anything.
      await this.refundDownload(userId);
      throw error;
    }
  }

  /** Gives a download back, e.g. a job that never made it to the queue, or one that ultimately failed to render. */
  async refundDownload(userId: string): Promise<void> {
    await this.prisma.$executeRaw`UPDATE users SET "downloadsUsed" = GREATEST("downloadsUsed" - 1, 0) WHERE id = ${userId}`;
  }

  async get(id: string, userId: string) {
    const job = await this.prisma.exportJob.findUnique({ where: { id }, include: { outputAsset: true, project: { select: { name: true } } } });
    if (!job) throw new NotFoundException("Export job not found.");
    if (job.requestedById !== userId) throw new ForbiddenException("You do not own this export job.");

    if (job.status === ExportStatus.COMPLETE && job.outputAsset) {
      const base = (job.project.name || "export").replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "export";
      const filename = `${base}.${EXTENSION[job.outputFormat]}`;
      const downloadUrl = await this.storage.getSignedDownloadUrl(job.outputAsset.storageKey, 600, filename);
      return { ...job, downloadUrl };
    }
    return job;
  }

  async listForProject(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (project.userId !== userId) throw new ForbiddenException("You do not own this project.");
    return this.prisma.exportJob.findMany({ where: { projectId }, orderBy: { queuedAt: "desc" } });
  }
}
