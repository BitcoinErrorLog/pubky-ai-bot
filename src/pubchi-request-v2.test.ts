import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@synonymdev/pubky";
import {
  bodySha256,
  parseRequestObjectV1,
  parseRequestObjectV2,
  signRequestObjectV1,
  signRequestObjectV2,
  unsignedBytesV2,
  verifySignedRequestObjectV2,
} from "@pubky/pubchi-schemas";

describe("Pubchi request protocol v2", () => {
  const now = 1_700_000_000;
  const seed = new Uint8Array(32).fill(7);
  const asker = Keypair.fromSecret(seed).publicKey.z32();
  const bot = Keypair.fromSecret(new Uint8Array(32).fill(9)).publicKey.z32();
  const common = {
    audience: "https://pubchi-production.up.railway.app",
    asker,
    bot,
    key_generation: 1,
    purpose: "ask" as const,
    body_sha256: bodySha256({ question: "hello" }),
    issued_at: now,
    expires_at: now + 600,
    nonce: "ab".repeat(32),
  };

  it("rejects cross-version parsing in both directions", () => {
    const v2 = signRequestObjectV2(
      { schema: "pubchi-request-object-v2", version: 2, ...common },
      seed,
    );
    expect(parseRequestObjectV2(v2).ok).toBe(true);
    expect(parseRequestObjectV1(v2).ok).toBe(false);

    const v1 = signRequestObjectV1(
      {
        schema: "pubchi-request-object",
        version: 1,
        asker,
        bot,
        purpose: "ask",
        body_sha256: common.body_sha256,
        issued_at: now,
        expires_at: now + 600,
        nonce: "cd".repeat(32),
      },
      seed,
    );
    expect(parseRequestObjectV1(v1).ok).toBe(true);
    expect(parseRequestObjectV2(v1).ok).toBe(false);
  });

  it("retains context at the Unicode code-point boundary", () => {
    const request = signRequestObjectV2(
      { schema: "pubchi-request-object-v2", version: 2, ...common, context: { about: "☕".repeat(1500) } },
      seed,
    );
    expect(parseRequestObjectV2(request).ok).toBe(true);
  });

  it("ships executable canonical vectors and stated negative reasons", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../packages/pubchi-schemas/fixtures/request-v2-vectors.json", import.meta.url), "utf8"),
    ) as { vectors: Array<{ name: string; object: unknown; canonical_hex: string; signature_hex: string; expect: string }> };
    expect(fixture.vectors).toHaveLength(7);
    for (const vector of fixture.vectors) {
      if (vector.expect !== "schema") {
        expect(vector.canonical_hex).toMatch(/^(?:[0-9a-f]{2})+$/);
        expect(vector.signature_hex).toMatch(/^[0-9a-f]{128}$/);
      }
      const parsed = vector.object as Record<string, unknown>;
      if (vector.expect === "ok") {
        expect(Buffer.from(unsignedBytesV2(parsed as never)).toString("hex")).toBe(vector.canonical_hex);
        expect(parseRequestObjectV2(parsed).ok).toBe(true);
        const verified = await verifySignedRequestObjectV2({
          request: parsed,
          body: { question: "hello" },
          now,
          nonces: {
            consume: async () => true,
          },
          consumeNonce: false,
        });
        expect(verified.ok).toBe(true);
      } else if (vector.name.includes("audience changed")) {
        expect(parseRequestObjectV2(parsed).ok).toBe(true);
        const verified = await verifySignedRequestObjectV2({
          request: parsed,
          body: { question: "hello" },
          now,
          nonces: { consume: async () => true },
          consumeNonce: false,
        });
        expect(verified).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
      } else if (vector.name.includes("audience removed")) {
        expect(parseRequestObjectV2(parsed).ok).toBe(false);
      } else if (vector.name.includes("parsed as v1")) {
        expect(parseRequestObjectV1(parsed).ok).toBe(false);
      } else if (vector.name.includes("parsed as v2")) {
        expect(parseRequestObjectV2(parsed).ok).toBe(false);
      } else {
        expect(parseRequestObjectV1(parsed).ok).toBe(false);
      }
    }
  });
});
