import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { writePsdBuffer, type Psd, type Layer } from "ag-psd";
import { parsePsdBuffer, type AssetSink } from "../src/ingest.js";
import { ensureCanvasInitialized } from "../src/canvasFactory.js";
import { readPixel } from "./pngPixels.js";

class RecordingSink implements AssetSink {
  images = new Map<string, Buffer>();
  async putImage(png: Buffer, hint: string): Promise<string> {
    const id = `asset_${this.images.size}_${hint.replace(/[^a-zA-Z0-9]/g, "_")}`;
    this.images.set(id, png);
    return id;
  }
}

function solidCanvas(width: number, height: number, css: string) {
  ensureCanvasInitialized();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, width, height);
  return canvas as unknown as HTMLCanvasElement;
}

describe("PSD binary round-trip (writePsdBuffer -> readPsd -> buildSceneGraph)", () => {
  it("ingests a real serialized PSD file byte-for-byte through ag-psd", async () => {
    ensureCanvasInitialized();

    const psd: Psd = {
      width: 400,
      height: 240,
      children: [
        {
          name: "Background",
          left: 0,
          top: 0,
          right: 400,
          bottom: 240,
          opacity: 1,
          blendMode: "normal",
          canvas: solidCanvas(400, 240, "#2266aa"),
        } as Layer,
        {
          name: "Card",
          children: [
            {
              name: "Full Name",
              left: 20,
              top: 20,
              right: 380,
              bottom: 60,
              opacity: 1,
              blendMode: "normal",
              text: {
                text: "Jane Doe",
                style: {
                  font: { name: "ArialMT" },
                  fontSize: 28,
                  fillColor: { r: 255, g: 255, b: 255, a: 255 },
                },
              },
            } as Layer,
            {
              name: "Photo",
              left: 20,
              top: 80,
              right: 140,
              bottom: 200,
              opacity: 1,
              blendMode: "normal",
              canvas: solidCanvas(120, 120, "#cccccc"),
            } as Layer,
          ],
        } as Layer,
      ],
    };

    // Real binary serialization, exactly what a Photoshop export or template re-upload produces.
    const bytes = writePsdBuffer(psd, { generateThumbnail: false });
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("8BPS"); // PSD file signature

    const sink = new RecordingSink();
    const { sceneGraph, warnings } = await parsePsdBuffer(bytes, sink);

    expect(sceneGraph.width).toBe(400);
    expect(sceneGraph.height).toBe(240);
    expect(sceneGraph.root).toHaveLength(2);

    const background = sceneGraph.root[0]!;
    expect(background.type).toBe("pixel");
    expect(background.name).toBe("Background");

    const group = sceneGraph.root[1]!;
    expect(group.type).toBe("group");
    if (group.type === "group") {
      expect(group.children).toHaveLength(2);
      const [nameNode, photoNode] = group.children;
      expect(nameNode!.type).toBe("text");
      if (nameNode!.type === "text") {
        expect(nameNode!.runs[0]!.text).toBe("Jane Doe");
      }
      expect(photoNode!.type).toBe("pixel");
    }

    // The extracted background raster must actually carry the pixels we wrote in.
    expect(sink.images.size).toBeGreaterThanOrEqual(2);
    if (background.type === "pixel") {
      const png = sink.images.get(background.imageAssetId)!;
      const px = readPixel(png, 10, 10);
      expect(px.r).toBeCloseTo(0x22, -1);
      expect(px.g).toBeCloseTo(0x66, -1);
      expect(px.b).toBeCloseTo(0xaa, -1);
    }

    expect(Array.isArray(warnings)).toBe(true);
  });
});
