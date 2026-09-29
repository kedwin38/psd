import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { BarcodeService, MAX_BARCODE_UPLOAD_BYTES } from "./barcode.service";
import { StorageService } from "../storage/storage.service";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("barcodes")
export class BarcodeController {
  constructor(
    private readonly barcodes: BarcodeService,
    private readonly storage: StorageService,
  ) {}

  @Post("extract")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BARCODE_UPLOAD_BYTES } }))
  async extract(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    if (!file) throw new BadRequestException('No file uploaded (expected multipart field "file").');
    const result = await this.barcodes.extract({ buffer: file.buffer }, user.id);
    const downloadUrl = await this.storage.getSignedDownloadUrl(result.storageKey, 600, `barcode-${result.format.toLowerCase()}.png`);
    return { text: result.text, format: result.format, width: result.width, height: result.height, downloadUrl };
  }
}
