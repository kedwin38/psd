import { createRequire } from "node:module";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";

// Loaded via Node's native `require`, not a Vitest/Vite import, and from the
// compiled output, not src — deliberately, for two compounding reasons:
// (1) NestJS's DI relies on design:paramtypes metadata that only esbuild-based
// transforms (vitest, tsx) emit unreliably for constructors mixing @Inject()'d
// and plain parameters; the real `tsc`/`nest build` output doesn't have that
// problem. (2) `app.get(SomeService)` matches providers by class-reference
// identity — if this file's copy of a class came through Vite's own transform
// while the app's internal `require()`s of the same file went through Node's
// native CJS loader, they'd be two different classes and `app.get` would 404.
// Using the same `require` for both sides keeps one shared module cache.
export const requireDist = createRequire(__filename);
const { AppModule } = requireDist("../dist/app.module");
const { WorkerModule } = requireDist("../dist/worker/worker.module");
const { PrismaService } = requireDist("../dist/prisma/prisma.service");

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix("api/v1");
  await app.init();
  return app;
}

/** Bootstraps the ingestion/render worker's own module graph (not part of AppModule). */
export async function createWorkerTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** Truncates every table between test files so each integration suite starts clean. */
export async function resetDatabase(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    users, organizations, template_categories, templates, template_versions,
    template_fields, assets, projects, export_jobs, audit_log_entries,
    refresh_tokens, webauthn_credentials, totp_credentials, user_role_assignments
    RESTART IDENTITY CASCADE`);
}
