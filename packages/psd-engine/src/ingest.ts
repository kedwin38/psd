import { createCanvas } from "@napi-rs/canvas";
import { readPsd, type Psd, type Layer, type LayerTextData, type ParagraphStyle, ColorMode as AgColorMode } from "ag-psd";
import {
  type SceneGraph,
  type SceneNode,
  type Rect,
  type ColorMode,
  type TextRun,
  type TextFrame,
  IdentityTransform,
  idFromPath,
  transformRect,
} from "@psd-studio/scene-graph";
import { ensureCanvasInitialized } from "./canvasFactory.js";
import { mapBlendMode } from "./blendMode.js";
import { toRgba } from "./color.js";

/** A napi-rs Canvas, typed loosely so we don't need the DOM lib. */
interface RasterCanvas {
  width: number;
  height: number;
  toBuffer(mimeType: "image/png"): Buffer;
}

export interface AssetSink {
  /** Persists a rasterized layer/photo as PNG bytes and returns its stable asset id. */
  putImage(png: Buffer, hint: string): Promise<string>;
}

export interface IngestWarning {
  path: string;
  message: string;
}

export interface IngestResult {
  sceneGraph: SceneGraph;
  warnings: IngestWarning[];
}

function mapColorMode(mode: AgColorMode | undefined): ColorMode {
  switch (mode) {
    case AgColorMode.CMYK:
      return "cmyk";
    case AgColorMode.Grayscale:
    case AgColorMode.Duotone:
      return "grayscale";
    case AgColorMode.Bitmap:
      return "bitmap";
    default:
      return "rgb";
  }
}

function extractDpi(psd: Psd): number {
  const res = psd.imageResources?.resolutionInfo?.horizontalResolution;
  return res && res > 0 ? Math.round(res) : 72;
}

function boundsOf(layer: Layer, fallback: Rect): Rect {
  const { left, top, right, bottom } = layer;
  if (left === undefined && top === undefined && right === undefined && bottom === undefined) {
    return fallback;
  }
  return {
    left: left ?? 0,
    top: top ?? 0,
    right: right ?? left ?? 0,
    bottom: bottom ?? top ?? 0,
  };
}

function unionBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return rects.reduce((acc, r) => ({
    left: Math.min(acc.left, r.left),
    top: Math.min(acc.top, r.top),
    right: Math.max(acc.right, r.right),
    bottom: Math.max(acc.bottom, r.bottom),
  }));
}

function hasPixels(layer: Layer): boolean {
  return (layer.right ?? 0) > (layer.left ?? 0) && (layer.bottom ?? 0) > (layer.top ?? 0);
}

const NO_BOUNDS: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

let transparentPng: Buffer | undefined;
/** The raster of a layer without pixels (an empty layer or placeholder): one transparent pixel, which both compositors stretch to the layer's bounds. */
function emptyRaster(): Buffer {
  return (transparentPng ??= createCanvas(1, 1).toBuffer("image/png"));
}

/** The frame a smart object is placed in: the box around its transform's four corners. */
function placementBounds(layer: Layer): Rect | null {
  const t = layer.placedLayer?.transform;
  if (!t || t.length < 8) return null;
  const xs = [t[0]!, t[2]!, t[4]!, t[6]!];
  const ys = [t[1]!, t[3]!, t[5]!, t[7]!];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * Photoshop lays text out in local space and places it with the type tool's transform [xx, xy, yx, yy, tx, ty]:
 * point text's first baseline starts at (tx, ty) on its alignment edge; paragraph text wraps in boxBounds. The
 * layer record's bounds are only the rendered glyphs' extent. Generators that leave the transform at identity
 * carry the position in the record bounds alone; those get no frame.
 */
function textFrameOf(layer: Layer): TextFrame | undefined {
  const text = layer.text!;
  const [xx = 1, xy = 0, yx = 0, yy = 1, tx = 0, ty = 0] = text.transform ?? [];
  const unset = xx === 1 && xy === 0 && yx === 0 && yy === 1 && tx === 0 && ty === 0;
  if (unset && (layer.left || layer.top)) return undefined;
  const box = text.shapeType === "box" && text.boxBounds?.length === 4 ? text.boxBounds : null;
  return {
    transform: { m00: xx, m01: yx, m10: xy, m11: yy, m02: tx, m12: ty },
    box: box && { left: box[0]!, top: box[1]!, right: box[2]!, bottom: box[3]! },
  };
}

/** Photoshop's rendered glyph extent when the layer has pixels; otherwise the text's own local extent placed through its frame. */
function textBoundsOf(layer: Layer, frame: TextFrame | undefined, fontSize: number): Rect {
  if (hasPixels(layer) || !frame) return boundsOf(layer, { left: 0, top: 0, right: 0, bottom: 0 });
  const local = layer.text!.boundingBox ?? layer.text!.bounds;
  const rect = local
    ? { left: local.left.value, top: local.top.value, right: local.right.value, bottom: local.bottom.value }
    : (frame.box ?? { left: 0, top: -fontSize, right: 0, bottom: 0 });
  return transformRect(frame.transform, rect);
}

/** A paragraph setting as it applies to the first paragraph: ag-psd's base style omits settings the paragraphs differ on. */
function paragraphSetting<K extends keyof ParagraphStyle>(text: LayerTextData, key: K): ParagraphStyle[K] {
  return text.paragraphStyle?.[key] ?? text.paragraphStyleRuns?.[0]?.style[key];
}

/** Type features the renderers don't reproduce. */
function textLayoutLimits(layer: Layer): string[] {
  const text = layer.text!;
  const [, xy = 0, yx = 0] = text.transform ?? [];
  const paragraphs = [text.paragraphStyle, ...(text.paragraphStyleRuns ?? []).map((r) => r.style)];
  const limits: string[] = [];
  if (xy !== 0 || yx !== 0) limits.push("Text is rotated or skewed: it is drawn through its type transform, but no Photoshop sample has confirmed rotated placement; check it against the design.");
  if (text.warp?.style && text.warp.style !== "none") limits.push(`Warped text ("${text.warp.style}") renders unwarped.`);
  // Text engine frame types: 0 point, 1 paragraph box, 2 type on a path.
  if (text.textPath?.data.type === 2) limits.push("Type on a path renders on a straight baseline, not along the path.");
  if (text.orientation === "vertical") limits.push("Vertical text renders horizontally.");
  if (text.shapeType === "box" && paragraphSetting(text, "justification")?.startsWith("justify")) {
    limits.push("Justified paragraph lines render ragged, not stretched to the box edges.");
  }
  const keys = ["justification", "spaceBefore", "spaceAfter"] as const;
  if (keys.some((key) => new Set(text.paragraphStyleRuns?.map((r) => r.style[key] ?? text.paragraphStyle?.[key])).size > 1)) {
    limits.push("Paragraphs differ in alignment or spacing; all of them lay out like the first.");
  }
  if (paragraphs.some((p) => p?.firstLineIndent || p?.startIndent || p?.endIndent)) limits.push("Paragraph indents are not applied.");
  const styles = [text.style, ...(text.styleRuns ?? []).map((r) => r.style)];
  if (styles.some((s) => s?.fontCaps === 1 || s?.fontBaseline)) limits.push("Small caps, superscript and subscript render as regular text.");
  return limits;
}

function mapAlignment(justification: string | undefined): "left" | "center" | "right" | "justify" {
  switch (justification) {
    case "center":
    case "justify-center":
      return "center";
    case "right":
    case "justify-right":
      return "right";
    case "justify-all":
    case "justify-left":
      return "justify";
    default:
      return "left";
  }
}

/** Splits PSD's run-length style array into concrete TextRun objects. */
function buildTextRuns(layer: Layer, warnings: IngestWarning[], path: string): TextRun[] {
  const textData = layer.text!;
  const fullText = textData.text ?? "";
  const baseStyle = textData.style ?? {};
  const styleRuns = textData.styleRuns;
  const autoLeading = paragraphSetting(textData, "autoLeading") ?? 1.2;

  const toRun = (text: string, style: typeof baseStyle): TextRun => {
    const fontSize = style.fontSize ?? baseStyle.fontSize ?? 12;
    const leading = style.leading ?? baseStyle.leading;
    // With auto leading on, Photoshop ignores the stored leading value (often a stale one).
    const auto = leading === undefined || (style.autoLeading ?? baseStyle.autoLeading) !== false;
    return {
      text,
      fontName: style.font?.name ?? baseStyle.font?.name ?? "Helvetica",
      fontSize,
      color: toRgba(style.fillColor ?? baseStyle.fillColor, 1),
      tracking: style.tracking ?? baseStyle.tracking,
      leadingPt: auto ? fontSize * autoLeading : leading,
      bold: style.fauxBold ?? baseStyle.fauxBold,
      italic: style.fauxItalic ?? baseStyle.fauxItalic,
      horizontalScale: style.horizontalScale ?? baseStyle.horizontalScale,
      verticalScale: style.verticalScale ?? baseStyle.verticalScale,
      baselineShift: style.baselineShift ?? baseStyle.baselineShift,
      // Text engine FontCaps: 0 normal, 1 small caps, 2 all caps.
      allCaps: (style.fontCaps ?? baseStyle.fontCaps) === 2 || undefined,
    };
  };

  if (!styleRuns || styleRuns.length === 0) {
    return [toRun(fullText, baseStyle)];
  }

  const runs: TextRun[] = [];
  let cursor = 0;
  for (const run of styleRuns) {
    const slice = fullText.slice(cursor, cursor + run.length);
    cursor += run.length;
    runs.push(toRun(slice, run.style));
  }
  if (cursor < fullText.length) {
    runs.push(toRun(fullText.slice(cursor), baseStyle));
  }
  if (runs.length === 0) {
    warnings.push({ path, message: "Text layer had no decodable runs; used empty text." });
    return [toRun("", baseStyle)];
  }
  return runs;
}

/** Any of Photoshop's lock toggles (the panel shows a lock icon for each of these). */
function isLocked(layer: Layer): boolean {
  const p = layer.protected;
  return !!(p?.transparency || p?.composite || p?.position);
}

export interface IngestOptions {
  /** Called for every layer that could not be fully translated. */
  onWarning?: (warning: IngestWarning) => void;
}

export async function parsePsdBuffer(buffer: Buffer, sink: AssetSink, options: IngestOptions = {}): Promise<IngestResult> {
  ensureCanvasInitialized();
  const psd = readPsd(buffer, {
    throwForMissingFeatures: false,
    logMissingFeatures: false,
  });
  return buildSceneGraph(psd, sink, options);
}

export async function buildSceneGraph(psd: Psd, sink: AssetSink, options: IngestOptions = {}): Promise<IngestResult> {
  const warnings: IngestWarning[] = [];
  const warn = (w: IngestWarning) => {
    warnings.push(w);
    options.onWarning?.(w);
  };

  /** Siblings may share a name, so ids hash a key that numbers repeats; a layer's first occurrence keys by its plain path. */
  async function convertLayers(layers: Layer[], parentPath: string, parentKey: string): Promise<SceneNode[]> {
    const seen = new Map<string, number>();
    const nodes: SceneNode[] = [];
    for (const layer of layers) {
      const name = layer.name ?? "Layer";
      const repeat = seen.get(name) ?? 0;
      seen.set(name, repeat + 1);
      const path = parentPath ? `${parentPath}/${name}` : name;
      const key = `${parentKey ? `${parentKey}/` : ""}${name}${repeat ? `\n${repeat}` : ""}`;
      nodes.push(await convertLayer(layer, path, key));
    }
    return nodes;
  }

  async function convertLayer(layer: Layer, path: string, key: string): Promise<SceneNode> {
    const id = idFromPath(key);
    const visible = !layer.hidden;
    const opacity = layer.opacity ?? 1;
    const { mode: blendMode, exact } = mapBlendMode(layer.blendMode);
    if (!exact) {
      warn({ path, message: `Blend mode "${layer.blendMode}" approximated as "${blendMode}" (no exact Canvas2D equivalent).` });
    }
    const clipping = !!layer.clipping;
    const locked = isLocked(layer);
    const maskAssetId: string | null = null; // v1: masks are baked into the layer raster by ag-psd's decode; standalone editable masks are a Phase 2 item.

    // --- Group ---
    if (layer.children) {
      const childNodes = await convertLayers(layer.children, path, key);
      const bounds =
        unionBounds(childNodes.map((n) => n.bounds).filter((b) => b.right > b.left && b.bottom > b.top)) ?? { left: 0, top: 0, right: psd.width, bottom: psd.height };
      const isPassThrough = layer.blendMode === undefined || layer.blendMode === "pass through";
      return {
        type: "group",
        id,
        path,
        name: layer.name ?? "Group",
        visible,
        opacity,
        blendMode,
        clipping,
        locked,
        maskAssetId,
        bounds,
        isPassThrough,
        children: childNodes,
      };
    }

    // --- Text ---
    if (layer.text) {
      const runs = buildTextRuns(layer, warnings, path);
      const frame = textFrameOf(layer);
      if (!frame) {
        warn({ path, message: "Text layer's type transform is unset (the document origin) though the layer sits elsewhere; placed from its layer bounds instead." });
      }
      for (const message of textLayoutLimits(layer)) warn({ path, message });
      const bounds = textBoundsOf(layer, frame, runs[0]!.fontSize);
      const before = paragraphSetting(layer.text, "spaceBefore") ?? 0;
      const after = paragraphSetting(layer.text, "spaceAfter") ?? 0;
      return {
        type: "text",
        id,
        path,
        name: layer.name ?? "Text",
        visible,
        opacity,
        blendMode,
        clipping,
        locked,
        maskAssetId,
        bounds,
        runs,
        alignment: mapAlignment(paragraphSetting(layer.text, "justification")),
        boxMode: layer.text.shapeType === "box" ? "paragraph" : "point",
        ...(frame && { frame }),
        ...(before || after ? { paragraphSpacing: { before, after } } : {}),
      };
    }

    // --- Smart object ---
    if (layer.placedLayer) {
      const canvas = layer.canvas as unknown as RasterCanvas | undefined;
      // An empty smart object (e.g. a photo placeholder) still has the frame it was placed in.
      const bounds = canvas ? boundsOf(layer, { left: 0, top: 0, right: canvas.width, bottom: canvas.height }) : (placementBounds(layer) ?? NO_BOUNDS);
      if (!canvas) {
        warn({ path, message: "Smart object had no decodable preview raster; rendered as empty." });
      }
      const imageAssetId = await sink.putImage(canvas ? canvas.toBuffer("image/png") : emptyRaster(), path);
      warn({
        path,
        message:
          "Smart object content baked at authoring time; live smart filters and warps are not re-simulated (spec §7 scope limit). Mark this layer as a replaceable field to allow end-user photo replacement.",
      });
      return {
        type: "smartObject",
        id,
        path,
        name: layer.name ?? "Smart Object",
        visible,
        opacity,
        blendMode,
        clipping,
        locked,
        maskAssetId,
        bounds,
        imageAssetId,
        placement: IdentityTransform,
        intrinsicWidth: Math.max(1, bounds.right - bounds.left),
        intrinsicHeight: Math.max(1, bounds.bottom - bounds.top),
        replaceable: false, // admin opts a smart object into end-user replacement during field mapping (§10)
      };
    }

    // --- Adjustment layer ---
    if (layer.adjustment) {
      const bounds = { left: 0, top: 0, right: psd.width, bottom: psd.height };
      warn({ path, message: `Adjustment layer ("${layer.adjustment.type}") is visibility-togglable only in v1 (spec §7).` });
      return {
        type: "adjustment",
        id,
        path,
        name: layer.name ?? "Adjustment",
        visible,
        opacity,
        blendMode,
        clipping,
        locked,
        maskAssetId,
        bounds,
        adjustmentKind: layer.adjustment.type,
        previewAssetId: null,
      };
    }

    // --- Pixel / shape layer (default) ---
    // An empty layer has no pixels but is still a layer in the design, so it stays in the tree.
    const canvas = layer.canvas as unknown as RasterCanvas | undefined;
    if (!canvas && hasPixels(layer)) {
      warn({ path, message: "Layer's pixels could not be decoded; it renders empty." });
    }
    const bounds = canvas ? boundsOf(layer, { left: 0, top: 0, right: canvas.width, bottom: canvas.height }) : boundsOf(layer, NO_BOUNDS);
    const imageAssetId = await sink.putImage(canvas ? canvas.toBuffer("image/png") : emptyRaster(), path);
    const isShape = !!(layer.vectorFill || layer.vectorMask);
    if (isShape) {
      return {
        type: "shape",
        id,
        path,
        name: layer.name ?? "Shape",
        visible,
        opacity,
        blendMode,
        clipping,
        locked,
        maskAssetId,
        bounds,
        imageAssetId,
      };
    }
    return {
      type: "pixel",
      id,
      path,
      name: layer.name ?? "Layer",
      visible,
      opacity,
      blendMode,
      clipping,
      locked,
      maskAssetId,
      bounds,
      imageAssetId,
    };
  }

  const rootNodes = await convertLayers(psd.children ?? [], "", "");

  const sceneGraph: SceneGraph = {
    formatVersion: 1,
    width: psd.width,
    height: psd.height,
    dpi: extractDpi(psd),
    colorMode: mapColorMode(psd.colorMode),
    iccProfileName: null,
    root: rootNodes,
  };

  return { sceneGraph, warnings };
}
