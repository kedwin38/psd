import { exportDivergences, fieldTextFit, isFontAvailable, type Ctx2D, type ExportDivergence } from "@psd-studio/canvas-renderer";
import type { CropRect, SceneGraph, SceneNode, TextLayerNode } from "@psd-studio/scene-graph";
import type { TemplateField } from "../lib/types";

export type FieldValue = { type: "text"; text: string } | { type: "image"; imageAssetId: string; crop: CropRect } | { type: "visibility"; visible: boolean };

export const isImageField = (field: TemplateField) => field.fieldType === "IMAGE" || field.fieldType === "SMART_OBJECT";

export const FIELD_KIND: Record<TemplateField["fieldType"], string> = { TEXT: "text", IMAGE: "photo", SMART_OBJECT: "photo", VISIBILITY: "show/hide" };

export interface TextRules {
  maxLength: number | null;
  required: boolean;
}

export function textRules(field: TemplateField): TextRules {
  const { maxLength, required } = field.constraints;
  return { maxLength: typeof maxLength === "number" ? maxLength : null, required: required === true };
}

export interface ImageRules {
  minWidthPx: number;
  minHeightPx: number;
  maxUploadBytes: number;
  allowedMimeTypes: string[];
}

export function imageRules(field: TemplateField): ImageRules {
  const c = field.constraints;
  const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
  return {
    minWidthPx: num(c.minWidthPx, 1),
    minHeightPx: num(c.minHeightPx, 1),
    maxUploadBytes: num(c.maxUploadBytes, Infinity),
    allowedMimeTypes: Array.isArray(c.allowedMimeTypes) ? c.allowedMimeTypes.filter((t): t is string => typeof t === "string") : ["image/png", "image/jpeg", "image/webp"],
  };
}

export const mimeList = (types: readonly string[]) => types.map((t) => t.replace("image/", "").toUpperCase()).join(", ");

/** The same checks the upload endpoint makes, run first so a bad file fails instantly and says why. */
export async function checkImageFile(file: File, rules: ImageRules): Promise<string | null> {
  if (file.type && !rules.allowedMimeTypes.includes(file.type)) return `This photo field accepts ${mimeList(rules.allowedMimeTypes)} images.`;
  if (file.size > rules.maxUploadBytes) return `That image is ${(file.size / 1e6).toFixed(1)} MB; this field accepts up to ${(rules.maxUploadBytes / 1e6).toFixed(1)} MB.`;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return "That file couldn't be read as an image.";
  const { width, height } = bitmap;
  bitmap.close();
  if (width < rules.minWidthPx || height < rules.minHeightPx) return `Image must be at least ${rules.minWidthPx}×${rules.minHeightPx}px (this one is ${width}×${height}px).`;
  return null;
}

/** What renders until the user edits the field: the layer's own text, which the textarea starts from too. */
export const authoredText = (node: TextLayerNode) => node.runs.map((r) => r.text).join("").replace(/\r\n?/g, "\n");

export interface TextCheck {
  error: string | null;
  warnings: string[];
}

export function checkText(ctx: Ctx2D, node: TextLayerNode, text: string, rules: TextRules): TextCheck {
  if (rules.required && text.trim().length === 0) return { error: "This field is required, so it won't save while empty.", warnings: [] };
  if (rules.maxLength !== null && text.length > rules.maxLength) return { error: `Text is over the ${rules.maxLength}-character limit.`, warnings: [] };
  const fit = fieldTextFit(ctx, node, text);
  const warnings: string[] = [];
  if (fit.lines > fit.capacity) warnings.push(`Wraps to ${fit.lines} lines but the layout has room for ${fit.capacity}, so it will run below its box.`);
  if (fit.overflowsWidth) warnings.push("A word is too long for the box and will run past its edge.");
  return { error: null, warnings };
}

const DIVERGENCE_NOTES: Record<ExportDivergence, string> = {
  "text-tracking": "Letter spacing shows here but isn't applied in exports yet, so exported text sits tighter and may wrap differently.",
  "text-opacity": "This text's transparency shows here but exports draw it fully opaque.",
  "text-blend": "This text's blend mode shows here but exports draw it normally.",
  "top-level-clipping": "This layer is masked by the one beneath it here, but exports don't apply that mask yet.",
};

/** Ways this field could look different in the final export than on the canvas, in plain words. */
export function exportNotes(ctx: Ctx2D, graph: SceneGraph, node: SceneNode, value: FieldValue | undefined): string[] {
  const notes = exportDivergences(graph, node).map((d) => DIVERGENCE_NOTES[d]);
  if (node.type === "text") {
    const fonts = new Set((value?.type === "text" ? node.runs.slice(0, 1) : node.runs).map((r) => r.fontName));
    for (const font of fonts) {
      if (!isFontAvailable(ctx, font)) notes.push(`The font “${font}” isn't installed in this browser, so the preview uses a stand-in and line breaks may differ in your export.`);
    }
  }
  return notes;
}

/** How much the export enlarges an upload to fill its frame; above ~1.5 it starts to look soft. */
export function upscaleFactor(node: SceneNode, crop: CropRect, natural: { width: number; height: number }): number {
  const { left, top, right, bottom } = node.bounds;
  return Math.max((right - left) / (crop.width * natural.width), (bottom - top) / (crop.height * natural.height));
}
