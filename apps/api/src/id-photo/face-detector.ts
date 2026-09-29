import { Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import * as tf from "@tensorflow/tfjs-node";
import * as faceapi from "@vladmandic/face-api";
import { join } from "node:path";

// dist/id-photo/face-detector.js -> dist/models/face (see package.json's build script and Dockerfile,
// which both copy apps/api/models alongside src/generated into dist/).
const MODELS_DIR = join(__dirname, "..", "models", "face");
/**
 * SSD Mobilenet v1 is a full convolutional detector, not the tiny/real-time one: it costs more
 * compute per image but is meaningfully more accurate on the framing real uploads have (arbitrary
 * angle, distance, lighting) — the right trade for a one-shot async job where correctness matters
 * far more than latency.
 */
const DETECTOR_OPTIONS = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
/** Detection runs on a downscaled copy for speed; landmarks are rescaled back to source pixels. */
const DETECT_MAX_DIMENSION = 1200;
/** Eye Aspect Ratio (Soukupová & Čech, 2016) below this is treated as a closed/near-closed eye. */
const EAR_OPEN_THRESHOLD = 0.2;
/** Mouth Aspect Ratio (inner-lip gap / mouth width) above this is treated as visibly open. */
const MAR_CLOSED_THRESHOLD = 0.35;

export interface DetectedFace {
  /** Face bounding box in SOURCE image pixel coordinates. */
  box: { x: number; y: number; width: number; height: number };
  /** Average position of both eyes, in source pixel coordinates. */
  eyeCenter: { x: number; y: number };
  /** Per-eye centers, for measuring head tilt (roll) — leftEye is the subject's own left eye. */
  leftEye: { x: number; y: number };
  rightEye: { x: number; y: number };
  /** Chin tip (68-point landmark #8), in source pixel coordinates. */
  chin: { x: number; y: number };
  /** Estimated crown (top of head/hairline) y in source pixel coordinates — see estimateCrownY. */
  crownY: number;
  confidence: number;
  /** Average Eye Aspect Ratio across both eyes; below EAR_OPEN_THRESHOLD reads as closed. */
  eyeAspectRatio: number;
  eyesOpen: boolean;
  /** Inner-lip gap over mouth width; above MAR_CLOSED_THRESHOLD reads as visibly open. */
  mouthAspectRatio: number;
  mouthClosed: boolean;
  /**
   * Estimated head yaw (left/right turn), in degrees — positive means turned toward the subject's
   * right. Derived from landmark symmetry (eye-corner-to-nose-bridge distance ratio), not a measured
   * 3D angle: the 68-point model only ever sees a 2D projection, so this is a heuristic, same in
   * spirit as the crown-height estimate below.
   */
  estimatedYawDegrees: number;
}

let modelsLoaded: Promise<void> | null = null;

/** Loads the (small, vendored) SSD Mobilenet v1 detector and 68-point landmark models once per process. */
function ensureModelsLoaded(): Promise<void> {
  modelsLoaded ??= (async () => {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  })();
  return modelsLoaded;
}

/**
 * 68-point landmarks don't include the forehead/hairline (the model only sees jaw, brows, eyes,
 * nose, mouth), so "head height chin-to-crown" has to be estimated rather than measured directly.
 * We use the well-established portrait-photography approximation that the hairline sits roughly
 * as far above the eyebrows as the eyebrows sit above the chin's midpoint is from the eyebrows —
 * i.e. crown ≈ browY - (chinY - browY) * 0.6. This is an approximation, not a measurement; the
 * compliance report is honest that head-height is estimated.
 */
function estimateCrownY(browY: number, chinY: number): number {
  return browY - (chinY - browY) * 0.6;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Eye Aspect Ratio: (vertical gaps) / (2 * horizontal width), using dlib's canonical 6-point eye ordering. */
function eyeAspectRatio(eye: { x: number; y: number }[]): number {
  const vertical = dist(eye[1]!, eye[5]!) + dist(eye[2]!, eye[4]!);
  const horizontal = dist(eye[0]!, eye[3]!);
  return horizontal > 0 ? vertical / (2 * horizontal) : 0;
}

/** Mouth Aspect Ratio using the inner-lip ring (landmarks 60-67 of the 68-point mouth block). */
function mouthAspectRatio(mouth: { x: number; y: number }[]): number {
  const inner = mouth.slice(12); // getMouth() returns 20 points (outer 0-11, inner 12-19) = absolute 48-67
  const width = dist(inner[0]!, inner[4]!); // 60 -> 64
  const gap = dist(inner[2]!, inner[6]!); // 62 -> 66
  return width > 0 ? gap / width : 0;
}

/**
 * Heuristic yaw from landmark symmetry: how much closer the nose bridge sits to one eye than the
 * other, as a fraction of the sum of both distances, scaled to degrees. At 0 the face is frontal;
 * the scale factor (90) is a working approximation, not a calibrated camera model — good enough to
 * flag a meaningfully turned head, not to measure one precisely.
 */
function estimateYaw(leftEyeOuter: { x: number; y: number }, rightEyeOuter: { x: number; y: number }, noseBridge: { x: number; y: number }): number {
  const dLeft = dist(leftEyeOuter, noseBridge);
  const dRight = dist(rightEyeOuter, noseBridge);
  const sum = dLeft + dRight;
  if (sum === 0) return 0;
  const asymmetry = (dRight - dLeft) / sum;
  return asymmetry * 90;
}

@Injectable()
export class FaceDetectorService {
  private readonly logger = new Logger(FaceDetectorService.name);

  /** Detects the single primary face in an RGB (no alpha) raw buffer. Throws if none/too many are found. */
  async detect(rgb: Buffer, width: number, height: number): Promise<DetectedFace> {
    await ensureModelsLoaded();

    const scale = Math.min(1, DETECT_MAX_DIMENSION / Math.max(width, height));
    const detectBuffer = scale < 1 ? await downscale(rgb, width, height, scale) : { data: rgb, width, height };

    const tensor = tf.tensor3d(new Uint8Array(detectBuffer.data), [detectBuffer.height, detectBuffer.width, 3], "int32");
    let results;
    try {
      results = await faceapi.detectAllFaces(tensor, DETECTOR_OPTIONS).withFaceLandmarks();
    } finally {
      tensor.dispose();
    }

    if (results.length === 0) {
      throw new UnprocessableEntityException("No face was found in this photo. Use a clear, front-facing photo with your face fully visible.");
    }
    if (results.length > 1) {
      throw new UnprocessableEntityException(
        `Found ${results.length} faces in this photo. An ID photo must show only you — upload a photo with just yourself in frame.`,
      );
    }
    const result = results[0]!;

    const inv = 1 / (scale < 1 ? scale : 1);
    const box = result.detection.box;
    const landmarks = result.landmarks;
    const centerOf = (points: { x: number; y: number }[]) => ({
      x: (points.reduce((s, p) => s + p.x, 0) / points.length) * inv,
      y: (points.reduce((s, p) => s + p.y, 0) / points.length) * inv,
    });
    const leftEyePoints = landmarks.getLeftEye();
    const rightEyePoints = landmarks.getRightEye();
    const leftEye = centerOf(leftEyePoints);
    const rightEye = centerOf(rightEyePoints);
    const eyeCenter = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
    const chinPoint = landmarks.getJawOutline()[8]!;
    const chin = { x: chinPoint.x * inv, y: chinPoint.y * inv };
    const browPoints = [...landmarks.getLeftEyeBrow(), ...landmarks.getRightEyeBrow()];
    const browY = (browPoints.reduce((s, p) => s + p.y, 0) / browPoints.length) * inv;

    const ear = (eyeAspectRatio(leftEyePoints) + eyeAspectRatio(rightEyePoints)) / 2;
    const mar = mouthAspectRatio(landmarks.getMouth());
    const noseBridge = landmarks.getNose()[3]!; // lowest point of the nose bridge, just above the nostrils
    const yaw = estimateYaw(leftEyePoints[0]!, rightEyePoints[3]!, noseBridge);

    this.logger.debug(`Face detected at score ${result.detection.score.toFixed(2)}, EAR ${ear.toFixed(2)}, MAR ${mar.toFixed(2)}, yaw~${yaw.toFixed(1)}°`);

    return {
      box: { x: box.x * inv, y: box.y * inv, width: box.width * inv, height: box.height * inv },
      eyeCenter,
      leftEye,
      rightEye,
      chin,
      crownY: estimateCrownY(browY, chin.y),
      confidence: result.detection.score,
      eyeAspectRatio: ear,
      eyesOpen: ear >= EAR_OPEN_THRESHOLD,
      mouthAspectRatio: mar,
      mouthClosed: mar <= MAR_CLOSED_THRESHOLD,
      estimatedYawDegrees: yaw,
    };
  }
}

async function downscale(rgb: Buffer, width: number, height: number, scale: number): Promise<{ data: Buffer; width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const data = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(targetWidth, targetHeight).raw().toBuffer();
  return { data, width: targetWidth, height: targetHeight };
}
