import { readPsd, type Psd, type Layer, ColorMode as AgColorMode } from "ag-psd";
import {
  type SceneGraph,
  type SceneNode,
  type Rect,
  type ColorMode,
  type TextRun,
  IdentityTransform,
  idFromPath,
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

  const toRun = (text: string, style: typeof baseStyle): TextRun => ({
    text,
    fontName: style.font?.name ?? baseStyle.font?.name ?? "Helvetica",
    fontSize: style.fontSize ?? baseStyle.fontSize ?? 12,
    color: toRgba(style.fillColor ?? baseStyle.fillColor, 1),
    tracking: style.tracking ?? baseStyle.tracking,
    leadingPt: style.leading ?? baseStyle.leading,
    bold: style.fauxBold ?? baseStyle.fauxBold,
    italic: style.fauxItalic ?? baseStyle.fauxItalic,
  });

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

  async function convertLayer(layer: Layer, parentPath: string): Promise<SceneNode | null> {
    const path = parentPath ? `${parentPath}/${layer.name ?? "Layer"}` : layer.name ?? "Layer";
    const id = idFromPath(path);
    const visible = !layer.hidden;
    const opacity = layer.opacity ?? 1;
    const { mode: blendMode, exact } = mapBlendMode(layer.blendMode);
    if (!exact) {
      warn({ path, message: `Blend mode "${layer.blendMode}" approximated as "${blendMode}" (no exact Canvas2D equivalent).` });
    }
    const clipping = !!layer.clipping;
    const maskAssetId: string | null = null; // v1: masks are baked into the layer raster by ag-psd's decode; standalone editable masks are a Phase 2 item.

    // --- Group ---
    if (layer.children) {
      const childNodes: SceneNode[] = [];
      for (const child of layer.children) {
        const node = await convertLayer(child, path);
        if (node) childNodes.push(node);
      }
      const bounds =
        unionBounds(childNodes.map((n) => n.bounds)) ?? { left: 0, top: 0, right: psd.width, bottom: psd.height };
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
        maskAssetId,
        bounds,
        isPassThrough,
        children: childNodes,
      };
    }

    // --- Text ---
    if (layer.text) {
      const runs = buildTextRuns(layer, warnings, path);
      const bounds = boundsOf(layer, { left: 0, top: 0, right: 0, bottom: 0 });
      return {
        type: "text",
        id,
        path,
        name: layer.name ?? "Text",
        visible,
        opacity,
        blendMode,
        clipping,
        maskAssetId,
        bounds,
        runs,
        alignment: mapAlignment(layer.text.paragraphStyle?.justification),
        boxMode: layer.text.shapeType === "box" ? "paragraph" : "point",
      };
    }

    // --- Smart object ---
    if (layer.placedLayer) {
      const canvas = layer.canvas as unknown as RasterCanvas | undefined;
      const bounds = boundsOf(layer, canvas ? { left: 0, top: 0, right: canvas.width, bottom: canvas.height } : { left: 0, top: 0, right: 0, bottom: 0 });
      if (!canvas) {
        warn({ path, message: "Smart object had no decodable preview raster; rendered as empty." });
      }
      const imageAssetId = canvas ? await sink.putImage(canvas.toBuffer("image/png"), path) : await sink.putImage(Buffer.alloc(0), path);
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
        maskAssetId,
        bounds,
        adjustmentKind: layer.adjustment.type,
        previewAssetId: null,
      };
    }

    // --- Pixel / shape layer (default) ---
    const canvas = layer.canvas as unknown as RasterCanvas | undefined;
    if (canvas) {
      const bounds = boundsOf(layer, { left: 0, top: 0, right: canvas.width, bottom: canvas.height });
      const imageAssetId = await sink.putImage(canvas.toBuffer("image/png"), path);
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
        maskAssetId,
        bounds,
        imageAssetId,
      };
    }

    warn({ path, message: "Layer had no decodable pixel content; it was skipped." });
    return null;
  }

  const rootNodes: SceneNode[] = [];
  for (const layer of psd.children ?? []) {
    const node = await convertLayer(layer, "");
    if (node) rootNodes.push(node);
  }

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
