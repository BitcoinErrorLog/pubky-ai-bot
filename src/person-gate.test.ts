import { describe, expect, it } from "vitest";
import { applyPersonGate, buildPersonEvidence, gateResourceLabels, KNOWN_PERSON_LABELS, PERSON_GATE_VERSION } from "./person-gate.js";
import { PERSON_GAZETTEER_ABOUT_LABELS, PERSON_GAZETTEER_NOT_PEOPLE } from "./person-gazetteer.js";
import { GIVEN_NAMES } from "./person-gazetteer-data/given-names.js";

// Captured 2026-09-21 11:02 UTC from https://bitcoinops.org/en/podcast/2026/09/08 (evidence/phase1-2026-09-21/fixture-optech-podcast-2026-09-08.html).
const OPTECH_BYLINE = "Bitcoin Optech Newsletter #421 Recap Podcast Sep 8, 2026 Mark “Murch” Erhardt, Gustavo Flores Echaiz, and Mike Schmidt are joined by average_gary, Erick Cestari, Conduition, and Greg Sanders to discuss Newsletter #421. The Bitcoin Optech Podcast and transcription content is licensed Creative Commons CC BY-SA 2.0. News: Using silent payments for miner payouts in coinbase transaction. Responsible disclosure of a denial-of-service vulnerability in CLN.";

const optech = {
  canonicalValue: "https://bitcoinops.org/en/podcast/2026/09/08",
  title: "Bitcoin Optech Newsletter #421 Recap Podcast",
  authors: ["Bitcoin Optech"],
  bodyText: OPTECH_BYLINE,
  taxonomy: { domain: ["news"] },
};

// Rows from evidence/phase1-2026-09-21/input-plan-af388df.json and input-shadow-b5974c9-retry.json (no body text).
const theBlockRow = {
  canonicalValue: "https://www.theblock.co/news/regulation/2026-09-14-where-the-clarity-act-stands-ahead-of-tuesdays-senate-vote-414720",
  title: "Where the Clarity Act stands ahead of Tuesday’s Senate vote",
  authors: ["Sarah Wynn"],
  metadata: { feed: "the-block", categories: ["People", "Policy", "Regulation", "U.S. Policymaking", "Donald Trump", "Elizabeth Warren", "Senate Banking Committee", "News"] },
};
const stackerRow = {
  canonicalValue: "https://stacker.news/items/1571285",
  title: "Stacker News Monthly: August 2026",
  authors: ["SimpleStacker"],
  metadata: { feed: "stacker-news", categories: ["meta"] },
};

describe("person gate — evidence rules", () => {
  it("drops podcast hosts, guests, nicknames and handles named in a byline list (real Optech page)", () => {
    const result = gateResourceLabels(
      ["news", "bitcoin", "optech", "newsletter-421", "podcast", "mark-erhardt", "murch", "gustavo-flores-echaiz", "mike-schmidt", "erick-cestari", "greg-sanders", "conduition", "average-gary", "silent-payments"],
      optech,
      ["optech"],
    );
    expect(result.labels).toEqual(["news", "bitcoin", "optech", "newsletter-421", "podcast", "silent-payments"]);
    const reasons = Object.fromEntries(result.dropped.map((drop) => [drop.label, drop.reason]));
    expect(reasons).toEqual({
      "mark-erhardt": "known-person",
      murch: "known-person",
      "gustavo-flores-echaiz": "known-person",
      "mike-schmidt": "known-person",
      "erick-cestari": "person-mention",
      "greg-sanders": "person-mention",
      conduition: "person-token",
      "average-gary": "person-mention",
    });
    expect(result.version).toBe(PERSON_GATE_VERSION);
  });

  it("reaches the same verdicts on the Optech byline without the known-person entity list", () => {
    const evidence = buildPersonEvidence(optech, ["optech"]);
    const result = applyPersonGate(["mark-erhardt", "murch", "mike-schmidt", "gustavo-flores-echaiz", "conduition"], evidence, { useKnownPersons: false });
    expect(result.labels).toEqual([]);
    expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}:${drop.evidence ?? ""}`)).toEqual([
      "mark-erhardt:person-mention:list",
      "murch:nickname:",
      "mike-schmidt:given-name:capitalised-mention",
      "gustavo-flores-echaiz:given-name:capitalised-mention",
      "conduition:person-token:",
    ]);
  });

  it("matches authors exactly, squashed, and by surname, but not publication-shaped authors", () => {
    expect(gateResourceLabels(["simple-stacker", "meta", "monthly-recap"], stackerRow).dropped).toEqual([
      { label: "simple-stacker", reason: "author-match", evidence: "SimpleStacker" },
    ]);
    const wynn = gateResourceLabels(["wynn", "sarah-wynn", "clarity-act"], theBlockRow);
    expect(wynn.labels).toEqual(["clarity-act"]);
    expect(wynn.dropped.map((drop) => drop.reason)).toEqual(["author-match", "author-match"]);
    // Organisation authors do not poison their own tokens.
    const research = gateResourceLabels(["research", "blockstream"], { canonicalValue: "https://blog.blockstream.com/x", title: "Liquid research", authors: ["Blockstream Research"], bodyText: "Blockstream Research publishes liquid research notes." });
    expect(research.labels).toEqual(["research", "blockstream"]);
  });

  it("fails closed on given-name labels when no body text is available (plan rows)", () => {
    const result = gateResourceLabels(["news", "clarity-act", "donald-trump", "elizabeth-warren", "senate-banking", "senate-banking-commi", "people"], theBlockRow);
    expect(result.labels).toEqual(["news", "clarity-act", "senate-banking", "people"]);
    expect(result.dropped).toEqual([
      { label: "donald-trump", reason: "given-name", evidence: "no-body" },
      { label: "elizabeth-warren", reason: "given-name", evidence: "no-body" },
      { label: "senate-banking-commi", reason: "truncated", evidence: "committee" },
    ]);
  });

  it("keeps a given-name label only when the body uses the phrase in lowercase", () => {
    const body = "The mark price is derived from the index. Traders watch the mark price closely. Mark Price Analytics Ltd was not involved.";
    const kept = gateResourceLabels(["mark-price"], { canonicalValue: "https://example.com/a", title: "Derivatives", bodyText: body });
    expect(kept.labels).toEqual(["mark-price"]);
    const dropped = gateResourceLabels(["brian-armstrong"], { canonicalValue: "https://example.com/b", title: "Listing", bodyText: "Coinbase CEO Brian Armstrong says the listing is live. Armstrong spoke on stage." });
    expect(dropped.dropped[0]).toMatchObject({ label: "brian-armstrong", reason: "person-mention", evidence: "honorific" });
    const absent = gateResourceLabels(["brian-armstrong"], { canonicalValue: "https://example.com/c", title: "Listing", bodyText: "A body that never mentions the name at all." });
    expect(absent.dropped[0]).toMatchObject({ label: "brian-armstrong", reason: "given-name", evidence: "no-lowercase-use" });
    // A known person is caught by the entity list before any text rule.
    expect(gateResourceLabels(["jack-mallers"], { canonicalValue: "https://example.com/b2", title: "Rewards", bodyText: "Strike CEO Jack Mallers says bitcoin rewards work." }).dropped[0])
      .toMatchObject({ label: "jack-mallers", reason: "known-person" });
  });

  it("drops a bare surname when the body carries the full name or an honorific", () => {
    const body = "Senate Republicans release the final draft as Donald Trump accepts most ethics provisions. Trump had objected.";
    const result = gateResourceLabels(["trump", "clarity-act", "ethics-reform"], { canonicalValue: "https://example.com/d", title: "Draft", bodyText: body });
    expect(result.labels).toEqual(["clarity-act", "ethics-reform"]);
    expect(result.dropped[0]).toMatchObject({ label: "trump", reason: "person-token" });
    const honorific = gateResourceLabels(["lummis"], { canonicalValue: "https://example.com/e", title: "Vote", bodyText: "Senator Lummis credited the deal." });
    expect(honorific.dropped[0]).toMatchObject({ label: "lummis", reason: "person-mention", evidence: "honorific" });
  });

  it("drops the single token of a name it already dropped (`trump` beside `donald-trump`) and keeps common words", () => {
    const result = gateResourceLabels(["donald-trump", "trump", "policy"], theBlockRow);
    expect(result.labels).toEqual(["policy"]);
    expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}`)).toEqual(["donald-trump:given-name", "trump:person-token"]);
    const back = gateResourceLabels(["adam-back", "back"], { canonicalValue: "https://example.com/f", title: "Hashcash", bodyText: "Adam Back invented hashcash. Users come back for more." }, []);
    expect(back.labels).toEqual(["back"]);
  });

  it("drops handles from @mentions and profile URLs, but not forge organisations", () => {
    expect(gateResourceLabels(["alexk111", "hd-wallet-scanner", "bip-32"], { canonicalValue: "https://github.com/alexk111/HD-Wallet-Scanner", title: "HD Wallet Scanner" }).dropped)
      .toEqual([{ label: "alexk111", reason: "handle", evidence: "profile-url" }]);
    expect(gateResourceLabels(["statoshi", "bitcoin-statistics"], { canonicalValue: "https://t.me/statoshi", title: "Statoshi" }).dropped)
      .toEqual([{ label: "statoshi", reason: "handle", evidence: "profile-url" }]);
    expect(gateResourceLabels(["pubky", "pubky-core"], { canonicalValue: "https://github.com/pubky/pubky-core", title: "pubky-core" }).labels).toEqual(["pubky", "pubky-core"]);
    expect(gateResourceLabels(["openwall", "john-the-ripper"], { canonicalValue: "https://github.com/openwall/john/blob/bleeding-jumbo/doc/README.bitcoin", title: "README.bitcoin" }).labels).toEqual(["openwall", "john-the-ripper"]);
    expect(gateResourceLabels(["fanquake", "bitcoin-core"], { canonicalValue: "https://example.com/g", title: "Release", bodyText: "Thanks to @fanquake for the release notes." }).dropped)
      .toEqual([{ label: "fanquake", reason: "handle", evidence: "mention" }]);
  });

  it("applies the gazetteer: about-labels need the name in the title, notPeople are never dropped", () => {
    expect(PERSON_GAZETTEER_ABOUT_LABELS.has("satoshi-nakamoto")).toBe(true);
    const mention = gateResourceLabels(["satoshi-nakamoto", "digital-gold"], { canonicalValue: "https://stacker.news/items/1571676", title: "Why Sat-Digital-Gold can't win without Nah•Sovereign•Diamond", authors: ["dendehomie"] });
    expect(mention.dropped).toEqual([{ label: "satoshi-nakamoto", reason: "gazetteer-not-about" }]);
    const about = gateResourceLabels(["satoshi-nakamoto", "whitepaper"], { canonicalValue: "https://example.com/h", title: "Who was Satoshi Nakamoto?", bodyText: "Satoshi Nakamoto wrote the whitepaper." });
    expect(about.labels).toEqual(["satoshi-nakamoto", "whitepaper"]);
    expect(PERSON_GAZETTEER_NOT_PEOPLE.has("morgan-stanley")).toBe(true);
    const org = gateResourceLabels(["morgan-stanley", "amy-oldenburg", "bitcoin-etf"], { canonicalValue: "https://example.com/i", title: "Morgan Stanley’s Bitcoin Investment Recommendation Explained w/ Amy Oldenburg", authors: ["Mark Mason"], bodyText: "Morgan Stanley published portfolio models. Amy Oldenburg explained them." });
    expect(org.labels).toEqual(["morgan-stanley", "bitcoin-etf"]);
    expect(org.dropped[0]).toMatchObject({ label: "amy-oldenburg", reason: "person-mention", evidence: "attribution" });
  });

  it("never drops protected labels, numeric labels, or non-person entities", () => {
    const result = gateResourceLabels(["bitcoin", "lightning", "august-2026", "bip-322", "strike", "jade", "ledger", "jameson-lopp"], { canonicalValue: "https://blog.lopp.net/x", title: "Securing your financial sovereignty", bodyText: "Jameson Lopp writes about Strike, Jade and Ledger." }, ["lightning"]);
    expect(result.labels).toEqual(["bitcoin", "lightning", "august-2026", "bip-322", "strike", "jade", "ledger"]);
    expect(result.dropped).toEqual([{ label: "jameson-lopp", reason: "known-person" }]);
    expect(KNOWN_PERSON_LABELS.has("lopp")).toBe(true);
  });

  it("marks 20-character truncation artefacts from the text and keeps legitimate 20-character labels", () => {
    const evidence = { canonicalValue: "https://example.com/j", title: "Recovery", description: "Seed phrase recovery for Bitcoin For Corporations attendees.", bodyText: "" };
    const result = gateResourceLabels(["seed-phrase-recovery", "bitcoin-for-corporat", "senate-agriculture-c"], { ...evidence, metadata: { categories: ["Senate Agriculture Committee"] } });
    expect(result.labels).toEqual(["seed-phrase-recovery"]);
    expect(result.dropped).toEqual([
      { label: "bitcoin-for-corporat", reason: "truncated", evidence: "corporations" },
      { label: "senate-agriculture-c", reason: "truncated", evidence: "committee" },
    ]);
    expect(gateResourceLabels(["chad-preferred-stock"], { canonicalValue: "https://example.com/k", title: "Offering", bodyText: "The CHAD preferred stock offering closed." }).labels).toEqual(["chad-preferred-stock"]);
  });

  it("keeps the given-name lexicon free of topical collisions", () => {
    for (const word of ["bill", "will", "may", "june", "august", "chase", "grant", "jade", "iris", "river", "swan", "ark", "morgan", "warren", "austin", "chad", "strike", "max", "per", "mark-"]) {
      expect(GIVEN_NAMES.has(word)).toBe(false);
    }
    expect(GIVEN_NAMES.has("mark")).toBe(true);
  });
});
