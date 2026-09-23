import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { createTestApp, createWorkerTestApp, resetDatabase, requireDist } from "./test-app";
import type { PrismaService as PrismaServiceType } from "../src/prisma/prisma.service";
import type { StorageService as StorageServiceType } from "../src/storage/storage.service";

const { PrismaService } = requireDist("../dist/prisma/prisma.service") as { PrismaService: new () => PrismaServiceType };
const { StorageService } = requireDist("../dist/storage/storage.service") as { StorageService: new (...args: never[]) => StorageServiceType };
const { AssetOwnerType, IngestStatus, RoleName } = requireDist("../dist/generated/prisma") as typeof import("../src/generated/prisma");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Ingestion sandbox crash isolation", () => {
  let app: INestApplication;
  let workerApp: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase(app);
    workerApp = await createWorkerTestApp();
  });

  afterAll(async () => {
    await app.close();
    await workerApp.close();
  });

  it("fails the version cleanly instead of crashing when the PSD is corrupt past its header", async () => {
    const prisma = app.get(PrismaService);
    const storage = app.get(StorageService);

    const user = await prisma.user.create({
      data: { email: "sandbox-test@example.com", displayName: "Sandbox Test", status: "ACTIVE", roles: { create: { role: RoleName.SUPER_ADMIN } } },
    });
    const category = await prisma.templateCategory.create({ data: { name: "Sandbox Test Category" } });
    const template = await prisma.template.create({ data: { name: "Sandbox Test Template", categoryId: category.id } });

    // Passes the upload endpoint's magic-byte check ("8BPS") but is garbage
    // past that — real-world equivalent of a truncated or hand-crafted
    // malicious file that a byte-signature check alone can't catch.
    const corrupt = Buffer.concat([Buffer.from("8BPS", "ascii"), Buffer.from(Array.from({ length: 500 }, () => Math.floor(Math.random() * 256)))]);
    const asset = await storage.storeAsset({ data: corrupt, mimeType: "image/vnd.adobe.photoshop", ownerType: AssetOwnerType.TEMPLATE_SOURCE, hint: "corrupt.psd" });

    const version = await prisma.templateVersion.create({
      data: { templateId: template.id, versionNo: 1, psdAssetId: asset.id, ingestStatus: IngestStatus.PENDING, createdById: user.id },
    });

    // Mirrors the real topology: the API process enqueues, a separate worker
    // process (here, a second Nest application context) consumes over Redis.
    const { IngestionProcessorService } = requireDist("../dist/worker/ingestion.processor");
    const processor: { onModuleInit: () => void } = workerApp.get(IngestionProcessorService);
    processor.onModuleInit();

    const { INGESTION_QUEUE_TOKEN } = requireDist("../dist/queue/queue.module");
    const queue = app.get(INGESTION_QUEUE_TOKEN);
    await queue.add("ingest", { templateVersionId: version.id });

    let finalStatus = version.ingestStatus;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const current = await prisma.templateVersion.findUniqueOrThrow({ where: { id: version.id } });
      finalStatus = current.ingestStatus;
      if (finalStatus === IngestStatus.FAILED || finalStatus === IngestStatus.READY) break;
    }

    expect(finalStatus).toBe(IngestStatus.FAILED);

    // The API process (this test process, sharing a container with the app)
    // is still alive and able to serve requests — the crash stayed sandboxed.
    const stillAlive = await prisma.templateCategory.findUnique({ where: { id: category.id } });
    expect(stillAlive).not.toBeNull();
  });
});
