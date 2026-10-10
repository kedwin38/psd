import { existsSync } from "node:fs";
import { Logger } from "@nestjs/common";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { join } from "node:path";

// dist/id-photo/matting.js -> apps/api/.models (NOT apps/api/models: the build script copies that
// directory wholesale into dist/, and duplicating ~490MB of weights into every build output and
// Docker layer is exactly what .models/ existing outside it avoids). The path resolution holds in
// the Docker image too (/app/dist/id-photo -> /app/.models — see the Dockerfile's explicit COPY).
// MATTING_MODEL_PATH overrides it for unusual deployments without touching the Env schema.
const MODEL_PATH = process.env.MATTING_MODEL_PATH ?? join(__dirname, "..", "..", ".models", "birefnet-portrait-fp16.onnx");

/** BiRefNet's training input resolution (onnx-community/BiRefNet-portrait-ONNX, preprocessor_config.json). */
const MODEL_INPUT_SIZE = 1024;
/** ImageNet channel mean/std the export's preprocessor_config.json normalizes with. */
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;
const INPUT_DIMS = [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE] as const;

const logger = new Logger("Matting");

export interface MatteResult {
  /** Soft single-channel alpha (0-255), same WxH as the input: 255 = subject, 0 = background. */
  alpha: Buffer;
  width: number;
  height: number;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

/** Loads the BiRefNet session once per process from the local weights — never fetched at request
 *  time (no runtime network dependency, same reasoning as the vendored face-landmark models). */
function loadSession(): Promise<ort.InferenceSession> {
  sessionPromise ??= (async () => {
    if (!existsSync(MODEL_PATH)) {
      throw new Error(
        `Matting model not found at ${MODEL_PATH}. Run "pnpm --filter @psd-studio/api run fetch-models" ` +
          "to download it (one-time, ~490MB, sha256-pinned).",
      );
    }
    const started = Date.now();
    const session = await ort.InferenceSession.create(MODEL_PATH, { graphOptimizationLevel: "all" });
    logger.log(`Loaded BiRefNet-portrait fp16 in ${Date.now() - started}ms (input: ${session.inputNames[0]}, output: ${session.outputNames[0]})`);
    return session;
  })();
  return sessionPromise;
}

// --- float16 <-> float32 conversion -------------------------------------------------------------
// fp16 ONNX exports may declare fp16 input/output tensors, which onnxruntime hands over as raw
// half-precision bit patterns (Uint16Array) rather than JS numbers. Both directions below are the
// standard bit-manipulation routines for IEEE 754 binary16.

const scratchBuffer = new ArrayBuffer(4);
const scratchFloat = new Float32Array(scratchBuffer);
const scratchUint32 = new Uint32Array(scratchBuffer);

function floatToHalfBits(value: number): number {
  scratchFloat[0] = value;
  const x = scratchUint32[0]!;
  let bits = (x >> 16) & 0x8000;
  let mantissa = (x >> 12) & 0x07ff;
  const exponent = (x >> 23) & 0xff;
  if (exponent < 103) return bits;
  if (exponent > 142) {
    bits |= 0x7c00;
    bits |= ((exponent === 255 ? 0 : 1) & ((x & 0x007fffff) !== 0 ? 1 : 0)) as number;
    return bits;
  }
  if (exponent < 113) {
    mantissa |= 0x0800;
    bits |= (mantissa >> (114 - exponent)) + ((mantissa >> (113 - exponent)) & 1);
    return bits;
  }
  bits |= ((exponent - 112) << 10) | (mantissa >> 1);
  bits += mantissa & 1;
  return bits;
}

function halfBitsToFloat(half: number): number {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const mantissa = half & 0x03ff;
  let value: number;
  if (exponent === 0) value = mantissa * 2 ** -24;
  else if (exponent === 0x1f) value = mantissa === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
  else value = (mantissa + 1024) * 2 ** (exponent - 25);
  return sign ? -value : value;
}

// The export's input dtype isn't knowable before the first run without parsing the protobuf, so
// the first inference probes float32 and falls back to float16 — onnxruntime rejects a dtype
// mismatch loudly, never silently coerces — and the answer is memoized for the process lifetime.
let inputDtype: "float32" | "float16" | null = null;

async function runSession(session: ort.InferenceSession, floats: Float32Array): Promise<ort.InferenceSession.ReturnType> {
  const inputName = session.inputNames[0]!;
  const feedFloat32 = () => ({ [inputName]: new ort.Tensor("float32", floats, [...INPUT_DIMS]) });
  const feedFloat16 = () => {
    const halves = new Uint16Array(floats.length);
    for (let i = 0; i < floats.length; i++) halves[i] = floatToHalfBits(floats[i]!);
    return { [inputName]: new ort.Tensor("float16", halves, [...INPUT_DIMS]) };
  };

  if (inputDtype === "float32") return session.run(feedFloat32());
  if (inputDtype === "float16") return session.run(feedFloat16());
  try {
    const result = await session.run(feedFloat32());
    inputDtype = "float32";
    return result;
  } catch {
    const result = await session.run(feedFloat16());
    inputDtype = "float16";
    logger.log("Model takes fp16 input tensors — converting on every inference (memoized decision).");
    return result;
  }
}

/**
 * Runs BiRefNet-portrait over an RGB (no alpha) raw buffer at its native resolution: the image is
 * resampled to 1024x1024 and ImageNet-normalized, the model produces a logits/probability map,
 * and the map is resampled back to the source's exact WxH as a soft 0-255 alpha matte. Soft alpha
 * — a per-pixel foreground probability, not a binary mask — is what keeps hair, garment edges and
 * other fine structure intact through the composite; binarization happens later, only where the
 * safety nets in segmentation.ts need a yes/no answer.
 */
export async function inferMatte(rgb: Buffer, width: number, height: number): Promise<MatteResult> {
  const session = await loadSession();
  const started = Date.now();

  // Preprocess: resample to the model's square input and normalize per-channel into NCHW layout.
  const resized = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (resized.length !== MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3) {
    throw new Error(`Matting preprocess produced ${resized.length} bytes, expected ${MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3}.`);
  }
  const pixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const floats = new Float32Array(pixels * 3);
  for (let p = 0; p < pixels; p++) {
    for (let channel = 0; channel < 3; channel++) {
      floats[channel * pixels + p] = (resized[p * 3 + channel]! / 255 - IMAGENET_MEAN[channel]!) / IMAGENET_STD[channel]!;
    }
  }

  const results = await runSession(session, floats);
  const output = results[session.outputNames[0]!];
  if (!output || output.data.length !== pixels) {
    const shape = output ? `(length ${output.data.length})` : "(missing)";
    throw new Error(`Matting model output ${shape} doesn't match ${MODEL_INPUT_SIZE}x${MODEL_INPUT_SIZE}.`);
  }

  // fp16 outputs arrive as half-precision bit patterns; fp32 as plain numbers.
  const rawValues = new Float32Array(pixels);
  if (output.type === "float16") {
    const halves = output.data as unknown as Uint16Array;
    for (let i = 0; i < pixels; i++) rawValues[i] = halfBitsToFloat(halves[i]!);
  } else {
    for (let i = 0; i < pixels; i++) rawValues[i] = (output.data as unknown as ArrayLike<number>)[i]!;
  }

  // The export emits pre-sigmoid logits; a probability map would already be confined to [0, 1].
  // Across a million pixels of a real portrait, logits essentially always exceed that range, so
  // this detection is reliable — and it keeps the code working unchanged against either variant.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pixels; i++) {
    const v = rawValues[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const isLogits = max > 1.0001 || min < -0.0001;

  const alphaInput = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i++) {
    const probability = isLogits ? 1 / (1 + Math.exp(-rawValues[i]!)) : rawValues[i]!;
    alphaInput[i] = Math.max(0, Math.min(255, Math.round(probability * 255)));
  }

  // Back to the source's own resolution. .greyscale() before .resize() is load-bearing, same as
  // every other single-channel mask op in this codebase: without it sharp silently promotes the
  // 1-channel buffer to 3-channel output and every downstream pixel lands in the wrong place.
  const alpha = await sharp(alphaInput, { raw: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE, channels: 1 } })
    .greyscale()
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  if (alpha.length !== width * height) {
    throw new Error(`Matting resize produced ${alpha.length} bytes, expected ${width * height} (${width}x${height}).`);
  }

  logger.debug(`Inferred ${width}x${height} matte in ${Date.now() - started}ms (range ${min.toFixed(2)}..${max.toFixed(2)}, ${isLogits ? "sigmoid applied" : "already probabilities"})`);
  return { alpha, width, height };
}
