import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { Layer, Psd } from "ag-psd";
import { buildSceneGraph, type AssetSink } from "../src/ingest.js";
import { findNodeById, idFromPath } from "@psd-studio/scene-graph";

class RecordingSink implements AssetSink {
  puts: { hint: string; bytes: number }[] = [];
  async putImage(png: Buffer, hint: string): Promise<string> {
    this.puts.push({ hint, bytes: png.length });
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
});
