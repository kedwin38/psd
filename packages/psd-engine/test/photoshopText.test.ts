import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { SceneGraph, SceneNode, TextLayerNode } from "@psd-studio/scene-graph";
import { parsePsdBuffer } from "../src/ingest.js";
import { SceneCompositor } from "../src/compositor.js";
import { decodePng } from "./pngPixels.js";

/**
 * Real Photoshop files (see fixtures/photoshop/NOTICE). Each `ink` is the extent of the pixels Photoshop itself
 * rendered for the layer, so it is where the text truly sits; `origin` is the layer's type transform translation.
 */
const FIXTURES = join(__dirname, "fixtures", "photoshop");
// Metric-compatible with Arial, so ArialMT layers render with Photoshop's advance widths.
const LIBERATION_SANS = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";
const hasArialMetrics = existsSync(LIBERATION_SANS) && !!GlobalFonts.registerFromPath(LIBERATION_SANS, "ArialMT");

type Ink = [left: number, top: number, right: number, bottom: number];

interface Truth {
  file: string;
  name: string;
  ink: Ink;
  origin: [number, number];
  align: "left" | "center";
}

const ARIAL_LAYERS: Truth[] = [
  { file: "blend-and-clipping.psd", name: "clipping", ink: [148, 189, 251, 213], origin: [147.05, 207.04], align: "left" },
  { file: "blend-and-clipping.psd", name: "interior clipping", ink: [404, 176, 507, 225], origin: [403.05, 194.04], align: "left" },
  { file: "blend-and-clipping.psd", name: "none", ink: [168, 449, 234, 464], origin: [166.05, 463.04], align: "left" },
  { file: "blend-and-clipping.psd", name: "interior", ink: [410, 447, 505, 466], origin: [408.05, 465.04], align: "left" },
  { file: "text.psd", name: "Line 1 Line 2 Line 3 and text", ink: [84, 110, 169, 151], origin: [83.81, 119.72], align: "left" },
  { file: "adjustment-fillers.psd", name: "TEXT", ink: [63, 334, 184, 366], origin: [48.59, 330.2], align: "center" },
];

async function ingest(file: string): Promise<SceneGraph> {
  const { sceneGraph } = await parsePsdBuffer(readFileSync(join(FIXTURES, file)), { putImage: async (_png, hint) => hint });
  return sceneGraph;
}

function textNode(graph: SceneGraph, name: string): TextLayerNode {
  const find = (nodes: SceneNode[]): TextLayerNode | undefined =>
    nodes.map((n) => (n.type === "group" ? find(n.children) : n.type === "text" && n.name === name ? n : undefined)).find(Boolean);
  const node = find(graph.root);
  if (!node) throw new Error(`No text layer "${name}"`);
  return node;
}

/** Where the server compositor puts the layer's glyphs, rendering it alone. */
async function renderedInk(graph: SceneGraph, node: TextLayerNode): Promise<Ink> {
  const { png } = await new SceneCompositor({ getImage: async () => Buffer.alloc(0) }).render({ ...graph, root: [node] });
  const { width, height, data } = decodePng(png);
  let [l, t, r, b] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! <= 20) continue;
      [l, t, r, b] = [Math.min(l, x), Math.min(t, y), Math.max(r, x + 1), Math.max(b, y + 1)];
    }
  }
  return [l, t, r, b];
}

const center = (ink: Ink) => (ink[0] + ink[2]) / 2;

describe("Photoshop text placement", () => {
  it("records each text layer's type frame, with bounds on Photoshop's rendered glyphs", async () => {
    for (const truth of ARIAL_LAYERS) {
      const node = textNode(await ingest(truth.file), truth.name);
      const { m00, m01, m10, m11, m02, m12 } = node.frame!.transform;
      expect([m00, m01, m10, m11]).toEqual([1, 0, 0, 1]);
      expect(m02).toBeCloseTo(truth.origin[0], 2);
      expect(m12).toBeCloseTo(truth.origin[1], 2);
      expect(node.bounds).toEqual({ left: truth.ink[0], top: truth.ink[1], right: truth.ink[2], bottom: truth.ink[3] });
    }
    // Point text's origin is its first baseline: glyphs without descenders end on it.
    for (const name of ["none", "interior"]) {
      const node = textNode(await ingest("blend-and-clipping.psd"), name);
      expect(Math.abs(node.bounds.bottom - node.frame!.transform.m12)).toBeLessThan(1.5);
    }
    const box = textNode(await ingest("adjustment-fillers.psd"), "TEXT");
    expect(box.boxMode).toBe("paragraph");
    expect(box.frame!.box).toEqual({ left: 0, top: 0, right: 149.75, bottom: 103.25 });
    expect(box.alignment).toBe("center");
  });

  it.skipIf(!hasArialMetrics)("exports each Arial text layer onto the pixels Photoshop rendered for it", async () => {
    for (const truth of ARIAL_LAYERS) {
      const graph = await ingest(truth.file);
      const ink = await renderedInk(graph, textNode(graph, truth.name));
      expect(Math.abs(ink[1] - truth.ink[1]), `${truth.name} top`).toBeLessThanOrEqual(2);
      expect(Math.abs(ink[3] - truth.ink[3]), `${truth.name} bottom`).toBeLessThanOrEqual(2);
      // The compositor doesn't apply tracking yet (see canvas-renderer's export divergences), so right edges run short.
      if (truth.align === "left") expect(Math.abs(ink[0] - truth.ink[0]), `${truth.name} left`).toBeLessThanOrEqual(2);
      else expect(Math.abs(center(ink) - center(truth.ink)), `${truth.name} center`).toBeLessThanOrEqual(2);
    }
  });

  it("scales text by its type transform (a 2x frame renders twice the font size)", async () => {
    const graph = await ingest("masks-text.psd");
    const signIn = textNode(graph, "sign in");
    expect(signIn.frame).toEqual({ transform: { m00: 2, m01: 0, m10: 0, m11: 2, m02: 472.3984375, m12: 58.8515625 }, box: null });
    expect(signIn.runs[0]!.fontSize).toBe(16);

    // ProximaNova isn't installed, so compare placement and size, not exact glyph extents.
    const heading = textNode(graph, "text replaced");
    expect(heading.frame!.box).toEqual({ left: 0, top: 0, right: 280, bottom: 67.6875 });
    const photoshop: Ink = [194, 188, 444, 227];
    const ink = await renderedInk(graph, heading);
    expect(Math.abs(center(ink) - center(photoshop))).toBeLessThanOrEqual(2);
    expect(Math.abs(ink[1] - photoshop[1])).toBeLessThanOrEqual(3);
    expect(Math.abs(ink[3] - photoshop[3])).toBeLessThanOrEqual(3);
    expect((ink[2] - ink[0]) / (photoshop[2] - photoshop[0])).toBeGreaterThan(0.85);
  });
});
