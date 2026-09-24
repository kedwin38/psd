import type { Rgba, TextRun } from "@psd-studio/scene-graph";

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
  const postScript = run.fontName.replace(/["\\]/g, "");
  const [familyPart = postScript, stylePart = ""] = postScript.split("-", 2);
  const family = familyPart.replace(/([a-z])([A-Z])/g, "$1 $2");
  const weight = run.bold ? 700 : (STYLE_WEIGHTS.find(([re]) => re.test(stylePart))?.[1] ?? 400);
  const italic = run.italic || /italic|oblique/i.test(stylePart);
  const stack = family === postScript ? `"${postScript}"` : `"${postScript}", "${family}"`;
  return `${italic ? "italic " : ""}${weight} ${sizePx}px ${stack}, sans-serif`;
}

export function rgbaToCss({ r, g, b, a }: Rgba): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${a})`;
}
