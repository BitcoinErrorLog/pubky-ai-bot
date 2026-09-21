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

  it("keeps a given-name label only when the body uses the phrase in lowercase and never capitalised", () => {
    const body = "The mark price is derived from the index. Mark price divergence matters. Traders watch the mark price closely.";
    const kept = gateResourceLabels(["mark-price"], { canonicalValue: "https://example.com/a", title: "Derivatives", bodyText: body });
    expect(kept.labels).toEqual(["mark-price"]);
    // One planted lowercase copy does not launder a name that the page capitalises (Kimi finding 1).
    const laundered = gateResourceLabels(["donald-trump", "policy"], { canonicalValue: "https://example.com/z", title: "Bill", bodyText: "Donald Trump signed the bill. Donald Trump spoke. Senator Donald Trump returned. footnote: donald trump" });
    expect(laundered.labels).toEqual(["policy"]);
    expect(laundered.dropped[0]).toMatchObject({ label: "donald-trump", reason: "person-mention", evidence: "honorific" });
    const plain = gateResourceLabels(["elizabeth-warren", "policy"], { canonicalValue: "https://example.com/y", title: "Vote", bodyText: "Elizabeth Warren testified. Elizabeth Warren warned. see elizabeth warren" });
    expect(plain.labels).toEqual(["policy"]);
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

  it("judges a label with numeric tokens by its name tokens (Kimi finding 2)", () => {
    const body = "Donald Trump signed the bill. Saylor keeps buying bitcoin. Saylor spoke again.";
    const result = gateResourceLabels(["donald-trump-2026", "saylor-2026", "august-2026", "bip-322", "newsletter-421", "nfl-week-1"], { canonicalValue: "https://example.com/n", title: "Numbers", bodyText: body });
    expect(result.labels).toEqual(["saylor-2026", "august-2026", "bip-322", "newsletter-421", "nfl-week-1"]);
    expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}`)).toEqual(["donald-trump-2026:given-name"]);
    expect(gateResourceLabels(["mark-erhardt-2"], { canonicalValue: "https://example.com/n2", title: "Podcast" }).dropped[0]).toMatchObject({ label: "mark-erhardt-2", reason: "known-person", evidence: "mark-erhardt" });
  });

  it("judges bare surnames by full-name or honorific evidence, never by attribution alone (Kimi findings r1-3, r2-2)", () => {
    const fullName = gateResourceLabels(["saylor", "bitcoin-treasury"], { canonicalValue: "https://example.com/s", title: "Treasury", bodyText: "Michael Saylor keeps buying bitcoin. Saylor spoke again about the treasury." });
    expect(fullName.labels).toEqual(["bitcoin-treasury"]);
    expect(fullName.dropped[0]).toMatchObject({ label: "saylor", reason: "person-token", evidence: "surname-of-mention" });
    const honorific = gateResourceLabels(["saylor"], { canonicalValue: "https://example.com/s2", title: "Treasury", bodyText: "Strategy founder Saylor keeps buying bitcoin." });
    expect(honorific.dropped[0]).toMatchObject({ label: "saylor", reason: "person-mention", evidence: "honorific" });
    // Prose cannot separate "Saylor said" from "Binance said": attribution alone never drops a bare token.
    expect(gateResourceLabels(["saylor"], { canonicalValue: "https://example.com/s3", title: "Treasury", bodyText: "Saylor keeps buying bitcoin. Saylor spoke again." }).labels).toEqual(["saylor"]);
    expect(gateResourceLabels(["binance", "kraken"], { canonicalValue: "https://example.com/b", title: "Exchanges", bodyText: "Binance said withdrawals resumed. Users heard Binance said funds are safe. Kraken said nothing." }).labels).toEqual(["binance", "kraken"]);
    const coinbase = gateResourceLabels(["coinbase", "listing"], { canonicalValue: "https://example.com/c", title: "Listing", bodyText: "Coinbase said the listing is live. Coinbase Exchange added the pair." });
    expect(coinbase.labels).toEqual(["coinbase", "listing"]);
  });

  it("keeps institutions and organisations that speak, drops people that speak (Kimi finding r2-1)", () => {
    const body = "The White House said the bill will be signed. Fox News said bitcoin rose. The Federal Reserve said rates hold. The Kansas City Chiefs said the stadium deal is done. Elizabeth Warren said the bill is flawed. Saylor Armstrong said nothing. Saylor Armstrong said it again.";
    const result = gateResourceLabels(["white-house", "fox-news", "federal-reserve", "kansas-city-chiefs", "elizabeth-warren", "saylor-armstrong", "clarity-act"], { canonicalValue: "https://example.com/w", title: "Bill", bodyText: body });
    expect(result.labels).toEqual(["white-house", "fox-news", "federal-reserve", "kansas-city-chiefs", "clarity-act"]);
    expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}:${drop.evidence}`)).toEqual([
      "elizabeth-warren:person-mention:attribution",
      "saylor-armstrong:person-mention:attribution",
    ]);
  });

  it("does not let an organisation suffix launder a given-name label (Kimi finding r3-1)", () => {
    const body = "Donald Trump signed the bill. Elizabeth Warren objected. Michael Saylor bought more.";
    const result = gateResourceLabels(["donald-trump-news", "elizabeth-warren-act", "michael-saylor-fund", "adam-back-labs", "saylor-fund", "white-house"], { canonicalValue: "https://example.com/l", title: "Bill", bodyText: body });
    expect(result.labels).toEqual(["white-house"]);
    expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}`)).toEqual([
      "donald-trump-news:given-name",
      "elizabeth-warren-act:given-name",
      "michael-saylor-fund:given-name",
      "adam-back-labs:known-person",
      "saylor-fund:person-token",
    ]);
    // Without the full name in the body, a surname plus organisation word stays (recorded limit).
    expect(gateResourceLabels(["saylor-fund"], { canonicalValue: "https://example.com/l3", title: "Fund", bodyText: "The fund grew. Saylor said so." }).labels).toEqual(["saylor-fund"]);
    expect(gateResourceLabels(["joe-biden-news"], { canonicalValue: "https://example.com/l2", title: "Policy" }).dropped[0]).toMatchObject({ label: "joe-biden-news", reason: "given-name", evidence: "no-body" });
  });

  it("finds a person name in any window of a label (Kimi finding r4-1) and gazetteer aliases with suffixes", () => {
    const body = "Donald Trump signed the bill. Elizabeth Warren objected. Michael Saylor bought more.";
    const result = gateResourceLabels(["news-donald-trump", "act-elizabeth-warren", "fund-michael-saylor", "labs-adam-back", "the-donald-trump", "sipa-labs", "murch-news", "gmaxwell-capital", "white-house", "fox-news"], { canonicalValue: "https://example.com/w2", title: "Bill", bodyText: body });
    expect(result.labels).toEqual(["white-house", "fox-news"]);
    expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}`)).toEqual([
      "news-donald-trump:given-name",
      "act-elizabeth-warren:given-name",
      "fund-michael-saylor:given-name",
      "labs-adam-back:known-person",
      "the-donald-trump:given-name",
      "sipa-labs:known-person",
      "murch-news:known-person",
      "gmaxwell-capital:known-person",
    ]);
    // A lowercase-only phrase that the feed also puts in its title or categories is still a name (Kimi r4 backlog 1).
    const laundered = gateResourceLabels(["donald-trump-news"], { canonicalValue: "https://example.com/w3", title: "Donald Trump News roundup", bodyText: "welcome to donald trump news, your daily roundup of donald trump news." });
    expect(laundered.dropped[0]).toMatchObject({ label: "donald-trump-news", reason: "given-name", evidence: "named-by-feed" });
    // Surname evidence also reaches a surname-plus-suffix label.
    expect(gateResourceLabels(["saylor-fund"], { canonicalValue: "https://example.com/w4", title: "Fund", bodyText: "Michael Saylor launched a fund. The Saylor fund grows." }).dropped[0]).toMatchObject({ label: "saylor-fund", reason: "person-token", evidence: "surname-of-mention" });
  });

  it("treats forge accounts as handles only with person-leaning prose (Kimi finding r2-3)", () => {
    expect(gateResourceLabels(["conduition"], { canonicalValue: "https://github.com/conduition/musig2", title: "musig2", bodyText: "Written by Conduition. Conduition argues that adaptor signatures compose." }).dropped[0])
      .toMatchObject({ label: "conduition", reason: "handle", evidence: "profile-url" });
    expect(gateResourceLabels(["openwall"], { canonicalValue: "https://github.com/openwall/john", title: "john", bodyText: "Security teams use Openwall tools. Openwall maintains John the Ripper." }).labels).toEqual(["openwall"]);
    expect(gateResourceLabels(["acme-corp"], { canonicalValue: "https://github.com/acme-corp/widgets", title: "widgets", bodyText: "Acme Corp builds widgets. Acme Corp ships weekly." }).labels).toEqual(["acme-corp"]);
    expect(gateResourceLabels(["blockstream"], { canonicalValue: "https://github.com/Blockstream/esplora", title: "esplora" }).labels).toEqual(["blockstream"]);
  });

  it("caps metadata evidence so a hostile feed cannot inflate gate cost (Kimi finding 5)", () => {
    const categories = Array.from({ length: 200 }, () => "Donald Trump ".repeat(20_000));
    const started = performance.now();
    const result = gateResourceLabels(["donald-trump", "policy"], { canonicalValue: "https://example.com/m", title: "Meta", metadata: { categories } });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.labels).toEqual(["policy"]);
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

  it("does not read a label's own role word as an honorific (`analyst-reports`)", () => {
    const result = gateResourceLabels(["analyst-reports", "developer-tools", "host-identity"], { canonicalValue: "https://example.com/ar", title: "Markets", bodyText: "Analyst reports moved the price. Developer tools improved.", metadata: { categories: ["Analyst Reports"] } });
    expect(result.labels).toEqual(["analyst-reports", "developer-tools", "host-identity"]);
  });

  it("keeps feed categories apart: adjacent category strings never form one capitalised run", () => {
    const result = gateResourceLabels(["senate-banking", "warren-senate", "policy"], { canonicalValue: "https://example.com/cat", title: "Vote", bodyText: "The vote is Tuesday.", metadata: { categories: ["Elizabeth Warren", "Senate Banking Committee", "News"] } });
    expect(result.labels).toEqual(["senate-banking", "policy"]);
    expect(result.dropped).toEqual([{ label: "warren-senate", reason: "person-token", evidence: "surname-of-mention" }]);
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

  describe("round 6 (Grok review of 1b97f12)", () => {
    it("R1: a lexicon-miss two-token name is fail-closed on an exact capitalised mention", () => {
      const noBody = gateResourceLabels(["elon-musk", "tesla", "bitcoin-treasury"], { canonicalValue: "https://example.com/r6a", title: "Tesla bitcoin", metadata: { categories: ["Elon Musk", "Tesla"] } });
      expect(noBody.labels).toEqual(["tesla", "bitcoin-treasury"]);
      expect(noBody.dropped[0]).toMatchObject({ label: "elon-musk", reason: "person-mention", evidence: "no-body" });
      const once = gateResourceLabels(["elon-musk"], { canonicalValue: "https://example.com/r6b", title: "Tesla", bodyText: "Elon Musk said Tesla holds bitcoin." });
      expect(once.dropped[0]).toMatchObject({ label: "elon-musk", reason: "person-mention" });
      const plain = gateResourceLabels(["vitalik-buterin"], { canonicalValue: "https://example.com/r6c", title: "Research", bodyText: "The roadmap by the Ethereum Foundation cites Vitalik Buterin in passing." });
      expect(plain.dropped[0]).toMatchObject({ label: "vitalik-buterin", reason: "person-mention", evidence: "no-lowercase-use" });
      // A lexicon-miss name with no mention anywhere (no category, no body) is outside the rule: recorded limit.
      expect(gateResourceLabels(["vitalik-buterin"], { canonicalValue: "https://example.com/r6d", title: "Research", metadata: { categories: ["Vitalik Buterin"] } }).dropped[0]).toMatchObject({ label: "vitalik-buterin", reason: "person-mention", evidence: "no-body" });
    });

    it("R1: topical two-token phrases survive the fail-closed mention rule", () => {
      const cats = gateResourceLabels(["senate-banking", "market-structure", "silent-payments", "analyst-reports", "layer-1s"], { canonicalValue: "https://example.com/r6e", title: "Vote", metadata: { categories: ["Elizabeth Warren", "Senate Banking Committee", "Market Structure", "Silent Payments", "Analyst Reports", "Layer-1s"] } });
      expect(cats.labels).toEqual(["senate-banking", "market-structure", "silent-payments", "analyst-reports", "layer-1s"]);
      const prose = gateResourceLabels(["market-structure", "bull-market"], { canonicalValue: "https://example.com/r6f", title: "Markets", bodyText: "Market Structure legislation advanced. The market structure bill and the bull market both continued." });
      expect(prose.labels).toEqual(["market-structure", "bull-market"]);
    });

    it("R2: concatenated names are judged as their hyphenated window", () => {
      const body = "Donald Trump signed the bill. Strike CEO Jack Mallers says rewards work.";
      const result = gateResourceLabels(["donaldtrump", "jackmallers", "jamesonlopp", "blockstream", "bitcoin"], { canonicalValue: "https://example.com/r6g", title: "Bill", bodyText: body });
      expect(result.labels).toEqual(["blockstream", "bitcoin"]);
      expect(result.dropped.map((drop) => `${drop.label}:${drop.reason}`)).toEqual(["donaldtrump:given-name", "jackmallers:known-person", "jamesonlopp:known-person"]);
    });

    it("R3: all-caps names form a capitalised run, all-caps tickers do not", () => {
      const result = gateResourceLabels(["trump", "etf", "bip-322", "bitcoin-etf"], { canonicalValue: "https://example.com/r6h", title: "Wire", bodyText: "DONALD TRUMP SIGNS THE BILL. TRUMP HAD OBJECTED. THE ETF AND BIP-322 WERE NOT MENTIONED." });
      expect(result.labels).toEqual(["etf", "bip-322", "bitcoin-etf"]);
      expect(result.dropped[0]).toMatchObject({ label: "trump", reason: "person-token", evidence: "surname-of-mention" });
    });

    it("R4: surname evidence for partial windows needs a strong mention", () => {
      expect(gateResourceLabels(["back-pressure"], { canonicalValue: "https://example.com/r6i", title: "Relay", bodyText: "Adam Back invented hashcash. Back-pressure in the relay queue matters." }).labels).toEqual(["back-pressure"]);
      expect(gateResourceLabels(["saylor-fund"], { canonicalValue: "https://example.com/r6j", title: "Fund", bodyText: "Strategy chairman Michael Saylor launched a fund. The Saylor fund grows." }).dropped[0]).toMatchObject({ label: "saylor-fund", reason: "person-token", evidence: "surname-of-mention" });
      expect(gateResourceLabels(["warren-senate"], { canonicalValue: "https://example.com/r6k", title: "Vote", bodyText: "The vote is Tuesday.", metadata: { categories: ["Elizabeth Warren", "Senate Banking Committee"] } }).dropped[0]).toMatchObject({ label: "warren-senate", reason: "person-token" });
    });

    it("R5: an honorific inside the label makes the other token a person", () => {
      expect(gateResourceLabels(["ceo-mallers"], { canonicalValue: "https://example.com/r6l", title: "Rewards", bodyText: "CEO Mallers said rewards work. Mallers added that fees fell." }).dropped[0]).toMatchObject({ label: "ceo-mallers", reason: "person-mention", evidence: "honorific" });
      expect(gateResourceLabels(["analyst-reports", "developer-tools"], { canonicalValue: "https://example.com/r6m", title: "Markets", bodyText: "Analyst reports moved the price. Developer tools improved.", metadata: { categories: ["Analyst Reports"] } }).labels).toEqual(["analyst-reports", "developer-tools"]);
    });
  });
});
