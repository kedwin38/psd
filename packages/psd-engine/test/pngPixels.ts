import { PNG } from "pngjs";

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Decodes a PNG buffer and reads a single pixel — used to assert compositor output. */
export function readPixel(png: Buffer, x: number, y: number): Pixel {
  const decoded = PNG.sync.read(png);
  const idx = (decoded.width * y + x) << 2;
  return {
    r: decoded.data[idx]!,
    g: decoded.data[idx + 1]!,
    b: decoded.data[idx + 2]!,
    a: decoded.data[idx + 3]!,
  };
}

export function decodePng(png: Buffer): { width: number; height: number; data: Buffer } {
  const decoded = PNG.sync.read(png);
  return { width: decoded.width, height: decoded.height, data: decoded.data as unknown as Buffer };
}
