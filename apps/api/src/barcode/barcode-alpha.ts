import sharp, { type Sharp } from "sharp";

/** Feather blurred into the ink/background threshold so bar and text edges are anti-aliased in
 *  the ink mask, not jagged — kept small so it doesn't blur together a barcode's thin, closely
 *  spaced bars. */
const ALPHA_FEATHER_SIGMA = 0.5;
/** The exact backdrop the extracted barcode is composited onto: pure, fully-saturated white. */
const BACKDROP_RGB: readonly [number, number, number] = [255, 255, 255];

function toGrayscale(rgb: Buffer, width: number, height: number, channels: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += channels) {
    gray[i] = (rgb[p]! * 306 + rgb[p + 1]! * 601 + rgb[p + 2]! * 117) >> 10;
  }
  return gray;
}

/** Otsu's method: the luminance split that best separates the crop into two classes (ink vs.
 *  background), found from the crop's own histogram rather than a fixed brightness cutoff — a
 *  barcode photographed under warm light or printed on off-white stock has no single universal
 *  threshold that works, but the crop's own bimodal ink/background split always does. */
function otsuThreshold(gray: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const v of gray) histogram[v]!++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t]!;

  let sumBelow = 0;
  let weightBelow = 0;
  let bestVariance = -1;
  let bestThreshold = 127;
  for (let t = 0; t < 256; t++) {
    weightBelow += histogram[t]!;
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += t * histogram[t]!;
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sumAll - sumBelow) / weightAbove;
    const variance = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = t;
    }
  }
  return bestThreshold;
}

/**
 * Builds a 0/255 ink mask marking a barcode's printed content (bars, modules, label text) as ink
 * and everything else — the surrounding paper/screen background, and any quiet zone caught in the
 * crop — as backdrop. The split point comes from Otsu's method on the crop's own histogram; which
 * side of that split is "ink" is decided by pixel count (a barcode's background always covers more
 * of the crop than its printed content), so this works the same for dark-on-light or light-on-dark
 * barcodes without needing to know which in advance.
 */
function computeInkAlphaMask(gray: Uint8Array): Uint8Array {
  const threshold = otsuThreshold(gray);
  const n = gray.length;
  let darkCount = 0;
  for (let i = 0; i < n; i++) if (gray[i]! <= threshold) darkCount++;
  const darkIsBackground = darkCount > n / 2;

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const isDark = gray[i]! <= threshold;
    const isInk = darkIsBackground ? !isDark : isDark;
    mask[i] = isInk ? 255 : 0;
  }
  return mask;
}

/** Same channel-promotion guard as the ID photo mask pipeline: sharp silently upgrades a
 *  single-channel raw buffer to 3-channel through spatial ops (including `.resize()`) unless told
 *  to stay greyscale. `expectedLength` is the op's own output size, not necessarily the input's —
 *  a resize changes it on purpose. */
async function maskOp(input: Buffer, width: number, height: number, apply: (img: Sharp) => Sharp, expectedLength = width * height): Promise<Buffer> {
  const out = await apply(sharp(input, { raw: { width, height, channels: 1 } }).greyscale())
    .raw()
    .toBuffer();
  if (out.length !== expectedLength) {
    throw new Error(`Barcode alpha op produced ${out.length} bytes, expected ${expectedLength}.`);
  }
  return out;
}

/**
 * Renders a barcode crop as a fully opaque PNG of its printed ink over an exact pure-white
 * backdrop — resized (typically upscaled) to the given output dimensions. The ink keeps its own
 * colour (a red-on-white barcode stays red); the original paper/screen background and any quiet
 * zone caught by the crop become the flat white backdrop, so the download is a clean, print-ready
 * image of the barcode itself rather than a rectangle of whatever surrounded it. The composite is
 * done manually per pixel, over separately-resized RGB and mask buffers, rather than sharp's own
 * `.resize()`+`.composite()`, which silently premultiplies RGB by alpha during processing and can
 * under-correct back out of it, darkening colours in proportion to their transparency.
 */
export async function renderWhiteBackedBarcodePng(cropBuffer: Buffer, outputWidth: number, outputHeight: number): Promise<Buffer> {
  const { data, info } = await sharp(cropBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const gray = toGrayscale(data, width, height, channels);
  const mask = computeInkAlphaMask(gray);
  const feathered = await maskOp(Buffer.from(mask), width, height, (img) => img.blur(ALPHA_FEATHER_SIGMA));

  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    rgb[i * 3] = data[p]!;
    rgb[i * 3 + 1] = data[p + 1]!;
    rgb[i * 3 + 2] = data[p + 2]!;
  }

  const [resizedRgb, resizedAlpha] = await Promise.all([
    sharp(rgb, { raw: { width, height, channels: 3 } })
      .resize(outputWidth, outputHeight, { kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer(),
    maskOp(feathered, width, height, (img) => img.resize(outputWidth, outputHeight, { kernel: sharp.kernel.lanczos3 }), outputWidth * outputHeight),
  ]);

  const canvas = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let i = 0; i < outputWidth * outputHeight; i++) {
    // Standard source-over compositing of the (feathered) ink over the flat white backdrop:
    // out = ink*mask + white*(1 - mask). The feathered mask anti-aliases the bar/text edges, and
    // the fully-covered backdrop makes the output opaque end to end — an "exact white background".
    const a = resizedAlpha[i]! / 255;
    const ia = 1 - a;
    canvas[i * 4] = Math.round(resizedRgb[i * 3]! * a + BACKDROP_RGB[0] * ia);
    canvas[i * 4 + 1] = Math.round(resizedRgb[i * 3 + 1]! * a + BACKDROP_RGB[1] * ia);
    canvas[i * 4 + 2] = Math.round(resizedRgb[i * 3 + 2]! * a + BACKDROP_RGB[2] * ia);
    canvas[i * 4 + 3] = 255;
  }

  return sharp(canvas, { raw: { width: outputWidth, height: outputHeight, channels: 4 } })
    .png({ quality: 100, palette: false })
    .toBuffer();
}
