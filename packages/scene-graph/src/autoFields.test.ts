import { describe, expect, it } from "vitest";
import { autoFields, lockingNode } from "./autoFields.js";
import { FieldConstraintsSchema } from "./fields.js";
import { idFromPath, type SceneGraph, type SceneNode } from "./nodes.js";

const base = (path: string, extra: Partial<SceneNode> = {}) => ({
  id: idFromPath(path),
  path,
  name: path.split("/").pop()!,
  visible: true,
  opacity: 1,
  blendMode: "normal" as const,
  clipping: false,
  bounds: { left: 10, top: 20, right: 311, bottom: 220 },
  ...extra,
});

const run = (text: string, fontName = "ArialMT", fontSize = 28) => ({ text, fontName, fontSize, color: { r: 0, g: 0, b: 0, a: 1 } });

function graph(): SceneGraph {
  return {
    formatVersion: 1,
    width: 600,
    height: 400,
    dpi: 300,
    colorMode: "rgb",
    root: [
      { ...base("Background", { locked: true }), type: "pixel", imageAssetId: "a_bg" },
      {
        ...base("Card"),
        type: "group",
        isPassThrough: true,
        children: [
          { ...base("Card/Name"), type: "text", runs: [run("Jane "), run("Doe", "Arial-BoldMT", 96)], alignment: "center", boxMode: "point" },
          { ...base("Card/Photo"), type: "smartObject", imageAssetId: "a_photo", placement: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 0, m12: 0 }, intrinsicWidth: 301, intrinsicHeight: 200, replaceable: false },
          { ...base("Card/Logo"), type: "shape", imageAssetId: "a_logo" },
        ],
      },
      {
        ...base("Frame", { locked: true }),
        type: "group",
        isPassThrough: true,
        children: [{ ...base("Frame/Border"), type: "pixel", imageAssetId: "a_border" }],
      },
      { ...base("Tint", { visible: false }), type: "adjustment", adjustmentKind: "hue/saturation" },
    ],
  };
}

describe("autoFields", () => {
  it("makes every unlocked layer a field in Layers-panel order, skipping locked layers and everything inside locked groups", () => {
    expect(autoFields(graph()).map((f) => [f.layerPath, f.fieldType, f.label, f.order])).toEqual([
      ["Tint", "VISIBILITY", "Tint", 0],
      ["Card", "VISIBILITY", "Card", 3],
      ["Card/Logo", "IMAGE", "Logo", 4],
      ["Card/Photo", "IMAGE", "Photo", 5],
      ["Card/Name", "TEXT", "Name", 6],
    ]);
  });

  it("keeps each field's order when other layers lock or unlock", () => {
    const g = graph();
    const card = g.root[1]! as Extract<SceneNode, { type: "group" }>;
    card.children[2] = { ...card.children[2]!, locked: true };
    g.root[0] = { ...g.root[0]!, locked: false };
    expect(autoFields(g).map((f) => [f.label, f.order])).toEqual([
      ["Tint", 0],
      ["Card", 3],
      ["Photo", 5],
      ["Name", 6],
      ["Background", 7],
    ]);
  });

  it("produces constraints the manual field path accepts", () => {
    for (const field of autoFields(graph())) {
      expect(FieldConstraintsSchema.parse(field.constraints)).toEqual(field.constraints);
      expect(field.nodeId).toBe(idFromPath(field.layerPath));
    }
  });

  it("gives text a generous limit that always fits the authored copy, plus its own fonts, sizes and alignment", () => {
    const name = autoFields(graph()).find((f) => f.label === "Name")!;
    expect(name.constraints).toEqual({
      kind: "text",
      maxLength: 200,
      allowedFonts: ["ArialMT", "Arial-BoldMT"],
      minFontSizePt: 8,
      maxFontSizePt: 96,
      colorLocked: true,
      allowedAlignments: ["center"],
      required: false,
    });

    const long = graph();
    const card = long.root[1]! as Extract<SceneNode, { type: "group" }>;
    card.children[0] = { ...card.children[0]!, runs: [run("x".repeat(150) + "\r\n" + "y".repeat(149))] } as SceneNode;
    expect(autoFields(long).find((f) => f.label === "Name")!.constraints).toMatchObject({ maxLength: 600 });
  });

  it("sizes image minimums from the layer's own bounds, allowing up to a 2x upscale", () => {
    expect(autoFields(graph()).find((f) => f.label === "Photo")!.constraints).toEqual({
      kind: "image",
      aspectRatioW: 301,
      aspectRatioH: 200,
      aspectTolerancePct: 100,
      minWidthPx: 151,
      minHeightPx: 100,
      maxUploadBytes: 25 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      required: false,
    });
  });

  it("defaults show/hide toggles to the layer's authored visibility", () => {
    expect(autoFields(graph()).find((f) => f.label === "Tint")!.constraints).toEqual({ kind: "visibility", defaultVisible: false });
  });
});

describe("lockingNode", () => {
  it("finds a layer's own lock or its group's", () => {
    const g = graph();
    expect(lockingNode(g, idFromPath("Background"))?.path).toBe("Background");
    expect(lockingNode(g, idFromPath("Frame/Border"))?.path).toBe("Frame");
    expect(lockingNode(g, idFromPath("Card/Photo"))).toBeUndefined();
    expect(lockingNode(g, "n_missing")).toBeUndefined();
  });
});
