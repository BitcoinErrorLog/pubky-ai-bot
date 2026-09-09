import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPublicHomeserverReader,
  HOMESERVER_READ_MAX_BYTES,
  wrapReaderTimeout,
  type PublicHomeserverReader,
} from "./homeserver-read.js";
import {
  parsePubchiBotV1,
  parsePubchiConfigV1,
  parseOwnerBindingV1,
} from "@pubky/pubchi-schemas";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/homeserver/${name}.json`, import.meta.url), "utf8");
}

function replaceNullsWithUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(replaceNullsWithUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceNullsWithUndefined(entry)]));
  }
  return value;
}

describe("homeserver public getJson timeout", () => {
  it("aborts a hung public getJson after the timeout", async () => {
    const hung: PublicHomeserverReader = {
      getJson: () => new Promise(() => {}),
    };
    const reader = wrapReaderTimeout(hung, 40);
    await expect(reader.getJson("pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/x.json")).rejects.toThrow(
      /homeserver_timeout/,
    );
  });
});

describe("homeserver public getJson wire fidelity", () => {
  it("parses the captured wire bodies with nulls preserved", async () => {
    const reader = createPublicHomeserverReader({
      publicStorage: {
        getText: async (uri) => {
          if (uri.includes("/bots/")) return fixture("owner-binding");
          if (uri.endsWith("/config.json")) return fixture("config");
          return fixture("bot");
        },
      },
    });

    const bot = await reader.getJson("pubky://owner/pub/pubchi.app/bot.json");
    const config = await reader.getJson("pubky://owner/pub/pubchi.app/config.json");
    const binding = await reader.getJson("pubky://owner/pub/pubchi.app/bots/bot.json");

    expect(bot.status).toBe(200);
    expect(config.status).toBe(200);
    expect(binding.status).toBe(200);
    expect(parsePubchiBotV1(bot.body).ok).toBe(true);
    expect(parsePubchiConfigV1(config.body).ok).toBe(true);
    expect(parseOwnerBindingV1(binding.body).ok).toBe(true);
    expect((bot.body as { backup_confirmed_at: unknown }).backup_confirmed_at).toBeNull();
    expect((config.body as { brain: { endpoint: unknown } }).brain.endpoint).toBeNull();
  });

  it("documents the old SDK conversion failure for null fields", () => {
    const bot = replaceNullsWithUndefined(JSON.parse(fixture("bot")));
    const config = replaceNullsWithUndefined(JSON.parse(fixture("config")));

    expect(parsePubchiBotV1(bot)).toEqual({ ok: false, code: "SCHEMA_INVALID" });
    expect(parsePubchiConfigV1(config)).toEqual({ ok: false, code: "BRAIN_FORBIDDEN" });
  });

  it("rejects oversized, malformed, and non-object bodies with typed failures", async () => {
    const reader = (text: string) => createPublicHomeserverReader({
      publicStorage: { getText: async () => text },
    }).getJson("pubky://owner/pub/document.json");

    await expect(reader("x".repeat(HOMESERVER_READ_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "homeserver_body_too_large",
    });
    await expect(reader("{")).rejects.toMatchObject({ code: "homeserver_invalid_json" });
    await expect(reader("[]")).rejects.toMatchObject({ code: "homeserver_non_object" });
  });
});
