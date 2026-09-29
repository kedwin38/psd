import { Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import * as tf from "@tensorflow/tfjs-node";
import * as faceapi from "@vladmandic/face-api";
import { join } from "node:path";

// dist/id-photo/face-detector.js -> dist/models/face (see package.json's build script and Dockerfile,
// which both copy apps/api/models alongside src/generated into dist/).
const MODELS_DIR = join(__dirname, "..", "models", "face");
const DETECTOR_OPTIONS = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });
/** Detection runs on a downscaled copy for speed; landmarks are rescaled back to source pixels. */
const DETECT_MAX_DIMENSION = 800;

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
}

let modelsLoaded: Promise<void> | null = null;

/** Loads the (small, vendored) tiny-face-detector and 68-point landmark models once per process. */
function ensureModelsLoaded(): Promise<void> {
  modelsLoaded ??= (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
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

@Injectable()
export class FaceDetectorService {
  private readonly logger = new Logger(FaceDetectorService.name);

  /** Detects the single primary face in an RGB (no alpha) raw buffer. Throws if none/too many are found. */
  async detect(rgb: Buffer, width: number, height: number): Promise<DetectedFace> {
    await ensureModelsLoaded();

    const scale = Math.min(1, DETECT_MAX_DIMENSION / Math.max(width, height));
    const detectBuffer = scale < 1 ? await downscale(rgb, width, height, scale) : { data: rgb, width, height };

    const tensor = tf.tensor3d(new Uint8Array(detectBuffer.data), [detectBuffer.height, detectBuffer.width, 3], "int32");
    let result;
    try {
      result = await faceapi.detectSingleFace(tensor, DETECTOR_OPTIONS).withFaceLandmarks();
    } finally {
      tensor.dispose();
    }

    if (!result) {
      throw new UnprocessableEntityException("No face was found in this photo. Use a clear, front-facing photo with your face fully visible.");
    }

    const inv = 1 / (scale < 1 ? scale : 1);
    const box = result.detection.box;
    const landmarks = result.landmarks;
    const centerOf = (points: { x: number; y: number }[]) => ({
      x: (points.reduce((s, p) => s + p.x, 0) / points.length) * inv,
      y: (points.reduce((s, p) => s + p.y, 0) / points.length) * inv,
    });
    const leftEye = centerOf(landmarks.getLeftEye());
    const rightEye = centerOf(landmarks.getRightEye());
    const eyeCenter = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
    const chinPoint = landmarks.getJawOutline()[8]!;
    const chin = { x: chinPoint.x * inv, y: chinPoint.y * inv };
    const browPoints = [...landmarks.getLeftEyeBrow(), ...landmarks.getRightEyeBrow()];
    const browY = (browPoints.reduce((s, p) => s + p.y, 0) / browPoints.length) * inv;

    this.logger.debug(`Face detected at score ${result.detection.score.toFixed(2)}`);

    return {
      box: { x: box.x * inv, y: box.y * inv, width: box.width * inv, height: box.height * inv },
      eyeCenter,
      leftEye,
      rightEye,
      chin,
      crownY: estimateCrownY(browY, chin.y),
      confidence: result.detection.score,
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
