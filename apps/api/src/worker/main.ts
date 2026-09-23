import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log("PSD Template Studio ingestion/render worker started.");
}

bootstrap();
