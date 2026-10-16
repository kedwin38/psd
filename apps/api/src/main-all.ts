import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { GlobalFonts } from "@napi-rs/canvas";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { WorkerModule } from "./worker/worker.module";
import type { Env } from "./config/env";

/**
 * Combined entrypoint for single-instance deployments (e.g. Render's free
 * tier): boots the HTTP API and the ingestion/render worker in ONE process
 * so the heavy native dependencies (sharp, @napi-rs/canvas, tfjs-node) load
 * once instead of twice. Behavior mirrors src/main.ts and src/worker/main.ts.
 */
async function bootstrapApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(ConfigService<Env, true>);

  if (config.get("TRUST_PROXY")) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get("CORS_ORIGIN"),
    credentials: true,
    exposedHeaders: ["WWW-Authenticate"],
  });
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();

  const port = config.get("API_PORT");
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PSD Template Studio API listening on :${port}`);
}

async function bootstrapWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log("PSD Template Studio ingestion/render worker started.");
  if (GlobalFonts.families.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("No system fonts found: exports and previews will render without any text. Install a font package (see apps/api/Dockerfile).");
  }
}

void (async () => {
  await Promise.all([bootstrapApi(), bootstrapWorker()]);
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Combined bootstrap failed:", error);
  process.exit(1);
});
