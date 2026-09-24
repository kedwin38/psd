import {
  authoredWrapWidth,
  fieldWrapWidth,
  glyphTransform,
  layoutText,
  lineHeight,
  lineWidth,
  textFrame,
  transformRect,
  type FieldOverride,
  type GroupNode,
  type Rect,
  type SceneGraph,
  type SceneNode,
  type TextLayerNode,
  type TextLayout,
  type TextRun,
} from "@psd-studio/scene-graph";
import { COMPOSITE_OPERATION } from "./blend.js";
import { clipUnits, createDomBuffer, type BufferFactory, type ClipUnit, type Ctx2D } from "./buffer.js";
import { rgbaToCss, setRunFont, textMeasure } from "./text.js";

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
    const override = this.overrides.get(node.id);
    const { transform: t, lines, runs } = layoutFor(ctx, node, override?.type === "text" ? override.text : undefined);
    const { scale } = this.options;
    ctx.save();
    // Diverges from server: SceneCompositor ignores a text layer's own opacity and blend mode.
    ctx.globalAlpha = node.opacity;
    ctx.globalCompositeOperation = COMPOSITE_OPERATION[node.blendMode];
    ctx.textBaseline = "alphabetic";
    ctx.transform(scale, 0, 0, scale, this.ox, this.oy);
    ctx.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
    for (const line of lines) {
      for (const segment of line.segments) {
        const run = runs[segment.run]!;
        const g = glyphTransform(line, segment, run);
        ctx.save();
        ctx.transform(g.m00, g.m10, g.m01, g.m11, g.m02, g.m12);
        setRunFont(ctx, run);
        ctx.fillStyle = rgbaToCss(run.color);
        ctx.fillText(segment.text, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

type RunsLayout = TextLayout & { runs: readonly TextRun[] };

/** The authored runs as paintText lays them out, or with text given, that replacement text in the first run's style. */
function layoutFor(ctx: Ctx2D, node: TextLayerNode, text?: string): RunsLayout {
  ctx.save();
  try {
    const measure = textMeasure(ctx);
    const runs = text === undefined ? node.runs : [{ ...node.runs[0]!, text }];
    return { ...layoutText(node, runs, measure, text === undefined ? authoredWrapWidth(node) : fieldWrapWidth(node, measure)), runs };
  } finally {
    ctx.restore();
  }
}

/** Scene-space extents of laid-out lines, each spanning a font size above its baseline to a quarter below. */
function layoutExtent(node: TextLayerNode, { transform, lines, runs }: RunsLayout): Rect {
  const box = textFrame(node).box;
  const local = lines.map((line): Rect => {
    const size = Math.max(runs[0]!.fontSize, ...line.segments.map((s) => runs[s.run]!.fontSize));
    const left = line.segments[0]?.x ?? box?.left ?? 0;
    return { left, top: line.baseline - size, right: left + lineWidth(line), bottom: line.baseline + size * 0.25 };
  });
  return transformRect(transform, {
    left: Math.min(...local.map((r) => r.left)),
    top: Math.min(...local.map((r) => r.top)),
    right: Math.max(...local.map((r) => r.right)),
    bottom: Math.max(...local.map((r) => r.bottom)),
  });
}

/** Scene-space extents of authored text exactly as paintText lays it out (for PSDs that store empty text-layer bounds). */
export function measureTextBounds(ctx: Ctx2D, node: TextLayerNode): Rect {
  return layoutExtent(node, layoutFor(ctx, node));
}

export interface TextRunBox {
  /** Index into node.runs; a run spanning several lines yields one box per line. */
  run: number;
  /** Scene-space glyph (ink) bounds, which can be much tighter or looser than the layer's stored bounds. */
  rect: Rect;
}

/** Per-run glyph boxes of authored text, laid out exactly as paintText draws it; whitespace-only segments get no box. */
export function textRunBoxes(ctx: Ctx2D, node: TextLayerNode): TextRunBox[] {
  const { transform, lines, runs } = layoutFor(ctx, node);
  const boxes: TextRunBox[] = [];
  ctx.save();
  for (const line of lines) {
    for (const s of line.segments) {
      const run = runs[s.run]!;
      setRunFont(ctx, run);
      const m = ctx.measureText(s.text);
      const glyphs = { left: -m.actualBoundingBoxLeft, top: -m.actualBoundingBoxAscent, right: m.actualBoundingBoxRight, bottom: m.actualBoundingBoxDescent };
      if (glyphs.right > glyphs.left && glyphs.bottom > glyphs.top) boxes.push({ run: s.run, rect: transformRect(transform, transformRect(glyphTransform(line, s, run), glyphs)) });
    }
  }
  ctx.restore();
  return boxes;
}

export interface FieldTextFit {
  lines: number;
  /** Lines the layout has room for: those fitting a paragraph box, or point text's authored line count; more paint past it. */
  capacity: number;
  /** A single word wider than the box can't wrap and paints past its right edge. */
  overflowsWidth: boolean;
}

/** How replacement text for a text field lays out, as the export draws it. */
export function fieldTextFit(ctx: Ctx2D, node: TextLayerNode, text: string): FieldTextFit {
  ctx.save();
  const measure = textMeasure(ctx);
  const width = fieldWrapWidth(node, measure);
  const { lines } = layoutText(node, [{ ...node.runs[0]!, text }], measure, width);
  const authoredLines = layoutText(node, node.runs, measure, authoredWrapWidth(node)).lines.length;
  ctx.restore();
  const overflowsWidth = lines.some((line) => lineWidth(line) > width + 0.5);
  const box = textFrame(node).box;
  if (!box) return { lines: lines.length, capacity: authoredLines, overflowsWidth };
  const style = node.runs[0]!;
  const room = box.bottom - box.top - style.fontSize * 1.25;
  const capacity = box.bottom > box.top ? Math.max(1, 1 + Math.floor(room / lineHeight(style) + 0.05)) : Infinity;
  return { lines: lines.length, capacity, overflowsWidth };
}

/** Scene-space extents of replacement text exactly as paintText lays it out (for text layers stored with empty bounds). */
export function measureFieldTextBounds(ctx: Ctx2D, node: TextLayerNode, text: string): Rect {
  return layoutExtent(node, layoutFor(ctx, node, text));
}

function imageSize(image: CanvasImageSource): { width: number; height: number } {
  if ("naturalWidth" in image) return { width: image.naturalWidth, height: image.naturalHeight };
  if ("videoWidth" in image) return { width: image.videoWidth, height: image.videoHeight };
  if ("displayWidth" in image) return { width: image.displayWidth, height: image.displayHeight };
  if (typeof image.width === "number") return { width: image.width, height: image.height as number };
  const svg = image as SVGImageElement;
  return { width: svg.width.baseVal.value, height: svg.height.baseVal.value };
}
