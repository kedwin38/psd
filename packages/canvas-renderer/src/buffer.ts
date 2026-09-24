import type { SceneNode } from "@psd-studio/scene-graph";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Creates a transparent offscreen drawing surface; injectable so the renderer also runs outside a browser. */
export type BufferFactory = (width: number, height: number) => Ctx2D;

export const createDomBuffer: BufferFactory = (width, height) => {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("2D canvas context unavailable.");
  return ctx;
};

export interface ClipUnit {
  base: SceneNode;
  clipped: SceneNode[];
}

/** Groups each clipping base with the consecutive "clip to layer below" siblings painted above it. */
export function clipUnits(children: readonly SceneNode[]): ClipUnit[] {
  const units: ClipUnit[] = [];
  for (const child of children) {
    const last = units[units.length - 1];
    if (child.clipping && last) last.clipped.push(child);
    else units.push({ base: child, clipped: [] });
  }
  return units;
}
