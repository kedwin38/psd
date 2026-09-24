import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { Layer, Psd } from "ag-psd";
import { buildSceneGraph, type AssetSink } from "../src/ingest.js";
import { findNodeById, idFromPath, walkSceneGraph, type SceneNode } from "@psd-studio/scene-graph";

class RecordingSink implements AssetSink {
  puts: { hint: string; bytes: number; png: Buffer }[] = [];
  async putImage(png: Buffer, hint: string): Promise<string> {
    this.puts.push({ hint, bytes: png.length, png });
    return `asset_${this.puts.length}`;
  }
}

function fakeCanvas(width: number, height: number, css: string) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, width, height);
  return canvas as unknown as HTMLCanvasElement;
}

describe("buildSceneGraph", () => {
  it("converts a flat pixel layer", async () => {
    const psd: Psd = {
      width: 100,
      height: 80,
      children: [
        {
          name: "Background",
          left: 0,
          top: 0,
          right: 100,
          bottom: 80,
          opacity: 1,
          blendMode: "normal",
          canvas: fakeCanvas(100, 80, "#336699"),
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph, warnings } = await buildSceneGraph(psd, sink);

    expect(sceneGraph.width).toBe(100);
    expect(sceneGraph.height).toBe(80);
    expect(sceneGraph.root).toHaveLength(1);
    const node = sceneGraph.root[0]!;
    expect(node.type).toBe("pixel");
    expect(node.name).toBe("Background");
    expect(node.bounds).toEqual({ left: 0, top: 0, right: 100, bottom: 80 });
    expect(sink.puts).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("recurses into groups and builds a bounding box from children", async () => {
    const psd: Psd = {
      width: 200,
      height: 200,
      children: [
        {
          name: "Card",
          blendMode: "pass through",
          children: [
            {
              name: "Photo",
              left: 10,
              top: 10,
              right: 110,
              bottom: 110,
              opacity: 1,
              blendMode: "normal",
              canvas: fakeCanvas(100, 100, "#ff0000"),
            } as Layer,
          ],
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph } = await buildSceneGraph(psd, sink);

    const group = sceneGraph.root[0]!;
    expect(group.type).toBe("group");
    expect(group.path).toBe("Card");
    if (group.type === "group") {
      expect(group.isPassThrough).toBe(true);
      expect(group.children).toHaveLength(1);
      expect(group.bounds).toEqual({ left: 10, top: 10, right: 110, bottom: 110 });
      expect(group.children[0]!.path).toBe("Card/Photo");
      expect(group.children[0]!.id).toBe(idFromPath("Card/Photo"));
    }
  });

  it("converts a text layer with per-run styling", async () => {
    const psd: Psd = {
      width: 300,
      height: 100,
      children: [
        {
          name: "Full Name",
          left: 20,
          top: 20,
          right: 280,
          bottom: 60,
          opacity: 1,
          blendMode: "normal",
          text: {
            text: "Jane Doe",
            style: {
              font: { name: "Helvetica-Bold" },
              fontSize: 24,
              fillColor: { r: 10, g: 20, b: 30, a: 255 },
            },
            paragraphStyle: { justification: "center" },
          },
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph } = await buildSceneGraph(psd, sink);

    const node = sceneGraph.root[0]!;
    expect(node.type).toBe("text");
    if (node.type === "text") {
      expect(node.runs).toHaveLength(1);
      expect(node.runs[0]!.text).toBe("Jane Doe");
      expect(node.runs[0]!.fontName).toBe("Helvetica-Bold");
      expect(node.runs[0]!.fontSize).toBe(24);
      expect(node.runs[0]!.color).toEqual({ r: 10, g: 20, b: 30, a: 1 });
      expect(node.alignment).toBe("center");
    }
  });

  it("splits multi-run text using styleRuns lengths", async () => {
    const psd: Psd = {
      width: 300,
      height: 100,
      children: [
        {
          name: "Mixed",
          opacity: 1,
          blendMode: "normal",
          text: {
            text: "BoldPart normal",
            style: { font: { name: "Inter" }, fontSize: 16, fillColor: { r: 0, g: 0, b: 0, a: 255 } },
            styleRuns: [
              { length: 8, style: { fauxBold: true } },
              { length: 7, style: {} },
            ],
          },
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph } = await buildSceneGraph(psd, sink);
    const node = sceneGraph.root[0]!;
    if (node.type === "text") {
      expect(node.runs).toHaveLength(2);
      expect(node.runs[0]!.text).toBe("BoldPart");
      expect(node.runs[0]!.bold).toBe(true);
      expect(node.runs[1]!.text).toBe(" normal");
      expect(node.runs[1]!.bold).toBeUndefined();
    }
  });

  function textLayer(text: Layer["text"], extra: Partial<Layer> = {}): Psd {
    return { width: 600, height: 400, children: [{ name: "T", opacity: 1, blendMode: "normal", text, ...extra } as Layer] };
  }

  async function ingestText(psd: Psd) {
    const { sceneGraph, warnings } = await buildSceneGraph(psd, new RecordingSink());
    const node = sceneGraph.root[0]!;
    if (node.type !== "text") throw new Error("expected a text node");
    return { node, warnings: warnings.map((w) => w.message) };
  }

  it("places text by its type transform: point origin, paragraph box, local units", async () => {
    const style = { font: { name: "ArialMT" }, fontSize: 12 };
    const point = await ingestText(textLayer({ text: "Jane", transform: [4, 0, 0, 4, 100, 250], style }, { left: 102, top: 216, right: 240, bottom: 251 }));
    expect(point.node.frame).toEqual({ transform: { m00: 4, m01: 0, m10: 0, m11: 4, m02: 100, m12: 250 }, box: null });
    expect(point.node.bounds).toEqual({ left: 102, top: 216, right: 240, bottom: 251 });
    expect(point.node.runs[0]!.fontSize).toBe(12);
    expect(point.warnings).toEqual([]);

    const box = await ingestText(textLayer({ text: "Address line", transform: [1, 0, 0, 1, 40, 60], shapeType: "box", boxBounds: [0, 0, 200, 80], style }));
    expect(box.node.boxMode).toBe("paragraph");
    expect(box.node.frame).toEqual({ transform: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 40, m12: 60 }, box: { left: 0, top: 0, right: 200, bottom: 80 } });
  });

  it("derives bounds from the type frame when the layer has no rendered pixels", async () => {
    const units = (value: number) => ({ units: "Points" as const, value });
    const boundingBox = { left: units(1), top: units(-9), right: units(49), bottom: units(0) };
    const glyphs = await ingestText(textLayer({ text: "Hi", transform: [2, 0, 0, 2, 100, 50], boundingBox, style: { fontSize: 12 } }, { left: 100, top: 50, right: 100, bottom: 50 }));
    expect(glyphs.node.bounds).toEqual({ left: 102, top: 32, right: 198, bottom: 50 });

    const box = await ingestText(textLayer({ text: "Hi", transform: [1, 0, 0, 1, 10, 20], shapeType: "box", boxBounds: [0, 0, 150, 40], style: { fontSize: 12 } }));
    expect(box.node.bounds).toEqual({ left: 10, top: 20, right: 160, bottom: 60 });

    const bare = await ingestText(textLayer({ text: "Hi", transform: [1, 0, 0, 1, 40, 288], style: { fontSize: 28 } }, { left: 40, top: 260, right: 40, bottom: 260 }));
    expect(bare.node.bounds).toEqual({ left: 40, top: 260, right: 40, bottom: 288 });
  });

  it("falls back to layer bounds, with a warning, when a generator left the type transform unset", async () => {
    const { node, warnings } = await ingestText(textLayer({ text: "Jane", transform: [1, 0, 0, 1, 0, 0], style: { fontSize: 28 } }, { left: 40, top: 260, right: 40, bottom: 260 }));
    expect(node.frame).toBeUndefined();
    expect(node.bounds).toEqual({ left: 40, top: 260, right: 40, bottom: 260 });
    expect(warnings.some((m) => m.includes("type transform is unset"))).toBe(true);
  });

  it("uses auto leading instead of a stale stored leading", async () => {
    const leadingOf = async (style: NonNullable<Layer["text"]>["style"], paragraphStyle?: NonNullable<Layer["text"]>["paragraphStyle"]) =>
      (await ingestText(textLayer({ text: "a\nb", transform: [1, 0, 0, 1, 10, 50], style, paragraphStyle }))).node.runs[0]!.leadingPt;
    expect(await leadingOf({ fontSize: 48, leading: 6, autoLeading: true })).toBeCloseTo(57.6);
    expect(await leadingOf({ fontSize: 20, leading: 6, autoLeading: true }, { autoLeading: 1.75 })).toBeCloseTo(35);
    expect(await leadingOf({ fontSize: 48 })).toBeCloseTo(57.6);
    expect(await leadingOf({ fontSize: 14, leading: 14, autoLeading: false })).toBe(14);
  });

  it("reads paragraph settings from the first paragraph and character scaling, shift and caps from each run", async () => {
    const { node, warnings } = await ingestText(
      textLayer({
        text: "Hello\nWorld",
        transform: [1, 0, 0, 1, 43, 81.5],
        style: { fontSize: 60, horizontalScale: 1.2, baselineShift: -4, fontCaps: 2 },
        paragraphStyle: { spaceAfter: 10 },
        paragraphStyleRuns: [
          { length: 6, style: { justification: "center" } },
          { length: 5, style: { justification: "left" } },
        ],
      }),
    );
    expect(node.alignment).toBe("center");
    expect(node.paragraphSpacing).toEqual({ before: 0, after: 10 });
    expect(node.runs[0]).toMatchObject({ horizontalScale: 1.2, baselineShift: -4, allCaps: true });
    expect(warnings).toEqual(["Paragraphs differ in alignment or spacing; all of them lay out like the first."]);
  });

  it("warns about type features the renderers don't reproduce", async () => {
    const { warnings } = await ingestText(
      textLayer({
        text: "Arc",
        transform: [0.866, 0.5, -0.5, 0.866, 100, 100],
        warp: { style: "arc", value: 50 },
        orientation: "vertical",
        style: { fontSize: 20, fontCaps: 1 },
        paragraphStyle: { firstLineIndent: 12 },
        textPath: { data: { type: 2, frameMatrix: [], textRange: [], pathData: {} } },
      }),
    );
    expect(warnings).toEqual([
      expect.stringContaining("rotated or skewed"),
      'Warped text ("arc") renders unwarped.',
      "Type on a path renders on a straight baseline, not along the path.",
      "Vertical text renders horizontally.",
      "Paragraph indents are not applied.",
      "Small caps, superscript and subscript render as regular text.",
    ]);
  });

  it("marks a placed layer as a smart object and warns about baked content", async () => {
    const psd: Psd = {
      width: 100,
      height: 100,
      children: [
        {
          name: "Portrait",
          left: 0,
          top: 0,
          right: 100,
          bottom: 100,
          opacity: 1,
          blendMode: "normal",
          canvas: fakeCanvas(100, 100, "#888888"),
          placedLayer: { id: "1", type: "raster", transform: [0, 0, 100, 0, 100, 100, 0, 100] },
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph, warnings } = await buildSceneGraph(psd, sink);
    const node = sceneGraph.root[0]!;
    expect(node.type).toBe("smartObject");
    expect(warnings.some((w) => w.message.includes("baked at authoring time"))).toBe(true);
  });

  it("maps adjustment layers to structural nodes with a warning", async () => {
    const psd: Psd = {
      width: 50,
      height: 50,
      children: [
        {
          name: "Brightness",
          opacity: 1,
          blendMode: "normal",
          adjustment: { type: "brightness/contrast", brightness: 10 },
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph, warnings } = await buildSceneGraph(psd, sink);
    const node = sceneGraph.root[0]!;
    expect(node.type).toBe("adjustment");
    if (node.type === "adjustment") {
      expect(node.adjustmentKind).toBe("brightness/contrast");
    }
    expect(warnings.some((w) => w.message.includes("visibility-togglable"))).toBe(true);
  });

  it("warns and approximates an unsupported blend mode", async () => {
    const psd: Psd = {
      width: 10,
      height: 10,
      children: [
        {
          name: "Vivid",
          opacity: 1,
          blendMode: "vivid light",
          canvas: fakeCanvas(10, 10, "#123456"),
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph, warnings } = await buildSceneGraph(psd, sink);
    expect(sceneGraph.root[0]!.blendMode).toBe("hard-light");
    expect(warnings.some((w) => w.message.includes('approximated as "hard-light"'))).toBe(true);
  });

  it("marks hidden layers as not visible", async () => {
    const psd: Psd = {
      width: 10,
      height: 10,
      children: [
        {
          name: "Hidden",
          hidden: true,
          opacity: 1,
          blendMode: "normal",
          canvas: fakeCanvas(10, 10, "#123456"),
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph } = await buildSceneGraph(psd, sink);
    expect(sceneGraph.root[0]!.visible).toBe(false);
  });

  it("maps any Photoshop lock toggle to locked", async () => {
    const psd: Psd = {
      width: 20,
      height: 20,
      children: [
        { name: "Background", opacity: 1, blendMode: "normal", protected: { transparency: true }, canvas: fakeCanvas(20, 20, "#fff") } as Layer,
        { name: "Free", opacity: 1, blendMode: "normal", canvas: fakeCanvas(10, 10, "#000") } as Layer,
      ],
    };
    const { sceneGraph } = await buildSceneGraph(psd, new RecordingSink());
    expect(sceneGraph.root.map((n) => n.locked)).toEqual([true, false]);
  });

  it("finds nested nodes via findNodeById after ingestion", async () => {
    const psd: Psd = {
      width: 50,
      height: 50,
      children: [
        {
          name: "Group",
          children: [{ name: "Leaf", opacity: 1, blendMode: "normal", canvas: fakeCanvas(10, 10, "#000") } as Layer],
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph } = await buildSceneGraph(psd, sink);
    const leaf = findNodeById(sceneGraph, idFromPath("Group/Leaf"));
    expect(leaf).toBeDefined();
    expect(leaf!.name).toBe("Leaf");
  });

  it("keeps an empty layer in the tree, with a transparent raster instead of dropping it", async () => {
    const psd: Psd = {
      width: 50,
      height: 50,
      children: [{ name: "Base", left: 0, top: 0, right: 50, bottom: 50, canvas: fakeCanvas(50, 50, "#000") } as Layer, { name: "Empty", left: 0, top: 0, right: 0, bottom: 0 } as Layer],
    };
    const sink = new RecordingSink();
    const { sceneGraph, warnings } = await buildSceneGraph(psd, sink);
    expect(sceneGraph.root.map((n) => [n.name, n.type])).toEqual([
      ["Base", "pixel"],
      ["Empty", "pixel"],
    ]);
    expect(sceneGraph.root[1]!.bounds).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    const image = await loadImage(sink.puts[1]!.png);
    expect([image.width, image.height]).toEqual([1, 1]);
    expect(warnings).toHaveLength(0);
  });

  it("gives an empty smart object its placed frame and a raster browsers can decode", async () => {
    const psd: Psd = {
      width: 400,
      height: 300,
      children: [
        {
          name: "Logo Slot",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          placedLayer: { id: "1", type: "raster", transform: [300, 200, 380, 200, 380, 280, 300, 280], width: 80, height: 80 },
        } as Layer,
      ],
    };
    const sink = new RecordingSink();
    const { sceneGraph } = await buildSceneGraph(psd, sink);
    const node = sceneGraph.root[0]!;
    expect(node.type).toBe("smartObject");
    expect(node.bounds).toEqual({ left: 300, top: 200, right: 380, bottom: 280 });
    expect(sink.puts[0]!.bytes).toBeGreaterThan(0);
    await expect(loadImage(sink.puts[0]!.png)).resolves.toBeDefined();
  });

  it("gives sibling layers that share a name, and their contents, distinct ids", async () => {
    const leaf = (name: string) => ({ name, left: 0, top: 0, right: 10, bottom: 10, canvas: fakeCanvas(10, 10, "#000") }) as Layer;
    const psd: Psd = {
      width: 50,
      height: 50,
      children: [{ name: "Tile", children: [leaf("Photo")] } as Layer, { name: "Tile", children: [leaf("Photo")] } as Layer, leaf("Tile")],
    };
    const { sceneGraph } = await buildSceneGraph(psd, new RecordingSink());
    const ids = [...walkSceneGraph(sceneGraph)].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sceneGraph.root.map((n) => n.path)).toEqual(["Tile", "Tile", "Tile"]);
    // A layer's first occurrence keeps its plain path's id, as templates ingested before have it.
    expect(sceneGraph.root[0]!.id).toBe(idFromPath("Tile"));
    expect(findNodeById(sceneGraph, idFromPath("Tile/Photo"))).toBe((sceneGraph.root[0] as Extract<SceneNode, { type: "group" }>).children[0]);
  });
});
