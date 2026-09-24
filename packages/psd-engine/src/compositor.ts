import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { SceneGraph, SceneNode, GroupNode, FieldOverride, Rgba } from "@psd-studio/scene-graph";
import { rgbaToCss } from "./color.js";

/** Loosely-typed napi-rs canvas 2D context so we avoid depending on lib.dom. */
type Ctx2D = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

export interface AssetSource {
  /** Fetches a stored image asset (a layer raster or a user upload) as PNG/JPEG bytes. */
  getImage(assetId: string): Promise<Buffer>;
}

export interface RenderOptions {
  /** 1 = native template resolution. Editor previews use small scales; export uses >=1 (spec §13). */
  scale?: number;
  /** Field-value edits to merge into the graph before painting (spec §7 pipeline). */
  overrides?: FieldOverride[];
}

export interface RenderWarning {
  nodeId: string;
  message: string;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  warnings: RenderWarning[];
}

function rectWidth(n: SceneNode) {
  return Math.max(0, n.bounds.right - n.bounds.left);
}
function rectHeight(n: SceneNode) {
  return Math.max(0, n.bounds.bottom - n.bounds.top);
}

/** Greedy word-wrap used when rendering user-entered text (original template runs render verbatim). */
function wrapText(ctx: Ctx2D, text: string, maxWidthPx: number): string[] {
  const paragraphs = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = words[0]!;
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      const candidate = `${current} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidthPx || current.length === 0) {
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

function fontString(fontName: string, fontSizePx: number, bold?: boolean, italic?: boolean): string {
  const weight = bold ? "bold " : "";
  const style = italic ? "italic " : "";
  return `${style}${weight}${fontSizePx}px "${fontName}"`;
}

export class SceneCompositor {
  constructor(private readonly assets: AssetSource) {}

  private imageCache = new Map<string, Promise<Image>>();

  private loadCached(assetId: string): Promise<Image> {
    let cached = this.imageCache.get(assetId);
    if (!cached) {
      cached = this.assets.getImage(assetId).then((buf) => loadImage(buf));
      this.imageCache.set(assetId, cached);
    }
    return cached;
  }

  async render(graph: SceneGraph, options: RenderOptions = {}): Promise<RenderResult> {
    const scale = options.scale ?? 1;
    const overridesByNode = new Map<string, FieldOverride>();
    for (const o of options.overrides ?? []) overridesByNode.set(o.nodeId, o);

    const width = Math.max(1, Math.round(graph.width * scale));
    const height = Math.max(1, Math.round(graph.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const warnings: RenderWarning[] = [];

    for (const node of graph.root) {
      await this.paintNode(ctx, node, scale, overridesByNode, warnings);
    }

    return { png: canvas.toBuffer("image/png"), width, height, warnings };
  }

  private isVisible(node: SceneNode, overridesByNode: Map<string, FieldOverride>): boolean {
    const override = overridesByNode.get(node.id);
    if (override?.type === "visibility") return override.visible;
    return node.visible;
  }

  private async paintNode(
    ctx: Ctx2D,
    node: SceneNode,
    scale: number,
    overridesByNode: Map<string, FieldOverride>,
    warnings: RenderWarning[],
  ): Promise<void> {
    if (!this.isVisible(node, overridesByNode)) return;

    switch (node.type) {
      case "group":
        await this.paintGroup(ctx, node, scale, overridesByNode, warnings);
        return;
      case "text":
        await this.paintText(ctx, node, scale, overridesByNode, warnings);
        return;
      // IMAGE fields map to pixel/shape layers and SMART_OBJECT fields to smart objects; both take the upload the same way.
      case "pixel":
      case "shape":
      case "smartObject": {
        const override = overridesByNode.get(node.id);
        if (override?.type === "image") {
          await this.paintReplacementImage(ctx, node, override, scale, warnings);
        } else {
          await this.paintRaster(ctx, node, node.imageAssetId, node.bounds, scale, node.opacity, node.blendMode, warnings);
        }
        return;
      }
      case "adjustment":
        // v1 scope limit (spec §7): adjustment layers are structural/visibility-togglable only —
        // the compositor does not yet apply their pixel effect to layers beneath them.
        warnings.push({ nodeId: node.id, message: "Adjustment layer effect not applied (structural support only)." });
        return;
    }
  }

  private async paintGroup(
    ctx: Ctx2D,
    group: GroupNode,
    scale: number,
    overridesByNode: Map<string, FieldOverride>,
    warnings: RenderWarning[],
  ): Promise<void> {
    if (group.isPassThrough) {
      // Pass-through groups don't isolate blending: paint children straight onto the parent buffer.
      for (const child of this.resolveClipStacks(group.children)) {
        await this.paintClipUnit(ctx, child, scale, overridesByNode, warnings);
      }
      return;
    }

    // Isolated group: composite children on an offscreen buffer, then merge as one unit
    // so the group's own opacity/blend mode apply to the flattened result (matches PSD semantics).
    const offscreen = createCanvas(ctx.canvas.width, ctx.canvas.height);
    const offCtx = offscreen.getContext("2d");
    for (const child of this.resolveClipStacks(group.children)) {
      await this.paintClipUnit(offCtx, child, scale, overridesByNode, warnings);
    }
    ctx.save();
    ctx.globalAlpha = group.opacity;
    (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = group.blendMode;
    ctx.drawImage(offscreen as unknown as Parameters<Ctx2D["drawImage"]>[0], 0, 0);
    ctx.restore();
  }

  /** Groups consecutive [base, ...clippedAbove] siblings so clip-to-base masking can be applied together. */
  private resolveClipStacks(children: SceneNode[]): ClipUnit[] {
    const units: ClipUnit[] = [];
    for (const child of children) {
      if (child.clipping && units.length > 0) {
        units[units.length - 1]!.clipped.push(child);
      } else {
        units.push({ base: child, clipped: [] });
      }
    }
    return units;
  }

  private async paintClipUnit(
    ctx: Ctx2D,
    unit: ClipUnit,
    scale: number,
    overridesByNode: Map<string, FieldOverride>,
    warnings: RenderWarning[],
  ): Promise<void> {
    await this.paintNode(ctx, unit.base, scale, overridesByNode, warnings);
    if (unit.clipped.length === 0) return;
    if (!this.isVisible(unit.base, overridesByNode)) return;

    // Approximation (documented, spec §7): each clipped-above layer is rendered on its own
    // transparent buffer, alpha-masked to the base layer's silhouette via "destination-in",
    // then normal-composited onto the parent. This matches Photoshop visually for the common
    // case (clipped photo/color inside a shape) but does not perfectly replay every nested
    // blend-mode interaction between clipped layers themselves.
    const baseMask = createCanvas(ctx.canvas.width, ctx.canvas.height);
    const baseMaskCtx = baseMask.getContext("2d");
    await this.paintNode(baseMaskCtx, unit.base, scale, overridesByNode, warnings);

    for (const clipped of unit.clipped) {
      const layer = createCanvas(ctx.canvas.width, ctx.canvas.height);
      const layerCtx = layer.getContext("2d");
      await this.paintNode(layerCtx, clipped, scale, overridesByNode, warnings);
      layerCtx.save();
      (layerCtx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = "destination-in";
      layerCtx.drawImage(baseMask as unknown as Parameters<Ctx2D["drawImage"]>[0], 0, 0);
      layerCtx.restore();
      ctx.drawImage(layer as unknown as Parameters<Ctx2D["drawImage"]>[0], 0, 0);
    }
  }

  private async paintRaster(
    ctx: Ctx2D,
    node: SceneNode,
    imageAssetId: string,
    bounds: SceneNode["bounds"],
    scale: number,
    opacity: number,
    blendMode: string,
    warnings: RenderWarning[],
  ): Promise<void> {
    let image: Image;
    try {
      image = await this.loadCached(imageAssetId);
    } catch {
      warnings.push({ nodeId: node.id, message: `Could not load image asset ${imageAssetId}.` });
      return;
    }
    ctx.save();
    ctx.globalAlpha = opacity;
    (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = blendMode;
    ctx.drawImage(
      image as unknown as Parameters<Ctx2D["drawImage"]>[0],
      bounds.left * scale,
      bounds.top * scale,
      Math.max(1, (bounds.right - bounds.left) * scale),
      Math.max(1, (bounds.bottom - bounds.top) * scale),
    );
    ctx.restore();
  }

  private async paintReplacementImage(
    ctx: Ctx2D,
    node: SceneNode,
    override: Extract<FieldOverride, { type: "image" }>,
    scale: number,
    warnings: RenderWarning[],
  ): Promise<void> {
    let image: Image;
    try {
      image = await this.loadCached(override.imageAssetId);
    } catch {
      warnings.push({ nodeId: node.id, message: `Could not load replacement image ${override.imageAssetId}.` });
      return;
    }
    const iw = image.width;
    const ih = image.height;
    const sx = override.crop.x * iw;
    const sy = override.crop.y * ih;
    const sw = Math.max(1, override.crop.width * iw);
    const sh = Math.max(1, override.crop.height * ih);

    ctx.save();
    ctx.globalAlpha = node.opacity;
    (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = node.blendMode;
    ctx.drawImage(
      image as unknown as Parameters<Ctx2D["drawImage"]>[0],
      sx,
      sy,
      sw,
      sh,
      node.bounds.left * scale,
      node.bounds.top * scale,
      Math.max(1, (node.bounds.right - node.bounds.left) * scale),
      Math.max(1, (node.bounds.bottom - node.bounds.top) * scale),
    );
    ctx.restore();
  }

  private async paintText(
    ctx: Ctx2D,
    node: Extract<SceneNode, { type: "text" }>,
    scale: number,
    overridesByNode: Map<string, FieldOverride>,
    warnings: RenderWarning[],
  ): Promise<void> {
    const override = overridesByNode.get(node.id);
    const boxWidth = rectWidth(node) * scale;
    ctx.save();
    ctx.textBaseline = "alphabetic";

    if (override?.type === "text") {
      const style = node.runs[0];
      if (!style) {
        warnings.push({ nodeId: node.id, message: "Text field has no base style to inherit; skipped." });
        ctx.restore();
        return;
      }
      const fontSizePx = style.fontSize * scale;
      ctx.font = fontString(style.fontName, fontSizePx, style.bold, style.italic);
      ctx.fillStyle = rgbaToCss(style.color);
      const lineHeight = (style.leadingPt ?? style.fontSize * 1.2) * scale;
      const lines = wrapText(ctx, override.text, boxWidth || fontSizePx * 20);
      let y = node.bounds.top * scale + fontSizePx;
      for (const line of lines) {
        this.drawAlignedLine(ctx, line, node, scale, y);
        y += lineHeight;
      }
      ctx.restore();
      return;
    }

    // No override: render the original authored runs left-to-right on the layer's baseline(s).
    let x = node.bounds.left * scale;
    let y = node.bounds.top * scale + node.runs[0]!.fontSize * scale;
    for (const run of node.runs) {
      const fontSizePx = run.fontSize * scale;
      ctx.font = fontString(run.fontName, fontSizePx, run.bold, run.italic);
      ctx.fillStyle = rgbaToCss(run.color);
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

  private drawAlignedLine(ctx: Ctx2D, line: string, node: Extract<SceneNode, { type: "text" }>, scale: number, y: number): void {
    const left = node.bounds.left * scale;
    const right = node.bounds.right * scale;
    const width = ctx.measureText(line).width;
    let x = left;
    if (node.alignment === "center") x = left + (right - left - width) / 2;
    else if (node.alignment === "right") x = right - width;
    ctx.fillText(line, x, y);
  }
}

interface ClipUnit {
  base: SceneNode;
  clipped: SceneNode[];
}

export function textColorCss(color: Rgba): string {
  return rgbaToCss(color);
}
