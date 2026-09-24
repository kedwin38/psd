import type { Rgba, TextMeasure, TextRun } from "@psd-studio/scene-graph";
import type { Ctx2D } from "./buffer.js";

const STYLE_WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra-?light|ultra-?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi-?bold|demi-?bold/i, 600],
  [/extra-?bold|ultra-?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

/**
 * PSDs store PostScript names ("OpenSans-SemiBoldItalic"); browsers match CSS family names, so the
 * stack tries the exact PostScript name first, then the derived family with an inferred weight/style.
 * Diverges from server: SceneCompositor sets only the quoted PostScript name with no fallback family.
 */
export function cssFont(run: Pick<TextRun, "fontName" | "bold" | "italic">, sizePx: number): string {
  const { stack, stylePart } = fontFamilies(run.fontName);
  const weight = run.bold ? 700 : (STYLE_WEIGHTS.find(([re]) => re.test(stylePart))?.[1] ?? 400);
  const italic = run.italic || /italic|oblique/i.test(stylePart);
  return `${italic ? "italic " : ""}${weight} ${sizePx}px ${stack}, sans-serif`;
}

function fontFamilies(fontName: string): { stack: string; stylePart: string } {
  const postScript = fontName.replace(/["\\]/g, "");
  const [familyPart = postScript, stylePart = ""] = postScript.split("-", 2);
  const family = familyPart.replace(/([a-z])([A-Z])/g, "$1 $2");
  return { stack: family === postScript ? `"${postScript}"` : `"${postScript}", "${family}"`, stylePart };
}

const PROBE_TEXT = "mmmmmmmmmmlli1WQ@#";

/**
 * Whether this environment has the font cssFont asks for, i.e. whether text in it renders in the
 * real face rather than the generic fallback: a missing family measures exactly like the generic.
 */
export function isFontAvailable(ctx: Ctx2D, fontName: string): boolean {
  const { stack } = fontFamilies(fontName);
  ctx.save();
  try {
    return ["monospace", "serif"].some((generic) => {
      ctx.font = `72px ${generic}`;
      const fallback = ctx.measureText(PROBE_TEXT).width;
      ctx.font = `72px ${stack}, ${generic}`;
      return ctx.measureText(PROBE_TEXT).width !== fallback;
    });
  } finally {
    ctx.restore();
  }
}

/** Sets ctx to draw a run at its local font size. Diverges from server: SceneCompositor ignores tracking; PSD tracking is in 1/1000 em. */
export function setRunFont(ctx: Ctx2D, run: TextRun): void {
  ctx.font = cssFont(run, run.fontSize);
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${((run.tracking ?? 0) / 1000) * run.fontSize}px`;
}

/** Measures runs as paintText draws them; leaves ctx's font set, so callers save and restore around it. */
export function textMeasure(ctx: Ctx2D): TextMeasure {
  return {
    width(text, run) {
      setRunFont(ctx, run);
      return ctx.measureText(text).width;
    },
    capHeight(run) {
      setRunFont(ctx, run);
      return ctx.measureText("H").actualBoundingBoxAscent;
    },
  };
}

export function rgbaToCss({ r, g, b, a }: Rgba): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${a})`;
}
