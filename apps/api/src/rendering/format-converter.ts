import { PDFDocument, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import sharp from "sharp";
import type { ExportFormat } from "../generated/prisma";

export interface FormatConversionInput {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  dpi: number;
}

export interface FormatConversionResult {
  buffer: Buffer;
  mimeType: string;
  fileExtension: string;
}

/**
 * Converts the compositor's raster PNG output into the export formats the
 * spec calls for (§13): PNG passthrough, JPEG/TIFF via sharp, and a real
 * single-page PDF built with Skia's PDFDocument (not a PNG wrapped in a
 * pretend PDF header).
 */
export async function convertToExportFormat(input: FormatConversionInput, format: ExportFormat): Promise<FormatConversionResult> {
  switch (format) {
    case "PNG":
      return { buffer: input.png, mimeType: "image/png", fileExtension: "png" };

    case "JPEG": {
      const buffer = await sharp(input.png).flatten({ background: "#ffffff" }).jpeg({ quality: 95 }).toBuffer();
      return { buffer, mimeType: "image/jpeg", fileExtension: "jpg" };
    }

    case "TIFF": {
      const buffer = await sharp(input.png)
        .tiff({ compression: "lzw", xres: input.dpi, yres: input.dpi })
        .toBuffer();
      return { buffer, mimeType: "image/tiff", fileExtension: "tiff" };
    }

    case "PDF": {
      const widthPt = (input.widthPx / input.dpi) * 72;
      const heightPt = (input.heightPx / input.dpi) * 72;
      const doc = new PDFDocument({ title: "PSD Template Studio export" });
      const ctx = doc.beginPage(widthPt, heightPt) as unknown as SKRSContext2D;
      const image = await loadImage(input.png);
      ctx.drawImage(image, 0, 0, widthPt, heightPt);
      doc.endPage();
      const buffer = doc.close();
      return { buffer, mimeType: "application/pdf", fileExtension: "pdf" };
    }

    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}
