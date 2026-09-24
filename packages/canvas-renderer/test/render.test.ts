import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { SceneCompositor } from "@psd-studio/psd-engine";
import { measureTextBounds, renderScene, type Ctx2D } from "../src/index.js";

const napiBuffer = (w: number, h: number) => createCanvas(w, h).getContext("2d") as unknown as Ctx2D;

function solidPng(w: number, h: number, css: string): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, w, h);
  return canvas.toBuffer("image/png");
}

function base(id: string, bounds: SceneNode["bounds"], extra: Partial<SceneNode> = {}) {
  return { id, path: id, name: id, visible: true, opacity: 1, blendMode: "normal" as const, clipping: false, bounds, ...extra };
}

function pixel(id: string, bounds: SceneNode["bounds"], extra: Partial<SceneNode> = {}): SceneNode {
  return { ...base(id, bounds, extra), type: "pixel", imageAssetId: id } as SceneNode;
}

function graphOf(root: SceneNode[]): SceneGraph {
  return { formatVersion: 1, width: 100, height: 100, dpi: 72, colorMode: "rgb", root };
}

async function renderBoth(graph: SceneGraph, assets: Record<string, Buffer>, visibility?: Map<string, boolean>) {
  const images = new Map<string, Image>();
  for (const [id, png] of Object.entries(assets)) images.set(id, await loadImage(png));
  const client = napiBuffer(graph.width, graph.height);
  renderScene(client, graph, { scale: 1, images: (id) => images.get(id) as unknown as CanvasImageSource, visibility, createBuffer: napiBuffer });
  const server = await new SceneCompositor({ getImage: async (id) => assets[id]! }).render(graph);
  const serverCtx = napiBuffer(graph.width, graph.height);
  serverCtx.drawImage((await loadImage(server.png)) as unknown as CanvasImageSource, 0, 0);
  const at = (ctx: Ctx2D) => (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  return { client: at(client), server: at(serverCtx) };
}

const assets = {
  bg: solidPng(100, 100, "#ffffff"),
  red: solidPng(40, 40, "#ff0000"),
  blue: solidPng(60, 60, "#0000ff"),
  hidden: solidPng(100, 100, "#00ff00"),
};

describe("renderScene", () => {
  it("matches the server compositor for isolated groups, blend modes, opacity and nested clipping", async () => {
    const graph = graphOf([
      pixel("bg", { left: 0, top: 0, right: 100, bottom: 100 }),
      {
        ...base("group", { left: 10, top: 10, right: 90, bottom: 90 }, { opacity: 0.5, blendMode: "multiply" }),
        type: "group",
        isPassThrough: false,
        children: [pixel("red", { left: 10, top: 10, right: 50, bottom: 50 }), pixel("blue", { left: 30, top: 30, right: 90, bottom: 90 }, { clipping: true })],
      },
      pixel("hidden", { left: 0, top: 0, right: 100, bottom: 100 }, { visible: false }),
    ]);
    const { client, server } = await renderBoth(graph, assets);
    for (const [x, y] of [[5, 5], [20, 20], [40, 40], [70, 70], [45, 20]] as const) {
      const c = client(x, y);
      const s = server(x, y);
      c.forEach((v, i) => expect(Math.abs(v - s[i]!)).toBeLessThanOrEqual(2));
    }
    expect(client(70, 70)).toEqual([255, 255, 255, 255]);
    const near = (px: number[], rgb: number[]) => rgb.forEach((v, i) => expect(Math.abs(px[i]! - v)).toBeLessThanOrEqual(2));
    near(client(20, 20), [255, 127, 127]);
    near(client(40, 40), [127, 127, 255]);
  });

  it("lets view-only visibility hide authored-visible layers and reveal authored-hidden ones", async () => {
    const graph = graphOf([pixel("bg", { left: 0, top: 0, right: 100, bottom: 100 }), pixel("hidden", { left: 0, top: 0, right: 100, bottom: 100 }, { visible: false })]);
    const { client } = await renderBoth(graph, assets, new Map([["hidden", true]]));
    expect(client(50, 50)).toEqual([0, 255, 0, 255]);
    const { client: hiddenBg } = await renderBoth(graph, assets, new Map([["bg", false]]));
    expect(hiddenBg(50, 50)[3]).toBe(0);
  });

  it("measures text extents for layers stored with empty bounds", () => {
    const text = {
      ...base("t", { left: 10, top: 20, right: 10, bottom: 20 }),
      type: "text",
      alignment: "left",
      boxMode: "point",
      runs: [{ text: "Hello\nWide world", fontName: "Arial", fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as SceneNode;
    const rect = measureTextBounds(napiBuffer(1, 1), text as Extract<SceneNode, { type: "text" }>);
    expect(rect.left).toBe(10);
    expect(rect.right).toBeGreaterThan(60);
    expect(rect.bottom).toBeCloseTo(20 + 20 + 24 + 5);
  });

  it("honors clipping for top-level layers (intentional divergence from the server)", async () => {
    const graph = graphOf([pixel("red", { left: 0, top: 0, right: 40, bottom: 40 }), pixel("blue", { left: 20, top: 20, right: 80, bottom: 80 }, { clipping: true })]);
    const { client } = await renderBoth(graph, assets);
    expect(client(30, 30)).toEqual([0, 0, 255, 255]);
    expect(client(60, 60)[3]).toBe(0);
  });
});
