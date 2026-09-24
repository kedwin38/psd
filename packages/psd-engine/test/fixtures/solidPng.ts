import { createCanvas } from "@napi-rs/canvas";

export function solidPng(width: number, height: number, css: string): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

/** Left half one color, right half another — for checking which part of an image a crop window picks. */
export function sideBySidePng(width: number, height: number, leftCss: string, rightCss: string): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = leftCss;
  ctx.fillRect(0, 0, width / 2, height);
  ctx.fillStyle = rightCss;
  ctx.fillRect(width / 2, 0, width / 2, height);
  return canvas.toBuffer("image/png");
}
