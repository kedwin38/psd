import { Injectable, Logger } from "@nestjs/common";
import * as tf from "@tensorflow/tfjs-node";
import * as bodyPix from "@tensorflow-models/body-pix";
import sharp, { type Sharp } from "sharp";
import { join } from "node:path";

// dist/id-photo/segmentation.js -> dist/models/segmentation (see package.json's build script and
// Dockerfile, which both copy apps/api/models alongside src/generated into dist/).
const MODEL_JSON_PATH = join(__dirname, "..", "models", "segmentation", "model-stride16.json");
/**
 * Fraction of the frame the segmented subject must occupy for the mask to be trusted. Below this,
 * nothing was really found (an empty room, a wall); above the upper bound the "background" is
 * nearly the whole frame, which usually means the subject fills it edge-to-edge and there's no
 * background left to correct — either way, the mask isn't a safe basis for compositing.
 */
const MIN_RELIABLE_COVERAGE = 0.04;
const MAX_RELIABLE_COVERAGE = 0.97;
/** Blur radius (px) feathered into the final mask so the composite edge is anti-aliased, not jagged. */
const MASK_FEATHER_SIGMA = 1.2;
/**
 * Median filter window (px) run over the binary mask first. Low-contrast boundaries — a light
 * garment against a light wall, say — make BodyPix's per-pixel classification flicker
 * pixel-to-pixel near the edge; a median filter is the standard fix for exactly this kind of
 * salt-and-pepper noise.
 */
const MASK_DENOISE_WINDOW = 9;
/**
 * Morphological "closing" (a blur-then-rebinarize pass) run after denoising, to bridge the small
 * gaps a low-contrast boundary leaves in an otherwise-solid silhouette (a scalloped/bitten-looking
 * edge along a shoulder, say) without moving the real edge. MASK_CLOSE_THRESHOLD is deliberately
 * below the neutral midpoint (128): after a blur, a pixel surrounded mostly by foreground reads as
 * a mid-grey around ~130-180, so a lower cutoff resolves "mostly surrounded by person" as person.
 */
const MASK_CLOSE_BLUR_SIGMA = 12;
const MASK_CLOSE_THRESHOLD = 90;

export interface SegmentationResult {
  /** Single-channel alpha buffer (0-255), same WxH as the input: 255 = subject, 0 = background,
   *  feathered in between at the silhouette edge. */
  alpha: Buffer;
  width: number;
  height: number;
  /** Fraction of pixels classified as the subject, before feathering. */
  coverage: number;
  /** False when coverage looks degenerate enough that the mask probably isn't trustworthy. */
  reliable: boolean;
}

/**
 * Keeps only the mask's largest 4-connected blob and zeroes out every other one. BodyPix
 * occasionally misclassifies a small, disconnected patch elsewhere in the frame (a shadow, a
 * texture in the background) as "person" — a real defect ("leaving patches on the image"), not
 * noise a blur or median filter would catch, since a stray patch can itself be solid and
 * contiguous. The subject is, by construction, the largest contiguous region in any photo where
 * segmentation is trustworthy at all (that's what "reliable" coverage already means), so this is a
 * safe, image-specific decision rather than a fixed rule.
 */
function keepLargestComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const label = sizes.length;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const idx = stack[--top]!;
      size++;
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x > 0 && mask[idx - 1] && labels[idx - 1] === -1) {
        labels[idx - 1] = label;
        stack[top++] = idx - 1;
      }
      if (x < width - 1 && mask[idx + 1] && labels[idx + 1] === -1) {
        labels[idx + 1] = label;
        stack[top++] = idx + 1;
      }
      if (y > 0 && mask[idx - width] && labels[idx - width] === -1) {
        labels[idx - width] = label;
        stack[top++] = idx - width;
      }
      if (y < height - 1 && mask[idx + width] && labels[idx + width] === -1) {
        labels[idx + width] = label;
        stack[top++] = idx + width;
      }
    }
    sizes.push(size);
  }

  const out = new Uint8Array(n);
  if (sizes.length === 0) return out;
  let largest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[largest]!) largest = i;
  for (let i = 0; i < n; i++) if (labels[i] === largest) out[i] = 255;
  return out;
}

/**
 * Fills every "background" region the mask has that isn't actually reachable from the photo's
 * edge — a real background pixel can always be traced back to the frame border by only crossing
 * other background pixels; anything BodyPix marked as background but sealed off entirely inside the
 * foreground (a hole punched in the middle of a face or a chest, say, from a confusing shadow or
 * fabric pattern) is topologically impossible as real background and can only be a misclassification.
 * A person's photo is one solid, hole-free object; this makes the mask agree, regardless of how
 * large the hole is — unlike a blur/closing pass, which only bridges small gaps.
 */
function fillEnclosedHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const reachable = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;

  const seed = (idx: number) => {
    if (!mask[idx] && !reachable[idx]) {
      reachable[idx] = 1;
      stack[top++] = idx;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (top > 0) {
    const idx = stack[--top]!;
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0 && !mask[idx - 1] && !reachable[idx - 1]) {
      reachable[idx - 1] = 1;
      stack[top++] = idx - 1;
    }
    if (x < width - 1 && !mask[idx + 1] && !reachable[idx + 1]) {
      reachable[idx + 1] = 1;
      stack[top++] = idx + 1;
    }
    if (y > 0 && !mask[idx - width] && !reachable[idx - width]) {
      reachable[idx - width] = 1;
      stack[top++] = idx - width;
    }
    if (y < height - 1 && !mask[idx + width] && !reachable[idx + width]) {
      reachable[idx + width] = 1;
      stack[top++] = idx + width;
    }
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = mask[i] || !reachable[i] ? 255 : 0;
  return out;
}

/**
 * Runs one spatial op on a single-channel mask buffer and returns a single-channel buffer back.
 * sharp silently promotes a single-channel raw buffer to 3-channel sRGB through several spatial ops
 * (blur, median) unless the pipeline is explicitly told to stay greyscale — .greyscale() right
 * before the op, and a hard length check after, turn that class of bug into an immediate throw
 * instead of a silently misaligned mask.
 */
async function maskOp(input: Buffer, width: number, height: number, apply: (img: Sharp) => Sharp): Promise<Buffer> {
  const out = await apply(sharp(input, { raw: { width, height, channels: 1 } }).greyscale())
    .raw()
    .toBuffer();
  if (out.length !== width * height) {
    throw new Error(`Mask op produced ${out.length} bytes, expected ${width * height} (${width}x${height}, 1 channel).`);
  }
  return out;
}

let netPromise: Promise<bodyPix.BodyPix> | null = null;

/**
 * BodyPix's ResNet50 variant, loaded once per process from the vendored weights on disk (not
 * fetched at request time — same reasoning as the vendored face-landmark models: no runtime
 * network dependency, no risk of a shard truncating mid-download under load). ResNet50 is the
 * more accurate of BodyPix's two backbones; MobileNet trades accuracy for a size/speed this
 * server-side batch job doesn't need to make.
 */
function loadNet(): Promise<bodyPix.BodyPix> {
  netPromise ??= bodyPix.load({
    architecture: "ResNet50",
    outputStride: 16,
    quantBytes: 4,
    // body-pix's own ModelConfig types modelUrl as `string`, but it's passed straight through to
    // tf.loadGraphModel, which also accepts an IOHandler (tf.io.fileSystem) at runtime — a gap in
    // body-pix's types, not an actual type mismatch.
    modelUrl: tf.io.fileSystem(MODEL_JSON_PATH) as unknown as string,
  });
  return netPromise;
}

@Injectable()
export class SegmentationService {
  private readonly logger = new Logger(SegmentationService.name);

  /**
   * Segments the foreground subject out of an RGB (no alpha) raw buffer — real per-pixel deep
   * segmentation, not a color-distance heuristic, so it works against any background: patterned,
   * gradient, or a color close to the subject's own clothing or skin tone.
   */
  async segmentPerson(rgb: Buffer, width: number, height: number): Promise<SegmentationResult> {
    const net = await loadNet();
    const tensor = tf.tensor3d(new Uint8Array(rgb), [height, width, 3]);
    let result: bodyPix.SemanticPersonSegmentation;
    try {
      result = await net.segmentPerson(tensor as unknown as Parameters<typeof net.segmentPerson>[0], {
        internalResolution: "full",
        segmentationThreshold: 0.65,
      });
    } finally {
      tensor.dispose();
    }

    let sum = 0;
    for (const v of result.data) sum += v;
    const coverage = sum / result.data.length;
    const reliable = coverage >= MIN_RELIABLE_COVERAGE && coverage <= MAX_RELIABLE_COVERAGE;

    const binary = Buffer.from(result.data.map((v) => (v ? 255 : 0)));
    let alpha: Buffer = binary;
    if (reliable) {
      const singleBlob = keepLargestComponent(new Uint8Array(binary), result.width, result.height);
      const holesFilled = Buffer.from(fillEnclosedHoles(singleBlob, result.width, result.height));
      const denoised = await maskOp(holesFilled, result.width, result.height, (img) => img.median(MASK_DENOISE_WINDOW));
      const closedBlur = await maskOp(denoised, result.width, result.height, (img) => img.blur(MASK_CLOSE_BLUR_SIGMA));
      const closed = await maskOp(closedBlur, result.width, result.height, (img) => img.threshold(MASK_CLOSE_THRESHOLD));
      alpha = await maskOp(closed, result.width, result.height, (img) => img.blur(MASK_FEATHER_SIGMA));
    }

    this.logger.debug(`Segmented person: coverage ${(coverage * 100).toFixed(1)}%, reliable=${reliable}`);
    return { alpha, width: result.width, height: result.height, coverage, reliable };
  }
}
