import { Module } from "@nestjs/common";
import { BarcodeController } from "./barcode.controller";
import { BarcodeService } from "./barcode.service";
import { BarcodeDetectorService } from "./barcode-detector";

@Module({
  controllers: [BarcodeController],
  providers: [BarcodeService, BarcodeDetectorService],
  exports: [BarcodeService],
})
export class BarcodeModule {}
