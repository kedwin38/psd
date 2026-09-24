import { describe, expect, it } from "vitest";
import type { TextLayerNode, TextRun } from "./nodes.js";
import { fieldColumn, glyphTransform, layoutText, lineWidth, transformRect, type TextMeasure } from "./textLayout.js";

/** Every character is half an em wide; capitals are 0.7 em tall. */
const measure: TextMeasure = {
  width: (text, run) => text.length * run.fontSize * 0.5,
  capHeight: (run) => run.fontSize * 0.7,
};

function run(text: string, extra: Partial<TextRun> = {}): TextRun {
  return { text, fontName: "Arial", fontSize: 20, color: { r: 0, g: 0, b: 0, a: 1 }, ...extra };
}

function node(runs: TextRun[], extra: Partial<TextLayerNode> = {}): TextLayerNode {
  return {
    type: "text",
    id: "t",
    path: "t",
    name: "t",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    clipping: false,
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    alignment: "left",
    boxMode: "point",
    frame: { transform: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 100, m12: 50 }, box: null },
    runs,
    ...extra,
  };
}

const lines = (n: TextLayerNode, wrap: number | null = null) =>
  layoutText(n, n.runs, measure, wrap).lines.map((l) => ({ baseline: l.baseline, x: l.segments[0]?.x, text: l.segments.map((s) => s.text).join(""), width: lineWidth(l) }));

describe("layoutText", () => {
  it("starts point text's first baseline on the origin and aligns each line about it", () => {
    const text = [run("ab\nabcd")];
    expect(lines(node(text))).toEqual([
      { baseline: 0, x: 0, text: "ab", width: 20 },
      { baseline: 24, x: 0, text: "abcd", width: 40 },
    ]);
    expect(lines(node(text, { alignment: "center" })).map((l) => l.x)).toEqual([-10, -20]);
    expect(lines(node(text, { alignment: "right" })).map((l) => l.x)).toEqual([-20, -40]);
  });

  it("wraps paragraph text in its box, hanging the first line a cap height below the box top", () => {
    const box = { left: 5, top: 10, right: 105, bottom: 200 };
    const n = node([run("aaaa bbbb cccc")], { boxMode: "paragraph", frame: { transform: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 0, m12: 0 }, box } });
    expect(lines(n, 100)).toEqual([
      { baseline: 24, x: 5, text: "aaaa bbbb", width: 90 },
      { baseline: 48, x: 5, text: "cccc", width: 40 },
    ]);
    expect(lines({ ...n, alignment: "center" }, 100).map((l) => l.x)).toEqual([10, 35]);
    expect(lines({ ...n, alignment: "right" }, 100).map((l) => l.x)).toEqual([15, 65]);
  });

  it("adds paragraph spacing at hard returns but not at Photoshop's Shift+Enter breaks", () => {
    const n = node([run("1\u00032\n3", { leadingPt: 14 })], { paragraphSpacing: { before: 3, after: 10 } });
    expect(lines(n).map((l) => [l.text, l.baseline])).toEqual([
      ["1", 0],
      ["2", 14],
      ["3", 41],
    ]);
  });

  it("advances each line by the largest leading on it", () => {
    const n = node([run("small\n", { leadingPt: 10 }), run("BIG", { fontSize: 40, leadingPt: 48 }), run(" tail\nnext", { leadingPt: 10 })]);
    expect(lines(n).map((l) => [l.text, l.baseline])).toEqual([
      ["small", 0],
      ["BIG tail", 48],
      ["next", 58],
    ]);
  });

  it("applies character scaling, baseline shift and all caps", () => {
    const n = node([run("ab", { horizontalScale: 1.5, baselineShift: -4, allCaps: true })]);
    const layout = layoutText(n, n.runs, measure, null);
    const line = layout.lines[0]!;
    expect(line.segments[0]).toEqual({ run: 0, text: "AB", x: 0, width: 30 });
    expect(glyphTransform(line, line.segments[0]!, n.runs[0]!)).toEqual({ m00: 1.5, m01: 0, m10: 0, m11: 1, m02: 0, m12: 4 });
  });

  it("returns the type transform, which maps local layout into the scene", () => {
    const rotated = { m00: 0, m01: -2, m10: 2, m11: 0, m02: 100, m12: 50 };
    const n = node([run("abcd")], { frame: { transform: rotated, box: null } });
    expect(layoutText(n, n.runs, measure, null).transform).toBe(rotated);
    // A 40-wide, 20-tall local line box turns into a 40-wide, 80-tall scene box under a 90° rotation at 2x.
    expect(transformRect(rotated, { left: 0, top: -20, right: 40, bottom: 0 })).toEqual({ left: 100, top: 50, right: 140, bottom: 130 });
  });

  it("lays out graphs without a frame inside their bounds, never wrapping authored text", () => {
    const n = node([run("aaaa bbbb")], { frame: undefined, bounds: { left: 10, top: 20, right: 30, bottom: 40 } });
    expect(lines(n)).toEqual([{ baseline: 34, x: 10, text: "aaaa bbbb", width: 90 }]);
  });
});

describe("fieldColumn", () => {
  it("wraps point-text replacements at the authored width, aligned about the origin", () => {
    const n = node([run("abcdef")], { alignment: "center" });
    expect(fieldColumn(n, measure)).toEqual({ left: -30, width: 60, baseline: 0 });
  });

  it("wraps paragraph replacements in the box, below its first-line hang", () => {
    const n = node([run("x")], { boxMode: "paragraph", frame: { transform: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 0, m12: 0 }, box: { left: 5, top: 10, right: 105, bottom: 90 } } });
    expect(fieldColumn(n, measure)).toEqual({ left: 5, width: 100, baseline: 24 });
  });
});
