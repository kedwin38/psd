import { createCanvas, ImageData } from "@napi-rs/canvas";
import { initializeCanvas } from "ag-psd";

/**
 * ag-psd has no native dependency of its own — it needs a canvas
 * implementation injected once at startup so it can decode layer pixels into
 * real canvases instead of plain byte arrays. We use @napi-rs/canvas
 * (Skia-backed) for both this decode step and our own compositor, so the
 * exact same rasterizer produces the interactive preview and the print-grade
 * export (spec §6, §7).
 */
let initialized = false;

export function ensureCanvasInitialized(): void {
  if (initialized) return;
  initializeCanvas(
    (width, height) => createCanvas(width, height) as unknown as HTMLCanvasElement,
    (width, height) => new ImageData(width, height) as unknown as globalThis.ImageData,
  );
  initialized = true;
}
