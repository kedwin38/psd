import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  createDomBuffer,
  hitTest,
  isNodeVisible,
  measureTextBounds,
  rasterAssetId,
  renderScene,
  type Ctx2D,
  type LayerImageStore,
} from "@psd-studio/canvas-renderer";
import type { Rect, SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { findNode } from "./sceneTree";

const PADDING = 24;
/** Backing-store pixels per PSD pixel are capped so small templates on HiDPI screens don't allocate huge canvases. */
const MAX_RENDER_SCALE = 2;

export function SceneCanvas({
  graph,
  images,
  imagesVersion,
  visibility,
  selectedId,
  onSelect,
  isPickable,
  status,
}: {
  graph: SceneGraph;
  images: LayerImageStore | null;
  imagesVersion: number;
  visibility: ReadonlyMap<string, boolean>;
  selectedId: string | null;
  onSelect: (node: SceneNode) => void;
  isPickable?: (node: SceneNode) => boolean;
  status?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<SceneNode | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = Math.max(0, Math.min((box.width - PADDING * 2) / graph.width, (box.height - PADDING * 2) / graph.height));
  const renderScale = Math.min(fit * (window.devicePixelRatio || 1), MAX_RENDER_SCALE);
  const pixelWidth = Math.max(1, Math.round(graph.width * renderScale));
  const pixelHeight = Math.max(1, Math.round(graph.height * renderScale));

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || fit <= 0 || !images) return;
    const frame = requestAnimationFrame(() => renderScene(ctx, graph, { scale: renderScale, images: images.get, visibility }));
    return () => cancelAnimationFrame(frame);
  }, [graph, images, imagesVersion, visibility, renderScale, pixelWidth, pixelHeight, fit]);

  const selected = useMemo(() => (selectedId ? findNode(graph.root, selectedId) : null), [graph, selectedId]);

  const boundsOf = useMemo(() => {
    const measured = new Map<string, Rect>();
    let measureCtx: Ctx2D | null = null;
    return (node: SceneNode): Rect => {
      const { left, top, right, bottom } = node.bounds;
      if (node.type !== "text" || (right > left && bottom > top)) return node.bounds;
      let rect = measured.get(node.id);
      if (!rect) {
        measureCtx ??= createDomBuffer(1, 1);
        rect = measureTextBounds(measureCtx, node);
        measured.set(node.id, rect);
      }
      return rect;
    };
  }, [graph]);

  useEffect(() => {
    const ctx = overlayRef.current?.getContext("2d");
    if (!ctx || fit <= 0) return;
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    const cssPx = renderScale / fit;
    if (hover && hover.id !== selected?.id) outline(ctx, boundsOf(hover), renderScale, cssPx, false);
    if (selected) outline(ctx, boundsOf(selected), renderScale, cssPx, true);
  }, [selected, hover, boundsOf, renderScale, pixelWidth, pixelHeight, fit]);

  const nodeAt = (e: PointerEvent<HTMLCanvasElement>): SceneNode | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * graph.width;
    const y = ((e.clientY - rect.top) / rect.height) * graph.height;
    return hitTest(graph, x, y, {
      isVisible: (n) => isNodeVisible(n, visibility),
      isPickable,
      boundsOf,
      alphaAt: (n, px, py) => {
        const assetId = rasterAssetId(n);
        if (!assetId || !images) return undefined;
        const { left, top, right, bottom } = n.bounds;
        return images.alphaAt(assetId, (px - left) / (right - left), (py - top) / (bottom - top));
      },
    });
  };

  return (
    <div ref={containerRef} className="scene-canvas">
      <div className="scene-canvas-stage" style={{ width: graph.width * fit, height: graph.height * fit }}>
        <canvas ref={canvasRef} className="scene-canvas-layer checkerboard" width={pixelWidth} height={pixelHeight} role="img" aria-label="Template canvas" />
        <canvas
          ref={overlayRef}
          className="scene-canvas-layer"
          width={pixelWidth}
          height={pixelHeight}
          style={{ cursor: hover ? "pointer" : "default" }}
          onPointerMove={(e) => {
            const node = nodeAt(e);
            if (node?.id !== hover?.id) setHover(node);
          }}
          onPointerLeave={() => setHover(null)}
          onPointerUp={(e) => {
            if (e.button !== 0) return;
            const node = nodeAt(e);
            if (node) onSelect(node);
          }}
        />
      </div>
      {hover && <div className="scene-canvas-chip hover">{hover.name}</div>}
      {status && <div className="scene-canvas-chip status">{status}</div>}
    </div>
  );
}

function outline(ctx: CanvasRenderingContext2D, bounds: Rect, scale: number, cssPx: number, selected: boolean): void {
  const x = Math.round(bounds.left * scale) + 0.5;
  const y = Math.round(bounds.top * scale) + 0.5;
  const w = Math.max(1, Math.round((bounds.right - bounds.left) * scale) - 1);
  const h = Math.max(1, Math.round((bounds.bottom - bounds.top) * scale) - 1);
  ctx.save();
  ctx.lineWidth = cssPx * (selected ? 1.5 : 1);
  if (selected) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([5 * cssPx, 4 * cssPx]);
    ctx.strokeStyle = "#4f8cff";
  } else {
    ctx.strokeStyle = "rgba(79, 140, 255, 0.65)";
  }
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}
