import { IdentityTransform, type AffineTransform, type Rect, type TextFrame, type TextLayerNode, type TextRun } from "./nodes.js";

/** Font measurement the renderer supplies, in the run's local units (its fontSize as stored). */
export interface TextMeasure {
  width(text: string, run: TextRun): number;
  /** Height of a capital above the baseline: Photoshop hangs a paragraph's first line from its box top by this much. */
  capHeight(run: TextRun): number;
}

export interface TextSegment {
  /** Index into the laid-out runs. */
  run: number;
  text: string;
  x: number;
  width: number;
}

export interface TextLine {
  baseline: number;
  segments: TextSegment[];
}

export interface TextLayout {
  /** Maps the local coordinates of `lines` into scene space. */
  transform: AffineTransform;
  lines: TextLine[];
}

/** Hard returns start a paragraph; U+0003 is the line break Photoshop stores for Shift+Enter, which doesn't. */
const LINE_BREAK = /(\r\n|\r|\n|\u0003)/;

export function lineHeight(run: TextRun): number {
  return run.leadingPt ?? run.fontSize * 1.2;
}

/** Where a node's text lays out: its PSD type frame, or for graphs without one, `bounds` taken as a box in scene space. */
export function textFrame(node: TextLayerNode): TextFrame {
  return node.frame ?? { transform: IdentityTransform, box: node.bounds };
}

/** Width replacement text wraps at, in local units: the paragraph box, or for point text the widest authored line. */
export function fieldWrapWidth(node: TextLayerNode, measure: TextMeasure): number {
  const { box } = textFrame(node);
  const width = box ? box.right - box.left : Math.max(0, ...layoutText(node, node.runs, measure, null).lines.map(lineWidth));
  return width || node.runs[0]!.fontSize * 20;
}

/** The local-space column replacement text (styled as the first run) wraps and aligns in, and its first baseline. */
export function fieldColumn(node: TextLayerNode, measure: TextMeasure): { left: number; width: number; baseline: number } {
  const { box } = textFrame(node);
  const width = fieldWrapWidth(node, measure);
  if (box) return { left: box.left, width, baseline: box.top + measure.capHeight(node.runs[0]!) };
  return { left: alignAt(node.alignment, width), width, baseline: 0 };
}

/** Wrap width for the authored runs: Photoshop wraps paragraph text in its box and never wraps point text. */
export function authoredWrapWidth(node: TextLayerNode): number | null {
  const box = node.frame?.box;
  return box ? box.right - box.left : null;
}

export function lineWidth(line: TextLine): number {
  const last = line.segments[line.segments.length - 1];
  return last ? last.x + last.width - line.segments[0]!.x : 0;
}

/**
 * Lays runs out as Photoshop does in the node's local frame: point text's first baseline sits on the origin and
 * each line aligns about it; paragraph text's lines align within its box, the first hung a cap height below the
 * box top. Lines advance by their tallest run's leading. wrapWidth greedy-wraps at spaces; null keeps hard breaks only.
 */
export function layoutText(node: TextLayerNode, runs: readonly TextRun[], measure: TextMeasure, wrapWidth: number | null): TextLayout {
  const { transform, box } = textFrame(node);
  const spacing = node.paragraphSpacing ? node.paragraphSpacing.after + node.paragraphSpacing.before : 0;
  const lines: TextLine[] = [];
  let baseline = 0;
  breakLines(runs, measure, wrapWidth).forEach((pieces, i) => {
    const lineRuns = pieces.runs.map((r) => runs[r]!);
    if (i === 0) baseline = box ? box.top + Math.max(...lineRuns.map((r) => measure.capHeight(r))) : 0;
    else baseline += Math.max(...lineRuns.map(lineHeight)) + (pieces.paragraphStart ? spacing : 0);
    const segments = segmentsOf(pieces.pieces, runs, measure);
    const width = segments.reduce((sum, s) => sum + s.width, 0);
    const x0 = box ? alignIn(node.alignment, box, width) : alignAt(node.alignment, width);
    for (const s of segments) s.x += x0;
    lines.push({ baseline, segments });
  });
  return { transform, lines };
}

interface Piece {
  run: number;
  text: string;
}

interface PiecesLine {
  pieces: Piece[];
  /** Runs that set this line's metrics: those with text on it, or for an empty line the run it breaks in. */
  runs: number[];
  /** Follows a hard return, so paragraph spacing precedes it. */
  paragraphStart: boolean;
}

function breakLines(runs: readonly TextRun[], measure: TextMeasure, wrapWidth: number | null): PiecesLine[] {
  const lines: PiecesLine[] = [{ pieces: [], runs: [], paragraphStart: false }];
  const current = () => lines[lines.length - 1]!;
  runs.forEach((run, r) => {
    run.text.split(LINE_BREAK).forEach((part, i) => {
      if (i % 2 === 1) {
        lines.push({ pieces: [], runs: [r], paragraphStart: part !== "\u0003" });
        return;
      }
      if (current().runs.length === 0) current().runs.push(r);
      for (const text of part.split(/(\s+)/)) {
        if (!text) continue;
        const piece = { run: r, text };
        const line = current();
        const isWord = /\S/.test(text);
        if (wrapWidth !== null && isWord && line.pieces.some((p) => /\S/.test(p.text)) && widthOf([...line.pieces, piece], runs, measure) > wrapWidth) {
          while (line.pieces.length > 0 && !/\S/.test(line.pieces[line.pieces.length - 1]!.text)) line.pieces.pop();
          lines.push({ pieces: [piece], runs: [r], paragraphStart: false });
          continue;
        }
        line.pieces.push(piece);
      }
    });
  });
  for (const line of lines) {
    const withText = [...new Set(line.pieces.map((p) => p.run))];
    if (withText.length > 0) line.runs = withText;
  }
  return lines;
}

function segmentsOf(pieces: readonly Piece[], runs: readonly TextRun[], measure: TextMeasure): TextSegment[] {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last?.run === p.run) last.text += p.text;
    else merged.push({ ...p });
  }
  let x = 0;
  return merged.map(({ run, text }) => {
    const width = measure.width(text, runs[run]!);
    const segment = { run, text, x, width };
    x += width;
    return segment;
  });
}

function widthOf(pieces: readonly Piece[], runs: readonly TextRun[], measure: TextMeasure): number {
  return segmentsOf(pieces, runs, measure).reduce((sum, s) => sum + s.width, 0);
}

function alignAt(alignment: TextLayerNode["alignment"], width: number): number {
  if (alignment === "center") return -width / 2;
  if (alignment === "right") return -width;
  return 0;
}

function alignIn(alignment: TextLayerNode["alignment"], box: Rect, width: number): number {
  if (alignment === "center") return box.left + (box.right - box.left - width) / 2;
  if (alignment === "right") return box.right - width;
  return box.left;
}

export function transformPoint(t: AffineTransform, x: number, y: number): { x: number; y: number } {
  return { x: t.m00 * x + t.m01 * y + t.m02, y: t.m10 * x + t.m11 * y + t.m12 };
}

/** Axis-aligned scene-space bounds of a local rect under t. */
export function transformRect(t: AffineTransform, r: Rect): Rect {
  const corners = [
    transformPoint(t, r.left, r.top),
    transformPoint(t, r.right, r.top),
    transformPoint(t, r.left, r.bottom),
    transformPoint(t, r.right, r.bottom),
  ];
  return {
    left: Math.min(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    right: Math.max(...corners.map((p) => p.x)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
}
