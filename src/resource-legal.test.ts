import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { discoverLegalResources, LEGAL_MAX_BODY_BYTES } from "./resource-legal.js";
import { configFromProcessEnv } from "./config.js";
import { runResourcesCli } from "./resources.js";
import { STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { sourceTreeHash } from "./source-tree-hash.js";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const federalFixture = JSON.parse(readFileSync(new URL("./test-fixtures/legal/federal-register.json", import.meta.url), "utf8")) as unknown;
const edgarFixture = JSON.parse(readFileSync(new URL("./test-fixtures/legal/sec-edgar.json", import.meta.url), "utf8")) as unknown;

describe("legal resource adapter", () => {
  it("discovers verified Federal Register and EDGAR metadata round-robin", async () => {
    const result = await discoverLegalResources({
      limit: 20,
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
  });

  it("fails closed for missing contact and malformed Federal Register rows", async () => {
    const result = await discoverLegalResources({
      limit: 10,
      federalFixture: { results: [{ html_url: "https://evil.example/a", document_number: "../secret", type: "Rule" }] },
      edgarFixture,
      now: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(result.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(result.legalRejections).toContainEqual(expect.objectContaining({ reason: "invalid-canonical-url" }));
    expect(result.legalRejections[0]?.value).toBe("https://evil.example/a");
  });

  it("halts on a response above the byte cap without parsing it", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "jeb-legal-"));
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
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      cacheDir,
    });
    expect(result.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(result.legalRejections).toEqual([]);
  });

  it.each(["publish", "reconcile"] as const)("refuses %s after an all-500 discovery", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-legal-cli-"));
    const stampPath = join(directory, "build-stamp.json");
    await writeFile(stampPath, JSON.stringify({
      configVersion: "external-resources-v3-bitcoin-canon",
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceHash: await sourceTreeHash(),
    }));
    let writes = 0;
    const cfg = configFromProcessEnv({ requireSecret: false, role: "resources" });
    cfg.homeserverPk = STAGING_HOMESERVER_PK;
    const all500 = async () => new Response("", { status: 500 });
    await expect(runResourcesCli(cfg, ["node", "main.js", "--role", "resources", "legal", "--source", "legal", "--mode", mode, "--target", "staging", "--limit", "1"], {
      buildStampPath: stampPath,
      fetchImpl: all500,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: { putJson: async () => { writes += 1; }, putBytes: async () => {}, getJson: async () => { throw new Error("unexpected"); }, deleteJson: async () => {}, listPosts: async () => [], reauth: async () => {}, botPk: "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo" },
    })).rejects.toThrow("source-unavailable");
    expect(writes).toBe(0);
  });
});
