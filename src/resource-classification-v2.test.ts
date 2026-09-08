import { describe, expect, it } from "vitest";
import { discoverResources, rankResourceLabels, type ExternalResourceInput } from "./external-resources.js";
import { DENIED_RESOURCE_LABELS } from "./resource-label-policy.js";
import { RESOURCE_ENTITIES, matchResourceEntities, slugifyPersonName } from "./resource-entities.js";
import { isValidOpenTagLabel } from "./bot-kit/tags/policy.js";
import { RESOURCE_RULES } from "./resource-classify.js";
import {
  normalize,
  RESOURCE_VOCABULARY,
  SUBJECT_DOMAIN_NAMES,
  type SubjectDomain,
  type SubjectId,
} from "./resource-vocabulary.js";

const input = (extra: Partial<ExternalResourceInput> = {}): ExternalResourceInput => ({
  family: "url",
  value: "https://bitcoinops.org/en/topics/taproot/",
  source: "web-index-direct",
  labels: ["documentation", "homepage", "general-tech"],
  ...extra,
});

describe("resource classification v2 policy", () => {
  it("keeps internal scoring buckets type-level distinct from labels", () => {
    const bucket: SubjectDomain = "dom:bitcoin";
    // @ts-expect-error Internal buckets are not branded subject labels.
    const forbiddenSubject: SubjectId = bucket;
    expect(forbiddenSubject).toBe("dom:bitcoin");
    const emittedIds = new Set([
      ...RESOURCE_VOCABULARY.map(({ id }) => String(id)),
      ...RESOURCE_ENTITIES.map(({ id }) => id),
      ...RESOURCE_RULES.flatMap(({ emit }) => Object.values(emit).flat()),
    ]);
    expect(SUBJECT_DOMAIN_NAMES.filter((domain) => emittedIds.has(domain))).toEqual([]);

    const run = discoverResources([input({
      value: "https://bitcoinops.org/en/podcast/example/",
      title: "Post quantum signatures",
    })], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels).toEqual(["bitcoin", "cryptography", "post-quantum", "signatures"]);
  });

  it("drops denied labels before the cap", () => {
    const run = discoverResources([input()], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels).toEqual(["bitcoin", "taproot", "topic"]);
    expect(run.accepted[0]?.labels.some((label) => DENIED_RESOURCE_LABELS.has(label))).toBe(false);
  });

  it("does not extract names from arbitrary prose", () => {
    expect(matchResourceEntities({ description: "Written by Elon Musk about Kanye West" })).toEqual([]);
  });

  it("emits bounded BIP labels and rejects garbage", () => {
    const run = discoverResources([input({ title: "BIP341, bip-0352, bip-0000, bip-12345, and bip-garbage" })], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels).toEqual(expect.arrayContaining(["bip-341", "bip-352"]));
    expect(run.accepted[0]?.labels).not.toContain("bip-0000");
    expect(run.accepted[0]?.labels).not.toContain("bip-12345");
    expect(run.accepted[0]?.labels).not.toContain("bip-garbage");
  });

  it("maps language through the closed ISO map only", () => {
    const spanish = discoverResources([input({ language: "es" })], { limit: 100, configVersion: "test-v2" });
    const english = discoverResources([input({ language: "en" })], { limit: 100, configVersion: "test-v2" });
    const unknown = discoverResources([input({ language: "xx" })], { limit: 100, configVersion: "test-v2" });
    expect(spanish.accepted[0]?.labels).toEqual(["bitcoin", "taproot", "spanish", "topic"]);
    expect(english.accepted[0]?.labels).toEqual(["bitcoin", "taproot", "topic"]);
    expect(unknown.accepted[0]?.labels).toEqual(["bitcoin", "taproot", "topic"]);
  });

  it("allows a shortId only when a canonical person slug exceeds the limit", () => {
    const people = RESOURCE_ENTITIES.filter((entity) => entity.kind === "person");
    expect(people).toHaveLength(65);
    for (const person of people) {
      const canonicalSlug = slugifyPersonName(person.aliases[0]!);
      const words = canonicalSlug.split("-");
      if (canonicalSlug.length > 20) {
        expect(person.shortId).toBe(person.id);
        expect(person.shortId?.startsWith(`${words[0]}-`)).toBe(true);
        expect(person.shortId?.endsWith(`-${words.at(-1)}`)).toBe(true);
      } else {
        expect(person.shortId).toBeUndefined();
        expect(person.id).toBe(canonicalSlug);
      }
      expect(person.id.length).toBeLessThanOrEqual(20);
      expect(person.id.split("-").length).toBeLessThanOrEqual(3);
      expect(isValidOpenTagLabel(person.id)).toBe(true);
    }
    expect(people.filter(({ shortId }) => shortId !== undefined).map(({ id }) => id)).toEqual(["gustavo-f-echaiz"]);
    expect(RESOURCE_ENTITIES.filter((entity) => entity.kind !== "person").length).toBeGreaterThanOrEqual(60);
  });

  it("has globally unique subject aliases that never name another id", () => {
    const ids = new Set(RESOURCE_VOCABULARY.map(({ id }) => String(id)));
    const aliases = new Map<string, string>();
    for (const subject of RESOURCE_VOCABULARY) {
      for (const alias of subject.aliases) {
        const key = normalize(alias);
        expect(aliases.get(key) ?? subject.id).toBe(subject.id);
        aliases.set(key, subject.id);
        const aliasId = key.replaceAll(" ", "-");
        expect(ids.has(aliasId) && aliasId !== subject.id).toBe(false);
      }
    }
  });

  it("ranks 14 candidates as domain, entities, scored subjects, then form", () => {
    expect(rankResourceLabels({
      domain: ["bitcoin"],
      entities: ["adam-back", "pieter-wuille", "bitcoin-core"],
      subjects: ["taproot", "schnorr", "musig", "covenants", "payjoin", "coinjoin"],
      form: ["newsletter", "spanish", "release", "discussion"],
    })).toEqual([
      "bitcoin",
      "adam-back",
      "pieter-wuille",
      "bitcoin-core",
      "taproot",
      "schnorr",
      "musig",
      "covenants",
      "payjoin",
      "coinjoin",
    ]);
  });

  it("drops cross-domain description noise and narrower phrase matches", () => {
    const satire = discoverResources([input({
      value: "https://github.com/lightningnetwork/lnd/pull/10702",
      title: "lncli: add horoscope-based liquidity guidance",
      description: "Astrological finance research may benefit node operators.",
    })], { limit: 100, configVersion: "test-v2" });
    expect(satire.accepted[0]?.labels).toEqual(["lightning", "bitcoin", "lnd", "liquidity", "pull-request"]);

    const selfCustody = discoverResources([input({
      value: "https://blockstream.com/app/",
      title: "Blockstream App",
      description: "A secure self-custody Liquid wallet.",
    })], { limit: 100, configVersion: "test-v2" });
    expect(selfCustody.accepted[0]?.labels).toEqual(["bitcoin", "blockstream", "liquid", "self-custody"]);
  });
});
