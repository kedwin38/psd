import { createCanvas, ImageData } from "@napi-rs/canvas";
import { initializeCanvas, writePsdBuffer, type Layer } from "ag-psd";

/**
 * A 600x380 PSD (the scene size fixtures/workspace.ts maps) whose Layers panel, topmost first, reads as NESTED_LAYERS:
 * groups three deep, a sibling group, loose layers between groups, an empty group, a hidden group, two sibling layers
 * sharing a name, an empty pixel layer, an empty smart object placeholder and Photoshop-locked layers (one a group).
 * ag-psd lists children bottom to top.
 */
export const NESTED_LAYERS: [name: string, depth: number][] = [
  ["Headline", 0],
  ["Frame", 0],
  ["Inner", 1],
  ["Deep", 2],
  ["Deep Star", 3],
  ["Deep Label", 3],
  ["Inner Badge", 2],
  ["Empty Group", 2],
  ["Frame Border", 1],
  ["Stripe", 0],
  ["Gallery", 0],
  ["Tile", 1],
  ["Tile", 1],
  ["Brand", 0],
  ["Brand Mark", 1],
  ["Transparent", 0],
  ["Logo Slot", 0],
  ["Background", 0],
];

/** Scene rects of the pixel layers, for pixel checks. */
export const NESTED_RECTS = {
  background: { left: 0, top: 0, right: 600, bottom: 380, color: "#204060" },
  stripe: { left: 0, top: 140, right: 600, bottom: 160, color: "#ffcc00" },
  deepStar: { left: 20, top: 20, right: 60, bottom: 60, color: "#ff0000" },
  logoSlot: { left: 300, top: 200, right: 380, bottom: 280 },
};

export function buildNestedPsdBuffer(): Buffer {
  initializeCanvas(
    (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement,
    (w, h) => new ImageData(w, h) as unknown as globalThis.ImageData,
  );
  const pixel = (name: string, r: { left: number; top: number; right: number; bottom: number }, color: string, extra: Partial<Layer> = {}): Layer => {
    const c = createCanvas(r.right - r.left, r.bottom - r.top);
    const ctx = c.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    return { name, ...r, opacity: 1, blendMode: "normal", canvas: c as unknown as HTMLCanvasElement, ...extra };
  };
  const text = (name: string, value: string, x: number, y: number): Layer => ({
    name,
    opacity: 1,
    blendMode: "normal",
    text: { text: value, transform: [1, 0, 0, 1, x, y], style: { font: { name: "ArialMT" }, fontSize: 20, fillColor: { r: 255, g: 255, b: 255, a: 255 } } },
  });
  const { background, stripe, deepStar, logoSlot } = NESTED_RECTS;
  const children: Layer[] = [
    pixel("Background", background, background.color, { protected: { position: true } }),
    {
      name: "Logo Slot",
      opacity: 1,
      blendMode: "normal",
      placedLayer: {
        id: "5a3b7c1e-9391-11ec-b4f1-c15674f50bc4",
        type: "raster",
        transform: [logoSlot.left, logoSlot.top, logoSlot.right, logoSlot.top, logoSlot.right, logoSlot.bottom, logoSlot.left, logoSlot.bottom],
        width: 80,
        height: 80,
      },
    },
    { name: "Transparent", opacity: 1, blendMode: "normal" },
    { name: "Brand", protected: { position: true }, children: [pixel("Brand Mark", { left: 320, top: 20, right: 380, bottom: 60 }, "#00ffff")] },
    {
      name: "Gallery",
      hidden: true,
      children: [pixel("Tile", { left: 200, top: 200, right: 240, bottom: 240 }, "#00ff00"), pixel("Tile", { left: 250, top: 200, right: 290, bottom: 240 }, "#0000ff")],
    },
    pixel("Stripe", stripe, stripe.color),
    {
      name: "Frame",
      children: [
        pixel("Frame Border", { left: 10, top: 10, right: 190, bottom: 130 }, "#888888", { protected: { position: true } }),
        {
          name: "Inner",
          children: [
            { name: "Empty Group", children: [] },
            pixel("Inner Badge", { left: 100, top: 20, right: 140, bottom: 60 }, "#ff00ff"),
            { name: "Deep", children: [text("Deep Label", "Deep", 20, 100), pixel("Deep Star", deepStar, deepStar.color)] },
          ],
        },
      ],
    },
    text("Headline", "Nested", 200, 40),
  ];
  return writePsdBuffer({ width: 600, height: 380, children }, { generateThumbnail: false });
}
