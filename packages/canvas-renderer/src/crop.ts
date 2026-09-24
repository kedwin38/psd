import type { CropRect, Rect } from "@psd-studio/scene-graph";

/** How far past "just covers the frame" the user may zoom into an uploaded image. */
export const MAX_CROP_ZOOM = 20;

const width = (r: Rect) => r.right - r.left;
const height = (r: Rect) => r.bottom - r.top;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Largest centered window of an image (width/height = aspect) with the frame's aspect ratio, so the
 * image fills the frame without distortion — what a fresh upload starts at.
 */
export function coverCrop(frame: Rect, aspect: number): CropRect {
  const frameAspect = Math.max(1e-9, width(frame)) / Math.max(1e-9, height(frame));
  if (aspect > frameAspect) {
    const w = frameAspect / aspect;
    return { x: (1 - w) / 2, y: 0, width: w, height: 1 };
  }
  const h = aspect / frameAspect;
  return { x: 0, y: (1 - h) / 2, width: 1, height: h };
}

/** Scene-space rect the whole image occupies when its crop window is stretched over the frame, as the compositors paint it. */
export function placementOf(frame: Rect, crop: CropRect): Rect {
  const w = width(frame) / crop.width;
  const h = height(frame) / crop.height;
  const left = frame.left - crop.x * w;
  const top = frame.top - crop.y * h;
  return { left, top, right: left + w, bottom: top + h };
}

/** Inverse of placementOf, clamped so the window stays inside the image despite floating-point drift. */
export function cropOf(frame: Rect, placement: Rect): CropRect {
  const x = clamp((frame.left - placement.left) / width(placement), 0, 1);
  const y = clamp((frame.top - placement.top) / height(placement), 0, 1);
  return {
    x,
    y,
    width: clamp(width(frame) / width(placement), Number.EPSILON, 1 - x),
    height: clamp(height(frame) / height(placement), Number.EPSILON, 1 - y),
  };
}

/**
 * Normalizes a placement to the image's aspect ratio (keeping its center), then scales it into
 * [cover, MAX_CROP_ZOOM × cover] and slides it so the frame never shows a gap.
 */
export function constrainPlacement(frame: Rect, placement: Rect, aspect: number): Rect {
  const coverW = Math.max(width(frame), height(frame) * aspect);
  const w = clamp(width(placement), coverW, coverW * MAX_CROP_ZOOM);
  const h = w / aspect;
  const cx = (placement.left + placement.right) / 2;
  const cy = (placement.top + placement.bottom) / 2;
  const left = clamp(cx - w / 2, frame.right - w, frame.left);
  const top = clamp(cy - h / 2, frame.bottom - h, frame.top);
  return { left, top, right: left + w, bottom: top + h };
}

export function movePlacement(frame: Rect, placement: Rect, dx: number, dy: number, aspect: number): Rect {
  return constrainPlacement(frame, { left: placement.left + dx, top: placement.top + dy, right: placement.right + dx, bottom: placement.bottom + dy }, aspect);
}

/** Scales about a scene point (the cursor, or the corner opposite a dragged handle). */
export function scalePlacement(frame: Rect, placement: Rect, factor: number, ax: number, ay: number, aspect: number): Rect {
  const s = (v: number, a: number) => a + (v - a) * factor;
  return constrainPlacement(frame, { left: s(placement.left, ax), top: s(placement.top, ay), right: s(placement.right, ax), bottom: s(placement.bottom, ay) }, aspect);
}
