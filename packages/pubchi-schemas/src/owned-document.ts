import { err, ok, type ParseResult } from "./codes.js";

export const OWNED_DOCUMENT_MAX_BYTES = 64 * 1024;

export function validateOwnedDocumentSize(input: unknown): ParseResult<void> {
  if (input === null || typeof input !== "object") return err("SCHEMA_INVALID");
  const serialized = JSON.stringify(input);
  if (serialized === undefined) return err("SCHEMA_INVALID");
  if (new TextEncoder().encode(serialized).byteLength > OWNED_DOCUMENT_MAX_BYTES) {
    return err("DOCUMENT_TOO_LARGE");
  }
  return ok(undefined);
}
