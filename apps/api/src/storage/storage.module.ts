import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env";
import { AssetsController } from "./assets.controller";
import { LocalDiskStorageDriver } from "./local-disk.driver";
import { S3StorageDriver } from "./s3.driver";
import { StorageService } from "./storage.service";
import { STORAGE_DRIVER } from "./storage.types";

@Global()
@Module({
  controllers: [AssetsController],
  providers: [
    {
      provide: STORAGE_DRIVER,
      useFactory: (config: ConfigService<Env, true>) => {
        if (config.get("STORAGE_DRIVER") === "s3") {
          return new S3StorageDriver({
            endpoint: config.get("S3_ENDPOINT"),
            bucket: config.get("S3_BUCKET"),
            accessKeyId: config.get("S3_ACCESS_KEY_ID"),
            secretAccessKey: config.get("S3_SECRET_ACCESS_KEY"),
            region: config.get("S3_REGION"),
          });
        }
        return new LocalDiskStorageDriver(
          config.get("STORAGE_LOCAL_PATH"),
          config.get("API_PUBLIC_URL"),
          config.get("JWT_ACCESS_SECRET"),
        );
      },
      inject: [ConfigService],
    },
    StorageService,
  ],
  exports: [StorageService, STORAGE_DRIVER],
})
export class StorageModule {}
