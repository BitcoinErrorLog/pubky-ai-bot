import { PublicKey } from "@synonymdev/pubky";
import { err, ok, type ParseResult } from "./codes.js";

/** z-base32 pubky id (52 chars). No `pubky` prefix. */
export const PUBKY_ID_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

export function isPubkyId(value: string): boolean {
  if (!PUBKY_ID_RE.test(value)) return false;
  try {
    const pk = PublicKey.from(value);
    return pk.z32() === value && pk.toUint8Array().length === 32;
  } catch {
    return false;
  }
}

export function parsePubkyId(value: unknown): ParseResult<string> {
  if (typeof value !== "string" || !isPubkyId(value)) return err("INVALID_PUBKY");
  return ok(value);
}

export function pubkyPublicBytes(id: string): Uint8Array {
  return PublicKey.from(id).toUint8Array();
}
