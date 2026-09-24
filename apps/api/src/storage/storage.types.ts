export interface PutResult {
  key: string;
  sizeBytes: number;
  checksumSha256: string;
}

/**
 * Object-storage port. `local` (disk, dev) and `s3` (Cloudflare R2 / any
 * S3-compatible endpoint, prod) are the two drivers behind it (spec §6, §14)
 * — nothing above this interface knows or cares which one is active.
 */
export interface StorageDriver {
  put(key: string, data: Buffer, contentType: string): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A short-lived URL a browser can fetch directly, without a standing credential. `filename`, when given, makes the
   * browser save the download under that name (with its real extension) instead of the extension-less storage key. */
  getSignedDownloadUrl(key: string, expiresInSeconds: number, filename?: string): Promise<string>;
}

export const STORAGE_DRIVER = Symbol("STORAGE_DRIVER");
