import type { Rect } from "@psd-studio/scene-graph";

/** zoom: CSS px per scene (PSD) px; x/y: CSS-px position of the scene origin inside the viewport. */
export interface View {
  zoom: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Centers rect in a viewport of the given size, as large as fits inside padding (never above maxZoom). */
export function fitRect(box: { width: number; height: number }, rect: Rect, padding: number, maxZoom = MAX_ZOOM): View {
  const w = Math.max(1, rect.right - rect.left);
  const h = Math.max(1, rect.bottom - rect.top);
  const zoom = clampZoom(Math.min((box.width - padding * 2) / w, (box.height - padding * 2) / h, maxZoom));
  return { zoom, x: box.width / 2 - (rect.left + w / 2) * zoom, y: box.height / 2 - (rect.top + h / 2) * zoom };
}

/** Zooms by factor while keeping the scene point under viewport point (px, py) fixed. */
export function zoomAround(view: View, px: number, py: number, factor: number): View {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

export function toScene(view: View, px: number, py: number): { x: number; y: number } {
  return { x: (px - view.x) / view.zoom, y: (py - view.y) / view.zoom };
}
