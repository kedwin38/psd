import { BadRequestException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import sharp from "sharp";
import { BarcodeDetectorService } from "./barcode-detector";
import { StorageService } from "../storage/storage.service";
import { sniffImageMime } from "../common/image-sniff";
import { AssetOwnerType } from "../generated/prisma";

export const MAX_BARCODE_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Margin kept around the barcode's own finder/result points, as a fraction of its box size — a
 *  barcode's quiet zone and any residual label text sit just outside those points, and a small
 *  margin keeps the decoder-critical border without dragging in the rest of the pasted material. */
const CROP_MARGIN_FRACTION = 0.15;
/** Output is upscaled so the shorter crop edge is at least this many pixels, for a crisp, scannable
 *  download — but never downscaled if the source crop is already bigger. */
const MIN_OUTPUT_EDGE_PX = 900;
const MAX_UPSCALE_FACTOR = 6;

export interface ExtractBarcodeResult {
  text: string;
  format: string;
  assetId: string;
  storageKey: string;
  width: number;
  height: number;
}

@Injectable()
export class BarcodeService {
  constructor(
    private readonly detector: BarcodeDetectorService,
    private readonly storage: StorageService,
  ) {}

  async extract(file: { buffer: Buffer }, userId: string): Promise<ExtractBarcodeResult> {
    if (!file.buffer.length) throw new BadRequestException("Empty file.");
    if (file.buffer.length > MAX_BARCODE_UPLOAD_BYTES) throw new BadRequestException(`Image exceeds the ${MAX_BARCODE_UPLOAD_BYTES} byte limit.`);
    const mimeType = sniffImageMime(file.buffer);
    if (!mimeType) throw new BadRequestException("The pasted file isn't a PNG, JPEG, or WebP image.");

    await this.storage.storeAsset({ data: file.buffer, mimeType, ownerType: AssetOwnerType.BARCODE_SOURCE, hint: `barcode-source-${userId}` });

    const detection = await this.detector.detect(file.buffer);
    if (!detection) {
      throw new UnprocessableEntityException("No barcode could be found in the pasted image. Make sure the barcode is in frame and legible, then try again.");
    }

    const meta = await sharp(file.buffer).metadata();
    const sourceWidth = meta.width!;
    const sourceHeight = meta.height!;

    const marginX = detection.box.width * CROP_MARGIN_FRACTION;
    const marginY = detection.box.height * CROP_MARGIN_FRACTION;
    const left = Math.max(0, Math.floor(detection.box.left - marginX));
    const top = Math.max(0, Math.floor(detection.box.top - marginY));
    const right = Math.min(sourceWidth, Math.ceil(detection.box.left + detection.box.width + marginX));
    const bottom = Math.min(sourceHeight, Math.ceil(detection.box.top + detection.box.height + marginY));
    const cropWidth = Math.max(1, right - left);
    const cropHeight = Math.max(1, bottom - top);

    const cropped = sharp(file.buffer).extract({ left, top, width: cropWidth, height: cropHeight });

    const shorterEdge = Math.min(cropWidth, cropHeight);
    const scale = Math.min(MAX_UPSCALE_FACTOR, Math.max(1, MIN_OUTPUT_EDGE_PX / shorterEdge));
    const outputWidth = Math.round(cropWidth * scale);
    const outputHeight = Math.round(cropHeight * scale);

    const output = await cropped
      .resize(outputWidth, outputHeight, { kernel: sharp.kernel.lanczos3 })
      .png({ quality: 100, palette: false })
      .toBuffer();

    const asset = await this.storage.storeAsset({
      data: output,
      mimeType: "image/png",
      ownerType: AssetOwnerType.BARCODE_OUTPUT,
      hint: `barcode-output-${detection.format.toLowerCase()}`,
      width: outputWidth,
      height: outputHeight,
    });

    return { text: detection.text, format: detection.format, assetId: asset.id, storageKey: asset.storageKey, width: outputWidth, height: outputHeight };
  }
}
