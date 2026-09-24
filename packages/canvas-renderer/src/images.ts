import type { SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { createDomBuffer } from "./buffer.js";

export type AssetFetcher = (assetId: string, signal: AbortSignal) => Promise<Blob>;

export interface LayerImageRequest {
  assetId: string;
  /** Decode size in pixels; layer rasters are downsampled at decode so huge print PSDs stay cheap in memory. */
  width: number;
  height: number;
}

export function rasterAssetId(node: SceneNode): string | null {
  return node.type === "pixel" || node.type === "shape" || node.type === "smartObject" ? node.imageAssetId : null;
}

export function layerImageRequests(graph: SceneGraph, decodeScale: number): LayerImageRequest[] {
  const requests: LayerImageRequest[] = [];
  const visit = (nodes: readonly SceneNode[]) => {
    for (const node of nodes) {
      if (node.type === "group") visit(node.children);
      const assetId = rasterAssetId(node);
      if (!assetId) continue;
      const { left, top, right, bottom } = node.bounds;
      requests.push({ assetId, width: Math.max(1, Math.ceil((right - left) * decodeScale)), height: Math.max(1, Math.ceil((bottom - top) * decodeScale)) });
    }
  };
  visit(graph.root);
  return requests;
}

/** Fetches and decodes per-layer rasters once, with bounded concurrency, and serves them synchronously to the renderer. */
export class LayerImageStore {
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly alpha = new Map<string, Uint8Array>();
  private readonly inFlight = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly abort = new AbortController();

  constructor(
    private readonly fetcher: AssetFetcher,
    private readonly concurrency = 6,
  ) {}

  readonly get = (assetId: string): ImageBitmap | undefined => this.bitmaps.get(assetId);

  get loadedCount(): number {
    return this.bitmaps.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** Loads every not-yet-requested asset; onProgress fires after each one settles. */
  async load(requests: readonly LayerImageRequest[], onProgress: () => void): Promise<void> {
    const queue = [...new Map(requests.map((r) => [r.assetId, r])).values()].filter(
      (r) => !this.bitmaps.has(r.assetId) && !this.inFlight.has(r.assetId) && !this.failed.has(r.assetId),
    );
    for (const r of queue) this.inFlight.add(r.assetId);
    const worker = async () => {
      for (let r = queue.shift(); r && !this.abort.signal.aborted; r = queue.shift()) {
        await this.loadOne(r);
        if (!this.abort.signal.aborted) onProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
  }

  private async loadOne(request: LayerImageRequest): Promise<void> {
    try {
      const blob = await this.fetcher(request.assetId, this.abort.signal);
      const bitmap = await createImageBitmap(blob, { resizeWidth: request.width, resizeHeight: request.height, resizeQuality: "high" });
      if (this.abort.signal.aborted) bitmap.close();
      else this.bitmaps.set(request.assetId, bitmap);
    } catch {
      if (!this.abort.signal.aborted) this.failed.add(request.assetId);
    } finally {
      this.inFlight.delete(request.assetId);
    }
  }

  /** Alpha (0..255) at normalized image coordinates (u, v in 0..1), or undefined if the image isn't loaded. */
  alphaAt(assetId: string, u: number, v: number): number | undefined {
    const bitmap = this.bitmaps.get(assetId);
    if (!bitmap) return undefined;
    const { width, height } = bitmap;
    let channel = this.alpha.get(assetId);
    if (!channel) {
      const ctx = createDomBuffer(width, height);
      ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      channel = new Uint8Array(width * height);
      for (let i = 0; i < channel.length; i++) channel[i] = rgba[i * 4 + 3]!;
      this.alpha.set(assetId, channel);
    }
    const px = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const py = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
    return channel[py * width + px];
  }

  dispose(): void {
    this.abort.abort();
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
    this.alpha.clear();
  }
}
