import { createCanvas, ImageData } from "@napi-rs/canvas";
import { initializeCanvas, writePsdBuffer, type Psd, type Layer } from "ag-psd";

/**
 * Builds a real PSD binary (via ag-psd's actual writer) with the mix of
 * layer types the golden-path e2e test exercises: a background, a group
 * containing two text layers, a smart-object photo layer, and a hidden
 * watermark layer. This exists so the e2e test needs no checked-in binary
 * fixture and always matches the current ag-psd version.
 */
export function buildTestPsdBuffer(): Buffer {
  initializeCanvas(
    (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement,
    (w, h) => new ImageData(w, h) as unknown as globalThis.ImageData,
  );

  function solid(w: number, h: number, css: string) {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, w, h);
    return c as unknown as HTMLCanvasElement;
  }

  const psd: Psd = {
    width: 600,
    height: 380,
    children: [
      {
        name: "Background",
        left: 0,
        top: 0,
        right: 600,
        bottom: 380,
        opacity: 1,
        blendMode: "normal",
        canvas: solid(600, 380, "#1c4e80"),
      } as Layer,
      {
        name: "Card",
        children: [
          {
            name: "Full Name",
            left: 40,
            top: 260,
            right: 560,
            bottom: 300,
            opacity: 1,
            blendMode: "normal",
            text: {
              text: "Jane Doe",
              style: { font: { name: "ArialMT" }, fontSize: 28, fillColor: { r: 255, g: 255, b: 255, a: 255 } },
            },
          } as Layer,
          {
            name: "Title",
            left: 40,
            top: 305,
            right: 560,
            bottom: 335,
            opacity: 1,
            blendMode: "normal",
            text: {
              text: "Software Engineer",
              style: { font: { name: "ArialMT" }, fontSize: 18, fillColor: { r: 220, g: 220, b: 220, a: 255 } },
            },
          } as Layer,
          {
            name: "Photo",
            left: 40,
            top: 40,
            right: 200,
            bottom: 200,
            opacity: 1,
            blendMode: "normal",
            canvas: solid(160, 160, "#888888"),
            placedLayer: {
              id: "20953ddb-9391-11ec-b4f1-c15674f50bc4",
              type: "raster",
              transform: [40, 40, 200, 40, 200, 200, 40, 200],
              width: 160,
              height: 160,
            },
          } as Layer,
          {
            name: "Watermark",
            left: 0,
            top: 0,
            right: 600,
            bottom: 380,
            opacity: 0.15,
            blendMode: "normal",
            hidden: true,
            canvas: solid(600, 380, "#ff0000"),
          } as Layer,
        ],
      } as Layer,
    ],
  };

  return writePsdBuffer(psd, { generateThumbnail: false });
}
