import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type Ref } from "react";
import {
  createDomBuffer,
  hitTest,
  isNodeVisible,
  measureTextBounds,
  rasterAssetId,
  renderScene,
  rgbaToCss,
  textRunBoxes,
  type Ctx2D,
  type LayerImageStore,
  type TextRunBox,
} from "@psd-studio/canvas-renderer";
import type { Rect, SceneGraph, SceneNode, TextLayerNode } from "@psd-studio/scene-graph";
import { isTypingTarget } from "../lib/keyboard";
import { findNode } from "./sceneTree";
import { fitRect, toScene, zoomAround, type View } from "./viewport";

const PADDING = 24;
const FOCUS_PADDING = 64;
/** Double-clicking a short word shouldn't zoom so far in that its surroundings vanish. */
const FOCUS_MAX_ZOOM = 8;
export const ZOOM_STEP = 1.25;
const CLICK_SLOP_PX = 4;
const DROPPABLE_TYPES = /^image\/(png|jpeg|webp)$/;

export interface SceneCanvasHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
  actualSize: () => void;
  /** Leaves text-focus mode; false if it wasn't active. */
  exitTextFocus: () => boolean;
}

export interface ImageDrop {
  /** Why a dropped image can't replace this node's raster, or null if it can. */
  rejectReason: (node: SceneNode | null) => string | null;
  onDrop: (node: SceneNode, file: File) => void;
}

type Point = { x: number; y: number };
type Gesture = { kind: "pan"; start: Point; view: View } | { kind: "pinch"; dist: number; mid: Point; view: View };

export function SceneCanvas({
  graph,
  images,
  imagesVersion,
  visibility,
  selectedId,
  onSelect,
  isPickable,
  status,
  imageDrop,
  ref,
}: {
  graph: SceneGraph;
  images: LayerImageStore | null;
  imagesVersion: number;
  visibility: ReadonlyMap<string, boolean>;
  selectedId: string | null;
  onSelect: (node: SceneNode) => void;
  isPickable?: (node: SceneNode) => boolean;
  status?: string | null;
  imageDrop?: ImageDrop;
  ref?: Ref<SceneCanvasHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const measureRef = useRef<Ctx2D | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  /** null follows "fit to screen" across resizes; set once the admin zooms or pans. */
  const [view, setView] = useState<View | null>(null);
  const [hover, setHover] = useState<SceneNode | null>(null);
  const [focus, setFocus] = useState<{ nodeId: string; run: number | null } | null>(null);
  const [drag, setDrag] = useState<{ node: SceneNode | null; reason: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const pointerInside = useRef(false);
  const touches = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const down = useRef<Point | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitted = useMemo(() => fitRect(box, { left: 0, top: 0, right: graph.width, bottom: graph.height }, PADDING), [box, graph.width, graph.height]);
  const fittedRef = useRef(fitted);
  fittedRef.current = fitted;
  const v = view ?? fitted;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(box.width * dpr));
  const pixelHeight = Math.max(1, Math.round(box.height * dpr));
  const ready = box.width > 0 && box.height > 0;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !ready || !images) return;
    const frame = requestAnimationFrame(() =>
      renderScene(ctx, graph, { scale: v.zoom * dpr, origin: { x: v.x * dpr, y: v.y * dpr }, images: images.get, visibility }),
    );
    return () => cancelAnimationFrame(frame);
  }, [graph, images, imagesVersion, visibility, v.zoom, v.x, v.y, dpr, pixelWidth, pixelHeight, ready]);

  const measureCtx = () => (measureRef.current ??= createDomBuffer(1, 1));

  const selected = useMemo(() => (selectedId ? findNode(graph.root, selectedId) : null), [graph, selectedId]);
  const focused = useMemo(() => {
    const node = focus ? findNode(graph.root, focus.nodeId) : null;
    return node?.type === "text" ? node : null;
  }, [graph, focus]);

  useEffect(() => {
    if (focus && focus.nodeId !== selectedId) setFocus(null);
  }, [focus, selectedId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const boundsOf = useMemo(() => {
    const measured = new Map<string, Rect>();
    return (node: SceneNode): Rect => {
      const { left, top, right, bottom } = node.bounds;
      if (node.type !== "text" || (right > left && bottom > top)) return node.bounds;
      let rect = measured.get(node.id);
      if (!rect) {
        rect = measureTextBounds(measureCtx(), node);
        measured.set(node.id, rect);
      }
      return rect;
    };
  }, [graph]);

  const runBoxes = useMemo(() => (focused ? textRunBoxes(measureCtx(), focused) : []), [focused]);
  const focusInk = focused ? (unionRect(runBoxes.map((b) => b.rect)) ?? boundsOf(focused)) : null;

  useEffect(() => {
    const ctx = overlayRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    if (!ready) return;
    const toPx = (r: Rect): Rect => ({
      left: (r.left * v.zoom + v.x) * dpr,
      top: (r.top * v.zoom + v.y) * dpr,
      right: (r.right * v.zoom + v.x) * dpr,
      bottom: (r.bottom * v.zoom + v.y) * dpr,
    });
    if (focused && focusInk) {
      const ink = toPx(focusInk);
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath();
      ctx.rect(0, 0, pixelWidth, pixelHeight);
      ctx.rect(ink.left - 4 * dpr, ink.top - 4 * dpr, ink.right - ink.left + 8 * dpr, ink.bottom - ink.top + 8 * dpr);
      ctx.fill("evenodd");
      ctx.restore();
      stroke(ctx, toPx(boundsOf(focused)), dpr, "rgba(255, 255, 255, 0.45)", [2, 3]);
      for (const b of runBoxes) {
        const r = toPx(b.rect);
        if (b.run === focus?.run) {
          ctx.fillStyle = "rgba(79, 140, 255, 0.28)";
          ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
        }
        stroke(ctx, r, dpr, b.run === focus?.run ? "#4f8cff" : "rgba(79, 140, 255, 0.6)");
      }
      outline(ctx, ink, dpr, true);
    } else {
      if (hover && hover.id !== selected?.id) outline(ctx, toPx(boundsOf(hover)), dpr, false);
      if (selected) outline(ctx, toPx(boundsOf(selected)), dpr, true);
    }
    if (drag?.node) {
      const r = toPx(boundsOf(drag.node));
      const ok = drag.reason === null;
      ctx.fillStyle = ok ? "rgba(46, 204, 113, 0.25)" : "rgba(231, 76, 60, 0.18)";
      ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
      stroke(ctx, r, dpr * 2, ok ? "#2ecc71" : "#e74c3c");
    }
  }, [selected, hover, focused, focusInk?.left, focusInk?.top, focusInk?.right, focusInk?.bottom, runBoxes, focus?.run, drag, boundsOf, v.zoom, v.x, v.y, dpr, pixelWidth, pixelHeight, ready]);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? r.height : 1);
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002));
      setView((prev) => zoomAround(prev ?? fittedRef.current, e.clientX - r.left, e.clientY - r.top, factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target)) return;
      if (e.type === "keyup") return setSpaceHeld(false);
      if (!pointerInside.current) return;
      e.preventDefault();
      setSpaceHeld(true);
    };
    const release = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
    };
  }, []);

  const zoomBy = (factor: number) => setView((prev) => zoomAround(prev ?? fittedRef.current, box.width / 2, box.height / 2, factor));

  useImperativeHandle(ref, () => ({
    zoomBy,
    fit: () => setView(null),
    actualSize: () => zoomBy(1 / v.zoom),
    exitTextFocus: () => {
      if (!focus) return false;
      setFocus(null);
      return true;
    },
  }));

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Drops ignore locks (the page rejects locked targets) so an image never lands on whatever a locked layer covers.
  const hitAt = (p: Point, respectLocks = true): SceneNode | null =>
    hitTest(graph, p.x, p.y, {
      isVisible: (n) => isNodeVisible(n, visibility),
      isPickable: respectLocks ? isPickable : undefined,
      boundsOf,
      alphaAt: (n, px, py) => {
        const assetId = rasterAssetId(n);
        if (!assetId || !images) return undefined;
        const { left, top, right, bottom } = n.bounds;
        return images.alphaAt(assetId, (px - left) / (right - left), (py - top) / (bottom - top));
      },
    });

  const inFocusedText = (s: Point) => !!focusInk && contains(inflate(focusInk, 6 / v.zoom), s);

  const click = (p: Point) => {
    const s = toScene(v, p.x, p.y);
    if (focus && inFocusedText(s)) {
      setFocus({ ...focus, run: runAt(runBoxes, s) });
      return;
    }
    setFocus(null);
    const node = hitAt(s);
    if (node) onSelect(node);
  };

  const focusText = (p: Point) => {
    const s = toScene(v, p.x, p.y);
    if (inFocusedText(s)) return;
    const node = hitAt(s);
    if (node?.type !== "text") return;
    const boxes = textRunBoxes(measureCtx(), node);
    onSelect(node);
    setFocus({ nodeId: node.id, run: runAt(boxes, s) });
    setView(fitRect(box, unionRect(boxes.map((b) => b.rect)) ?? boundsOf(node), FOCUS_PADDING, FOCUS_MAX_ZOOM));
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, p);
      e.currentTarget.setPointerCapture(e.pointerId);
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()] as [Point, Point];
        gesture.current = { kind: "pinch", dist: distance(a, b), mid: midpoint(a, b), view: v };
        down.current = null;
        return;
      }
    }
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = { kind: "pan", start: p, view: v };
      setPanning(true);
      return;
    }
    if (e.button === 0) down.current = p;
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g?.kind === "pinch") {
      const [a, b] = [...touches.current.values()];
      if (!a || !b) return;
      const mid = midpoint(a, b);
      const zoomed = zoomAround(g.view, g.mid.x, g.mid.y, distance(a, b) / g.dist);
      setView({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y });
      return;
    }
    if (g?.kind === "pan") {
      setView({ ...g.view, x: g.view.x + p.x - g.start.x, y: g.view.y + p.y - g.start.y });
      return;
    }
    if (e.pointerType === "touch" && down.current && distance(p, down.current) > CLICK_SLOP_PX) {
      gesture.current = { kind: "pan", start: down.current, view: v };
      down.current = null;
      setPanning(true);
      return;
    }
    const node = hitAt(toScene(v, p.x, p.y));
    if (node?.id !== hover?.id) setHover(node);
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    if (g) {
      if (g.kind === "pan" || touches.current.size < 2) {
        gesture.current = null;
        setPanning(false);
      }
      down.current = null;
      return;
    }
    const start = down.current;
    down.current = null;
    const p = local(e);
    if (e.button === 0 && start && distance(p, start) <= CLICK_SLOP_PX) click(p);
  };

  const onPointerCancel = () => {
    touches.current.clear();
    gesture.current = null;
    down.current = null;
    setPanning(false);
  };

  const dropCheck = (e: DragEvent<HTMLDivElement>) => {
    const p = local(e);
    const node = hitAt(toScene(v, p.x, p.y), false);
    const type = e.dataTransfer.files[0]?.type ?? e.dataTransfer.items[0]?.type ?? "";
    const reason = type && !DROPPABLE_TYPES.test(type) ? "Only PNG, JPEG or WebP images can be dropped onto a layer." : imageDrop!.rejectReason(node);
    return { node, reason };
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!imageDrop || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const next = dropCheck(e);
    if (next.node?.id !== drag?.node?.id || next.reason !== drag?.reason) setDrag(next);
    if (hover) setHover(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!imageDrop || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDrag(null);
    const file = e.dataTransfer.files[0];
    const { node, reason } = dropCheck(e);
    const accepted = !reason && node && file;
    setNotice(accepted ? null : (reason ?? "Drop an image file."));
    if (accepted) imageDrop.onDrop(node, file);
  };

  const dragMessage = drag ? (drag.reason ?? (drag.node ? `Drop to replace the image in “${drag.node.name}”` : null)) : null;

  return (
    <div
      ref={containerRef}
      className="scene-canvas"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(null);
      }}
      onDrop={onDrop}
    >
      <div className="scene-canvas-stage checkerboard" style={{ left: v.x, top: v.y, width: graph.width * v.zoom, height: graph.height * v.zoom }} />
      <canvas ref={canvasRef} className="scene-canvas-layer" width={pixelWidth} height={pixelHeight} role="img" aria-label="Template canvas" />
      <canvas
        ref={overlayRef}
        className="scene-canvas-layer scene-canvas-overlay"
        width={pixelWidth}
        height={pixelHeight}
        style={{ cursor: panning ? "grabbing" : spaceHeld ? "grab" : hover ? "pointer" : "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerEnter={() => (pointerInside.current = true)}
        onPointerLeave={() => {
          pointerInside.current = false;
          setHover(null);
        }}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onDoubleClick={(e) => focusText(local(e))}
      />
      {hover && !focused && !drag && <div className="scene-canvas-chip hover">{hover.name}</div>}
      {focused && (
        <div className="scene-canvas-chip focus" role="status" aria-label="Text layer focus">
          {focusLabel(focused, focus?.run ?? null)}
        </div>
      )}
      {(dragMessage ?? notice) && <div className={`scene-canvas-chip notice${drag && !drag.reason ? " ok" : ""}`}>{dragMessage ?? notice}</div>}
      {status && <div className="scene-canvas-chip status">{status}</div>}
      <div className="scene-canvas-toolbar" role="toolbar" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <output aria-label="Zoom level">{Math.round(v.zoom * 100)}%</output>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button type="button" title="Fit to screen (Ctrl/⌘+0)" onClick={() => setView(null)}>
          Fit
        </button>
        <button type="button" title="Actual pixels (Ctrl/⌘+1)" onClick={() => zoomBy(1 / v.zoom)}>
          100%
        </button>
      </div>
    </div>
  );
}

function focusLabel(node: TextLayerNode, run: number | null): string {
  const r = run === null ? undefined : node.runs[run];
  if (!r) return `${node.name}: ${node.runs.length} text run(s), click one to inspect it (Esc to exit)`;
  const tracking = r.tracking ? ` · tracking ${r.tracking}` : "";
  return `Run ${run! + 1} of ${node.runs.length}: “${r.text.trim()}” · ${r.fontName} ${r.fontSize}pt · ${rgbaToCss(r.color)}${tracking}`;
}

function runAt(boxes: readonly TextRunBox[], p: Point): number | null {
  let best: TextRunBox | null = null;
  let bestDist = Infinity;
  for (const b of boxes) {
    const dx = Math.max(b.rect.left - p.x, 0, p.x - b.rect.right);
    const dy = Math.max(b.rect.top - p.y, 0, p.y - b.rect.bottom);
    if (dx * dx + dy * dy < bestDist) {
      best = b;
      bestDist = dx * dx + dy * dy;
    }
  }
  return best?.run ?? null;
}

function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

const inflate = (r: Rect, d: number): Rect => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });
const contains = (r: Rect, p: Point) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function stroke(ctx: CanvasRenderingContext2D, r: Rect, lineWidth: number, color: string, dash: number[] = []): void {
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash.map((d) => d * lineWidth));
  ctx.strokeRect(Math.round(r.left) + 0.5, Math.round(r.top) + 0.5, Math.max(1, Math.round(r.right - r.left) - 1), Math.max(1, Math.round(r.bottom - r.top) - 1));
  ctx.restore();
}

function outline(ctx: CanvasRenderingContext2D, r: Rect, cssPx: number, selected: boolean): void {
  if (!selected) return stroke(ctx, r, cssPx, "rgba(79, 140, 255, 0.65)");
  stroke(ctx, r, cssPx * 1.5, "rgba(255, 255, 255, 0.9)");
  stroke(ctx, r, cssPx * 1.5, "#4f8cff", [5 / 1.5, 4 / 1.5]);
}
