import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { GlobalFonts } from "@napi-rs/canvas";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log("PSD Template Studio ingestion/render worker started.");
  if (GlobalFonts.families.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("No system fonts found: exports and previews will render without any text. Install a font package (see apps/api/Dockerfile).");
  }
}

bootstrap();
