#!/usr/bin/env node
/**
 * Downloads the BiRefNet-portrait fp16 ONNX matting model used by the ID-photo pipeline
 * (see src/id-photo/matting.ts) into apps/api/.models/.
 *
 * The model is ~490MB — far past GitHub's 100MB-per-file hard limit — so it can't be vendored
 * in git like the face-detection weights in apps/api/models/. Instead it is fetched from a
 * pinned URL and verified byte-for-byte (exact size + SHA-256) before being moved into place,
 * so a truncated or tampered download can never be loaded. The script is idempotent: an
 * already-present, already-valid model is left untouched, so it is safe to run repeatedly
 * (locally, in CI — where the .models directory is cached — and in the Docker build).
 *
 * Usage:
 *   node scripts/fetch-matting-model.mjs           download if missing/invalid
 *   node scripts/fetch-matting-model.mjs --force   re-download even if present
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL_URL = "https://huggingface.co/onnx-community/BiRefNet-portrait-ONNX/resolve/main/onnx/model_fp16.onnx";
const EXPECTED_BYTES = 489_666_272;
const EXPECTED_SHA256 = "4c05930c0b6f1418d02eb1de81c46fe37638ba54f5a93adeb5c674521db10110";
const FILENAME = "birefnet-portrait-fp16.onnx";

// scripts/fetch-matting-model.mjs -> apps/api/.models/<file>. The directory is gitignored and
// deliberately outside apps/api/models/ (which the build script copies wholesale into dist/) so
// the 490MB weights are never duplicated into the build output or the Docker image layers.
const DEST = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".models", FILENAME);

/** Stream-hash a file — ~490MB never needs to sit in memory. */
function sha256OfFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function isValidExisting(path) {
  if (!existsSync(path)) return false;
  if (statSync(path).size !== EXPECTED_BYTES) return false;
  process.stdout.write(`Verifying existing ${FILENAME} …\n`);
  return (await sha256OfFile(path)) === EXPECTED_SHA256;
}

async function download() {
  mkdirSync(dirname(DEST), { recursive: true });
  const part = `${DEST}.part`;
  if (existsSync(part)) unlinkSync(part);

  process.stdout.write(`Downloading ${MODEL_URL}\n  -> ${DEST} (${(EXPECTED_BYTES / 1e6).toFixed(1)} MB)\n`);
  const response = await fetch(MODEL_URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const reported = Number(response.headers.get("content-length"));
  if (Number.isFinite(reported) && reported !== EXPECTED_BYTES) {
    throw new Error(`Server reports ${reported} bytes, expected ${EXPECTED_BYTES} — the pinned model has changed; refusing to download.`);
  }

  let received = 0;
  let lastReportedMb = 0;
  const counter = new Transform({
    transform(chunk, _enc, callback) {
      received += chunk.byteLength;
      if (received > EXPECTED_BYTES) {
        callback(new Error(`Download exceeded the expected ${EXPECTED_BYTES} bytes — the pinned model has changed; aborting.`));
        return;
      }
      const mb = Math.floor(received / 5e6);
      if (mb > lastReportedMb) {
        lastReportedMb = mb;
        process.stdout.write(`  ${received} / ${EXPECTED_BYTES} bytes\n`);
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part));
  } catch (error) {
    if (existsSync(part)) unlinkSync(part);
    throw error;
  }

  if (received !== EXPECTED_BYTES) {
    unlinkSync(part);
    throw new Error(`Downloaded ${received} bytes, expected ${EXPECTED_BYTES}. Re-run to retry.`);
  }

  process.stdout.write("Verifying SHA-256 …\n");
  const digest = await sha256OfFile(part);
  if (digest !== EXPECTED_SHA256) {
    unlinkSync(part);
    throw new Error(`SHA-256 mismatch: got ${digest}, expected ${EXPECTED_SHA256}. Re-run to retry.`);
  }

  renameSync(part, DEST);
  process.stdout.write(`OK: ${FILENAME} verified and in place.\n`);
}

const force = process.argv.includes("--force");
if (!force && (await isValidExisting(DEST))) {
  process.stdout.write(`${FILENAME} already present and valid — nothing to do (use --force to re-download).\n`);
} else {
  await download();
}
