import { Injectable, Logger } from "@nestjs/common";
import * as tf from "@tensorflow/tfjs-node";
import * as bodyPix from "@tensorflow-models/body-pix";
import sharp from "sharp";
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
/** Blur radius (px) feathered into the binary mask so the composite edge is anti-aliased, not jagged. */
const MASK_FEATHER_SIGMA = 1.2;
/**
 * Median filter window (px) run over the binary mask before feathering. Low-contrast boundaries —
 * a light garment against a light wall, say — make BodyPix's per-pixel classification flicker
 * pixel-to-pixel near the edge; a median filter is the standard fix for exactly this kind of
 * salt-and-pepper noise, cleaning up the speckle without softening the real silhouette edge the
 * way a plain blur would.
 */
const MASK_DENOISE_WINDOW = 9;

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
    // .greyscale() is load-bearing here: without it, sharp's median/blur silently promote a
    // single-channel raw buffer to 3-channel sRGB output, which would misalign every downstream
    // per-pixel index.
    const alpha = reliable
      ? await sharp(binary, { raw: { width: result.width, height: result.height, channels: 1 } })
          .greyscale()
          .median(MASK_DENOISE_WINDOW)
          .blur(MASK_FEATHER_SIGMA)
          .raw()
          .toBuffer()
      : binary;

    this.logger.debug(`Segmented person: coverage ${(coverage * 100).toFixed(1)}%, reliable=${reliable}`);
    return { alpha, width: result.width, height: result.height, coverage, reliable };
  }
}
