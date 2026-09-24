import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { coverCrop, cropOf, movePlacement, placementOf, scalePlacement } from "@psd-studio/canvas-renderer";
import type { CropRect, Rect } from "@psd-studio/scene-graph";
import type { View } from "../canvas/viewport";

type Corner = "nw" | "ne" | "sw" | "se";
type Gesture =
  | { kind: "move"; pointer: { x: number; y: number }; start: Rect }
  | { kind: "scale"; anchor: { x: number; y: number }; start: Rect }
  | { kind: "pinch"; dist: number; start: Rect };

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const WHEEL_COMMIT_MS = 300;

/**
 * Reposition/zoom tool for an uploaded photo inside its layer's frame: drag to move, drag a corner,
 * scroll or pinch to scale. The photo always covers the frame without distortion; the part outside
 * the frame shows faintly so you can see what's cropped away. Saves the crop window on release.
 */
export function CropOverlay({
  frame,
  crop,
  aspect,
  image,
  view,
  label,
  onChange,
  onClose,
}: {
  frame: Rect;
  crop: CropRect;
  /** Width/height of the uploaded photo. */
  aspect: number;
  image: ImageBitmap | undefined;
  view: View;
  label: string;
  /** final: the gesture ended, so the crop should be saved. */
  onChange: (crop: CropRect, final: boolean) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const placement = placementOf(frame, crop);
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const z = view.zoom;
  const box = { left: placement.left * z + view.x, top: placement.top * z + view.y, width: (placement.right - placement.left) * z, height: (placement.bottom - placement.top) * z };
  const toScene = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current!.parentElement!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / z, y: (e.clientY - r.top - view.y) / z };
  };
  const toSceneRef = useRef(toScene);
  toSceneRef.current = toScene;
  const emit = (next: Rect, final: boolean) => onChangeRef.current(cropOf(frame, next), final);

  useLayoutEffect(() => rootRef.current?.focus({ preventScroll: true }), []);

  useEffect(() => {
    const canvas = ghostRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!image) return;
    const k = canvas.width / (placement.right - placement.left);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect((frame.left - placement.left) * k, (frame.top - placement.top) * k, (frame.right - frame.left) * k, (frame.bottom - frame.top) * k);
    ctx.clip("evenodd");
    ctx.globalAlpha = 0.4;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  });

  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const s = toSceneRef.current(e);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      emit(scalePlacement(frame, placementRef.current, factor, s.x, s.y, aspect), false);
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        wheelTimer.current = undefined;
        emit(placementRef.current, true);
      }, WHEEL_COMMIT_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      // Closing right after scrolling must still save the zoom it produced.
      if (wheelTimer.current === undefined) return;
      clearTimeout(wheelTimer.current);
      wheelTimer.current = undefined;
      emit(placementRef.current, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, aspect]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, corner?: Corner) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const start = placementRef.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), start };
    } else if (corner) {
      gesture.current = { kind: "scale", anchor: { x: corner.endsWith("w") ? start.right : start.left, y: corner.startsWith("n") ? start.bottom : start.top }, start };
    } else {
      gesture.current = { kind: "move", pointer: toScene(e), start };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = toScene(e);
    if (g.kind === "move") emit(movePlacement(frame, g.start, s.x - g.pointer.x, s.y - g.pointer.y, aspect), false);
    else if (g.kind === "scale") {
      const factor = Math.max(Math.abs(s.x - g.anchor.x) / (g.start.right - g.start.left), Math.abs(s.y - g.anchor.y) / (g.start.bottom - g.start.top));
      emit(scalePlacement(frame, g.start, factor, g.anchor.x, g.anchor.y, aspect), false);
    } else {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const mid = toScene({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      emit(scalePlacement(frame, g.start, Math.hypot(a.x - b.x, a.y - b.y) / g.dist, mid.x, mid.y, aspect), false);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    if (!gesture.current) return;
    gesture.current = null;
    pointers.current.clear();
    emit(placementRef.current, true);
  };

  const nudge = (dx: number, dy: number) => emit(movePlacement(frame, placementRef.current, dx, dy, aspect), true);

  return (
    <div
      ref={rootRef}
      className="crop-overlay"
      style={box}
      tabIndex={0}
      role="application"
      aria-label={`Reposition ${label}: drag to move, drag a corner or scroll to zoom, arrow keys to nudge, Enter when done`}
      onPointerDown={(e) => onPointerDown(e)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "Escape" || e.key === "Enter") onClose();
        else if (e.key === "ArrowLeft") nudge(-step, 0);
        else if (e.key === "ArrowRight") nudge(step, 0);
        else if (e.key === "ArrowUp") nudge(0, -step);
        else if (e.key === "ArrowDown") nudge(0, step);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <canvas ref={ghostRef} className="crop-ghost" />
      <div
        className="crop-frame"
        style={{ left: (frame.left - placement.left) * z, top: (frame.top - placement.top) * z, width: (frame.right - frame.left) * z, height: (frame.bottom - frame.top) * z }}
      />
      {CORNERS.map((c) => (
        <div key={c} className={`crop-handle ${c}`} onPointerDown={(e) => onPointerDown(e, c)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      ))}
      <div className="crop-toolbar" style={{ top: (frame.bottom - placement.top) * z + 8, left: (frame.left - placement.left) * z }}>
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onChange(coverCrop(frame, aspect), true)}>
          Fit
        </button>
        <button type="button" className="primary" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
