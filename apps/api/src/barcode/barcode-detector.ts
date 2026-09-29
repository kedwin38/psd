import { Injectable } from "@nestjs/common";
import sharp from "sharp";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, NotFoundException as ZXingNotFoundException, RGBLuminanceSource } from "@zxing/library";

export interface BarcodeDetection {
  text: string;
  format: string;
  /** Axis-aligned bounding box, in source-image pixels, around the barcode's actual printed
   *  content (bars/modules and any attached label) — not padded, and not just ZXing's own decode
   *  scanline, which for a 1D barcode is a single horizontal slice through the middle of the bars
   *  and says nothing about their real height. */
  box: { left: number; top: number; width: number; height: number };
}

const HINTS = new Map();
HINTS.set(DecodeHintType.TRY_HARDER, true);

/** How much local luminance range (0-255) within a row/column counts as "barcode content" (bars,
 *  or printed text) rather than uniform background/quiet-zone. */
const CONTENT_RANGE_THRESHOLD = 40;
/** Rows/columns allowed to fall below the threshold before region-growing stops in that direction
 *  — bridges the quiet gap between a 1D barcode's bars and its printed value underneath. */
const MAX_CONTENT_GAP = 8;

function toGrayscale(data: Buffer, width: number, height: number, channels: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += channels) {
    gray[i] = (data[p]! * 306 + data[p + 1]! * 601 + data[p + 2]! * 117) >> 10;
  }
  return gray;
}

function rangeAlongFixedAxis(gray: Uint8Array, width: number, axis: "row" | "col", index: number, fixedLo: number, fixedHi: number): number {
  let min = 255;
  let max = 0;
  for (let f = fixedLo; f <= fixedHi; f++) {
    const v = axis === "row" ? gray[index * width + f]! : gray[f * width + index]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/** Walks outward from `start` along one axis while the perpendicular band still looks like
 *  printed content, returning the furthest position reached. */
function growEdge(gray: Uint8Array, width: number, height: number, axis: "row" | "col", dir: 1 | -1, start: number, fixedLo: number, fixedHi: number): number {
  const limit = axis === "row" ? height : width;
  let pos = Math.min(Math.max(start, 0), limit - 1);
  let last = pos;
  let gap = 0;
  while (pos >= 0 && pos < limit) {
    const range = rangeAlongFixedAxis(gray, width, axis, pos, fixedLo, fixedHi);
    if (range >= CONTENT_RANGE_THRESHOLD) {
      last = pos;
      gap = 0;
    } else if (++gap > MAX_CONTENT_GAP) {
      break;
    }
    pos += dir;
  }
  return last;
}

/**
 * Grows the true printed extent of the barcode out from ZXing's own (often degenerate) result
 * points. A 1D symbology's result points sit on a single horizontal scanline through the bars —
 * real height, and any attached human-readable label, aren't in them at all. Region-growing along
 * local luminance contrast (bars/text are high-contrast; surrounding paper/background is flat)
 * recovers the barcode's actual footprint regardless of its symbology, size, or orientation.
 */
function growContentBox(gray: Uint8Array, width: number, height: number, seed: { left: number; top: number; right: number; bottom: number }) {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const centerY = clamp(Math.round((seed.top + seed.bottom) / 2), 0, height - 1);
  const bandTop = clamp(centerY - 2, 0, height - 1);
  const bandBottom = clamp(centerY + 2, 0, height - 1);

  const left = growEdge(gray, width, height, "col", -1, Math.round(seed.left), bandTop, bandBottom);
  const right = growEdge(gray, width, height, "col", 1, Math.round(seed.right), bandTop, bandBottom);

  const top = growEdge(gray, width, height, "row", -1, centerY, left, right);
  const bottom = growEdge(gray, width, height, "row", 1, centerY, left, right);

  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * Wraps ZXing's reader against a raw RGBA buffer. ZXing only locates the barcode well enough to
 * decode it; the crop region actually used comes from `growContentBox` above, seeded by ZXing's
 * result points.
 */
@Injectable()
export class BarcodeDetectorService {
  /** Detects and decodes a barcode in an arbitrary photo/screenshot; null if none is found. */
  async detect(imageBuffer: Buffer): Promise<BarcodeDetection | null> {
    const { data, info } = await sharp(imageBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    const argb = new Int32Array(width * height);
    for (let i = 0, p = 0; i < argb.length; i++, p += channels) {
      const r = data[p]!;
      const g = data[p + 1]!;
      const b = data[p + 2]!;
      argb[i] = (0xff << 24) | (r << 16) | (g << 8) | b;
    }

    const reader = new MultiFormatReader();
    reader.setHints(HINTS);
    const source = new RGBLuminanceSource(argb, width, height);

    for (const src of [source, source.invert()]) {
      try {
        const bitmap = new BinaryBitmap(new HybridBinarizer(src));
        const result = reader.decode(bitmap);
        const points = result.getResultPoints().filter((p) => p != null);
        if (points.length === 0) return null;
        const xs = points.map((p) => p.getX());
        const ys = points.map((p) => p.getY());
        const seed = {
          left: Math.max(0, Math.min(...xs)),
          top: Math.max(0, Math.min(...ys)),
          right: Math.min(width, Math.max(...xs)),
          bottom: Math.min(height, Math.max(...ys)),
        };
        const gray = toGrayscale(data as Buffer, width, height, channels);
        const box = growContentBox(gray, width, height, seed);
        return { text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] ?? "UNKNOWN", box };
      } catch (err) {
        if (err instanceof ZXingNotFoundException) continue;
        // Other ZXing exceptions (ChecksumException, FormatException) also mean "couldn't read this
        // orientation" here, not a real fault — same as NotFoundException for our purposes.
        continue;
      }
    }
    return null;
  }
}
