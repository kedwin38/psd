import { describe, expect, it } from "vitest";
import { idFromPath, type SceneGraph } from "@psd-studio/scene-graph";
import { SceneCompositor, type AssetSource } from "../src/compositor.js";
import { solidPng } from "./fixtures/solidPng.js";
import { readPixel } from "./pngPixels.js";

class FakeAssets implements AssetSource {
  constructor(private readonly images: Map<string, Buffer>) {}
  async getImage(assetId: string): Promise<Buffer> {
    const buf = this.images.get(assetId);
    if (!buf) throw new Error(`no fixture asset for ${assetId}`);
    return buf;
  }
}

describe("SceneCompositor", () => {
  it("renders a flat pixel layer at full opacity", async () => {
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 100,
      height: 100,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "pixel",
          id: "bg",
          path: "Background",
          name: "Background",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          imageAssetId: "red",
        },
      ],
    };
    const assets = new FakeAssets(new Map([["red", solidPng(100, 100, "#ff0000")]]));
    const result = await new SceneCompositor(assets).render(graph);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    const px = readPixel(result.png, 50, 50);
    expect(px).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("respects layer opacity when compositing over a background", async () => {
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 10,
      height: 10,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "pixel",
          id: "bg",
          path: "Background",
          name: "Background",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "white",
        },
        {
          type: "pixel",
          id: "fg",
          path: "Foreground",
          name: "Foreground",
          visible: true,
          opacity: 0.5,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "black",
        },
      ],
    };
    const assets = new FakeAssets(
      new Map([
        ["white", solidPng(10, 10, "#ffffff")],
        ["black", solidPng(10, 10, "#000000")],
      ]),
    );
    const result = await new SceneCompositor(assets).render(graph);
    const px = readPixel(result.png, 5, 5);
    // 50% black over white ≈ mid gray
    expect(px.r).toBeGreaterThan(110);
    expect(px.r).toBeLessThan(145);
  });

  it("applies multiply blend mode", async () => {
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 10,
      height: 10,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "pixel",
          id: "bg",
          path: "Background",
          name: "Background",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "yellow",
        },
        {
          type: "pixel",
          id: "fg",
          path: "Tint",
          name: "Tint",
          visible: true,
          opacity: 1,
          blendMode: "multiply",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "cyan",
        },
      ],
    };
    // yellow (255,255,0) multiply cyan (0,255,255) => (0,255,0)
    const assets = new FakeAssets(
      new Map([
        ["yellow", solidPng(10, 10, "#ffff00")],
        ["cyan", solidPng(10, 10, "#00ffff")],
      ]),
    );
    const result = await new SceneCompositor(assets).render(graph);
    const px = readPixel(result.png, 5, 5);
    expect(px.r).toBeLessThan(20);
    expect(px.g).toBeGreaterThan(235);
    expect(px.b).toBeLessThan(20);
  });

  it("hides a layer when a visibility field override turns it off", async () => {
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 10,
      height: 10,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "pixel",
          id: "bg",
          path: "Background",
          name: "Background",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "white",
        },
        {
          type: "pixel",
          id: "watermark",
          path: "Watermark",
          name: "Watermark",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "red",
        },
      ],
    };
    const assets = new FakeAssets(
      new Map([
        ["white", solidPng(10, 10, "#ffffff")],
        ["red", solidPng(10, 10, "#ff0000")],
      ]),
    );
    const withWatermark = await new SceneCompositor(assets).render(graph);
    expect(readPixel(withWatermark.png, 5, 5)).toEqual({ r: 255, g: 0, b: 0, a: 255 });

    const withoutWatermark = await new SceneCompositor(assets).render(graph, {
      overrides: [{ type: "visibility", nodeId: "watermark", visible: false }],
    });
    expect(readPixel(withoutWatermark.png, 5, 5)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("flattens a non-pass-through group as one unit with its own opacity", async () => {
    const groupId = idFromPath("Group");
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 10,
      height: 10,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "pixel",
          id: "bg",
          path: "Background",
          name: "Background",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          imageAssetId: "white",
        },
        {
          type: "group",
          id: groupId,
          path: "Group",
          name: "Group",
          visible: true,
          opacity: 0.5,
          blendMode: "normal",
          clipping: false,
          isPassThrough: false,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          children: [
            {
              type: "pixel",
              id: "child",
              path: "Group/Child",
              name: "Child",
              visible: true,
              opacity: 1,
              blendMode: "normal",
              clipping: false,
              bounds: { left: 0, top: 0, right: 10, bottom: 10 },
              imageAssetId: "black",
            },
          ],
        },
      ],
    };
    const assets = new FakeAssets(
      new Map([
        ["white", solidPng(10, 10, "#ffffff")],
        ["black", solidPng(10, 10, "#000000")],
      ]),
    );
    const result = await new SceneCompositor(assets).render(graph);
    const px = readPixel(result.png, 5, 5);
    expect(px.r).toBeGreaterThan(110);
    expect(px.r).toBeLessThan(145);
  });

  it("renders replacement photo content cropped into a smart object's bounds", async () => {
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 20,
      height: 20,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "smartObject",
          id: "photo",
          path: "Photo",
          name: "Photo",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 0, top: 0, right: 20, bottom: 20 },
          imageAssetId: "placeholder",
          placement: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 0, m12: 0 },
          intrinsicWidth: 20,
          intrinsicHeight: 20,
          replaceable: true,
        },
      ],
    };
    const assets = new FakeAssets(
      new Map([
        ["placeholder", solidPng(20, 20, "#888888")],
        ["uploaded", solidPng(40, 40, "#00ff00")],
      ]),
    );
    const result = await new SceneCompositor(assets).render(graph, {
      overrides: [{ type: "image", nodeId: "photo", imageAssetId: "uploaded", crop: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    expect(readPixel(result.png, 10, 10)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("renders replaced text with the field's own text and inherited styling", async () => {
    const graph: SceneGraph = {
      formatVersion: 1,
      width: 200,
      height: 60,
      dpi: 72,
      colorMode: "rgb",
      root: [
        {
          type: "text",
          id: "name",
          path: "Name",
          name: "Name",
          visible: true,
          opacity: 1,
          blendMode: "normal",
          clipping: false,
          bounds: { left: 10, top: 10, right: 190, bottom: 40 },
          alignment: "left",
          boxMode: "point",
          runs: [
            {
              text: "Template Text",
              fontName: "sans-serif",
              fontSize: 20,
              color: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        },
      ],
    };
    const assets = new FakeAssets(new Map());
    const result = await new SceneCompositor(assets).render(graph, {
      overrides: [{ type: "text", nodeId: "name", text: "Jane Doe" }],
    });
    // A background stays fully transparent where no glyph was painted; somewhere in the
    // text's bounding box a glyph pixel should have been painted with the run's black fill.
    const decodedHasInk = (() => {
      for (let x = 10; x < 190; x += 2) {
        for (let y = 10; y < 40; y += 2) {
          const px = readPixel(result.png, x, y);
          if (px.a > 0 && px.r < 50 && px.g < 50 && px.b < 50) return true;
        }
      }
      return false;
    })();
    expect(decodedHasInk).toBe(true);
  });
});
