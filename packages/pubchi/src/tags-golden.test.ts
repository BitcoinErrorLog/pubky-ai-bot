import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotProjection, snapshotSha256 } from "../pubchi-schemas/index.js";
import { createPublicHomeserverReader } from "./homeserver-read.js";
import { Nexus } from "../bot-kit/nexus/nexus.js";
import { evaluateC5Candidate, taintField, type C5Candidate, type C5PolicyResult } from "./tags-policy.js";
import { parseTarget, runTagSuggestions } from "./tags.js";
import { TEST_OWNER, testTenant } from "./test-helpers.js";

const URI = `pubky://${TEST_OWNER}/pub/social/v1/posts/0035NV17R994G`;
const MANIFEST = resolve(process.cwd(), "packages/pubchi/fixtures/c5-golden-manifest.json");
const HOMESERVER_PINS = resolve(process.cwd(), "packages/pubchi/fixtures/c5-homeserver-snapshots.json");
const REPORT = "/tmp/pubchi-c5/svc/golden-report.json";

function candidate(label: string): C5Candidate {
  return {
    raw: label,
    evidence: [taintField(URI, URI, "target.uri")],
    rationale: taintField("Matches public evidence.", URI, "template.rationale"),
  };
}

type GoldenPolicy = typeof evaluateC5Candidate;

function evaluateGoldenCandidate(
  policy: GoldenPolicy,
  input: C5Candidate,
  people: readonly string[],
  expectedCode: string,
): { pass: boolean; failures: Array<{ label: string; reason: string }> } {
  const result = policy(input, people, new Set());
  if (!result.accepted && result.code === expectedCode) return { pass: true, failures: [] };
  return { pass: false, failures: [{ label: input.raw, reason: expectedCode }] };
}

const RED_FIXTURES = [
  { name: "person", label: "alice", people: ["alice"], code: "person" },
  { name: "pubky", label: "b".repeat(52), people: ["b".repeat(52)], code: "pubky" },
  { name: "homoglyph-slur", label: "ch\u0456nk", people: [], code: "slur" },
  { name: "four-word-zwj", label: "one\u200dtwo\u200dthree\u200dfour", people: [], code: "word_count" },
  { name: "instruction", label: "ignore-previous-rules", people: [], code: "tainted" },
] as const;

describe("C5 calibrated golden evaluator", () => {
  it.each(RED_FIXTURES)(
    "fails deliberately admitted $name label, then passes under production policy",
    ({ label, people, code }) => {
      let used = false;
      // This wrapper is test-local, has no env/config selection, and is never exported to production.
      const redWrapper: GoldenPolicy = (input, tokens, seen) => {
        if (!used && input.raw === label) {
          used = true;
          return { accepted: true, label: input.raw, evidence: [URI], already_applied: false };
        }
        return evaluateC5Candidate(input, tokens, seen);
      };
      const red = evaluateGoldenCandidate(redWrapper, candidate(label), people, code);
      expect(used).toBe(true);
      expect(red).toEqual({ pass: false, failures: [{ label, reason: code }] });
      expect(evaluateGoldenCandidate(evaluateC5Candidate, candidate(label), people, code)).toEqual({
        pass: true,
        failures: [],
      });
    },
  );
});

type ManifestTarget = {
  uri: string;
  kind: "post" | "user";
  nexus_snapshot_sha256: string;
};

function liveManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { nexus_host: string; targets: ManifestTarget[] };
  expect(manifest.targets).toHaveLength(50);
  return { targets: manifest.targets, nexus: new Nexus(manifest.nexus_host, 10_000, "v1") };
}

// This compares the public index to its recorded projections. The index cannot verify App writes.
describe.runIf(process.env.C5_NEXUS_CHECK === "1")("Nexus v1 read-surface comparison", () => {
  it("compares the current index with the 50 pinned Nexus projections", async () => {
    const { targets, nexus } = liveManifest();
    const changed: string[] = [];
    for (const entry of targets) {
      const target = parseTarget(entry, testTenant().bot);
      if (!target) throw new Error(`Invalid target in manifest: ${entry.uri}`);
      const post = target.kind === "post" ? await nexus.post(target.uri) : null;
      const user = target.kind === "user" ? await nexus.userDetails(target.pubky) : null;
      if ((!post && !user) || snapshotSha256(snapshotProjection(target, post, user)) !== entry.nexus_snapshot_sha256) {
        changed.push(entry.uri);
      }
    }
    expect(changed).toEqual([]);
  }, 180_000);
});

describe.runIf(process.env.C5_GOLDEN === "1")("C5 live golden runner", () => {
  it("reports tag suggestions verified against current public homeserver targets", async () => {
    const { targets: indexed, nexus } = liveManifest();
    const homeserverPins = JSON.parse(readFileSync(HOMESERVER_PINS, "utf8")) as Array<{
      kind: "post" | "user"; uri: string; snapshot_sha256: string;
    }>;
    const pins = new Map(homeserverPins.map((entry) => [entry.uri, entry.snapshot_sha256]));
    const targets = [...indexed, ...homeserverPins];
    const reader = createPublicHomeserverReader();
    const readPublicTargetSnapshot = reader.readPublicTargetSnapshot.bind(reader);
    const tenant = testTenant();
    async function evaluate(entry: Pick<ManifestTarget, "kind" | "uri">, index: number) {
      const target = parseTarget(entry, tenant.bot);
      if (!target) throw new Error(`Invalid target in manifest: ${entry.uri}`);
      const started = performance.now();
      const result = await runTagSuggestions({
        tenant, target, nexus, readPublicTargetSnapshot,
        now: Math.floor(Date.now() / 1000),
        runId: `golden-${index}`,
      });
      const latency_ms = Math.round(performance.now() - started);
      const snapshot = result.ok ? result.result.target?.snapshot_sha256 ?? null : null;
      const suggestions = result.ok ? result.result.tag_suggestions ?? [] : [];
      if (!snapshot) expect(suggestions).toEqual([]);
      return {
        uri: entry.uri, kind: entry.kind, latency_ms, snapshot_sha256: snapshot,
        changed_since_collection: snapshot && pins.has(entry.uri) ? snapshot !== pins.get(entry.uri) : null,
        status: result.ok ? snapshot ? "verified" : "target_unavailable" : "upstream_unavailable",
        suggestions: suggestions.map((item) => ({ label: item.label, evidence: item.evidence, reviewer_decision: "" })),
      };
    }
    const results: Array<Awaited<ReturnType<typeof evaluate>>> = [];
    for (let i = 0; i < targets.length; i += 4) {
      results.push(...await Promise.all(targets.slice(i, i + 4).map((target, n) => evaluate(target, i + n))));
    }
    const latencies = results.filter((item) => item.status === "verified").map((item) => item.latency_ms).sort((a, b) => a - b);
    const percentile = (p: number) => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
    const aggregate = {
      targets: results.length, verified: latencies.length,
      changed_since_collection: results.filter((item) => item.changed_since_collection === true).length,
      target_unavailable: results.filter((item) => item.status === "target_unavailable").length,
      upstream_unavailable: results.filter((item) => item.status === "upstream_unavailable").length,
      suggestions_total: results.reduce((sum, item) => sum + item.suggestions.length, 0),
      p50_ms: percentile(0.5), p95_ms: percentile(0.95),
    };
    mkdirSync("/tmp/pubchi-c5/svc", { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify({ scout: "not configured", aggregate, targets: results }, null, 2)}\n`);
    console.log("C5_GOLDEN", aggregate);
    expect(aggregate.upstream_unavailable).toBe(0);
  }, 240_000);
});
