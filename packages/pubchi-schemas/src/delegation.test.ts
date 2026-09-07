import { describe, expect, it } from "vitest";
import { Keypair } from "@synonymdev/pubky";
import {
  parseDeviceDelegationV1,
  signDeviceDelegationV1,
  verifyDeviceDelegationV1,
} from "./delegation.js";

const owner = Keypair.fromSecret(new Uint8Array(32).fill(2)).publicKey.z32();
const signer = Keypair.fromSecret(new Uint8Array(32).fill(1)).publicKey.z32();
const bot = Keypair.fromSecret(new Uint8Array(32).fill(3)).publicKey.z32();
const now = 1_700_000_000;

function delegation() {
  return signDeviceDelegationV1(
    {
      schema: "pubchi-device-delegation",
      version: 1,
      owner,
      signer,
      bot,
      purposes: ["who-tagged-me"],
      created_at: now - 1,
      expires_at: now + 100,
    },
    new Uint8Array(32).fill(1),
  );
}

describe("DeviceDelegationV1", () => {
  it("rejects malformed canonical input", () => {
    expect(parseDeviceDelegationV1({ schema: "pubchi-device-delegation", version: 1 })).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
  });

  it("requires a valid signer proof and matching claims", () => {
    const value = delegation();
    expect(verifyDeviceDelegationV1(value, owner, signer, bot, "who-tagged-me", now).ok).toBe(true);
    expect(
      verifyDeviceDelegationV1({ ...value, signature: `${value.signature.slice(0, -2)}00` }, owner, signer, bot, "who-tagged-me", now),
    ).toMatchObject({ ok: false, code: "DELEGATION_INVALID" });
    expect(verifyDeviceDelegationV1(value, Keypair.fromSecret(new Uint8Array(32).fill(4)).publicKey.z32(), signer, bot, "who-tagged-me", now)).toMatchObject({
      ok: false,
      code: "DELEGATION_OWNER_MISMATCH",
    });
    expect(verifyDeviceDelegationV1(value, owner, signer, Keypair.fromSecret(new Uint8Array(32).fill(4)).publicKey.z32(), "who-tagged-me", now)).toMatchObject({
      ok: false,
      code: "DELEGATION_INVALID",
    });
    expect(verifyDeviceDelegationV1(value, owner, signer, bot, "build-feed", now)).toMatchObject({
      ok: false,
      code: "DELEGATION_PURPOSE_FORBIDDEN",
    });
    expect(verifyDeviceDelegationV1(value, owner, signer, bot, "who-tagged-me", now + 161)).toMatchObject({
      ok: false,
      code: "DELEGATION_EXPIRED",
    });
  });

  it("allows the request-path clock skew at the expiry boundary", () => {
    const value = delegation();
    // expires_at = now + 100; inside the 60s skew allowance the proof still verifies.
    expect(verifyDeviceDelegationV1(value, owner, signer, bot, "who-tagged-me", now + 100 + 60).ok).toBe(true);
    expect(verifyDeviceDelegationV1(value, owner, signer, bot, "who-tagged-me", now + 100 + 61)).toMatchObject({
      ok: false,
      code: "DELEGATION_EXPIRED",
    });
  });

  it("rejects a delegation created in the future beyond the clock skew", () => {
    const future = signDeviceDelegationV1(
      {
        schema: "pubchi-device-delegation",
        version: 1,
        owner,
        signer,
        bot,
        purposes: ["who-tagged-me"],
        created_at: now + 61,
        expires_at: now + 200,
      },
      new Uint8Array(32).fill(1),
    );
    expect(verifyDeviceDelegationV1(future, owner, signer, bot, "who-tagged-me", now)).toMatchObject({
      ok: false,
      code: "DELEGATION_INVALID",
    });
    const withinSkew = signDeviceDelegationV1(
      {
        schema: "pubchi-device-delegation",
        version: 1,
        owner,
        signer,
        bot,
        purposes: ["who-tagged-me"],
        created_at: now + 60,
        expires_at: now + 200,
      },
      new Uint8Array(32).fill(1),
    );
    expect(verifyDeviceDelegationV1(withinSkew, owner, signer, bot, "who-tagged-me", now).ok).toBe(true);
  });
});
