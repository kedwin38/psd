import type { Color } from "ag-psd";
import type { Rgba } from "@psd-studio/scene-graph";

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function cmykToRgb(c: number, m: number, y: number, k: number): { r: number; g: number; b: number } {
  // PSD stores CMYK components as 0..100.
  const cN = c / 100;
  const mN = m / 100;
  const yN = y / 100;
  const kN = k / 100;
  return {
    r: 255 * (1 - cN) * (1 - kN),
    g: 255 * (1 - mN) * (1 - kN),
    b: 255 * (1 - yN) * (1 - kN),
  };
}

function hsbToRgb(h: number, s: number, b: number): { r: number; g: number; b: number } {
  // PSD stores h as 0..360, s/b as 0..100.
  const sN = s / 100;
  const bN = b / 100;
  const c = bN * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = bN - c;
  let [r, g, bl] = [0, 0, 0];
  if (h < 60) [r, g, bl] = [c, x, 0];
  else if (h < 120) [r, g, bl] = [x, c, 0];
  else if (h < 180) [r, g, bl] = [0, c, x];
  else if (h < 240) [r, g, bl] = [0, x, c];
  else if (h < 300) [r, g, bl] = [x, 0, c];
  else [r, g, bl] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (bl + m) * 255 };
}

function labToRgb(l: number, a: number, b: number): { r: number; g: number; b: number } {
  // Standard CIE Lab (D65) -> sRGB conversion.
  const y = (l + 16) / 116;
  const x = a / 500 + y;
  const z = y - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * f(x);
  const Y = 1.0 * f(y);
  const Z = 1.08883 * f(z);
  let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let bl = X * 0.0557 + Y * -0.204 + Z * 1.057;
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  r = gamma(r) * 255;
  g = gamma(g) * 255;
  bl = gamma(bl) * 255;
  return { r, g, b: bl };
}

/**
 * PSD text/fill colors can arrive in any of several color models depending
 * on the document's color mode and how the color was picked in Photoshop.
 * Normalizes all of them to the scene graph's sRGB Rgba shape.
 */
export function toRgba(color: Color | undefined, alpha = 1): Rgba {
  if (!color) return { r: 0, g: 0, b: 0, a: alpha };

  if ("r" in color && "g" in color && "b" in color) {
    // PSD's RGBA color struct encodes alpha on the same 0..255 scale as r/g/b (not 0..1),
    // matching every other channel in this struct — normalize it to the scene graph's 0..1.
    const a = "a" in color && typeof (color as { a?: number }).a === "number" ? (color as { a: number }).a / 255 : alpha;
    return { r: clamp255(color.r), g: clamp255(color.g), b: clamp255(color.b), a };
  }
  if ("fr" in color && "fg" in color && "fb" in color) {
    return { r: clamp255(color.fr * 255), g: clamp255(color.fg * 255), b: clamp255(color.fb * 255), a: alpha };
  }
  if ("c" in color && "m" in color && "y" in color && "k" in color) {
    const rgb = cmykToRgb(color.c, color.m, color.y, color.k);
    return { r: clamp255(rgb.r), g: clamp255(rgb.g), b: clamp255(rgb.b), a: alpha };
  }
  if ("h" in color && "s" in color && "b" in color) {
    const rgb = hsbToRgb(color.h, color.s, color.b);
    return { r: clamp255(rgb.r), g: clamp255(rgb.g), b: clamp255(rgb.b), a: alpha };
  }
  if ("l" in color && "a" in color && "b" in color) {
    const rgb = labToRgb(color.l, color.a, color.b);
    return { r: clamp255(rgb.r), g: clamp255(rgb.g), b: clamp255(rgb.b), a: alpha };
  }
  if ("k" in color) {
    const v = clamp255(255 - (color.k / 255) * 255);
    return { r: v, g: v, b: v, a: alpha };
  }
  return { r: 0, g: 0, b: 0, a: alpha };
}

export function rgbaToCss({ r, g, b, a }: Rgba): string {
  return `rgba(${clamp255(r)}, ${clamp255(g)}, ${clamp255(b)}, ${a})`;
}
