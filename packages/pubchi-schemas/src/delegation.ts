import { z } from "zod";
import { err, ok, type ParseResult } from "./codes.js";
import { canonicalJson } from "./canonical.js";
import { bytesToHex, hexToBytes, signEd25519, verifyPubkySignature } from "./ed25519.js";
import { fromZod, zPubky, zUnix, zVersion1 } from "./zod.js";
import { CLOCK_SKEW_SECONDS, PHASE0_PURPOSES, type Phase0Purpose } from "./request.js";

export const DEVICE_DELEGATION_MAX_SECONDS = 30 * 24 * 60 * 60;

const UnsignedDeviceDelegationV1Schema = z
  .object({
    schema: z.literal("pubchi-device-delegation"),
    version: zVersion1,
    owner: zPubky,
    signer: zPubky,
    bot: zPubky,
    purposes: z.array(z.enum(PHASE0_PURPOSES)).min(1).max(PHASE0_PURPOSES.length),
    created_at: zUnix,
    expires_at: zUnix,
  })
  .strict();

export const DeviceDelegationV1Schema = UnsignedDeviceDelegationV1Schema.extend({
  signature: z.string().regex(/^[0-9a-f]{128}$/),
}).strict();

export type UnsignedDeviceDelegationV1 = z.infer<typeof UnsignedDeviceDelegationV1Schema>;
export type DeviceDelegationV1 = z.infer<typeof DeviceDelegationV1Schema>;

export function delegationPath(signer: string): string {
  return `/pub/pubchi.app/devices/${signer}.json`;
}

export function delegationUri(owner: string, signer: string): string {
  return `pubky://${owner}${delegationPath(signer)}`;
}

export function parseDeviceDelegationV1(input: unknown): ParseResult<DeviceDelegationV1> {
  const parsed = fromZod(DeviceDelegationV1Schema, input);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.expires_at <= value.created_at) return err("DELEGATION_INVALID");
  if (value.expires_at - value.created_at > DEVICE_DELEGATION_MAX_SECONDS) {
    return err("DELEGATION_INVALID");
  }
  if (new Set(value.purposes).size !== value.purposes.length) return err("DELEGATION_INVALID");
  return ok(value);
}

export function unsignedDelegationBytes(unsigned: UnsignedDeviceDelegationV1): Uint8Array {
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

export function signDeviceDelegationV1(
  unsigned: UnsignedDeviceDelegationV1,
  secretSeed: Uint8Array,
): DeviceDelegationV1 {
  const signature = bytesToHex(signEd25519(secretSeed, unsignedDelegationBytes(unsigned)));
  return { ...unsigned, signature };
}

export function verifyDeviceDelegationV1(
  delegation: DeviceDelegationV1,
  owner: string,
  signer: string,
  bot: string,
  purpose: Phase0Purpose,
  now: number,
): ParseResult<DeviceDelegationV1> {
  if (delegation.owner !== owner) return err("DELEGATION_OWNER_MISMATCH");
  if (delegation.signer !== signer || delegation.bot !== bot) return err("DELEGATION_INVALID");
  // Same 60s clock-skew allowance as the request path, so boundary requests
  // do not fail spuriously. A `created_at` beyond that skew is not plausible
  // clock drift — reject it.
  if (delegation.created_at > now + CLOCK_SKEW_SECONDS) return err("DELEGATION_INVALID");
  if (now > delegation.expires_at + CLOCK_SKEW_SECONDS) return err("DELEGATION_EXPIRED");
  if (!delegation.purposes.includes(purpose)) return err("DELEGATION_PURPOSE_FORBIDDEN");
  const { signature, ...unsigned } = delegation;
  const sig = hexToBytes(signature);
  if (!sig || !verifyPubkySignature(signer, unsignedDelegationBytes(unsigned), sig)) {
    return err("DELEGATION_INVALID");
  }
  return ok(delegation);
}
