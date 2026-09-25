import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuditModule } from "./audit/audit.module";
import { StorageModule } from "./storage/storage.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/guards/jwt-auth.guard";
import { RolesGuard } from "./auth/guards/roles.guard";
import { StepUpGuard } from "./auth/guards/step-up.guard";
import { ProblemDetailsFilter } from "./common/filters/problem-details.filter";
import { CategoriesModule } from "./categories/categories.module";
import { TemplatesModule } from "./templates/templates.module";
import { ProjectsModule } from "./projects/projects.module";
import { ExportsModule } from "./exports/exports.module";
import { QueueModule } from "./queue/queue.module";
import { AdminModule } from "./admin/admin.module";
import { SettingsModule } from "./settings/settings.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
    PrismaModule,
    RedisModule,
    AuditModule,
    StorageModule,
    QueueModule,
    AuthModule,
    CategoriesModule,
    TemplatesModule,
    ProjectsModule,
    ExportsModule,
    AdminModule,
    SettingsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: StepUpGuard },
  ],
})
export class AppModule {}
