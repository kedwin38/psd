import { BadRequestException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import sharp from "sharp";
import { BarcodeDetectorService } from "./barcode-detector";
import { StorageService } from "../storage/storage.service";
import { sniffImageMime } from "../common/image-sniff";
import { AssetOwnerType } from "../generated/prisma";

export const MAX_BARCODE_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Fixed pixel margin kept around the detected content box, at the *source* image's own
 *  resolution — just enough to avoid clipping an anti-aliased edge pixel or a barcode's narrow
 *  quiet zone, not a visible strip of surrounding material. The detector's own region-growing
 *  (plus its trim-to-content pass) already finds the barcode's true printed edge, so this margin
 *  only needs to be a few pixels, not a fraction of the barcode's size. */
const CROP_MARGIN_PX = 4;
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

    const left = Math.max(0, Math.floor(detection.box.left - CROP_MARGIN_PX));
    const top = Math.max(0, Math.floor(detection.box.top - CROP_MARGIN_PX));
    const right = Math.min(sourceWidth, Math.ceil(detection.box.left + detection.box.width + CROP_MARGIN_PX));
    const bottom = Math.min(sourceHeight, Math.ceil(detection.box.top + detection.box.height + CROP_MARGIN_PX));
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
