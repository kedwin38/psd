import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import {
  authoredWrapWidth,
  fieldWrapWidth,
  layoutText,
  type SceneGraph,
  type SceneNode,
  type GroupNode,
  type FieldOverride,
  type Rgba,
  type TextLayerNode,
  type TextMeasure,
  type TextRun,
} from "@psd-studio/scene-graph";
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

/** A run's font at its local size; the type frame's transform scales it into the scene. */
function fontString(run: TextRun): string {
  const weight = run.bold ? "bold " : "";
  const style = run.italic ? "italic " : "";
  return `${style}${weight}${run.fontSize}px "${run.fontName}"`;
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
        this.paintText(ctx, node, scale, overridesByNode);
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

  /** Lays text out with the same shared layout as the client renderer, then draws it through the layer's type frame. */
  private paintText(ctx: Ctx2D, node: TextLayerNode, scale: number, overridesByNode: Map<string, FieldOverride>): void {
    const override = overridesByNode.get(node.id);
    const runs = override?.type === "text" ? [{ ...node.runs[0]!, text: override.text }] : node.runs;
    ctx.save();
    const measure: TextMeasure = {
      width(text, run) {
        ctx.font = fontString(run);
        return ctx.measureText(text).width;
      },
      capHeight(run) {
        ctx.font = fontString(run);
        return ctx.measureText("H").actualBoundingBoxAscent;
      },
    };
    const { transform: t, lines } = layoutText(node, runs, measure, override?.type === "text" ? fieldWrapWidth(node, measure) : authoredWrapWidth(node));
    ctx.textBaseline = "alphabetic";
    ctx.transform(scale, 0, 0, scale, 0, 0);
    ctx.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
    for (const line of lines) {
      for (const segment of line.segments) {
        const run = runs[segment.run]!;
        ctx.font = fontString(run);
        ctx.fillStyle = rgbaToCss(run.color);
        ctx.fillText(segment.text, segment.x, line.baseline);
      }
    }
    ctx.restore();
  }
}

interface ClipUnit {
  base: SceneNode;
  clipped: SceneNode[];
}

export function textColorCss(color: Rgba): string {
  return rgbaToCss(color);
}
