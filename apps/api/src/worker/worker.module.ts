import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "../config/env";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { IngestionProcessorService } from "./ingestion.processor";
import { RenderProcessorService } from "./render.processor";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, RedisModule, AuditModule, StorageModule],
  providers: [IngestionProcessorService, RenderProcessorService],
})
export class WorkerModule {}
