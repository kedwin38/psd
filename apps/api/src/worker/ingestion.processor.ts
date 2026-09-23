import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import { walkSceneGraph, type SceneGraph } from "@psd-studio/scene-graph";
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

const SANDBOX_TIMEOUT_MS = 90_000;
const SANDBOX_MEMORY_MB = 512;

interface SandboxResult {
  sceneGraph: SceneGraph;
  warnings: { path: string; message: string }[];
}

/**
 * Ingestion worker (spec §5, §10, §12): parses an uploaded PSD in a
 * disposable, memory-capped, time-boxed child process (ingestion-sandbox.ts)
 * so a hostile or malformed file can only take down that throwaway process
 * — never the worker itself or its other in-flight jobs — then resolves the
 * sandbox's placeholder asset references into real Asset rows via
 * @psd-studio/psd-engine's normalized output, guaranteeing the field-mapping
 * preview and the eventual export share one engine.
 */
@Injectable()
export class IngestionProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionProcessorService.name);
  private worker?: Worker<IngestionJobData>;
  private readonly sandboxScriptPath = join(__dirname, "ingestion-sandbox.js");

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

  private runSandboxed(psdFilePath: string, scratchDir: string): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = fork(this.sandboxScriptPath, [psdFilePath, scratchDir], {
          execArgv: [`--max-old-space-size=${SANDBOX_MEMORY_MB}`],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`PSD parsing sandbox exceeded ${SANDBOX_TIMEOUT_MS}ms and was killed.`));
      }, SANDBOX_TIMEOUT_MS);

      let settled = false;
      child.on("message", (msg: { type: "result" | "error"; sceneGraph?: SceneGraph; warnings?: SandboxResult["warnings"]; message?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (msg.type === "result" && msg.sceneGraph) {
          resolve({ sceneGraph: msg.sceneGraph, warnings: msg.warnings ?? [] });
        } else {
          reject(new Error(msg.message ?? "PSD parsing sandbox reported an unknown error."));
        }
        child.kill();
      });

      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`PSD parsing sandbox exited unexpectedly (code ${code}) — the file is likely malformed or triggered a crash.`));
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Replaces every `local:<file>:<hint>` placeholder with a real, persisted Asset id. */
  private async resolveSandboxAssets(sceneGraph: SceneGraph, scratchDir: string): Promise<void> {
    const cache = new Map<string, string>();
    for (const node of walkSceneGraph(sceneGraph)) {
      for (const field of ["imageAssetId", "maskAssetId"] as const) {
        const value = (node as Record<string, unknown>)[field];
        if (typeof value !== "string" || !value.startsWith("local:")) continue;
        let realId = cache.get(value);
        if (!realId) {
          const [, fileName, hint] = value.split(":");
          const bytes = await readFile(join(scratchDir, fileName!));
          const asset = await this.storage.storeAsset({
            data: bytes,
            mimeType: "image/png",
            ownerType: AssetOwnerType.TEMPLATE_LAYER,
            hint: hint ?? fileName!,
          });
          realId = asset.id;
          cache.set(value, realId);
        }
        (node as Record<string, unknown>)[field] = realId;
      }
    }
  }

  private async process(job: Job<IngestionJobData>): Promise<void> {
    const { templateVersionId } = job.data;
    const version = await this.prisma.templateVersion.findUniqueOrThrow({
      where: { id: templateVersionId },
      include: { psdAsset: true },
    });

    await this.prisma.templateVersion.update({ where: { id: templateVersionId }, data: { ingestStatus: IngestStatus.PARSING } });

    const scratchDir = await mkdtemp(join(tmpdir(), "psd-ingest-"));
    try {
      const bytes = await this.storage.getAssetBytes(version.psdAsset.storageKey);
      const psdFilePath = join(scratchDir, "source.psd");
      await writeFile(psdFilePath, bytes);

      const { sceneGraph, warnings } = await this.runSandboxed(psdFilePath, scratchDir);
      await this.resolveSandboxAssets(sceneGraph, scratchDir);

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
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
}
