import sharp, { type Sharp } from "sharp";
import type { IdPhotoStandard } from "../generated/prisma";
import type { DetectedFace } from "./face-detector";
import { standardSpec, type StandardSpec } from "./standards";

export interface ComplianceCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface ComplianceReport {
  standard: IdPhotoStandard;
  outputWidthPx: number;
  outputHeightPx: number;
  overallPass: boolean;
  checks: ComplianceCheck[];
  faceConfidence: number;
}

export interface ProcessResult {
  png: Buffer;
  report: ComplianceReport;
}

/** Fraction of an image's shorter edge sampled from each corner to estimate the background color. */
const CORNER_SAMPLE_FRAC = 0.08;
/** A corner region counts as "uniform" (safe to flatten) when its color std-dev is under this, per channel (0-255). */
const BACKGROUND_UNIFORMITY_THRESHOLD = 18;
/** How far (Euclidean, 0-255 scale) a pixel's color can be from the sampled background color and still count as background. */
const BACKGROUND_MATCH_DISTANCE = 32;
/** Percentile clip for the exposure/contrast stretch, applied per channel. */
const EXPOSURE_CLIP_PERCENTILE = 1;

/**
 * Turns an uploaded photo into a standard-compliant ID photo: auto white balance, auto exposure,
 * background flattening when the existing background is plain enough to do safely, and a precise
 * face-landmark-driven crop to the standard's head-size and eye-line targets. Deliberately never
 * touches the face itself (no smoothing, no retouching) — an ID photo has to show the subject's
 * true, unaltered appearance, and issuing authorities reject photos that don't.
 */
export async function processIdPhoto(sourceBuffer: Buffer, standard: IdPhotoStandard, face: DetectedFace, leveledDegrees = 0): Promise<ProcessResult> {
  const spec = standardSpec(standard);
  const image = sharp(sourceBuffer).rotate(); // auto-orients from EXIF before anything else measures pixels
  const meta = await image.metadata();
  const sourceWidth = meta.width!;
  const sourceHeight = meta.height!;

  const crop = computeCrop(face, spec, sourceWidth, sourceHeight);
  const background = await sampleBackgroundColor(image.clone(), sourceWidth, sourceHeight, face);

  let pipeline = image
    .clone()
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(spec.outputWidthPx, spec.outputHeightPx, { fit: "fill", kernel: "lanczos3" });

  pipeline = await applyWhiteBalance(pipeline);
  pipeline = applyExposureNormalization(pipeline);
  if (background.uniform) {
    pipeline = await flattenBackground(pipeline, background.rgb, spec.background.rgb, spec.outputWidthPx, spec.outputHeightPx, face, crop);
  }

  const png = await pipeline.png({ quality: 100 }).toBuffer();
  const report = await buildComplianceReport(png, standard, spec, face, crop, background.uniform, leveledDegrees);

  return { png, report };
}

interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Solves for the crop rectangle that places the detected head at the standard's target head-height
 * fraction and the eye line at its target fraction, centered horizontally on the face. Clamped to
 * the source image's bounds — a photo too tightly cropped to reach the target framing gets the
 * closest crop possible, and the compliance report will say so rather than silently failing.
 */
function computeCrop(face: DetectedFace, spec: StandardSpec, sourceWidth: number, sourceHeight: number): CropRect {
  const targetHeadFrac = (spec.headHeightFrac.min + spec.headHeightFrac.max) / 2;
  const targetEyeFrac = (spec.eyeLineFrac.min + spec.eyeLineFrac.max) / 2;
  const aspect = spec.outputWidthPx / spec.outputHeightPx;

  const headHeightPx = face.chin.y - face.crownY;
  let outHeight = headHeightPx / targetHeadFrac;
  let outWidth = outHeight * aspect;

  // Never ask for more than the source actually has.
  outHeight = Math.min(outHeight, sourceHeight);
  outWidth = Math.min(outWidth, sourceWidth, outHeight * aspect);
  outHeight = outWidth / aspect;

  let top = face.eyeCenter.y - outHeight * targetEyeFrac;
  let left = face.eyeCenter.x - outWidth / 2;

  top = Math.max(0, Math.min(top, sourceHeight - outHeight));
  left = Math.max(0, Math.min(left, sourceWidth - outWidth));

  return { left: Math.round(left), top: Math.round(top), width: Math.round(outWidth), height: Math.round(outHeight) };
}

async function sampleBackgroundColor(
  image: Sharp,
  width: number,
  height: number,
  face: DetectedFace,
): Promise<{ uniform: boolean; rgb: [number, number, number]; stdDev: number }> {
  const sampleW = Math.max(1, Math.round(width * CORNER_SAMPLE_FRAC));
  const sampleH = Math.max(1, Math.round(height * CORNER_SAMPLE_FRAC));
  const corners: CropRect[] = [
    { left: 0, top: 0, width: sampleW, height: sampleH },
    { left: width - sampleW, top: 0, width: sampleW, height: sampleH },
    { left: 0, top: height - sampleH, width: sampleW, height: sampleH },
    { left: width - sampleW, top: height - sampleH, width: sampleW, height: sampleH },
  ].filter((c) => !overlapsFace(c, face));

  const samples: number[][] = [];
  for (const corner of corners) {
    const { data } = await image.clone().extract(corner).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 3) samples.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  if (samples.length === 0) return { uniform: false, rgb: [255, 255, 255], stdDev: Infinity };

  const mean: [number, number, number] = [0, 0, 0];
  for (const s of samples) for (let c = 0; c < 3; c++) mean[c]! += s[c]! / samples.length;
  let variance = 0;
  for (const s of samples) for (let c = 0; c < 3; c++) variance += (s[c]! - mean[c]!) ** 2 / (samples.length * 3);
  const stdDev = Math.sqrt(variance);

  return { uniform: stdDev < BACKGROUND_UNIFORMITY_THRESHOLD, rgb: mean, stdDev };
}

function overlapsFace(rect: CropRect, face: DetectedFace): boolean {
  const pad = face.box.width * 0.5;
  const fx0 = face.box.x - pad;
  const fx1 = face.box.x + face.box.width + pad;
  const fy0 = face.crownY - pad;
  const fy1 = face.chin.y + pad;
  return rect.left < fx1 && rect.left + rect.width > fx0 && rect.top < fy1 && rect.top + rect.height > fy0;
}

/** Gray-world auto white balance: scales each channel so its mean matches the average of all three. */
async function applyWhiteBalance(pipeline: Sharp): Promise<Sharp> {
  const stats = await pipeline.clone().stats();
  const means = stats.channels.slice(0, 3).map((c) => c.mean);
  const gray = (means[0]! + means[1]! + means[2]!) / 3;
  const gains = means.map((m) => clampGain(gray / Math.max(1, m)));
  return pipeline.linear(gains as [number, number, number], [0, 0, 0]);
}

function clampGain(gain: number): number {
  return Math.min(1.15, Math.max(0.87, gain));
}

/** Percentile-based contrast stretch — brightens/normalizes exposure without sharp's default per-channel clipping surprises. */
function applyExposureNormalization(pipeline: Sharp): Sharp {
  return pipeline.normalize({ lower: EXPOSURE_CLIP_PERCENTILE, upper: 100 - EXPOSURE_CLIP_PERCENTILE });
}

/**
 * Replaces a already-plain background with the standard's exact required color. Soft-edged: pixels
 * close to the sampled background color are blended toward the target color in proportion to how
 * close they are, so the transition at the subject's silhouette doesn't hard-clip. Only ever called
 * when sampleBackgroundColor found the existing background uniform enough to do this safely.
 */
async function flattenBackground(
  pipeline: Sharp,
  fromRgb: [number, number, number],
  toRgb: [number, number, number],
  width: number,
  height: number,
  face: DetectedFace,
  crop: CropRect,
): Promise<Sharp> {
  const { data } = await pipeline.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  // Face region in the CROPPED/RESIZED output's coordinate space — pixels here are never touched,
  // regardless of color distance, so the flatten can never eat into the subject.
  const scaleX = width / crop.width;
  const scaleY = height / crop.height;
  const pad = face.box.width * 0.3;
  const fx0 = (face.box.x - crop.left - pad) * scaleX;
  const fx1 = (face.box.x + face.box.width - crop.left + pad) * scaleX;
  const fy0 = (face.crownY - crop.top - pad) * scaleY;
  const fy1 = (face.chin.y - crop.top + pad) * scaleY;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) continue;
      const idx = (y * width + x) * 3;
      const r = out[idx]!, g = out[idx + 1]!, b = out[idx + 2]!;
      const dist = Math.sqrt((r - fromRgb[0]) ** 2 + (g - fromRgb[1]) ** 2 + (b - fromRgb[2]) ** 2);
      if (dist >= BACKGROUND_MATCH_DISTANCE) continue;
      const blend = 1 - dist / BACKGROUND_MATCH_DISTANCE;
      out[idx] = Math.round(r + (toRgb[0] - r) * blend);
      out[idx + 1] = Math.round(g + (toRgb[1] - g) * blend);
      out[idx + 2] = Math.round(b + (toRgb[2] - b) * blend);
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } });
}

async function buildComplianceReport(
  png: Buffer,
  standard: IdPhotoStandard,
  spec: StandardSpec,
  face: DetectedFace,
  crop: CropRect,
  backgroundWasUniform: boolean,
  leveledDegrees: number,
): Promise<ComplianceReport> {
  // Re-measure geometry against the FINAL output: the eye/head positions scale exactly with the
  // crop-to-output resize, so this reports what the file actually shows, not just what we aimed for.
  const scaleY = spec.outputHeightPx / crop.height;
  const headHeightPx = (face.chin.y - face.crownY) * scaleY;
  const headHeightFrac = headHeightPx / spec.outputHeightPx;
  const eyeLineFrac = ((face.eyeCenter.y - crop.top) * scaleY) / spec.outputHeightPx;

  const stats = await sharp(png).stats();
  const brightness = stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;

  const checks: ComplianceCheck[] = [
    inRange("Head size", headHeightFrac, spec.headHeightFrac, (f) => `${Math.round(f * 100)}% of photo height`),
    inRange("Eye position", eyeLineFrac, spec.eyeLineFrac, (f) => `${Math.round(f * 100)}% down from the top`),
    {
      label: "Background",
      pass: backgroundWasUniform,
      detail: backgroundWasUniform
        ? `Flattened to ${spec.background.label}.`
        : `Your original background wasn't uniform enough to safely correct automatically — retake against a ${spec.background.label} backdrop for the best result.`,
    },
    {
      label: "Head pose",
      pass: Math.abs(leveledDegrees) < 15,
      detail:
        Math.abs(leveledDegrees) < 1
          ? "Head was level."
          : Math.abs(leveledDegrees) < 15
            ? `Auto-leveled ${Math.abs(leveledDegrees).toFixed(1)}° of head tilt.`
            : `Your head was tilted ${Math.abs(leveledDegrees).toFixed(1)}° — too far to correct reliably. Retake facing the camera directly, with your head level.`,
    },
    {
      label: "Brightness",
      pass: brightness > 60 && brightness < 235,
      detail: brightness <= 60 ? "The photo is too dark even after correction." : brightness >= 235 ? "The photo is overexposed even after correction." : "Within a normal exposure range.",
    },
    {
      label: "Resolution",
      pass: true,
      detail: `${spec.outputWidthPx}×${spec.outputHeightPx}px, matching the standard's print size.`,
    },
  ];

  return {
    standard,
    outputWidthPx: spec.outputWidthPx,
    outputHeightPx: spec.outputHeightPx,
    overallPass: checks.every((c) => c.pass),
    checks,
    faceConfidence: face.confidence,
  };
}

function inRange(label: string, value: number, range: { min: number; max: number }, describe: (v: number) => string): ComplianceCheck {
  const pass = value >= range.min && value <= range.max;
  return {
    label,
    pass,
    detail: pass
      ? `${describe(value)} — within the required ${Math.round(range.min * 100)}–${Math.round(range.max * 100)}% range.`
      : `${describe(value)} — outside the required ${Math.round(range.min * 100)}–${Math.round(range.max * 100)}% range.`,
  };
}
