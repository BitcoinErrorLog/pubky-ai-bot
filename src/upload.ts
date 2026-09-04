import { PubkySpecsBuilder } from "pubky-app-specs";

export type ImageContentType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface FileUploadPlan {
  blobPath: string;
  blobUrl: string;
  filePath: string;
  fileUrl: string;
  fileJson: Record<string, unknown>;
  bytes: Uint8Array;
  contentType: ImageContentType;
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v))) as Record<
    string,
    unknown
  >;
}

export function detectImageContentType(bytes: Uint8Array): ImageContentType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  throw new Error("file must be PNG, JPEG, WebP, or GIF (detected from magic bytes)");
}

export function assertUploadSize(bytes: Uint8Array, maxBytes: number, label: string): void {
  if (bytes.length === 0) throw new Error(`${label} file is empty`);
  if (bytes.length > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes (got ${bytes.length})`);
  }
}

/**
 * Specs-only blob/file plan: createBlob → blob URI, createFile(src=blob URI) → file URI.
 * Network PUT order (caller): putBytes(blob path, blob.data) then putJson(file path, file JSON).
 */
export function planFileUpload(
  botPk: string,
  bytes: Uint8Array,
  filename: string,
  opts: { maxBytes: number; label: string },
): FileUploadPlan {
  assertUploadSize(bytes, opts.maxBytes, opts.label);
  const contentType = detectImageContentType(bytes);
  const specs = new PubkySpecsBuilder(botPk);
  const blobResult = specs.createBlob(bytes);
  const fileResult = specs.createFile(filename, blobResult.meta.url, contentType, bytes.length);
  return {
    blobPath: blobResult.meta.path,
    blobUrl: blobResult.meta.url,
    filePath: fileResult.meta.path,
    fileUrl: fileResult.meta.url,
    fileJson: jsonRecord(fileResult.file.toJson()),
    bytes: blobResult.blob.data,
    contentType,
  };
}
