import type { BlendMode as AgBlendMode } from "ag-psd";
import type { BlendMode } from "@psd-studio/scene-graph";

/**
 * PSD defines more blend modes than the HTML5 Canvas 2D compositing spec
 * covers. Where there's no exact match we pick the visually nearest
 * supported mode rather than silently rendering "normal" — this is a
 * documented, deliberate fidelity limit (spec §7 "Honest scope limits"),
 * not a bug. `exact: false` entries should show a reduced-fidelity warning
 * to the template author during ingestion.
 */
export interface BlendModeMapping {
  mode: BlendMode;
  exact: boolean;
}

const MAP: Record<AgBlendMode, BlendModeMapping> = {
  normal: { mode: "normal", exact: true },
  dissolve: { mode: "normal", exact: false },
  darken: { mode: "darken", exact: true },
  multiply: { mode: "multiply", exact: true },
  "color burn": { mode: "color-burn", exact: true },
  "linear burn": { mode: "multiply", exact: false },
  "darker color": { mode: "darken", exact: false },
  lighten: { mode: "lighten", exact: true },
  screen: { mode: "screen", exact: true },
  "color dodge": { mode: "color-dodge", exact: true },
  "linear dodge": { mode: "screen", exact: false },
  "lighter color": { mode: "lighten", exact: false },
  overlay: { mode: "overlay", exact: true },
  "soft light": { mode: "soft-light", exact: true },
  "hard light": { mode: "hard-light", exact: true },
  "vivid light": { mode: "hard-light", exact: false },
  "linear light": { mode: "hard-light", exact: false },
  "pin light": { mode: "hard-light", exact: false },
  "hard mix": { mode: "hard-light", exact: false },
  difference: { mode: "difference", exact: true },
  exclusion: { mode: "exclusion", exact: true },
  subtract: { mode: "difference", exact: false },
  divide: { mode: "normal", exact: false },
  hue: { mode: "hue", exact: true },
  saturation: { mode: "saturation", exact: true },
  color: { mode: "color", exact: true },
  luminosity: { mode: "luminosity", exact: true },
  "linear height": { mode: "normal", exact: false },
  height: { mode: "normal", exact: false },
  subtraction: { mode: "normal", exact: false },
  "pass through": { mode: "normal", exact: true },
};

export function mapBlendMode(agMode: AgBlendMode | undefined): BlendModeMapping {
  if (!agMode) return { mode: "normal", exact: true };
  return MAP[agMode] ?? { mode: "normal", exact: false };
}
