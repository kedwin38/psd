import { Injectable, Logger } from "@nestjs/common";
import sharp, { type Sharp } from "sharp";
import { inferMatte } from "./matting";

/**
 * Fraction of the frame the segmented subject must occupy for the matte to be trusted. Below this,
 * nothing was really found (an empty room, a wall); above the upper bound the "background" is
 * nearly the whole frame, which usually means the subject fills it edge-to-edge and there's no
 * background left to correct — either way, the matte isn't a safe basis for compositing.
 */
const MIN_RELIABLE_COVERAGE = 0.04;
const MAX_RELIABLE_COVERAGE = 0.97;
/** Blur radius (px) feathered into the final alpha so the composite edge is anti-aliased, not
 *  jagged — applied to the soft matte, which is already smooth, so this is a light touch. */
const MASK_FEATHER_SIGMA = 1.2;

export interface SegmentationResult {
  /** Single-channel alpha buffer (0-255), same WxH as the input: 255 = subject, 0 = background,
   *  feathered in between at the silhouette edge. */
  alpha: Buffer;
  width: number;
  height: number;
  /** Mean alpha over the frame (0-1), the soft-matte equivalent of "fraction classified subject". */
  coverage: number;
  /** False when coverage looks degenerate enough that the matte probably isn't trustworthy. */
  reliable: boolean;
}

/**
 * Keeps only the mask's largest 4-connected blob and zeroes out every other one. Even a strong
 * matting model can leave a small, disconnected patch elsewhere in the frame (a shadow, a texture
 * in the background) scored as foreground — a real defect, not noise a blur would catch, since a
 * stray patch can itself be solid and contiguous. The subject is, by construction, the largest
 * contiguous region in any photo where segmentation is trustworthy at all (that's what "reliable"
 * coverage already means), so this is a safe, image-specific decision rather than a fixed rule.
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
 * other background pixels; anything the model marked as background but sealed off entirely inside
 * the foreground (a hole punched in the middle of a face or a chest, say) is topologically
 * impossible as real background and can only be a misclassification. A person's photo is one
 * solid, hole-free object; this makes the mask agree, regardless of how large the hole is.
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

@Injectable()
export class SegmentationService {
  private readonly logger = new Logger(SegmentationService.name);

  /**
   * Cuts the foreground subject out of an RGB (no alpha) raw buffer using BiRefNet-portrait — a
   * high-resolution dichotomous segmentation / matting network running via onnxruntime — rather
   * than a color-distance heuristic or a coarse per-part classifier. The model returns a *soft*
   * per-pixel foreground probability (a matte), which is what keeps hair, garment edges and other
   * fine structure intact through the composite; the safety nets below only harden it where a
   * yes/no answer is genuinely needed:
   *
   * 1. binarize at the midpoint purely to drive the connected-component analysis;
   * 2. keep the subject's largest connected component (kill stray islands);
   * 3. fill enclosed holes (kill punched-through face/chest patches);
   * 4. recombine: outside the kept component → 0, reclassified hole pixels → 255, everywhere
   *    else → the model's own soft value, so the silhouette keeps its anti-aliased edge.
   *
   * The previous BodyPix pipeline needed median denoising and a morphological closing pass
   * because per-pixel binary classification flickers at low-contrast boundaries; a matte carries
   * that uncertainty in its own values, so those crutches (which could also bite chunks off the
   * subject's own edge) are gone.
   */
  async segmentPerson(rgb: Buffer, width: number, height: number): Promise<SegmentationResult> {
    const matte = await inferMatte(rgb, width, height);
    const n = width * height;
    if (matte.alpha.length !== n) {
      throw new Error(`Matte size ${matte.alpha.length} doesn't match ${width}x${height} (${n}).`);
    }

    let sum = 0;
    for (const v of matte.alpha) sum += v;
    const coverage = sum / (n * 255);
    const reliable = coverage >= MIN_RELIABLE_COVERAGE && coverage <= MAX_RELIABLE_COVERAGE;

    let alpha = matte.alpha;
    if (reliable) {
      const soft = new Uint8Array(matte.alpha);
      const binary = new Uint8Array(n);
      for (let i = 0; i < n; i++) binary[i] = soft[i]! >= 128 ? 255 : 0;

      const singleBlob = keepLargestComponent(binary, width, height);
      const holesFilled = fillEnclosedHoles(singleBlob, width, height);

      const combined = Buffer.alloc(n);
      for (let i = 0; i < n; i++) {
        if (!holesFilled[i]!) combined[i] = 0; // outside the subject entirely
        else if (singleBlob[i]!) combined[i] = soft[i]!; // the model's own soft edge
        else combined[i] = 255; // an enclosed hole reclassified as subject — protect it fully
      }
      alpha = await maskOp(combined, width, height, (img) => img.blur(MASK_FEATHER_SIGMA));
    }

    this.logger.debug(`Matted person: mean coverage ${(coverage * 100).toFixed(1)}%, reliable=${reliable}`);
    return { alpha, width, height, coverage, reliable };
  }
}
