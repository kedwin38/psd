import { describe, expect, it } from "vitest";
import { CropRectSchema, type Rect } from "@psd-studio/scene-graph";
import { MAX_CROP_ZOOM, constrainPlacement, coverCrop, cropOf, movePlacement, placementOf, scalePlacement } from "../src/index.js";

const frame: Rect = { left: 40, top: 40, right: 200, bottom: 200 };
const w = (r: Rect) => r.right - r.left;
const h = (r: Rect) => r.bottom - r.top;

describe("crop geometry", () => {
  it("cover-crops a wide image to the frame's aspect, centered", () => {
    expect(coverCrop(frame, 2)).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(coverCrop(frame, 0.5)).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 });
  });

  it("round-trips a crop through its placement", () => {
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 };
    const back = cropOf(frame, placementOf(frame, crop));
    for (const k of ["x", "y", "width", "height"] as const) expect(back[k]).toBeCloseTo(crop[k], 12);
  });

  it("slides the image but never uncovers the frame", () => {
    const start = placementOf(frame, coverCrop(frame, 2));
    const moved = movePlacement(frame, start, 1000, -1000, 2);
    expect(moved.left).toBeCloseTo(frame.left, 9);
    expect(moved.top).toBeCloseTo(frame.top, 9);
    expect(cropOf(frame, moved).x).toBeCloseTo(0, 9);
    const other = movePlacement(frame, start, -1000, 0, 2);
    expect(other.right).toBeCloseTo(frame.right, 9);
    expect(CropRectSchema.safeParse(cropOf(frame, other)).success).toBe(true);
  });

  it("scales about an anchor, clamped between covering the frame and the max zoom", () => {
    const start = placementOf(frame, coverCrop(frame, 2));
    const zoomed = scalePlacement(frame, start, 2, 120, 120, 2);
    expect(w(zoomed)).toBeCloseTo(w(start) * 2, 9);
    expect((120 - zoomed.left) / w(zoomed)).toBeCloseTo((120 - start.left) / w(start), 9);
    expect(w(scalePlacement(frame, start, 0.1, 120, 120, 2))).toBeCloseTo(w(start), 9);
    expect(w(scalePlacement(frame, start, 1000, 120, 120, 2))).toBeCloseTo(w(start) * MAX_CROP_ZOOM, 9);
  });

  it("restores the image's own aspect ratio for a stretched legacy crop", () => {
    const stretched = placementOf(frame, { x: 0, y: 0, width: 1, height: 1 });
    const fixed = constrainPlacement(frame, stretched, 2);
    expect(w(fixed) / h(fixed)).toBeCloseTo(2, 9);
    expect(fixed.top).toBeCloseTo(frame.top, 9);
    expect(fixed.bottom).toBeCloseTo(frame.bottom, 9);
  });
});
