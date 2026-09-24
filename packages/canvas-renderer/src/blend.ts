import type { BlendMode } from "@psd-studio/scene-graph";

// PSD-only modes were already approximated (and warned about) at ingestion by psd-engine's blendMode.ts;
// scene-graph modes are Canvas2D names, so this table is 1:1 and exists to keep that contract type-checked.
export const COMPOSITE_OPERATION: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};
