import sharp from "sharp";
import type { FaceDetectorService, DetectedFace } from "./face-detector";

/** Below this tilt, leveling isn't worth the extra detection pass — a level-enough photo stays untouched. */
const ROLL_THRESHOLD_DEGREES = 1.5;

export interface LeveledPhoto {
  /** Upright PNG bytes, rotated level if the source had a detectable head tilt. */
  png: Buffer;
  face: DetectedFace;
  rolledDegrees: number;
}

/**
 * Detects the face, measures head tilt (roll) from the eye line, and — if it's enough to matter —
 * rotates the whole photo level and re-detects on the rotated result, so every downstream
 * measurement (crop, eye-line, head-height) is against a face that's actually upright. A crop alone
 * can't fix a tilted head; ID photos require a level, forward-facing pose.
 */
export async function detectLeveledFace(uprightSource: Buffer, detector: FaceDetectorService): Promise<LeveledPhoto> {
  const first = await detectOn(uprightSource, detector);
  const rollDegrees = rollAngleDegrees(first);

  if (Math.abs(rollDegrees) < ROLL_THRESHOLD_DEGREES) {
    return { png: uprightSource, face: first, rolledDegrees: 0 };
  }

  const rotated = await sharp(uprightSource)
    .rotate(-rollDegrees, { background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
  const releveled = await detectOn(rotated, detector);
  return { png: rotated, face: releveled, rolledDegrees: -rollDegrees };
}

function rollAngleDegrees(face: DetectedFace): number {
  const dy = face.rightEye.y - face.leftEye.y;
  const dx = face.rightEye.x - face.leftEye.x;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

async function detectOn(png: Buffer, detector: FaceDetectorService): Promise<DetectedFace> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return detector.detect(data, info.width, info.height);
}
