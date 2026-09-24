import type { FieldOverride, SceneGraph, SceneNode } from "@psd-studio/scene-graph";
import { createDomBuffer } from "./buffer.js";

export type AssetFetcher = (assetId: string, signal: AbortSignal) => Promise<Blob>;

export interface LayerImageRequest {
  assetId: string;
  /** Decode size in pixels; layer rasters are downsampled at decode so huge print PSDs stay cheap in memory. */
  width: number;
  height: number;
}

/** An end user's upload: its crop can change at any time, so it decodes whole, keeping its aspect ratio, with this long-edge cap. */
export interface UploadImageRequest {
  assetId: string;
  maxDimension: number;
}

export type ImageRequest = LayerImageRequest | UploadImageRequest;

export function uploadImageRequests(overrides: readonly FieldOverride[], maxDimension: number): UploadImageRequest[] {
  return overrides.flatMap((o) => (o.type === "image" ? [{ assetId: o.imageAssetId, maxDimension }] : []));
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
  private readonly natural = new Map<string, { width: number; height: number }>();
  private readonly alpha = new Map<string, Uint8Array>();
  private readonly inFlight = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly abort = new AbortController();

  constructor(
    private readonly fetcher: AssetFetcher,
    private readonly concurrency = 6,
  ) {}

  readonly get = (assetId: string): ImageBitmap | undefined => this.bitmaps.get(assetId);

  /** Full-resolution size of a loaded upload (bitmaps may be decoded smaller). */
  naturalSize(assetId: string): { width: number; height: number } | undefined {
    return this.natural.get(assetId);
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** Loads every not-yet-requested asset; onProgress fires after each one settles. */
  async load(requests: readonly ImageRequest[], onProgress: () => void): Promise<void> {
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

  private async loadOne(request: ImageRequest): Promise<void> {
    try {
      const blob = await this.fetcher(request.assetId, this.abort.signal);
      const bitmap = "maxDimension" in request ? await this.decodeUpload(request, blob) : await createImageBitmap(blob, { resizeWidth: request.width, resizeHeight: request.height, resizeQuality: "high" });
      if (this.abort.signal.aborted) bitmap.close();
      else this.bitmaps.set(request.assetId, bitmap);
    } catch {
      if (!this.abort.signal.aborted) this.failed.add(request.assetId);
    } finally {
      this.inFlight.delete(request.assetId);
    }
  }

  // EXIF orientation is applied here as it is by the server's image loader, so natural sizes agree.
  private async decodeUpload(request: UploadImageRequest, blob: Blob): Promise<ImageBitmap> {
    const full = await createImageBitmap(blob);
    this.natural.set(request.assetId, { width: full.width, height: full.height });
    const k = request.maxDimension / Math.max(full.width, full.height);
    if (k >= 1) return full;
    try {
      return await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: "high" });
    } finally {
      full.close();
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
    this.natural.clear();
    this.alpha.clear();
  }
}
