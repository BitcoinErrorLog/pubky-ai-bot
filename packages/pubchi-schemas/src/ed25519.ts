import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { pubkyPublicBytes } from "./pubky.js";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function signEd25519(secretSeed: Uint8Array, message: Uint8Array): Uint8Array {
  if (secretSeed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, asBuffer(secretSeed)]),
    format: "der",
    type: "pkcs8",
  });
  return nodeSign(null, asBuffer(message), key);
}

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, asBuffer(publicKey)]),
      format: "der",
      type: "spki",
    });
    return nodeVerify(null, asBuffer(message), key, asBuffer(signature));
  } catch {
    return false;
  }
}

export function verifyPubkySignature(asker: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verifyEd25519(pubkyPublicBytes(asker), message, signature);
  } catch {
    return false;
  }
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
