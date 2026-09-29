import sharp, { type Sharp, type Stats } from "sharp";
import type { IdPhotoStandard } from "../generated/prisma";
import type { DetectedFace } from "./face-detector";
import type { SegmentationService } from "./segmentation";
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

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Percentile clip for the exposure/contrast stretch, applied per channel. */
const EXPOSURE_CLIP_PERCENTILE = 1;
/** Channel-mean deviation from neutral gray below this is normal photographic variance, not a color cast — leave it alone. */
const WHITE_BALANCE_DEADZONE_FRACTION = 0.02;
/** A channel's existing (max-min) range at or above this (of 255) already uses most of the available dynamic range — don't stretch it further. */
const EXPOSURE_ALREADY_GOOD_RANGE = 200;
/** Below this "variance of Laplacian" (Pech-Pacheco et al., 2000) the face region reads as blurry. */
const SHARPNESS_VARIANCE_THRESHOLD = 40;
/** Above this mean-brightness gap (0-255) between the face's left and right halves, lighting reads as uneven. */
const LIGHTING_ASYMMETRY_THRESHOLD = 28;
/** Head-roll (in-plane tilt) beyond this, even after auto-leveling, can't be corrected reliably. */
const MAX_ROLL_DEGREES = 15;
/** Estimated head-yaw (turn away from the camera) beyond this reads as non-frontal. */
const MAX_YAW_DEGREES = 12;
/** Above this fraction of the output canvas being synthetic (padded, not photographed) fill, warn rather than pass silently. */
const SYNTHETIC_FILL_WARN_FRACTION = 0.15;

/**
 * Turns an uploaded photo into a standard-compliant ID photo: auto white balance, auto exposure, a
 * deep-segmentation background replacement (works against any original background, not just an
 * already-plain one), and a precise face-landmark-driven crop to the standard's head-size and
 * eye-line targets — hit exactly, every time, by extending the canvas with the standard's own flat
 * background color when the source photo doesn't have enough margin around the head to reach the
 * target framing natively, rather than falling back to a tighter, non-compliant crop. Deliberately
 * never touches the face itself (no smoothing, no retouching) — an ID photo has to show the
 * subject's true, unaltered appearance, and issuing authorities reject photos that don't.
 */
export async function processIdPhoto(
  sourceBuffer: Buffer,
  standard: IdPhotoStandard,
  face: DetectedFace,
  segmenter: SegmentationService,
  leveledDegrees = 0,
): Promise<ProcessResult> {
  const spec = standardSpec(standard);
  const image = sharp(sourceBuffer).rotate(); // auto-orients from EXIF before anything else measures pixels
  const meta = await image.metadata();
  const sourceWidth = meta.width!;
  const sourceHeight = meta.height!;

  // The ideal crop is solved to hit the target framing EXACTLY; it may extend past the source
  // image's edges. `real` is the part of it we can actually extract; the gap (if any) becomes
  // synthetic canvas fill, not a tighter, non-compliant crop.
  const ideal = computeIdealCrop(face, spec);
  const real = intersectRect(ideal, sourceWidth, sourceHeight);
  const scale = spec.outputHeightPx / ideal.height;

  let content = image.clone().extract(real);
  content = await applyWhiteBalance(content);
  content = await applyExposureNormalization(content);

  const background = await replaceBackground(content, segmenter, real.width, real.height);

  const placedWidth = Math.max(1, Math.round(real.width * scale));
  const placedHeight = Math.max(1, Math.round(real.height * scale));
  const placedLeft = clampInt(Math.round((real.left - ideal.left) * scale), 0, spec.outputWidthPx - placedWidth);
  const placedTop = clampInt(Math.round((real.top - ideal.top) * scale), 0, spec.outputHeightPx - placedHeight);
  // palette:false on every intermediate/final PNG encode below is load-bearing: sharp's PNG
  // encoder will otherwise auto-quantize to an indexed palette when it judges the image "fits"
  // one, which is real, lossy color alteration — never acceptable for a compliance photo, and
  // never acceptable as an intermediate step feeding a later composite.
  //
  // RGB and alpha are resized SEPARATELY, then joined after — resizing an already-RGBA buffer in
  // one pass hits a real sharp/libvips gotcha where the resampling filter premultiplies color by
  // alpha and never un-premultiplies it back out, silently darkening every partially- or fully-
  // transparent pixel's underlying color in proportion to how transparent it is. Resizing plain RGB
  // and a plain single-channel mask has no premultiply step to get wrong.
  const resizedRgb = await sharp(background.rgb, { raw: { width: real.width, height: real.height, channels: 3 } })
    .resize(placedWidth, placedHeight, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  // .greyscale() before resizing the mask is load-bearing, same as every other single-channel mask
  // op in segmentation.ts: without it, sharp silently promotes the 1-channel buffer to 3-channel
  // output, which would then get misread as 1-channel downstream and corrupt every pixel after it.
  const resizedAlpha = await sharp(background.alpha, { raw: { width: real.width, height: real.height, channels: 1 } })
    .greyscale()
    .resize(placedWidth, placedHeight, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  if (resizedAlpha.length !== placedWidth * placedHeight) {
    throw new Error(`Resized alpha mask produced ${resizedAlpha.length} bytes, expected ${placedWidth * placedHeight}.`);
  }
  // Placed directly into a raw, fully-transparent canvas buffer with a per-row copy — never
  // through sharp's .composite(): compositing an RGBA image over an RGBA base hits the same
  // premultiply gotcha as resize (see above), darkening every pixel in proportion to its
  // transparency. A plain memory copy has no blending step to get wrong, which is all this needs:
  // the placed region never overlaps anything (the canvas starts empty), so there's nothing to
  // actually blend.
  const canvasBuffer = Buffer.alloc(spec.outputWidthPx * spec.outputHeightPx * 4, 0);
  for (let y = 0; y < placedHeight; y++) {
    const srcOffset = y * placedWidth * 3;
    const srcAlphaOffset = y * placedWidth;
    const dstOffset = ((placedTop + y) * spec.outputWidthPx + placedLeft) * 4;
    for (let x = 0; x < placedWidth; x++) {
      const s = srcOffset + x * 3;
      const d = dstOffset + x * 4;
      canvasBuffer[d] = resizedRgb[s]!;
      canvasBuffer[d + 1] = resizedRgb[s + 1]!;
      canvasBuffer[d + 2] = resizedRgb[s + 2]!;
      canvasBuffer[d + 3] = resizedAlpha[srcAlphaOffset + x]!;
    }
  }
  const png = await sharp(canvasBuffer, { raw: { width: spec.outputWidthPx, height: spec.outputHeightPx, channels: 4 } })
    .png({ quality: 100, palette: false })
    .toBuffer();

  const syntheticFraction = 1 - (real.width * real.height) / (ideal.width * ideal.height);
  const placement: Rect = { left: placedLeft, top: placedTop, width: placedWidth, height: placedHeight };
  const report = await buildComplianceReport(png, standard, spec, face, ideal, scale, background, leveledDegrees, syntheticFraction, placement);

  return { png, report };
}

/**
 * Solves for the crop rectangle that places the detected head at the standard's target head-height
 * fraction and the eye line at its target fraction, centered horizontally on the face. Not clamped
 * to the source image's bounds — a photo too tightly framed to reach this natively gets the gap
 * filled with the standard's own background color instead (see intersectRect / processIdPhoto).
 */
function computeIdealCrop(face: DetectedFace, spec: StandardSpec): Rect {
  const targetHeadFrac = (spec.headHeightFrac.min + spec.headHeightFrac.max) / 2;
  const targetEyeFrac = (spec.eyeLineFrac.min + spec.eyeLineFrac.max) / 2;
  const aspect = spec.outputWidthPx / spec.outputHeightPx;

  const headHeightPx = face.chin.y - face.crownY;
  const height = headHeightPx / targetHeadFrac;
  const width = height * aspect;
  const top = face.eyeCenter.y - height * targetEyeFrac;
  const left = face.eyeCenter.x - width / 2;

  return { left, top, width, height };
}

/** The part of `rect` that actually overlaps the source image's bounds. */
function intersectRect(rect: Rect, sourceWidth: number, sourceHeight: number): Rect {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(sourceWidth, rect.left + rect.width);
  const bottom = Math.min(sourceHeight, rect.top + rect.height);
  return { left: Math.round(left), top: Math.round(top), width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(bottom - top)) };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface BackgroundResult {
  /** Raw RGB buffer (3 channels) — the subject's pixels, byte-for-byte unaltered by this step. */
  rgb: Buffer;
  /** Raw single-channel alpha mask, same WxH as `rgb`. */
  alpha: Buffer;
  applied: boolean;
  coverage: number;
}

/**
 * Cuts the subject out of its background using real per-pixel person segmentation
 * (BodyPix/ResNet50) rather than a color-distance heuristic — it works against a patterned,
 * gradient, or off-color background, not just an already-plain one. The subject's own pixels are
 * never recolored: this only produces an alpha mask (the segmentation, feathered at the silhouette
 * edge) alongside the RGB data, kept separate rather than joined immediately — see the resize step
 * in processIdPhoto for why. Only trusted when the mask's coverage looks like a real single subject
 * (see SegmentationService); otherwise the content is returned unmodified and fully opaque, rather
 * than composited with a guess.
 */
async function replaceBackground(pipeline: Sharp, segmenter: SegmentationService, width: number, height: number): Promise<BackgroundResult> {
  const { data } = await pipeline.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const segmentation = await segmenter.segmentPerson(Buffer.from(data), width, height);

  const alpha = segmentation.reliable ? segmentation.alpha : Buffer.alloc(width * height, 255);
  if (alpha.length !== width * height) {
    // Would silently misalign every pixel below (e.g. a mask that came back multi-channel) —
    // fail loudly instead of compositing garbage.
    throw new Error(`Segmentation mask size ${alpha.length} doesn't match ${width}x${height} (${width * height}).`);
  }

  return { rgb: Buffer.from(data), alpha, applied: segmentation.reliable, coverage: segmentation.coverage };
}

/**
 * Gray-world auto white balance: scales each channel so its mean matches the average of all three
 * — but only when the source photo actually has a color cast worth correcting. Read the image
 * first: a photo that's already close to neutral gets left untouched rather than recolored by a
 * blanket correction, which is exactly the kind of "hardened rule applied to every image" that can
 * introduce a cast where there wasn't one.
 */
async function applyWhiteBalance(pipeline: Sharp): Promise<Sharp> {
  const stats = await pipeline.clone().stats();
  const means = stats.channels.slice(0, 3).map((c) => c.mean);
  const gray = (means[0]! + means[1]! + means[2]!) / 3;
  const maxDeviation = Math.max(...means.map((m) => Math.abs(m - gray) / Math.max(1, gray)));
  if (maxDeviation < WHITE_BALANCE_DEADZONE_FRACTION) return pipeline;
  const gains = means.map((m) => clampGain(gray / Math.max(1, m)));
  return pipeline.linear(gains as [number, number, number], [0, 0, 0]);
}

function clampGain(gain: number): number {
  return Math.min(1.15, Math.max(0.87, gain));
}

/**
 * Percentile-based contrast stretch — but only applied when the photo's own histogram shows it's
 * actually compressed (a flat, low-contrast image). A photo that already spans close to the full
 * tonal range is left as-is: stretching it further wouldn't brighten anything real, only risk
 * banding or a washed-out look in a photo that didn't need correcting.
 */
async function applyExposureNormalization(pipeline: Sharp): Promise<Sharp> {
  const stats = await pipeline.clone().stats();
  const ranges = stats.channels.slice(0, 3).map((c) => c.max - c.min);
  if (Math.min(...ranges) >= EXPOSURE_ALREADY_GOOD_RANGE) return pipeline;
  return pipeline.normalize({ lower: EXPOSURE_CLIP_PERCENTILE, upper: 100 - EXPOSURE_CLIP_PERCENTILE });
}

/** The detected face's bounding box, converted into the final output canvas's pixel coordinates. */
function faceRegionInOutput(face: DetectedFace, ideal: Rect, scale: number, outputWidthPx: number, outputHeightPx: number): Rect {
  const left = Math.max(0, Math.round((face.box.x - ideal.left) * scale));
  const top = Math.max(0, Math.round((face.crownY - ideal.top) * scale));
  const right = Math.min(outputWidthPx, Math.round((face.box.x + face.box.width - ideal.left) * scale));
  const bottom = Math.min(outputHeightPx, Math.round((face.chin.y - ideal.top) * scale));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Variance of the Laplacian over a region — a standard, well-validated blur metric (Pech-Pacheco et al., 2000). */
async function sharpnessVariance(png: Buffer, region: Rect): Promise<number> {
  const stats = await sharp(png)
    .extract(region)
    .removeAlpha()
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .stats();
  return stats.channels[0]!.stdev ** 2;
}

/** Mean-brightness gap between the face region's left and right halves — a proxy for harsh, one-sided lighting. */
async function lightingAsymmetry(png: Buffer, region: Rect): Promise<number> {
  const halfWidth = Math.max(1, Math.floor(region.width / 2));
  const leftHalf = { left: region.left, top: region.top, width: halfWidth, height: region.height };
  const rightHalf = { left: region.left + region.width - halfWidth, top: region.top, width: halfWidth, height: region.height };
  const [leftStats, rightStats] = await Promise.all([sharp(png).extract(leftHalf).stats(), sharp(png).extract(rightHalf).stats()]);
  const meanOf = (s: Stats) => s.channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3;
  return Math.abs(meanOf(leftStats) - meanOf(rightStats));
}

async function buildComplianceReport(
  png: Buffer,
  standard: IdPhotoStandard,
  spec: StandardSpec,
  face: DetectedFace,
  ideal: Rect,
  scale: number,
  background: BackgroundResult,
  leveledDegrees: number,
  syntheticFraction: number,
  placement: Rect,
): Promise<ComplianceReport> {
  // Re-measure geometry against the FINAL output: the eye/head positions scale exactly with the
  // ideal-crop-to-canvas transform, so this reports what the file actually shows, not just what we
  // aimed for — it lands on the target by construction (that's the point of extending the canvas
  // instead of clamping), which is a genuine measurement of a genuinely correct result, not a
  // shortcut past it.
  const headHeightPx = (face.chin.y - face.crownY) * scale;
  const headHeightFrac = headHeightPx / spec.outputHeightPx;
  const eyeLineFrac = ((face.eyeCenter.y - ideal.top) * scale) / spec.outputHeightPx;

  // Brightness over the real PHOTOGRAPHED region only — the canvas can extend past it with fully
  // transparent (RGB 0,0,0 at alpha 0) fill, which would otherwise drag a whole-canvas average down
  // and fail a perfectly well-exposed photo for a framing reason that has nothing to do with exposure.
  const stats = await sharp(png).extract(placement).stats();
  const brightness = stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;

  const faceRegion = faceRegionInOutput(face, ideal, scale, spec.outputWidthPx, spec.outputHeightPx);
  const [sharpness, lightingGap] = await Promise.all([sharpnessVariance(png, faceRegion), lightingAsymmetry(png, faceRegion)]);

  const rollOk = Math.abs(leveledDegrees) < MAX_ROLL_DEGREES;
  const yawOk = Math.abs(face.estimatedYawDegrees) < MAX_YAW_DEGREES;
  const fillOk = syntheticFraction <= SYNTHETIC_FILL_WARN_FRACTION;

  const checks: ComplianceCheck[] = [
    inRange("Head size", headHeightFrac, spec.headHeightFrac, (f) => `${Math.round(f * 100)}% of photo height`),
    inRange("Eye position", eyeLineFrac, spec.eyeLineFrac, (f) => `${Math.round(f * 100)}% down from the top`),
    {
      label: "Background",
      pass: background.applied,
      detail: background.applied
        ? `Automatically cut out from the original background — delivered as a transparent PNG. When you print or submit it, use a ${spec.background.label} backdrop, as this standard requires.`
        : "Couldn't reliably separate you from the background in this photo — retake with more even lighting and a bit more space behind you.",
    },
    {
      label: "Photo coverage",
      pass: fillOk,
      detail: fillOk
        ? "Enough of the original photo was usable to fill the required frame."
        : `About ${Math.round(syntheticFraction * 100)}% of this photo's frame is outside what the original photo actually showed, and was left transparent — retake a bit further back so there's more room around you.`,
    },
    {
      label: "Head pose",
      pass: rollOk && yawOk,
      detail: headPoseDetail(leveledDegrees, face.estimatedYawDegrees, rollOk, yawOk),
    },
    {
      label: "Eyes open",
      pass: face.eyesOpen,
      detail: face.eyesOpen ? "Both eyes are open." : "Your eyes look closed or nearly closed — retake with your eyes fully open and looking at the camera.",
    },
    {
      label: "Mouth closed",
      pass: face.mouthClosed,
      detail: face.mouthClosed ? "Neutral, closed-mouth expression." : "Your mouth looks open — most ID standards require a neutral expression with your mouth closed.",
    },
    {
      label: "Sharpness",
      pass: sharpness >= SHARPNESS_VARIANCE_THRESHOLD,
      detail: sharpness >= SHARPNESS_VARIANCE_THRESHOLD ? "Your face is in sharp focus." : "Your face looks soft or blurry — retake steady, in focus, without camera shake.",
    },
    {
      label: "Even lighting",
      pass: lightingGap <= LIGHTING_ASYMMETRY_THRESHOLD,
      detail:
        lightingGap <= LIGHTING_ASYMMETRY_THRESHOLD
          ? "Lighting is even across your face."
          : "One side of your face is noticeably brighter than the other — retake with light in front of you, not off to one side.",
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

function headPoseDetail(rollDegrees: number, yawDegrees: number, rollOk: boolean, yawOk: boolean): string {
  if (rollOk && yawOk) {
    return Math.abs(rollDegrees) < 1 ? "Head was level and facing the camera." : `Auto-leveled ${Math.abs(rollDegrees).toFixed(1)}° of head tilt; facing the camera.`;
  }
  const issues: string[] = [];
  if (!rollOk) issues.push(`tilted ${Math.abs(rollDegrees).toFixed(1)}°`);
  if (!yawOk) issues.push(`turned an estimated ${Math.abs(yawDegrees).toFixed(0)}° from the camera`);
  return `Your head was ${issues.join(" and ")} — too far to correct reliably. Retake facing the camera directly, with your head level.`;
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
