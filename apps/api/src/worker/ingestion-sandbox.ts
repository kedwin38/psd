import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePsdBuffer, type AssetSink } from "@psd-studio/psd-engine";

/**
 * Runs as a forked child process (see ingestion.processor.ts) so a hostile
 * or merely malformed PSD can only crash, hang, or exhaust memory in this
 * disposable process — never the worker that owns the job queue, and never
 * with direct access to real storage credentials (spec §12: uploads parsed
 * in an isolated sandbox). It writes extracted layer rasters to its own
 * scratch directory and reports back placeholder ids; the parent process is
 * the only one that ever talks to the real object store.
 */

interface SandboxArgs {
  psdFilePath: string;
  scratchDir: string;
}

class ScratchAssetSink implements AssetSink {
  private counter = 0;
  constructor(private readonly scratchDir: string) {}

  async putImage(png: Buffer, hint: string): Promise<string> {
    const index = this.counter++;
    const fileName = `asset_${index}.png`;
    await writeFile(join(this.scratchDir, fileName), png);
    // Placeholder id the parent process resolves to a real Asset after this
    // process exits — never a real storage key or credential.
    return `local:${fileName}:${hint}`;
  }
}

async function main() {
  const [, , psdFilePath, scratchDir] = process.argv as [string, string, string, string];
  const args: SandboxArgs = { psdFilePath, scratchDir };

  try {
    const buffer = await readFile(args.psdFilePath);
    const sink = new ScratchAssetSink(args.scratchDir);
    const { sceneGraph, warnings } = await parsePsdBuffer(buffer, sink);
    process.send?.({ type: "result", sceneGraph, warnings });
    process.exitCode = 0;
  } catch (error) {
    process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

main();
