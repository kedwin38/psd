import { Module } from "@nestjs/common";
import { IdPhotoController } from "./id-photo.controller";
import { IdPhotoService } from "./id-photo.service";

@Module({
  controllers: [IdPhotoController],
  providers: [IdPhotoService],
  exports: [IdPhotoService],
})
export class IdPhotoModule {}
