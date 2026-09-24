const ALLOWED_UPLOAD_SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];

/** Real image type from magic bytes, never the client-declared mimetype; null if not PNG/JPEG/WebP. */
export function sniffImageMime(buffer: Buffer): string | null {
  for (const sig of ALLOWED_UPLOAD_SIGNATURES) {
    if (buffer.subarray(0, sig.bytes.length).equals(Buffer.from(sig.bytes))) return sig.mime;
  }
  // WebP: "RIFF"...."WEBP"
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}
