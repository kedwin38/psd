import { describe, expect, it } from "vitest";
import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { cssFont, hitTest } from "../src/index.js";

function node(id: string, bounds: [number, number, number, number], extra: Record<string, unknown> = {}): SceneNode {
  const [left, top, right, bottom] = bounds;
  return {
    type: "pixel",
    id,
    path: id,
    name: id,
    visible: true,
    opacity: 1,
    blendMode: "normal",
    clipping: false,
    bounds: { left, top, right, bottom },
    imageAssetId: id,
    ...extra,
  } as SceneNode;
}

function group(id: string, children: SceneNode[], extra: Record<string, unknown> = {}): SceneNode {
  return { ...node(id, [0, 0, 100, 100]), type: "group", isPassThrough: true, children, ...extra } as SceneNode;
}

const graphOf = (root: SceneNode[]): SceneGraph => ({ formatVersion: 1, width: 100, height: 100, dpi: 72, colorMode: "rgb", root });
const visible = (n: SceneNode) => n.visible;
const pick = (graph: SceneGraph, x: number, y: number, extra: Partial<Parameters<typeof hitTest>[3]> = {}) =>
  hitTest(graph, x, y, { isVisible: visible, isPickable: (n) => !n.locked, ...extra })?.id ?? null;

describe("hitTest", () => {
  const graph = graphOf([node("bg", [0, 0, 100, 100], { locked: true }), group("card", [node("photo", [10, 10, 60, 60]), node("badge", [40, 40, 80, 80])])]);

  it("returns the topmost leaf under the point, descending into groups", () => {
    expect(pick(graph, 50, 50)).toBe("badge");
    expect(pick(graph, 20, 20)).toBe("photo");
  });

  it("passes clicks through locked layers and hidden layers", () => {
    expect(pick(graph, 95, 95)).toBeNull();
    const hiddenBadge = graphOf([node("photo", [10, 10, 60, 60]), node("badge", [40, 40, 80, 80], { visible: false })]);
    expect(pick(hiddenBadge, 50, 50)).toBe("photo");
  });

  it("skips a locked group's whole subtree", () => {
    const locked = graphOf([node("under", [0, 0, 100, 100]), group("card", [node("photo", [10, 10, 60, 60])], { locked: true })]);
    expect(pick(locked, 20, 20)).toBe("under");
  });

  it("falls through transparent pixels of a raster layer", () => {
    const alphaAt = (n: SceneNode) => (n.id === "badge" ? 0 : 255);
    expect(pick(graph, 50, 50, { alphaAt })).toBe("photo");
  });

  it("only hits a clipped layer where its clipping base has pixels", () => {
    const clipped = graphOf([node("under", [0, 0, 100, 100]), node("shape", [0, 0, 50, 50]), node("fill", [0, 0, 100, 100], { clipping: true })]);
    expect(pick(clipped, 25, 25)).toBe("fill");
    expect(pick(clipped, 75, 75)).toBe("under");
  });

  it("ignores full-canvas adjustment layers", () => {
    const adj = graphOf([node("photo", [0, 0, 100, 100]), { ...node("curves", [0, 0, 100, 100]), type: "adjustment", adjustmentKind: "curves" } as SceneNode]);
    expect(pick(adj, 50, 50)).toBe("photo");
  });
});

describe("cssFont", () => {
  it("derives a family and weight from a PostScript name, keeping the exact name first", () => {
    expect(cssFont({ fontName: "OpenSans-SemiBoldItalic" }, 24)).toBe('italic 600 24px "OpenSans-SemiBoldItalic", "Open Sans", sans-serif');
    expect(cssFont({ fontName: "Montserrat-ExtraBold" }, 12)).toBe('800 12px "Montserrat-ExtraBold", "Montserrat", sans-serif');
    expect(cssFont({ fontName: "Arial", bold: true }, 10)).toBe('700 10px "Arial", sans-serif');
  });
});
