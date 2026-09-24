import { GlobalFonts, createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { FieldOverride, Rect, SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { SceneCompositor } from "@psd-studio/psd-engine";
import { exportDivergences, fieldTextFit, isFontAvailable, measureFieldTextBounds, measureTextBounds, renderScene, textRunBoxes, type Ctx2D } from "../src/index.js";

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

function translate(x: number, y: number) {
  return { m00: 1, m01: 0, m10: 0, m11: 1, m02: x, m12: y };
}

function graphOf(root: SceneNode[]): SceneGraph {
  return { formatVersion: 1, width: 100, height: 100, dpi: 72, colorMode: "rgb", root };
}

async function renderBoth(graph: SceneGraph, assets: Record<string, Buffer>, { visibility, overrides }: { visibility?: Map<string, boolean>; overrides?: FieldOverride[] } = {}) {
  const images = new Map<string, Image>();
  for (const [id, png] of Object.entries(assets)) images.set(id, await loadImage(png));
  const client = napiBuffer(graph.width, graph.height);
  renderScene(client, graph, { scale: 1, images: (id) => images.get(id) as unknown as CanvasImageSource, visibility, overrides, createBuffer: napiBuffer });
  const server = await new SceneCompositor({ getImage: async (id) => assets[id]! }).render(graph, { overrides });
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
    const { client } = await renderBoth(graph, assets, { visibility: new Map([["hidden", true]]) });
    expect(client(50, 50)).toEqual([0, 255, 0, 255]);
    const { client: hiddenBg } = await renderBoth(graph, assets, { visibility: new Map([["bg", false]]) });
    expect(hiddenBg(50, 50)[3]).toBe(0);
  });

  it("matches the server for field overrides, including an upload cropped into a pixel layer", async () => {
    const upload = createCanvas(80, 40);
    const uctx = upload.getContext("2d");
    uctx.fillStyle = "#ff0000";
    uctx.fillRect(0, 0, 40, 40);
    uctx.fillStyle = "#0000ff";
    uctx.fillRect(40, 0, 40, 40);
    const graph = graphOf([pixel("bg", { left: 0, top: 0, right: 100, bottom: 100 }), pixel("hidden", { left: 0, top: 0, right: 100, bottom: 100 }, { visible: false }), pixel("red", { left: 10, top: 10, right: 50, bottom: 50 })]);
    const overrides: FieldOverride[] = [
      { type: "image", nodeId: "red", imageAssetId: "upload", crop: { x: 0.25, y: 0, width: 0.5, height: 1 } },
      { type: "visibility", nodeId: "hidden", visible: true },
    ];
    const { client, server } = await renderBoth(graph, { ...assets, upload: upload.toBuffer("image/png") }, { overrides });
    for (const [x, y] of [[15, 30], [45, 30], [5, 5]] as const) expect(client(x, y)).toEqual(server(x, y));
    expect(client(15, 30)).toEqual([255, 0, 0, 255]);
    expect(client(45, 30)).toEqual([0, 0, 255, 255]);
    expect(client(5, 5)).toEqual([0, 255, 0, 255]);
  });

  it("measures text extents for layers stored with empty bounds", () => {
    const text = {
      ...base("t", { left: 10, top: 20, right: 10, bottom: 20 }),
      type: "text",
      alignment: "left",
      boxMode: "point",
      frame: { transform: translate(10, 40), box: null },
      runs: [{ text: "Hello\nWide world", fontName: "Arial", fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as SceneNode;
    const rect = measureTextBounds(napiBuffer(1, 1), text as Extract<SceneNode, { type: "text" }>);
    expect(rect.left).toBe(10);
    expect(rect.right).toBeGreaterThan(60);
    expect(rect.bottom).toBeCloseTo(20 + 20 + 24 + 5);
  });

  it("boxes each run's glyphs separately, tighter than the layer's stored bounds", () => {
    const text = {
      ...base("t", { left: 10, top: 20, right: 400, bottom: 120 }),
      type: "text",
      alignment: "left",
      boxMode: "point",
      runs: [
        { text: "Big ", fontName: "Arial", fontSize: 40, color: { r: 0, g: 0, b: 0, a: 1 } },
        { text: "small\nnext", fontName: "Arial", fontSize: 12, color: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    } as Extract<SceneNode, { type: "text" }>;
    const boxes = textRunBoxes(napiBuffer(1, 1), text);
    expect(boxes.map((b) => b.run)).toEqual([0, 1, 1]);
    const [big, small, next] = boxes.map((b) => b.rect) as [Rect, Rect, Rect];
    expect(small.left).toBeGreaterThan(big.right);
    expect(big.bottom - big.top).toBeGreaterThan(small.bottom - small.top);
    expect(next.top).toBeGreaterThan(small.bottom);
    expect(next.left).toBeLessThan(big.right);
    // The trailing space of "Big " advances the pen but has no ink.
    expect(big.right).toBeLessThan(small.left - 5);
    for (const r of [big, small, next]) {
      expect(r.left).toBeGreaterThanOrEqual(text.bounds.left - 2);
      expect(r.right).toBeLessThan(200);
    }
  });

  it("renders a panned, zoomed viewport through origin", async () => {
    const graph = graphOf([pixel("red", { left: 0, top: 0, right: 40, bottom: 40 }), pixel("blue", { left: 60, top: 60, right: 100, bottom: 100 })]);
    const images = new Map<string, Image>();
    for (const id of ["red", "blue"]) images.set(id, await loadImage(assets[id as "red" | "blue"]));
    const viewport = napiBuffer(50, 50);
    // 2x zoom with scene point (60, 60) at the viewport's top-left.
    renderScene(viewport, graph, { scale: 2, origin: { x: -120, y: -120 }, images: (id) => images.get(id) as unknown as CanvasImageSource, createBuffer: napiBuffer });
    expect([...viewport.getImageData(10, 10, 1, 1).data]).toEqual([0, 0, 255, 255]);
    renderScene(viewport, graph, { scale: 2, origin: { x: 0, y: 0 }, images: (id) => images.get(id) as unknown as CanvasImageSource, createBuffer: napiBuffer });
    expect([...viewport.getImageData(10, 10, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect(viewport.getImageData(49, 49, 1, 1).data[3]).toBe(255);
  });

  it("honors clipping for top-level layers (intentional divergence from the server)", async () => {
    const graph = graphOf([pixel("red", { left: 0, top: 0, right: 40, bottom: 40 }), pixel("blue", { left: 20, top: 20, right: 80, bottom: 80 }, { clipping: true })]);
    const { client } = await renderBoth(graph, assets);
    expect(client(30, 30)).toEqual([0, 0, 255, 255]);
    expect(client(60, 60)[3]).toBe(0);
    expect(exportDivergences(graph, graph.root[1]!)).toEqual(["top-level-clipping"]);
    expect(exportDivergences(graph, graph.root[0]!)).toEqual([]);
  });

  it("reports how replacement text wraps against the layer's box at export scale", () => {
    const text = {
      ...base("t", { left: 0, top: 0, right: 200, bottom: 30 }),
      type: "text",
      alignment: "left",
      boxMode: "point",
      runs: [{ text: "Jane", fontName: "Arial", fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as Extract<SceneNode, { type: "text" }>;
    const ctx = napiBuffer(1, 1);
    expect(fieldTextFit(ctx, text, "Short name")).toEqual({ lines: 1, capacity: 1, overflowsWidth: false });
    expect(fieldTextFit(ctx, text, "A considerably longer name that has to wrap onto more lines")).toMatchObject({ capacity: 1, overflowsWidth: false });
    expect(fieldTextFit(ctx, text, "A considerably longer name that has to wrap onto more lines").lines).toBeGreaterThan(1);
    expect(fieldTextFit(ctx, text, "Supercalifragilisticexpialidocious-and-then-some").overflowsWidth).toBe(true);
    expect(fieldTextFit(ctx, { ...text, bounds: { left: 0, top: 0, right: 200, bottom: 80 } }, "x").capacity).toBe(3);
  });

  it("measures replacement text where paintText draws it, for layers stored with empty bounds", () => {
    const text = {
      ...base("t", { left: 100, top: 20, right: 100, bottom: 20 }),
      type: "text",
      alignment: "center",
      boxMode: "point",
      frame: { transform: translate(100, 40), box: null },
      runs: [{ text: "Jo", fontName: "Arial", fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as Extract<SceneNode, { type: "text" }>;
    const ctx = napiBuffer(1, 1);
    const short = measureFieldTextBounds(ctx, text, "Jo");
    const long = measureFieldTextBounds(ctx, text, "Jonathan Livingston");
    expect(long.right - long.left).toBeGreaterThan((short.right - short.left) * 3);
    expect((long.left + long.right) / 2).toBeCloseTo(100, 5);
    // Point text wraps replacement text at its authored width, one auto-leading line (24) per wrapped line.
    const { lines } = fieldTextFit(ctx, text, "Jonathan Livingston");
    expect(lines).toBe(2);
    expect(short.bottom).toBeCloseTo(40 + 5);
    expect(long.bottom).toBeCloseTo(40 + 5 + 24);
  });

  it("flags text styling the server compositor doesn't apply yet", () => {
    const text = {
      ...base("t", { left: 0, top: 0, right: 200, bottom: 30 }, { opacity: 0.5 }),
      type: "text",
      alignment: "left",
      boxMode: "point",
      runs: [{ text: "Jane", fontName: "Arial", fontSize: 20, tracking: 50, color: { r: 0, g: 0, b: 0, a: 1 } }],
    } as SceneNode;
    expect(exportDivergences(graphOf([text]), text)).toEqual(["text-tracking", "text-opacity"]);
  });

  it("tells a missing font from an installed one by measuring against generic fallbacks", () => {
    const ctx = napiBuffer(1, 1);
    expect(isFontAvailable(ctx, "NoSuchFontAnywhere-Bold")).toBe(false);
    const installed = GlobalFonts.families.map((f) => f.family).find((f) => !/\s/.test(f) && !/mono|serif/i.test(f));
    if (installed) expect(isFontAvailable(ctx, installed)).toBe(true);
  });
});
