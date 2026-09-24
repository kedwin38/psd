import type { FieldOverride, GroupNode, Rect, SceneGraph, SceneNode, SmartObjectLayerNode, TextLayerNode } from "@psd-studio/scene-graph";
import { COMPOSITE_OPERATION } from "./blend.js";
import { clipUnits, createDomBuffer, type BufferFactory, type ClipUnit, type Ctx2D } from "./buffer.js";
import { cssFont, rgbaToCss } from "./text.js";

export type ImageLookup = (assetId: string) => CanvasImageSource | undefined;

export interface SceneRenderOptions {
  /** Canvas pixels per scene (PSD) pixel. */
  scale: number;
  images: ImageLookup;
  /** View-only visibility (e.g. the layers panel eye); wins over field overrides and authored visibility. */
  visibility?: ReadonlyMap<string, boolean>;
  overrides?: readonly FieldOverride[];
  createBuffer?: BufferFactory;
}

/** Paints the whole graph into ctx, which must already be sized to graph dimensions × scale. */
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

  constructor(private readonly options: SceneRenderOptions) {
    for (const o of options.overrides ?? []) this.overrides.set(o.nodeId, o);
    this.createBuffer = options.createBuffer ?? createDomBuffer;
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
        this.paintRaster(ctx, node, node.imageAssetId);
        return;
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
    ctx.drawImage(image, left * scale, top * scale, Math.max(1, (right - left) * scale), Math.max(1, (bottom - top) * scale));
    ctx.restore();
  }

  private paintReplacement(ctx: Ctx2D, node: SmartObjectLayerNode, override: Extract<FieldOverride, { type: "image" }>): void {
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
      left * scale,
      top * scale,
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
      const sizePx = style.fontSize * scale;
      ctx.font = cssFont(style, sizePx);
      ctx.fillStyle = rgbaToCss(style.color);
      setTracking(ctx, style.tracking, sizePx);
      const lineHeight = (style.leadingPt ?? style.fontSize * 1.2) * scale;
      const boxWidth = (node.bounds.right - node.bounds.left) * scale;
      let y = node.bounds.top * scale + sizePx;
      for (const line of wrapText(ctx, override.text, boxWidth || sizePx * 20)) {
        drawAlignedLine(ctx, line, node, scale, y);
        y += lineHeight;
      }
      ctx.restore();
      return;
    }

    let x = node.bounds.left * scale;
    let y = node.bounds.top * scale + node.runs[0]!.fontSize * scale;
    for (const run of node.runs) {
      const sizePx = run.fontSize * scale;
      ctx.font = cssFont(run, sizePx);
      ctx.fillStyle = rgbaToCss(run.color);
      setTracking(ctx, run.tracking, sizePx);
      const segments = run.text.split(/\r\n|\r|\n/);
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) {
          x = node.bounds.left * scale;
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
  let x = left;
  let right = left;
  let baseline = top + node.runs[0]!.fontSize;
  let descent = 0;
  ctx.save();
  for (const run of node.runs) {
    ctx.font = cssFont(run, run.fontSize);
    setTracking(ctx, run.tracking, run.fontSize);
    const segments = run.text.split(/\r\n|\r|\n/);
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        x = left;
        baseline += run.leadingPt ?? run.fontSize * 1.2;
      }
      x += ctx.measureText(segments[i]!).width;
      right = Math.max(right, x);
    }
    descent = Math.max(descent, run.fontSize * 0.25);
  }
  ctx.restore();
  return { left, top, right, bottom: baseline + descent };
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

function drawAlignedLine(ctx: Ctx2D, line: string, node: TextLayerNode, scale: number, y: number): void {
  const left = node.bounds.left * scale;
  const right = node.bounds.right * scale;
  const width = ctx.measureText(line).width;
  let x = left;
  if (node.alignment === "center") x = left + (right - left - width) / 2;
  else if (node.alignment === "right") x = right - width;
  ctx.fillText(line, x, y);
}
