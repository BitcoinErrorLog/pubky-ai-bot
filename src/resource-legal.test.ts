import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { discoverLegalResources, LEGAL_MAX_BODY_BYTES, legalSleep, parseLegalJson } from "./resource-legal.js";
import { configFromProcessEnv } from "./config.js";
import { runResourcesCli } from "./resources.js";
import { RESOURCE_PILOT_BOT_PK, STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { sourceTreeHash } from "./source-tree-hash.js";
import { execFileSync } from "node:child_process";
import { resetFetchState } from "./resource-fetch.js";

const federalFixture = JSON.parse(readFileSync(new URL("./test-fixtures/legal/federal-register.json", import.meta.url), "utf8")) as unknown;
const edgarFixture = JSON.parse(readFileSync(new URL("./test-fixtures/legal/sec-edgar.json", import.meta.url), "utf8")) as unknown;
const TEST_DIR = "/tmp/jeb-n6";

function cacheDir(name: string): string {
  return join(TEST_DIR, `legal-test-${name}`);
}

async function prepareCache(name: string): Promise<string> {
  const dir = cacheDir(name);
  await mkdir(dir, { recursive: true });
  resetFetchState();
  return dir;
}

const dnsLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const validFederalRow = {
  html_url: "https://www.federalregister.gov/documents/2026/09/10/ABC-1/a-rule",
  document_number: "ABC-1",
  type: "Rule",
  title: "A rule",
  agencies: [{ name: "SEC" }],
};
const validEdgarHit = {
  _id: "0000123456-26-000001:form.htm",
  _source: { ciks: ["123456"], form_type: ["8-K"], display_names: ["Example Corp"], file_date: "2026-09-10" },
};

async function cliStamp(): Promise<string> {
  const path = join(TEST_DIR, `stamp-${Date.now()}-${Math.random()}.json`);
  await writeFile(path, JSON.stringify({
    configVersion: "external-resources-v3-bitcoin-canon",
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHash: await sourceTreeHash(),
  }));
  return path;
}

describe("legal resource adapter", () => {
  it("positively discovers both legal sub-sources and maps every Federal Register type", async () => {
    const result = await discoverLegalResources({
      limit: 100,
      contactEmail: "legal@example.test",
      federalFixture,
      edgarFixture,
      now: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(result.shadowReport.halt).toBeNull();
    expect(result.legalSubSources).toEqual({ federalRegister: 20, edgar: 80 });
    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.accepted.every((item) => ["www.federalregister.gov", "www.sec.gov"].includes(new URL(item.displayValue).hostname))).toBe(true);
    expect(result.accepted.every((item) => item.labels.includes("jurisdiction:us"))).toBe(true);
    const kindRows = ["Rule", "Proposed Rule", "Notice", "Presidential Document"].map((type, index) => ({
      ...validFederalRow,
      document_number: `ABC-${index + 1}`,
      html_url: `https://www.federalregister.gov/documents/2026/09/10/ABC-${index + 1}/a-rule`,
      type,
    }));
    const kindResult = await discoverLegalResources({ limit: 4, contactEmail: "legal@example.test", federalFixture: { results: kindRows }, edgarFixture: { hits: { hits: [] } } });
    const types = new Set(kindResult.accepted.filter((item) => item.metadata?.subSource === "federal-register").map((item) => item.taxonomy.type[0]));
    expect(types).toEqual(new Set(["regulation", "proposed-rule", "notice", "presidential-document"]));
  });

  it("negatively rejects malformed identifiers without interpolating them into URLs", async () => {
    const result = await discoverLegalResources({
      limit: 10,
      federalFixture: { results: [{ html_url: "https://evil.example/a", document_number: "../secret", type: "Rule" }] },
      edgarFixture,
      now: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(result.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(result.shadowReport.unavailableSources).toEqual([{ id: "edgar", reason: "contact-missing" }]);
    expect(result.legalRejections).toContainEqual(expect.objectContaining({ reason: "invalid-canonical-url" }));
    expect(result.legalRejections[0]?.value).toBe("https://evil.example/a");
    expect(result.accepted.some((item) => item.displayValue.includes("secret"))).toBe(false);
  });

  it("positively records a source-unavailable halt for an unreachable source", async () => {
    const result = await discoverLegalResources({ limit: 1, contactEmail: "legal@example.test", federalFixture: { results: [] }, edgarFixture });
    expect(result.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(result.shadowReport.unavailableSources).toEqual([{ id: "federal-register", reason: "federal-register-empty" }]);
  });

  it("negatively fails closed for empty, non-JSON, and wrong-shaped source responses", async () => {
    for (const [name, body] of [["empty", ""], ["non-json", "not json"], ["shape", JSON.stringify({ results: "x" })]] as const) {
      const dir = await prepareCache(name);
      const fetchImpl = async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
      const result = await discoverLegalResources({ limit: 1, contactEmail: undefined, fetchImpl, dnsLookup, cacheDir: dir });
      expect(result.shadowReport.unavailableSources).toContainEqual({ id: "federal-register", reason: expect.any(String) });
      expect(result.accepted).toEqual([]);
    }
  });

  it("positively halts with a sub-source truncation reason before parsing", async () => {
    const dir = await prepareCache("truncated");
    const parseJson = vi.fn(parseLegalJson);
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("[" + "x".repeat(LEGAL_MAX_BODY_BYTES + 1) + "]", {
        headers: { "content-type": "application/json" },
      });
    };
    const result = await discoverLegalResources({
      limit: 1,
      contactEmail: "legal@example.test",
      fetchImpl,
      dnsLookup,
      cacheDir: dir,
      parseJson,
    });
    expect(result.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(result.shadowReport.unavailableSources).toContainEqual({ id: "federal-register", reason: "truncated" });
    expect(parseJson).not.toHaveBeenCalled();
    expect(result.legalRejections).toEqual([]);
  });

  it("negatively counts robots and page requests toward an injected request budget", async () => {
    const dir = await prepareCache("budget");
    let requests = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      requests += 1;
      return String(input).endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ results: [validFederalRow] }), { headers: { "content-type": "application/json" } });
    };
    const result = await discoverLegalResources({ limit: 1, contactEmail: undefined, fetchImpl, dnsLookup, cacheDir: dir, maxRequests: 1 });
    expect(requests).toBe(1);
    expect(result.shadowReport.requests).toBe(2);
    expect(result.shadowReport.halt).toEqual({ reason: "request-budget-exhausted" });
    expect(result.shadowReport.unavailableSources).toContainEqual({ id: "federal-register", reason: "request-budget-exhausted" });
  });

  it("positively rejects a limit above 100 before any transport request", async () => {
    let fetched = false;
    await expect(discoverLegalResources({ limit: 101, fetchImpl: async () => { fetched = true; return new Response(); } })).rejects.toThrow("1 to 100");
    expect(fetched).toBe(false);
  });

  it("negatively blocks a redirect to a non-allowlisted host before fetch", async () => {
    const dir = await prepareCache("redirect");
    const seen: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      seen.push(String(input));
      if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("", { status: 302, headers: { location: "https://evil.example/redirect" } });
    };
    const result = await discoverLegalResources({ limit: 1, contactEmail: undefined, fetchImpl, dnsLookup, cacheDir: dir });
    expect(seen.some((url) => url.includes("evil.example"))).toBe(false);
    expect(result.shadowReport.unavailableSources).toContainEqual({ id: "federal-register", reason: expect.stringContaining("allowlist") });
  });

  it("positively keeps canonical identities on the exact required HTTPS hosts", async () => {
    const result = await discoverLegalResources({ limit: 2, contactEmail: "legal@example.test", federalFixture: { results: [validFederalRow] }, edgarFixture: { hits: { hits: [validEdgarHit] } } });
    expect(result.accepted.map((item) => new URL(item.displayValue).origin)).toEqual(["https://www.federalregister.gov", "https://www.sec.gov"]);
  });

  it("positively canonicalizes padded EDGAR CIKs to the SEC archive integer", async () => {
    const padded = {
      _id: "0000123456-26-000001:form.htm",
      _source: { ciks: ["0001588489"], form_type: ["8-K"], display_names: ["Example Corp"] },
    };
    const unpadded = { ...padded, _source: { ...padded._source, ciks: ["1588489"] } };
    const paddedResult = await discoverLegalResources({
      limit: 1,
      contactEmail: "legal@example.test",
      federalFixture: { results: [] },
      edgarFixture: { hits: { hits: [padded] } },
    });
    const unpaddedResult = await discoverLegalResources({
      limit: 1,
      contactEmail: "legal@example.test",
      federalFixture: { results: [] },
      edgarFixture: { hits: { hits: [unpadded] } },
    });
    const paddedUrl = paddedResult.accepted[0]?.displayValue;
    const unpaddedUrl = unpaddedResult.accepted[0]?.displayValue;
    expect(paddedUrl).toBe("https://www.sec.gov/Archives/edgar/data/1588489/000012345626000001/form.htm");
    expect(paddedUrl).toBe(unpaddedUrl);
  });

  it("negatively rejects an all-zero EDGAR CIK", async () => {
    const result = await discoverLegalResources({
      limit: 1,
      contactEmail: "legal@example.test",
      federalFixture: { results: [] },
      edgarFixture: { hits: { hits: [{ ...validEdgarHit, _source: { ...validEdgarHit._source, ciks: ["0000000000"] } }] } },
    });
    expect(result.legalRejections).toContainEqual({ subSource: "edgar", reason: "invalid-cik", value: "0000000000" });
  });

  it("positively maps exact Federal Register agency names", async () => {
    const result = await discoverLegalResources({
      limit: 2,
      contactEmail: "legal@example.test",
      federalFixture: { results: [
        { ...validFederalRow, agencies: [{ name: "Federal Deposit Insurance Corporation" }] },
        { ...validFederalRow, document_number: "ABC-2", html_url: validFederalRow.html_url.replace("ABC-1", "ABC-2"), agencies: [{ name: "Homeland Security Department" }] },
      ] },
      edgarFixture: { hits: { hits: [] } },
    });
    expect(result.accepted[0]?.labels).toContain("fdic");
    expect(result.accepted[1]?.labels).not.toContain("sec");
  });

  it("negatively sanitizes and caps every EDGAR rejection value", async () => {
    const result = await discoverLegalResources({
      limit: 1,
      contactEmail: "legal@example.test",
      federalFixture: { results: [] },
      edgarFixture: { hits: { hits: [
        { ...validEdgarHit, _source: { ...validEdgarHit._source, ciks: ["\u202E123"] } },
        { ...validEdgarHit, _id: `\u202E${"x".repeat(200)}:form.htm` },
        { ...validEdgarHit, _id: "0000123456-26-000001:\u200B." },
        { ...validEdgarHit, _source: { ...validEdgarHit._source, form_type: ["\u202E8-k"] } },
      ] } },
    });
    expect(result.legalRejections.length).toBe(4);
    for (const rejection of result.legalRejections) {
      expect(rejection.value?.length ?? 0).toBeLessThanOrEqual(120);
      if (rejection.value !== undefined) expect(rejection.value).not.toMatch(/[\u200B-\u200F\u202A-\u202E]/);
    }
  });

  it("negatively rejects dot-only and single-character EDGAR file names", async () => {
    const result = await discoverLegalResources({
      limit: 1,
      contactEmail: "legal@example.test",
      federalFixture: { results: [] },
      edgarFixture: { hits: { hits: [{ ...validEdgarHit, _id: "0000123456-26-000001:." }] } },
    });
    expect(result.legalRejections).toContainEqual({ subSource: "edgar", reason: "invalid-file-name", value: "." });
  });

  it("positively exposes the production EDGAR pacing delay", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    await legalSleep(150);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 150);
    timer.mockRestore();
  });

  it("negatively rejects identifier fuzz without building a URL", async () => {
    const badValues = ["..", "/", "%2e", "%2F", "１２３", "\u200b123", "\u0000123", "x".repeat(2_048)];
    for (const value of badValues) {
      const result = await discoverLegalResources({
        limit: 1,
        federalFixture: { results: [{ ...validFederalRow, document_number: value }] },
        edgarFixture: { hits: { hits: [{ ...validEdgarHit, _id: `${value}:form.htm` }] } },
        contactEmail: "legal@example.test",
      });
      expect(result.accepted.every((item) => !item.displayValue.includes(value))).toBe(true);
    }
  });

  it("positively bounds hostile numeric and deeply nested JSON", () => {
    expect(() => parseLegalJson('{"value":1e400}')).toThrow("json-bounds-exceeded");
    const deep = "[".repeat(100_001) + "]".repeat(100_001);
    expect(() => parseLegalJson(deep)).toThrow();
  });

  it("negatively rejects duplicate keys and non-object rows", async () => {
    expect(() => parseLegalJson('{"results":[],"results":[]}')).toThrow("duplicate-json-key");
    const result = await discoverLegalResources({ limit: 1, federalFixture: { results: [null, "row", 1] }, edgarFixture });
    expect(result.legalRejections).toEqual([
      { subSource: "federal-register", reason: "invalid-record" },
      { subSource: "federal-register", reason: "invalid-record" },
      { subSource: "federal-register", reason: "invalid-record" },
    ]);
  });

  it("positively refuses publish and reconcile after all-500 discovery without homeserver calls", async () => {
    const stampPath = await cliStamp();
    let writes = 0;
    const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
    cfg.homeserverPk = STAGING_HOMESERVER_PK;
    const all500 = async () => new Response("", { status: 500 });
    for (const mode of ["publish", "reconcile"] as const) {
      const args = ["node", "main.js", "--role", "resources", "legal", "--source", "legal", "--mode", mode, "--target", "staging", "--limit", "1"];
      if (mode === "reconcile") args.push("--reconcile", "full", "--expected-pk", RESOURCE_PILOT_BOT_PK);
      await expect(runResourcesCli(cfg, args, {
        buildStampPath: stampPath,
        fetchImpl: all500,
        dnsLookup,
        transport: { putJson: async () => { writes += 1; }, putBytes: async () => {}, getJson: async () => { throw new Error("unexpected"); }, deleteJson: async () => [], listPosts: async () => [], reauth: async () => {}, botPk: RESOURCE_PILOT_BOT_PK },
      })).rejects.toThrow("source-unavailable");
    }
    expect(writes).toBe(0);
  });

  it("negatively refuses a partial Federal Register/EDGAR failure", async () => {
    const stampPath = await cliStamp();
    const oldContact = process.env.JEB_CONTACT_EMAIL;
    process.env.JEB_CONTACT_EMAIL = "partial@example.test";
    try {
      const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
      cfg.homeserverPk = STAGING_HOMESERVER_PK;
      const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("efts.sec.gov")) return new Response("", { status: 500 });
        if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
        return new Response(JSON.stringify({ results: [validFederalRow] }), { headers: { "content-type": "application/json" } });
      };
      await expect(runResourcesCli(cfg, ["node", "main.js", "--role", "resources", "legal", "--source", "legal", "--mode", "publish", "--target", "staging", "--limit", "1"], {
        buildStampPath: stampPath,
        fetchImpl,
        dnsLookup,
        transport: { putJson: async () => { throw new Error("must not write"); }, putBytes: async () => {}, getJson: async () => [], deleteJson: async () => {}, listPosts: async () => [], reauth: async () => {}, botPk: RESOURCE_PILOT_BOT_PK },
      })).rejects.toThrow("source-unavailable");
    } finally {
      if (oldContact === undefined) delete process.env.JEB_CONTACT_EMAIL;
      else process.env.JEB_CONTACT_EMAIL = oldContact;
    }
  });

  it("positively keeps contact-missing diagnostics free of the contact value", async () => {
    const sentinel = "sentinel-contact-value@example.test";
    const oldContact = process.env.JEB_CONTACT_EMAIL;
    process.env.JEB_CONTACT_EMAIL = sentinel;
    try {
      const result = await discoverLegalResources({ limit: 1, contactEmail: " " });
      const output = JSON.stringify(result);
      expect(output).not.toContain(sentinel);
      expect(output).toContain("contact-missing");
    } finally {
      if (oldContact === undefined) delete process.env.JEB_CONTACT_EMAIL;
      else process.env.JEB_CONTACT_EMAIL = oldContact;
    }
  });

  it("negatively keeps labels deterministic and agency/form labels bounded", async () => {
    const customFederal = { results: [{ ...validFederalRow, agencies: [{ name: "Unknown agency" }] }] };
    const customEdgar = { hits: { hits: [{ ...validEdgarHit, _source: { ...validEdgarHit._source, form_type: ["1234567890123"] } }] } };
    const first = await discoverLegalResources({ limit: 1, federalFixture: customFederal, edgarFixture: customEdgar, contactEmail: "legal@example.test" });
    const second = await discoverLegalResources({ limit: 1, federalFixture: customFederal, edgarFixture: customEdgar, contactEmail: "legal@example.test" });
    expect(first.accepted.map((item) => item.labels)).toEqual(second.accepted.map((item) => item.labels));
    expect(first.accepted.flatMap((item) => item.labels).some((label) => label.includes("unknown"))).toBe(false);
    expect(first.accepted.every((item) => item.metadata?.subSource !== "edgar" || /^[0-9a-z-]{1,12}$/.test(String(item.metadata.formType)))).toBe(true);
  });
});
