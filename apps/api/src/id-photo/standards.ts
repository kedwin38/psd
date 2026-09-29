import type { IdPhotoStandard } from "../generated/prisma";

/**
 * Passport/ID photo geometry, as documented by the issuing authorities' own published guidance
 * (US Dept. of State photo requirements; ICAO Doc 9303 portrait guidance used by most biometric
 * passports). These are the same public specs any photo booth or online tool targets — not a
 * substitute for your issuing authority's current rules, which can change. Always confirm before
 * you submit.
 */
export interface StandardSpec {
  label: string;
  /** Final output pixel size, at the standard's usual print resolution. */
  outputWidthPx: number;
  outputHeightPx: number;
  /** Acceptable head height (crown of head to chin) as a fraction of the output's height. */
  headHeightFrac: { min: number; max: number };
  /** Acceptable eye-line position, as a fraction of the output's height measured from the TOP. */
  eyeLineFrac: { min: number; max: number };
  /** Background the photo must show once corrected. */
  background: { label: string; rgb: [number, number, number] };
}

export const STANDARDS: Record<IdPhotoStandard, StandardSpec> = {
  // US passport/visa: 2x2in at 300dpi = 600x600px. Head height 1in-1 3/8in of 2in (50%-69%);
  // eye height 1 1/8in-1 3/8in from the BOTTOM of the photo (56.25%-68.75%), i.e. from the top
  // that's (1 - 0.6875) to (1 - 0.5625) = 31.25%-43.75%.
  US_PASSPORT: {
    label: "US Passport / Visa",
    outputWidthPx: 600,
    outputHeightPx: 600,
    headHeightFrac: { min: 0.5, max: 0.69 },
    eyeLineFrac: { min: 0.3125, max: 0.4375 },
    background: { label: "plain white", rgb: [255, 255, 255] },
  },
  // ICAO/biometric (Doc 9303): 35mm x 45mm at 300dpi ≈ 413x531px. Head height (chin to crown)
  // 70%-80% of photo height; eye line 42%-55% from the top of the photo, per common national
  // guidance built on the ICAO spec (e.g. UK/EU passport tools).
  ICAO: {
    label: "ICAO / Biometric",
    outputWidthPx: 413,
    outputHeightPx: 531,
    headHeightFrac: { min: 0.7, max: 0.8 },
    eyeLineFrac: { min: 0.42, max: 0.55 },
    background: { label: "plain light grey", rgb: [235, 235, 235] },
  },
};

export function standardSpec(standard: IdPhotoStandard): StandardSpec {
  return STANDARDS[standard];
}
