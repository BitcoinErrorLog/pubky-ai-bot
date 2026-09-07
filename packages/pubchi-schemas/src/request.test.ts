import { describe, expect, it } from "vitest";
import { Keypair } from "@synonymdev/pubky";
import { bodySha256, canonicalize } from "./canonical.js";
import { MAX_JSON_DEPTH, scanForbidden } from "./forbidden.js";
import { MemoryNonceStore } from "./nonce.js";
import { signRequestObjectV1, verifyRequestObjectV1 } from "./request.js";
import { PHASE0_BRAIN, PHASE0_BUDGETS, type TenantV1 } from "./tenant.js";

describe("body hash coerce", () => {
  it("hashes a missing body as null", () => {
    expect(bodySha256(undefined)).toBe(bodySha256(null));
  });
});

describe("verifyRequestObjectV1 fail-closed on device signer", () => {
  const asker = Keypair.fromSecret(new Uint8Array(32).fill(7)).publicKey.z32();
  const deviceSeed = new Uint8Array(32).fill(8);
  const signer = Keypair.fromSecret(deviceSeed).publicKey.z32();
  const bot = Keypair.fromSecret(new Uint8Array(32).fill(9)).publicKey.z32();
  const now = 1_700_000_000;

  function tenant(): TenantV1 {
    return {
      schema: "pubchi-tenant",
      version: 1,
      bot,
      owner: asker,
      tier: "read-only",
      brain: { ...PHASE0_BRAIN },
      budgets: { ...PHASE0_BUDGETS },
      created_at: now - 100,
      updated_at: now - 100,
    };
  }

  it("rejects a signer-bearing request instead of skipping delegation checks", async () => {
    const body = { question: "who tagged me?" };
    const request = signRequestObjectV1(
      {
        schema: "pubchi-request-object",
        version: 1,
        asker,
        signer,
        bot,
        purpose: "who-tagged-me",
        body_sha256: bodySha256(body),
        issued_at: now,
        expires_at: now + 600,
        nonce: "cd".repeat(32),
      },
      deviceSeed,
    );
    const nonces = new MemoryNonceStore();
    const verified = await verifyRequestObjectV1({ request, tenant: tenant(), body, now, nonces });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("DELEGATION_INVALID");
    // Fail-closed rejection must not consume the nonce.
    expect(await nonces.consume(bot, "cd".repeat(32), now + 600)).toBe(true);
  });

  it("still accepts a root-signed request with no signer", async () => {
    const body = { question: "who tagged me?" };
    const request = signRequestObjectV1(
      {
        schema: "pubchi-request-object",
        version: 1,
        asker,
        bot,
        purpose: "who-tagged-me",
        body_sha256: bodySha256(body),
        issued_at: now,
        expires_at: now + 600,
        nonce: "ef".repeat(32),
      },
      new Uint8Array(32).fill(7),
    );
    const verified = await verifyRequestObjectV1({ request, tenant: tenant(), body, now, nonces: new MemoryNonceStore() });
    expect(verified.ok).toBe(true);
  });
});

function nest(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe("JSON depth cap", () => {
  it("scanForbidden returns SCHEMA_INVALID for a too-deep value", () => {
    const deep = scanForbidden(nest(MAX_JSON_DEPTH + 2));
    expect(deep).toEqual({ ok: false, code: "SCHEMA_INVALID" });
    expect(scanForbidden(nest(2)).ok).toBe(true);
  });

  it("canonicalize throws RangeError for a too-deep value", () => {
    expect(() => canonicalize(nest(MAX_JSON_DEPTH + 2))).toThrow(RangeError);
    expect(canonicalize(nest(2))).toEqual([[0]]);
  });
});
