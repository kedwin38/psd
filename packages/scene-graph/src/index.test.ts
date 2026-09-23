import { describe, expect, it } from "vitest";
import {
  SceneGraphSchema,
  idFromPath,
  walkSceneGraph,
  findNodeById,
  type SceneGraph,
} from "./index.js";
import { FieldOverrideSchema } from "./fields.js";

function sampleGraph(): SceneGraph {
  return {
    formatVersion: 1,
    width: 1000,
    height: 600,
    dpi: 300,
    colorMode: "rgb",
    root: [
      {
        type: "group",
        id: idFromPath("Card"),
        path: "Card",
        name: "Card",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        clipping: false,
        isPassThrough: true,
        bounds: { left: 0, top: 0, right: 1000, bottom: 600 },
        children: [
          {
            type: "text",
            id: idFromPath("Card/Full Name"),
            path: "Card/Full Name",
            name: "Full Name",
            visible: true,
            opacity: 1,
            blendMode: "normal",
            clipping: false,
            bounds: { left: 40, top: 40, right: 400, bottom: 80 },
            alignment: "left",
            boxMode: "point",
            runs: [
              {
                text: "Jane Doe",
                fontName: "Inter-Bold",
                fontSize: 24,
                color: { r: 20, g: 20, b: 20, a: 1 },
              },
            ],
          },
          {
            type: "smartObject",
            id: idFromPath("Card/Photo"),
            path: "Card/Photo",
            name: "Photo",
            visible: true,
            opacity: 1,
            blendMode: "normal",
            clipping: false,
            bounds: { left: 40, top: 100, right: 240, bottom: 300 },
            imageAssetId: "asset_photo_preview",
            placement: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 0, m12: 0 },
            intrinsicWidth: 200,
            intrinsicHeight: 200,
            replaceable: true,
          },
        ],
      },
    ],
  };
}

describe("SceneGraphSchema", () => {
  it("round-trips a nested graph through parse/serialize", () => {
    const graph = sampleGraph();
    const parsed = SceneGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
    expect(parsed).toEqual(graph);
  });

  it("rejects an unknown node type", () => {
    const graph: any = sampleGraph();
    graph.root[0].children.push({ type: "bogus" });
    expect(() => SceneGraphSchema.parse(graph)).toThrow();
  });
});

describe("idFromPath", () => {
  it("is deterministic and path-sensitive", () => {
    expect(idFromPath("Card/Photo")).toBe(idFromPath("Card/Photo"));
    expect(idFromPath("Card/Photo")).not.toBe(idFromPath("Card/photo"));
  });
});

describe("walkSceneGraph / findNodeById", () => {
  it("visits groups and their descendants", () => {
    const graph = sampleGraph();
    const names = [...walkSceneGraph(graph)].map((n) => n.name);
    expect(names).toEqual(["Card", "Full Name", "Photo"]);
  });

  it("finds a nested node by id", () => {
    const graph = sampleGraph();
    const node = findNodeById(graph, idFromPath("Card/Photo"));
    expect(node?.type).toBe("smartObject");
  });
});

describe("FieldOverrideSchema", () => {
  it("accepts a valid text override", () => {
    const result = FieldOverrideSchema.parse({
      type: "text",
      nodeId: "n_abc",
      text: "John Smith",
    });
    expect(result.type).toBe("text");
  });

  it("rejects a crop window outside 0..1", () => {
    expect(() =>
      FieldOverrideSchema.parse({
        type: "image",
        nodeId: "n_abc",
        imageAssetId: "asset_1",
        crop: { x: -0.1, y: 0, width: 1, height: 1 },
      }),
    ).toThrow();
  });
});
