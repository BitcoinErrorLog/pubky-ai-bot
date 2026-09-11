import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import {
  canonicalPaperUrl,
  discoverPapers,
  assertPaperSourceUrl,
  iacrCachePath,
  parseArxivAtom,
  parseCrossrefJson,
  parseIacrRss,
  validateArxivId,
  validateDoi,
  validateEprintId,
  type PaperParser,
} from "./resource-papers.js";
import { runResourcesCli } from "./resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { sourceTreeHash } from "./source-tree-hash.js";

const fixture = (name: string) => readFile(new URL(`./test-fixtures/papers/${name}`, import.meta.url), "utf8");

const atom = `<?xml version="1.0"?><feed><entry><id>https://arxiv.org/abs/2401.12345v2</id><title>Bitcoin Security</title><summary>Research abstract</summary><category term="cs.CR"/></entry></feed>`;
const rss = `<?xml version="1.0"?><rss><channel><item><title>Cryptographic Bitcoin</title><link>https://eprint.iacr.org/2026/123</link><description>Paper abstract</description></item></channel></rss>`;
const crossref = JSON.stringify({ message: { items: [{ DOI: "10.1000/bitcoin.1", title: ["Bitcoin economics"], abstract: "<p>Research</p>", subject: ["Economics"] }] } });

const ROBOTS_ALLOW = "User-agent: *\nAllow: /\n";
const ROBOTS_DENY = "User-agent: *\nDisallow: /\n";

type FetchMap = (url: string) => Response | Promise<Response>;

function fetchFrom(map: FetchMap): typeof fetch {
  return (async (url: string | URL | Request) => map(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url)) as typeof fetch;
}

function happyFetch(overrides: Partial<Record<string, string | (() => Response)>> = {}): ReturnType<typeof vi.fn> {
  const bodies: Record<string, string> = {
    "https://export.arxiv.org/robots.txt": ROBOTS_ALLOW,
    "https://eprint.iacr.org/robots.txt": ROBOTS_ALLOW,
    "https://api.crossref.org/robots.txt": "",
    ...overrides,
  } as Record<string, string>;
  const impl = async (url: string): Promise<Response> => {
    for (const [prefix, body] of Object.entries(overrides)) {
      if (typeof body === "function" && url.startsWith(prefix)) return body();
    }
    if (url === "https://api.crossref.org/robots.txt" && !("https://api.crossref.org/robots.txt" in overrides)) {
      return new Response("not found", { status: 404 });
    }
    for (const [prefix, body] of Object.entries(bodies)) {
      if (typeof body === "string" && url.startsWith(prefix)) return new Response(body, { status: 200 });
    }
    if (url.startsWith("https://export.arxiv.org/api/query")) return new Response(atom, { status: 200 });
    if (url.startsWith("https://eprint.iacr.org/rss/")) return new Response(rss, { status: 200 });
    if (url.startsWith("https://api.crossref.org/works")) return new Response(crossref, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return vi.fn(impl as (url: string) => Promise<Response>);
}

const noSleep = async () => {};

describe("papers adapter", () => {
  it("parses the live fixtures from all three sub-sources", async () => {
    const arxiv = parseArxivAtom(await fixture("arxiv-live.xml"));
    expect(arxiv.papers.length).toBeGreaterThan(10);
    expect(arxiv.papers.every((paper) => paper.source === "arxiv" && paper.title)).toBe(true);
    expect(arxiv.papers.some((paper) => paper.categories.includes("cs.CR"))).toBe(true);
    const iacr = parseIacrRss(await fixture("iacr-live.xml"));
    expect(iacr.papers.length).toBeGreaterThan(10);
    expect(iacr.papers.every((paper) => /^https:\/\/eprint\.iacr\.org\/\d{4}\/\d{1,6}$/.test(paper.url))).toBe(true);
    const cross = parseCrossrefJson(await fixture("crossref-live.json"));
    expect(cross.papers.length).toBeGreaterThan(10);
    expect(cross.papers.every((paper) => paper.doi && paper.url === `https://doi.org/${paper.doi}`)).toBe(true);
  });

  it("canonicalizes identities and strips arXiv version suffixes", () => {
    expect(canonicalPaperUrl({ url: "https://arxiv.org/abs/2401.12345v2" })).toBe("https://arxiv.org/abs/2401.12345");
    expect(canonicalPaperUrl({ url: "https://arxiv.org/abs/cs/0601001v3" })).toBe("https://arxiv.org/abs/cs/0601001");
    expect(canonicalPaperUrl({ url: "https://eprint.iacr.org/2026/123" })).toBe("https://eprint.iacr.org/2026/123");
    expect(canonicalPaperUrl({ doi: "10.1000/BitCoin.1", url: "https://arxiv.org/abs/2401.12345v2" })).toBe("https://doi.org/10.1000/bitcoin.1");
    expect(canonicalPaperUrl({ url: "https://doi.org/10.1000/ABC" })).toBe("https://doi.org/10.1000/abc");
  });

  it("rejects unsafe identifiers and non-canonical hosts before any URL is built", () => {
    expect(validateDoi("10.1000/../../etc")).toBeNull();
    expect(validateDoi("10.1000/%2e%2e/x")).toBeNull();
    expect(validateDoi("10.1000//double")).toBeNull();
    expect(validateDoi(`10.1000/${"a".repeat(300)}`)).toBeNull();
    expect(validateDoi("10.1000/ünïcode")).toBeNull();
    expect(validateArxivId("2401.12345/../../x")).toBeNull();
    expect(validateArxivId("２４０１.１２３４")).toBeNull();
    expect(validateArxivId("2401.12345%2e")).toBeNull();
    expect(validateEprintId("2026/../../1")).toBeNull();
    expect(() => canonicalPaperUrl({ url: "https://evil.example/abs/2401.12345" })).toThrow("invalid canonical paper host");
    expect(() => canonicalPaperUrl({ url: "http://arxiv.org/abs/2401.12345" })).toThrow();
    expect(() => canonicalPaperUrl({ url: "https://arxiv.org/abs/2401.12345?token=x" })).toThrow();
    expect(() => canonicalPaperUrl({ url: "https://arxiv.org/abs/..%2f..%2fx" })).toThrow("invalid arXiv id");
    expect(() => canonicalPaperUrl({ doi: "10.1000/../evil", url: "https://arxiv.org/abs/2401.12345" })).toThrow("invalid DOI");
  });

  it("parses only bounded XML and refuses DTD, entity, deep, or oversized documents", () => {
    expect(() => parseArxivAtom("<!DOCTYPE feed><feed/>")).toThrow("forbidden XML declaration");
    expect(() => parseArxivAtom('<!ENTITY x "y"><feed/>')).toThrow("forbidden XML declaration");
    expect(() => parseArxivAtom("")).toThrow("empty response");
    expect(() => parseArxivAtom("not xml at all")).toThrow("no entries");
    const deep = `${"<a>".repeat(40)}x${"</a>".repeat(40)}`;
    expect(() => parseArxivAtom(deep)).toThrow("invalid XML depth");
    const many = `<feed>${"<b/>".repeat(20_001)}</feed>`;
    expect(() => parseIacrRss(many)).toThrow("XML element count exceeded");
    expect(() => parseArxivAtom("<feed><entry>")).toThrow("unbalanced XML");
  });

  it("counts malformed rows as rejections with reasons instead of crashing", () => {
    const mixed = `<?xml version="1.0"?><feed>
      <entry><id>https://arxiv.org/abs/2401.12345v1</id><title>Good</title><summary>s</summary></entry>
      <entry><id>https://mirror.example/abs/2401.99999</id><title>Bad id</title></entry>
      <entry><id>https://arxiv.org/abs/2401.22222v1</id></entry>
    </feed>`;
    const result = parseArxivAtom(mixed);
    expect(result.papers).toHaveLength(1);
    expect(result.rejected).toEqual([
      { source: "arxiv", reason: "invalid arXiv id" },
      { source: "arxiv", reason: "missing title" },
    ]);
    expect(() => parseArxivAtom("<feed><entry><id>x</id></entry></feed>")).toThrow("malformed");
  });

  it("bounds hostile JSON inputs", () => {
    expect(() => parseCrossrefJson("1e400")).toThrow("no items");
    expect(() => parseCrossrefJson(`[${"[".repeat(100_000)}`)).toThrow();
    expect(() => parseCrossrefJson("")).toThrow("empty response");
    expect(() => parseCrossrefJson(JSON.stringify({ message: { items: [] } }))).toThrow("no items");
    const hostileRows = JSON.stringify({
      message: {
        items: [
          null,
          42,
          [1e400],
          { DOI: "10.1000/../evil", title: ["Bad doi"] },
          { DOI: "10.1000/ok.1", title: ["Real Bitcoin work"], abstract: "<jats:p>abs</jats:p>" },
        ],
      },
    });
    const result = parseCrossrefJson(hostileRows);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]!.abstract).not.toContain("<");
    expect(result.rejected).toHaveLength(4);
    expect(() => parseArxivAtom("<".repeat(4 * 1024 * 1024))).toThrow();
  });

  it("runs all three sub-sources within the request budget and reports requests", async () => {
    const fetchImpl = happyFetch();
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(run.shadowReport.halt ?? null).toBeNull();
    // Three robots reads plus three page reads.
    expect(run.shadowReport.requests).toBe(6);
    expect(run.accepted).toHaveLength(3);
    for (const resource of run.accepted) {
      expect(resource.displayValue).toMatch(/^https:\/\/(doi\.org|arxiv\.org|eprint\.iacr\.org)\//);
      expect(resource.category).not.toBe("pubky");
      expect(resource.taxonomy.type).toContain("research");
      expect(resource.metadata?.kind).toBe("paper");
    }
    const urls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => new URL(url));
    expect(urls.every((url) => url.protocol === "https:" && ["export.arxiv.org", "eprint.iacr.org", "api.crossref.org"].includes(url.hostname))).toBe(true);
    // The contact address reaches Crossref only as the mailto query parameter.
    const crossrefCall = urls.find((url) => url.hostname === "api.crossref.org" && url.pathname === "/works");
    expect(crossrefCall?.searchParams.get("mailto")).toBe("contact@example.org");
    expect(JSON.stringify(run)).not.toContain("contact@example.org");
    expect(JSON.stringify(run)).not.toContain("mailto");
  });

  it("paces arXiv and IACR requests with source-specific intervals", async () => {
    const sleep = vi.fn(async () => {});
    await discoverPapers({
      limit: 10,
      contactEmail: "contact@example.org",
      fetchImpl: happyFetch() as unknown as typeof fetch,
      sleep,
      now: () => 0,
    });
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(sleep).not.toHaveBeenCalledWith(24 * 60 * 60 * 1_000);
  });

  it.each([
    ["same-host HTML page", "https://export.arxiv.org/abs/2401.12345"],
    ["path-prefix lookalike", "https://export.arxiv.org/api/queryevil"],
    ["alternate port", "https://export.arxiv.org:8443/api/query"],
    ["credential URL", "https://user:pass@export.arxiv.org/api/query"],
    ["percent-encoded lookalike", "https://export.arxiv.org/api%2fquery"],
    ["loopback IP", "https://127.0.0.1/api/query"],
    ["HTTP", "http://export.arxiv.org/api/query"],
    ["generic crawler path", "https://eprint.iacr.org/2026/123"],
  ])("refuses %s from the exact API/feed policy", (_name, url) => {
    expect(() => assertPaperSourceUrl(url, "GET")).toThrow();
  });

  it("refuses non-GET methods and allows only the exact required paths", () => {
    expect(() => assertPaperSourceUrl("https://export.arxiv.org/api/query", "POST")).toThrow();
    expect(() => assertPaperSourceUrl("https://export.arxiv.org/api/query?search_query=bitcoin", "GET")).not.toThrow();
    expect(() => assertPaperSourceUrl("https://eprint.iacr.org/rss/rss.xml", "GET")).not.toThrow();
    expect(() => assertPaperSourceUrl("https://api.crossref.org/works?rows=10", "GET")).not.toThrow();
    expect(() => assertPaperSourceUrl("https://export.arxiv.org/robots.txt", "GET")).not.toThrow();
    expect(() => assertPaperSourceUrl("https://evil.example/robots.txt", "GET")).toThrow();
  });

  it("dedupes across sub-sources by canonical identity, preferring the DOI", async () => {
    const atomWithDoi = `<?xml version="1.0"?><feed><entry><id>https://arxiv.org/abs/2401.12345v2</id><title>Same paper</title><summary>s</summary><arxiv:doi>10.1000/dup.1</arxiv:doi></entry></feed>`;
    const crossrefDup = JSON.stringify({ message: { items: [{ DOI: "10.1000/DUP.1", title: ["Same paper, crossref copy"] }] } });
    const fetchImpl = happyFetch({ "https://export.arxiv.org/api/query": atomWithDoi, "https://api.crossref.org/works": crossrefDup });
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    const identities = run.accepted.map((resource) => resource.identity);
    expect(new Set(identities).size).toBe(identities.length);
    expect(run.accepted.some((resource) => resource.displayValue === "https://doi.org/10.1000/dup.1")).toBe(true);
    expect(run.accepted.some((resource) => resource.displayValue.includes("arxiv.org/abs/2401.12345"))).toBe(false);
    expect(run.shadowReport.rejectionHistogram?.["duplicate canonical identity"]).toBe(1);
  });

  it("fails closed per sub-source and halts with source-unavailable", async () => {
    const fetchImpl = fetchFrom(async (url) => {
      if (url.includes("robots.txt")) return url.includes("crossref") ? new Response("x", { status: 404 }) : new Response(ROBOTS_ALLOW);
      if (url.includes("eprint")) return new Response("unavailable", { status: 503 });
      if (url.includes("crossref")) return new Response("garbage{", { status: 200 });
      return new Response("", { status: 200 });
    });
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep });
    expect(run.shadowReport.halt).toMatchObject({ reason: "source-unavailable" });
    expect(run.shadowReport.halt?.subSources).toEqual(expect.arrayContaining(["arxiv", "iacr-eprint", "crossref"]));
    expect(run.accepted).toHaveLength(0);
  });

  it("marks robots-unavailable and robots-disallowed sub-sources and never fetches the page", async () => {
    const seen: string[] = [];
    const fetchImpl = fetchFrom(async (url) => {
      seen.push(url);
      if (url.includes("export.arxiv.org/robots.txt")) return new Response(ROBOTS_DENY);
      if (url.includes("eprint.iacr.org/robots.txt")) return new Response("down", { status: 500 });
      if (url.includes("api.crossref.org/robots.txt")) return new Response("x", { status: 404 });
      if (url.includes("api.crossref.org/works")) return new Response(crossref);
      throw new Error(`unexpected ${url}`);
    });
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep });
    expect(run.shadowReport.halt?.subSources).toEqual(expect.arrayContaining(["arxiv-robots-disallowed", "iacr-eprint-robots-unavailable"]));
    expect(seen.some((url) => url.includes("/api/query"))).toBe(false);
    expect(seen.some((url) => url.includes("/rss/"))).toBe(false);
    expect(run.accepted).toHaveLength(1);
  });

  it("halts with <sub>-truncated when a body exceeds the byte cap and never runs the parser", async () => {
    const parserSpy: PaperParser = vi.fn(parseArxivAtom as unknown as PaperParser) as unknown as PaperParser;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = fetchFrom(async (url) => {
      if (url.includes("robots.txt")) return url.includes("crossref") ? new Response("x", { status: 404 }) : new Response(ROBOTS_ALLOW);
      if (url.includes("/api/query")) return new Response(stream, { status: 200 });
      if (url.includes("eprint")) return new Response(rss);
      return new Response(crossref);
    });
    const run = await discoverPapers({
      limit: 10,
      contactEmail: "contact@example.org",
      fetchImpl,
      sleep: noSleep,
      parsers: { arxiv: parserSpy },
    });
    expect(run.shadowReport.halt).toMatchObject({ reason: "arxiv-truncated" });
    expect(parserSpy).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it("treats an over-cap declared content-length as truncated without reading the body", async () => {
    const fetchImpl = fetchFrom(async (url) => {
      if (url.includes("robots.txt")) return url.includes("crossref") ? new Response("x", { status: 404 }) : new Response(ROBOTS_ALLOW);
      if (url.includes("/api/query")) return new Response(atom, { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } });
      if (url.includes("eprint")) return new Response(rss);
      return new Response(crossref);
    });
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep });
    expect(run.shadowReport.halt?.subSources).toContain("arxiv-truncated");
  });

  it("counts robots reads and redirect hops against the budget and halts on exhaustion", async () => {
    let redirected = false;
    const fetchImpl = fetchFrom(async (url) => {
      if (url.includes("robots.txt")) return new Response(ROBOTS_ALLOW);
      if (url.includes("/api/query") && !redirected) {
        redirected = true;
        return new Response(undefined, { status: 302, headers: { location: "https://export.arxiv.org/api/query?redirected=1" } });
      }
      if (url.includes("/api/query")) return new Response(atom);
      if (url.includes("eprint")) return new Response(rss);
      return new Response(crossref);
    });
    // One robots read plus two arXiv hops plus two IACR reads plus two Crossref reads.
    const ok = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep, maxRequests: 7 });
    expect(ok.shadowReport.halt ?? null).toBeNull();
    expect(ok.shadowReport.requests).toBe(7);
    const exhausted = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep, maxRequests: 2 });
    expect(exhausted.shadowReport.halt?.reason).toBe("request-budget-exhausted");
    expect(exhausted.shadowReport.requests).toBe(2);
  });

  it("rejects a redirect to a non-allowlisted host without fetching it", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("robots.txt")) return new Response(ROBOTS_ALLOW);
      if (url.includes("/api/query")) return new Response(undefined, { status: 302, headers: { location: "https://evil.example/steal" } });
      if (url.includes("eprint")) return new Response(rss);
      return new Response(crossref);
    }) as unknown as typeof fetch;
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep });
    expect(run.shadowReport.halt?.subSources).toContain("arxiv");
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.includes("evil.example"))).toBe(false);
  });

  it.each([
    ["credential URL", "https://user:pass@export.arxiv.org/api/query"],
    ["percent-encoded lookalike", "https://export.arxiv.org/api%2fquery"],
    ["loopback IP", "https://127.0.0.1/api/query"],
  ])("halts and never follows a %s redirect", async (_name, location) => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("robots.txt")) return new Response(ROBOTS_ALLOW);
      if (url.includes("/api/query")) return new Response(undefined, { status: 302, headers: { location } });
      if (url.includes("eprint")) return new Response(rss);
      return new Response(crossref);
    }) as unknown as typeof fetch;
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep });
    expect(run.shadowReport.halt?.subSources).toContain("arxiv");
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(calls).not.toContain(location);
  });

  it("reuses a fresh IACR cache without contacting IACR", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    try {
      await writeFile(iacrCachePath(directory), JSON.stringify({
        state: "complete",
        source: "iacr-eprint",
        sourceUrl: "https://eprint.iacr.org/rss/rss.xml",
        finalUrl: "https://eprint.iacr.org/rss/rss.xml",
        endpointPolicyVersion: "papers-source-policy-v2",
        maxBodyBytes: 2 * 1024 * 1024,
        responseType: "application/rss+xml",
        attemptedAtMs: 1_000,
        body: rss,
      }));
      const fetchImpl = happyFetch();
      const run = await discoverPapers({
        limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => 2_000, cacheDir: directory,
      });
      expect(run.shadowReport.halt ?? null).toBeNull();
      const calls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => url);
      expect(calls.some((url) => url.includes("eprint.iacr.org"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["corrupt", "not json"],
    ["future", JSON.stringify({ state: "complete", source: "iacr-eprint", sourceUrl: "https://eprint.iacr.org/rss/rss.xml", finalUrl: "https://eprint.iacr.org/rss/rss.xml", endpointPolicyVersion: "papers-source-policy-v2", maxBodyBytes: 2 * 1024 * 1024, responseType: "application/rss+xml", attemptedAtMs: 2_000, body: rss })],
  ])("halts on %s IACR cadence state without fetching IACR", async (_name, state) => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    try {
      if (state !== undefined) await writeFile(iacrCachePath(directory), state);
      const fetchImpl = happyFetch();
      const run = await discoverPapers({
        limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => 1_000, cacheDir: directory,
      });
      expect(run.shadowReport.halt?.subSources).toEqual(expect.arrayContaining([expect.stringMatching(/^iacr-eprint-cache-/)]));
      const calls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => url);
      expect(calls.some((url) => url.includes("eprint.iacr.org"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bootstraps a missing IACR cache with one complete response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    try {
      const fetchImpl = happyFetch();
      const run = await discoverPapers({
        limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => 1_000, cacheDir: directory,
      });
      expect(run.shadowReport.halt ?? null).toBeNull();
      const calls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => url);
      expect(calls.filter((url) => url.includes("eprint.iacr.org")).length).toBe(2);
      const cached = JSON.parse(await readFile(iacrCachePath(directory), "utf8")) as { state?: string; attemptedAtMs?: number; body?: string };
      expect(cached).toMatchObject({ state: "complete", attemptedAtMs: 1_000, body: rss });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one concurrent IACR bootstrap attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    let releaseRss: (() => void) | undefined;
    let markRssStarted: (() => void) | undefined;
    const calls: string[] = [];
    const rssStarted = new Promise<void>((resolve) => {
      markRssStarted = resolve;
    });
    const rssRelease = new Promise<void>((resolve) => {
      releaseRss = resolve;
    });
    const fetchImpl = fetchFrom(async (url) => {
      calls.push(url);
      if (url.includes("robots.txt")) return new Response(ROBOTS_ALLOW);
      if (url.includes("eprint.iacr.org/rss")) {
        markRssStarted!();
        await rssRelease;
        return new Response(rss);
      }
      if (url.includes("/api/query")) return new Response(atom);
      return new Response(crossref);
    });
    try {
      const first = discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep, now: () => 1_000, cacheDir: directory, processId: 101 });
      await rssStarted;
      const second = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl, sleep: noSleep, now: () => 1_000, cacheDir: directory, processId: 102 });
      releaseRss!();
      await first;
      expect(second.shadowReport.halt?.subSources).toContain("iacr-eprint-cadence-pending");
      expect(calls.filter((url) => url.includes("eprint.iacr.org/rss")).length).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a pending attempt after the complete cache write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    const filesystem = {
      readFile, rename, mkdir, chmod, lstat, open, unlink,
      writeFile: async (path: Parameters<typeof writeFile>[0], data: Parameters<typeof writeFile>[1], options?: Parameters<typeof writeFile>[2]) => {
        if (String(data).includes("\"state\":\"complete\"")) throw new Error("disk full");
        return writeFile(path, data, options);
      },
    };
    try {
      const fetchImpl = happyFetch();
      const first = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => 1_000, cacheDir: directory, filesystem });
      expect(first.shadowReport.halt?.subSources).toContain("iacr-eprint");
      const secondFetch = happyFetch();
      const second = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl: secondFetch as unknown as typeof fetch, sleep: noSleep, now: () => 1_001, cacheDir: directory });
      expect(second.shadowReport.halt?.subSources).toContain("iacr-eprint-cadence-pending");
      expect((secondFetch.mock.calls as unknown as [string][]).some(([url]) => url.includes("eprint.iacr.org"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers only a stale claim owned by a dead process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    const now = 24 * 60 * 60 * 1_000;
    try {
      await writeFile(iacrCachePath(directory), JSON.stringify({
        state: "complete", source: "iacr-eprint", sourceUrl: "https://eprint.iacr.org/rss/rss.xml", finalUrl: "https://eprint.iacr.org/rss/rss.xml",
        endpointPolicyVersion: "papers-source-policy-v2", maxBodyBytes: 2 * 1024 * 1024, responseType: "application/rss+xml", attemptedAtMs: 0, body: rss,
      }));
      await writeFile(`${iacrCachePath(directory)}.claim`, JSON.stringify({ owner: "00000000-0000-4000-8000-000000000001", pid: 999, claimedAtMs: now - 60_000 }));
      const fetchImpl = happyFetch();
      const run = await discoverPapers({
        limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => now, cacheDir: directory, processId: 100, isProcessAlive: () => false,
      });
      expect(run.shadowReport.halt ?? null).toBeNull();
      expect((fetchImpl.mock.calls as unknown as [string][]).filter(([url]) => url.includes("eprint.iacr.org/rss")).length).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a stale claim while its owner is live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    const now = 24 * 60 * 60 * 1_000;
    try {
      await writeFile(iacrCachePath(directory), JSON.stringify({
        state: "complete", source: "iacr-eprint", sourceUrl: "https://eprint.iacr.org/rss/rss.xml", finalUrl: "https://eprint.iacr.org/rss/rss.xml",
        endpointPolicyVersion: "papers-source-policy-v2", maxBodyBytes: 2 * 1024 * 1024, responseType: "application/rss+xml", attemptedAtMs: 0, body: rss,
      }));
      await writeFile(`${iacrCachePath(directory)}.claim`, JSON.stringify({ owner: "00000000-0000-4000-8000-000000000001", pid: 999, claimedAtMs: now - 60_000 }));
      const fetchImpl = happyFetch();
      const run = await discoverPapers({
        limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => now, cacheDir: directory, processId: 100, isProcessAlive: () => true,
      });
      expect(run.shadowReport.halt?.subSources).toContain("iacr-eprint-cadence-busy");
      expect((fetchImpl.mock.calls as unknown as [string][]).some(([url]) => url.includes("eprint.iacr.org"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked IACR state file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-cache-"));
    try {
      const target = join(directory, "other");
      await writeFile(target, "state");
      await symlink(target, iacrCachePath(directory));
      const fetchImpl = happyFetch();
      const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, now: () => 1_000, cacheDir: directory });
      expect(run.shadowReport.halt?.subSources).toContain("iacr-eprint-cache-invalid");
      expect((fetchImpl.mock.calls as unknown as [string][]).some(([url]) => url.includes("eprint.iacr.org"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the arXiv clock moves backward", async () => {
    const times = [1_000, 999];
    const fetchImpl = happyFetch();
    const run = await discoverPapers({
      limit: 10,
      contactEmail: "contact@example.org",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      now: () => times.shift() ?? 999,
    });
    expect(run.shadowReport.halt?.subSources).toContain("arxiv");
    const calls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(calls.some((url) => url.includes("/api/query"))).toBe(false);
  });

  it("halts with crossref-contact-missing and never leaks the env value when JEB_CONTACT_EMAIL is absent", async () => {
    const fetchImpl = happyFetch();
    const run = await discoverPapers({ limit: 10, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    expect(run.shadowReport.halt).toMatchObject({ reason: "source-unavailable", subSources: ["crossref-contact-missing"] });
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("contact@example.org");
    expect(serialized).not.toContain("mailto");
    const calls = (fetchImpl.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(calls.some((url) => url.includes("api.crossref.org/works"))).toBe(false);
  });

  it("rejects syntactically invalid contact configuration without exposing it", async () => {
    const contactEmail = "jeb@synonym.to";
    const run = await discoverPapers({
      limit: 10,
      contactEmail: `${contactEmail} invalid`,
      fetchImpl: happyFetch() as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(run.shadowReport.halt?.subSources).toContain("crossref-contact-missing");
    expect(JSON.stringify(run)).not.toContain(contactEmail);
  });

  it("rejects a request limit over the hard ceiling before fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(discoverPapers({ limit: 101, contactEmail: "contact@example.org", fetchImpl })).rejects.toThrow("request budget");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("publishes rule labels for the three sub-sources through classification", async () => {
    const atomWithDoi = `<?xml version="1.0"?><feed><entry><id>https://arxiv.org/abs/2401.12345v2</id><title>Bitcoin signatures research</title><summary>Digital signatures for bitcoin.</summary><category term="cs.CR"/></entry></feed>`;
    const fetchImpl = happyFetch({ "https://export.arxiv.org/api/query": atomWithDoi });
    const run = await discoverPapers({ limit: 10, contactEmail: "contact@example.org", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    const byHost = new Map(run.accepted.map((resource) => [new URL(resource.displayValue).hostname, resource]));
    expect(byHost.get("arxiv.org")?.labels).toEqual(expect.arrayContaining(["paper", "academic", "arxiv"]));
    expect(byHost.get("eprint.iacr.org")?.labels).toEqual(expect.arrayContaining(["paper", "academic", "iacr-eprint", "cryptography"]));
    expect(byHost.get("doi.org")?.labels).toEqual(expect.arrayContaining(["paper", "academic"]));
    expect(byHost.get("eprint.iacr.org")?.category).toBe("cryptography");
    expect(run.accepted.every((resource) => resource.tagHints && resource.tagHints.length > 0)).toBe(true);
  });
});

describe("papers end-to-end refusal", () => {
  beforeEach(() => {
    delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
    delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
    delete process.env.PUBKY_BOT_MNEMONIC;
    delete process.env.JEB_RESOURCE_TARGET;
    delete process.env.JEB_RESOURCE_MODE;
    delete process.env.JEB_HOMESERVER;
  });

  afterEach(() => {
    delete process.env.JEB_RESOURCE_TARGET;
    delete process.env.JEB_RESOURCE_MODE;
    delete process.env.JEB_HOMESERVER;
  });

  it.each(["publish", "reconcile"] as const)("%s refuses with an all-500 transport and makes zero homeserver calls", async (mode) => {
    const homeserverCalls: string[] = [];
    const transport = {
      botPk: "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
      resolvedHomeserverPk: STAGING_HOMESERVER_PK,
      putJson: async (path: string) => {
        homeserverCalls.push(path);
      },
      putBytes: async () => {
        homeserverCalls.push("putBytes");
      },
      getJson: async (path: string) => {
        homeserverCalls.push(path);
        throw new Error("404");
      },
      deleteJson: async (path: string) => {
        homeserverCalls.push(path);
      },
      listPosts: async () => [],
      reauth: async () => {},
    };
    const allFiveHundred = (async () => new Response("server error", { status: 500 })) as typeof fetch;
    const directory = await mkdtemp(join(tmpdir(), "jeb-papers-e2e-"));
    try {
      const buildStampPath = join(directory, "build-stamp.json");
      await writeFile(
        buildStampPath,
        JSON.stringify({
          configVersion: RESOURCE_CONFIG_VERSION,
          gitHead: "papers-e2e-head",
          sourceHash: await sourceTreeHash(),
        }),
      );
      process.env.JEB_RESOURCE_TARGET = "staging";
      process.env.JEB_RESOURCE_MODE = "shadow";
      process.env.JEB_HOMESERVER = STAGING_HOMESERVER_PK;
      await expect(
        runResourcesCli(
          configFromProcessEnv({ requireSecret: false, role: "resources" }),
          ["node", "main.js", "--role", "resources", "--source", "papers", "--mode", mode, "--target", "staging", "--limit", "5"],
          { transport, buildStampPath, gitHead: "papers-e2e-head", fetchImpl: allFiveHundred },
        ),
      ).rejects.toThrow("refused: source-unavailable");
      expect(homeserverCalls).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
