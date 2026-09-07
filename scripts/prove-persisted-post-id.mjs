/**
 * Direct execution against packages/bot-kit/src/publish/persisted-post-id.ts
 * (node --experimental-strip-types). Does not need vitest or pino.
 */
import assert from "node:assert/strict";
import { postIdFromUnixMs, timestampMsFromPostId } from "../packages/bot-kit/src/crockford.ts";
import {
  PersistedPostIdError,
  requireValidPersistedPostId,
  reuseValidPersistedPostId,
} from "../packages/bot-kit/src/publish/persisted-post-id.ts";

const LEGACY_HEX_ID = "528D628C576EC";
const BUILT = postIdFromUnixMs(Date.UTC(2025, 5, 1));

assert.equal(timestampMsFromPostId(LEGACY_HEX_ID), null, "incident hex must not decode as a timestamp id");

const reused = reuseValidPersistedPostId(LEGACY_HEX_ID, BUILT);
assert.equal(
  reused,
  BUILT,
  `legacy hex persisted id must fall back to builder id; got ${reused}`,
);
assert.notEqual(timestampMsFromPostId(reused), null);

assert.equal(reuseValidPersistedPostId(null, BUILT), BUILT);
assert.equal(reuseValidPersistedPostId(BUILT, "other"), BUILT);

assert.throws(() => requireValidPersistedPostId("standalone:x", LEGACY_HEX_ID), PersistedPostIdError);
assert.throws(() => requireValidPersistedPostId("standalone:x", null), PersistedPostIdError);
assert.equal(requireValidPersistedPostId("standalone:x", BUILT), BUILT);

console.log("PASS persisted-post-id helpers");
