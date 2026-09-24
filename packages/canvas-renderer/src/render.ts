import type { FieldOverride, GroupNode, Rect, SceneGraph, SceneNode, TextLayerNode, TextRun } from "@psd-studio/scene-graph";
import { COMPOSITE_OPERATION } from "./blend.js";
import { clipUnits, createDomBuffer, type BufferFactory, type ClipUnit, type Ctx2D } from "./buffer.js";
import { cssFont, rgbaToCss } from "./text.js";

export type ImageLookup = (assetId: string) => CanvasImageSource | undefined;

export interface SceneRenderOptions {
  /** Canvas pixels per scene (PSD) pixel. */
  scale: number;
  /** Canvas-pixel position of the scene origin, for rendering a zoomed/panned viewport. */
  origin?: { x: number; y: number };
  images: ImageLookup;
  /** View-only visibility (e.g. the layers panel eye); wins over field overrides and authored visibility. */
  visibility?: ReadonlyMap<string, boolean>;
  overrides?: readonly FieldOverride[];
  createBuffer?: BufferFactory;
}

/** Paints the graph into ctx: the whole scene if ctx is sized to graph dimensions × scale, or whatever part of it origin puts in view. */
export function renderScene(ctx: Ctx2D, graph: SceneGraph, options: SceneRenderOptions): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const painter = new Painter(options);
  // Diverges from server: SceneCompositor ignores clipping for top-level layers; Photoshop (and this) honor it.
  for (const unit of clipUnits(graph.root)) painter.paintClipUnit(ctx, unit);
}

export function isNodeVisible(node: SceneNode, visibility: ReadonlyMap<string, boolean> | undefined, overrides?: ReadonlyMap<string, FieldOverride>): boolean {
  const view = visibility?.get(node.id);
  if (view !== undefined) return view;
  const override = overrides?.get(node.id);
  if (override?.type === "visibility") return override.visible;
  return node.visible;
}

class Painter {
  private readonly overrides = new Map<string, FieldOverride>();
  private readonly createBuffer: BufferFactory;
  private readonly ox: number;
  private readonly oy: number;

  constructor(private readonly options: SceneRenderOptions) {
    for (const o of options.overrides ?? []) this.overrides.set(o.nodeId, o);
    this.createBuffer = options.createBuffer ?? createDomBuffer;
    this.ox = options.origin?.x ?? 0;
    this.oy = options.origin?.y ?? 0;
  }

  private visible(node: SceneNode): boolean {
    return isNodeVisible(node, this.options.visibility, this.overrides);
  }

  paintClipUnit(ctx: Ctx2D, unit: ClipUnit): void {
    this.paintNode(ctx, unit.base);
    if (unit.clipped.length === 0 || !this.visible(unit.base)) return;
    // Same approximation as the server: each clipped layer is masked to the base's alpha, then normal-composited.
    const mask = this.createBuffer(ctx.canvas.width, ctx.canvas.height);
    this.paintNode(mask, unit.base);
    for (const clipped of unit.clipped) {
      if (!this.visible(clipped)) continue;
      const layer = this.createBuffer(ctx.canvas.width, ctx.canvas.height);
      this.paintNode(layer, clipped);
      layer.globalCompositeOperation = "destination-in";
      layer.drawImage(mask.canvas, 0, 0);
      ctx.drawImage(layer.canvas, 0, 0);
    }
  }

  private paintNode(ctx: Ctx2D, node: SceneNode): void {
    if (!this.visible(node)) return;
    switch (node.type) {
      case "group":
        this.paintGroup(ctx, node);
        return;
      case "text":
        this.paintText(ctx, node);
        return;
      case "pixel":
      case "shape":
      case "smartObject": {
        const override = this.overrides.get(node.id);
        if (override?.type === "image") this.paintReplacement(ctx, node, override);
        else this.paintRaster(ctx, node, node.imageAssetId);
        return;
      }
      case "adjustment":
        // Same scope limit as the server: adjustment layers are structural only, their effect isn't applied.
        return;
    }
  }

  private paintGroup(ctx: Ctx2D, group: GroupNode): void {
    if (group.isPassThrough) {
      // Matches server: a pass-through group's own opacity is not applied (Photoshop would fade its children).
      for (const unit of clipUnits(group.children)) this.paintClipUnit(ctx, unit);
      return;
    }
    const buffer = this.createBuffer(ctx.canvas.width, ctx.canvas.height);
    for (const unit of clipUnits(group.children)) this.paintClipUnit(buffer, unit);
    ctx.save();
    ctx.globalAlpha = group.opacity;
    ctx.globalCompositeOperation = COMPOSITE_OPERATION[group.blendMode];
    ctx.drawImage(buffer.canvas, 0, 0);
    ctx.restore();
  }

  private paintRaster(ctx: Ctx2D, node: SceneNode, assetId: string): void {
    const image = this.options.images(assetId);
    if (!image) return;
    const { scale } = this.options;
    const { left, top, right, bottom } = node.bounds;
    ctx.save();
    ctx.globalAlpha = node.opacity;
    ctx.globalCompositeOperation = COMPOSITE_OPERATION[node.blendMode];
    ctx.drawImage(image, left * scale + this.ox, top * scale + this.oy, Math.max(1, (right - left) * scale), Math.max(1, (bottom - top) * scale));
    ctx.restore();
  }

  private paintReplacement(ctx: Ctx2D, node: SceneNode, override: Extract<FieldOverride, { type: "image" }>): void {
    const image = this.options.images(override.imageAssetId);
    if (!image) return;
    const { width: iw, height: ih } = imageSize(image);
    const { scale } = this.options;
    const { left, top, right, bottom } = node.bounds;
    ctx.save();
    ctx.globalAlpha = node.opacity;
    ctx.globalCompositeOperation = COMPOSITE_OPERATION[node.blendMode];
    ctx.drawImage(
      image,
      override.crop.x * iw,
      override.crop.y * ih,
      Math.max(1, override.crop.width * iw),
      Math.max(1, override.crop.height * ih),
      left * scale + this.ox,
      top * scale + this.oy,
      Math.max(1, (right - left) * scale),
      Math.max(1, (bottom - top) * scale),
    );
    ctx.restore();
  }

  private paintText(ctx: Ctx2D, node: TextLayerNode): void {
    const { scale } = this.options;
    const override = this.overrides.get(node.id);
    ctx.save();
    // Diverges from server: SceneCompositor ignores a text layer's own opacity and blend mode.
    ctx.globalAlpha = node.opacity;
    ctx.globalCompositeOperation = COMPOSITE_OPERATION[node.blendMode];
    ctx.textBaseline = "alphabetic";

    if (override?.type === "text") {
      const style = node.runs[0]!;
      ctx.fillStyle = rgbaToCss(style.color);
      const lines = wrapFieldText(ctx, node, override.text, scale);
      const lineHeight = (style.leadingPt ?? style.fontSize * 1.2) * scale;
      let y = node.bounds.top * scale + this.oy + style.fontSize * scale;
      for (const line of lines) {
        drawAlignedLine(ctx, line, node.alignment, node.bounds.left * scale + this.ox, node.bounds.right * scale + this.ox, y);
        y += lineHeight;
      }
      ctx.restore();
      return;
    }

    const left = node.bounds.left * scale + this.ox;
    let x = left;
    let y = node.bounds.top * scale + this.oy + node.runs[0]!.fontSize * scale;
    for (const run of node.runs) {
      const sizePx = run.fontSize * scale;
      ctx.font = cssFont(run, sizePx);
      ctx.fillStyle = rgbaToCss(run.color);
      setTracking(ctx, run.tracking, sizePx);
      const segments = run.text.split(/\r\n|\r|\n/);
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) {
          x = left;
          y += (run.leadingPt ?? run.fontSize * 1.2) * scale;
        }
        ctx.fillText(segments[i]!, x, y);
        x += ctx.measureText(segments[i]!).width;
      }
    }
    ctx.restore();
  }
}

/** Scene-space extents of authored text exactly as paintText lays it out (for PSDs that store empty text-layer bounds). */
export function measureTextBounds(ctx: Ctx2D, node: TextLayerNode): Rect {
  const { left, top } = node.bounds;
  let right = left;
  let lastBaseline = top;
  let descent = 0;
  layoutRuns(ctx, node, (_runIndex, run, x, baseline, metrics) => {
    right = Math.max(right, x + metrics.width);
    lastBaseline = baseline;
    descent = Math.max(descent, run.fontSize * 0.25);
  });
  return { left, top, right, bottom: lastBaseline + descent };
}

export interface TextRunBox {
  /** Index into node.runs; a run spanning several lines yields one box per line. */
  run: number;
  /** Scene-space glyph (ink) bounds, which can be much tighter or looser than the layer's stored bounds. */
  rect: Rect;
}

/** Per-run glyph boxes of authored text, laid out exactly as paintText draws it; whitespace-only segments get no box. */
export function textRunBoxes(ctx: Ctx2D, node: TextLayerNode): TextRunBox[] {
  const boxes: TextRunBox[] = [];
  layoutRuns(ctx, node, (run, _style, x, baseline, m) => {
    const rect = { left: x - m.actualBoundingBoxLeft, top: baseline - m.actualBoundingBoxAscent, right: x + m.actualBoundingBoxRight, bottom: baseline + m.actualBoundingBoxDescent };
    if (rect.right > rect.left && rect.bottom > rect.top) boxes.push({ run, rect });
  });
  return boxes;
}

/**
 * Sets ctx to a text field's style (its first run, as both compositors use for replacement text) at
 * scale and greedy-wraps the text to the layer's width; leaves the style set for drawing.
 */
function wrapFieldText(ctx: Ctx2D, node: TextLayerNode, text: string, scale: number): string[] {
  const style = node.runs[0]!;
  const sizePx = style.fontSize * scale;
  ctx.font = cssFont(style, sizePx);
  setTracking(ctx, style.tracking, sizePx);
  const boxWidth = (node.bounds.right - node.bounds.left) * scale;
  return wrapText(ctx, text, boxWidth || sizePx * 20);
}

export interface FieldTextFit {
  lines: number;
  /** Lines that fit in the layer's stored height; replacement text past that paints below the box. */
  capacity: number;
  /** A single word wider than the box can't wrap and paints past its right edge. */
  overflowsWidth: boolean;
}

/** How replacement text for a text field lays out at export scale (1 scene px = 1 output px). */
export function fieldTextFit(ctx: Ctx2D, node: TextLayerNode, text: string): FieldTextFit {
  ctx.save();
  const lines = wrapFieldText(ctx, node, text, 1);
  const boxWidth = node.bounds.right - node.bounds.left;
  const overflowsWidth = boxWidth > 0 && lines.some((line) => ctx.measureText(line).width > boxWidth + 0.5);
  ctx.restore();
  const style = node.runs[0]!;
  const leading = style.leadingPt ?? style.fontSize * 1.2;
  const room = node.bounds.bottom - node.bounds.top - style.fontSize * 1.25;
  const capacity = node.bounds.bottom > node.bounds.top ? Math.max(1, 1 + Math.floor(room / leading + 0.05)) : Infinity;
  return { lines: lines.length, capacity, overflowsWidth };
}

type RunSegmentVisitor =(runIndex: number, run: TextRun, x: number, baseline: number, metrics: TextMetrics) => void;

function layoutRuns(ctx: Ctx2D, node: TextLayerNode, visit: RunSegmentVisitor): void {
  const { left, top } = node.bounds;
  let x = left;
  let baseline = top + node.runs[0]!.fontSize;
  ctx.save();
  node.runs.forEach((run, runIndex) => {
    ctx.font = cssFont(run, run.fontSize);
    setTracking(ctx, run.tracking, run.fontSize);
    run.text.split(/\r\n|\r|\n/).forEach((segment, i) => {
      if (i > 0) {
        x = left;
        baseline += run.leadingPt ?? run.fontSize * 1.2;
      }
      const metrics = ctx.measureText(segment);
      visit(runIndex, run, x, baseline, metrics);
      x += metrics.width;
    });
  });
  ctx.restore();
}

// Diverges from server: SceneCompositor ignores tracking; PSD tracking is in 1/1000 em.
function setTracking(ctx: Ctx2D, tracking: number | undefined, sizePx: number): void {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${((tracking ?? 0) / 1000) * sizePx}px`;
}

function imageSize(image: CanvasImageSource): { width: number; height: number } {
  if ("naturalWidth" in image) return { width: image.naturalWidth, height: image.naturalHeight };
  if ("videoWidth" in image) return { width: image.videoWidth, height: image.videoHeight };
  if ("displayWidth" in image) return { width: image.displayWidth, height: image.displayHeight };
  if (typeof image.width === "number") return { width: image.width, height: image.height as number };
  const svg = image as SVGImageElement;
  return { width: svg.width.baseVal.value, height: svg.height.baseVal.value };
}

function wrapText(ctx: Ctx2D, text: string, maxWidthPx: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = words[0]!;
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidthPx) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

function drawAlignedLine(ctx: Ctx2D, line: string, alignment: TextLayerNode["alignment"], left: number, right: number, y: number): void {
  const width = ctx.measureText(line).width;
  let x = left;
  if (alignment === "center") x = left + (right - left - width) / 2;
  else if (alignment === "right") x = right - width;
  ctx.fillText(line, x, y);
}
