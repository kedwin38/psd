import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import type { Env } from "./config/env";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(ConfigService<Env, true>);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get("CORS_ORIGIN"),
    credentials: true,
  });
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();

  const port = config.get("API_PORT");
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PSD Template Studio API listening on :${port}`);
}

bootstrap();
