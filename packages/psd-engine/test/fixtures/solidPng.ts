import { createCanvas } from "@napi-rs/canvas";

export function solidPng(width: number, height: number, css: string): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}
