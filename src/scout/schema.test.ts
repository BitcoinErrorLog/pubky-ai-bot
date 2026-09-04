import { afterEach, describe, expect, it } from "vitest";
import { guardRawCypher } from "./guard.js";
import {
  refreshScoutSchema,
  resetScoutSchemaCacheForTests,
  schemaHealthSnapshot,
  setActiveScoutSchemaForTests,
} from "./schema-cache.js";
import { templateSchemaDeps } from "./schema-deps.js";
import { graphIndex, loadGoldenScoutGraph, parseScoutGraph, type ScoutGraph } from "./schema-model.js";
import { summarizeScoutSchema } from "./schema-summary.js";

const opts = { limitMax: 50, profilePropMax: 3, rawEnabled: true };
const USER = "1111111111111111111111111111111111111111111111111111";

afterEach(() => {
  resetScoutSchemaCacheForTests();
});

describe("template schema dependencies", () => {
  it("every template label, rel type, and property exists on the golden schema", () => {
    const golden = loadGoldenScoutGraph();
    const idx = graphIndex(golden);
    const deps = templateSchemaDeps();
    expect(deps.labels.length).toBeGreaterThan(0);
    expect(deps.relTypes.length).toBeGreaterThan(0);
    const missingLabels = deps.labels.filter((l) => !idx.labels.has(l));
    const missingRels = deps.relTypes.filter((r) => !idx.relTypes.has(r));
    const missingProps = deps.properties.filter((p) => !idx.properties.has(p));
    expect({ missingLabels, missingRels, missingProps }).toEqual({
      missingLabels: [],
      missingRels: [],
      missingProps: [],
    });
  });
});

describe("schema-aware raw guard", () => {
  it("rejects a label not in the active schema", () => {
    const r = guardRawCypher("MATCH (n:GhostInternal) RETURN n.id LIMIT 5", {}, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown label GhostInternal/);
  });

  it("rejects a relationship type not in the active schema", () => {
    const r = guardRawCypher("MATCH (a:User)-[:HIDES]->(b:User) RETURN a.id LIMIT 5", {}, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown relationship type HIDES/);
  });

  it("rejects a property not in the active schema", () => {
    const r = guardRawCypher("MATCH (n:User) RETURN n.secret_internal LIMIT 5", {}, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown property secret_internal/);
  });

  it("rejects a schema-present label marked private/denied", () => {
    const golden = loadGoldenScoutGraph();
    const schema: ScoutGraph = {
      ...golden,
      nodes: golden.nodes.map((n) => (n.label === "File" ? { ...n, private: true } : n)),
    };
    const r = guardRawCypher("MATCH (f:File) RETURN f.id LIMIT 5", {}, { ...opts, schema });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/private\/denied label File/);
  });

  it("allows a label added by a live schema after refresh", async () => {
    const golden = loadGoldenScoutGraph();
    const live: ScoutGraph = {
      ...golden,
      nodes: [
        ...golden.nodes,
        { label: "Topic", properties: { id: { type: "string" } } },
      ],
    };
    await refreshScoutSchema({ schema: async () => live });
    const r = guardRawCypher("MATCH (t:Topic) RETURN t.id LIMIT 5", {}, opts);
    expect(r.ok, r.reason).toBe(true);
    expect(schemaHealthSnapshot().source).toBe("live");
    expect(schemaHealthSnapshot().labels).toContain("Topic");
  });

  it("stays on golden-fallback and still rejects unknown labels", async () => {
    resetScoutSchemaCacheForTests();
    const out = await refreshScoutSchema({
      schema: async () => {
        throw new Error("network down");
      },
    });
    expect(out.ok).toBe(false);
    expect(out.source).toBe("golden");
    expect(schemaHealthSnapshot().source).toBe("golden");
    expect(schemaHealthSnapshot().fallbackCount).toBeGreaterThanOrEqual(1);
    const okUser = guardRawCypher("MATCH (n:User) RETURN n.id LIMIT 5", {}, opts);
    expect(okUser.ok, okUser.reason).toBe(true);
    const ghost = guardRawCypher("MATCH (n:GhostInternal) RETURN n.id LIMIT 5", {}, opts);
    expect(ghost.ok).toBe(false);
  });

  it("keeps profiling denylist after schema allow", () => {
    const r = guardRawCypher(
      `MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN u.name, u.bio, u.status, u.image, p.content LIMIT 50`,
      { id: USER },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/person-profiling/);
  });
});

describe("schema summary", () => {
  it("pins compact deterministic output on the golden schema", () => {
    const golden = loadGoldenScoutGraph();
    const s = summarizeScoutSchema(golden);
    expect(s.chars).toBeLessThanOrEqual(2000);
    expect(s.text).toBe(
      [
        "NODES",
        "File: content_type,id,name,owner_id,size,src,uri",
        "Post: attachments,content,id,indexed_at,kind",
        "User: bio,id,image,indexed_at,links,name,status",
        "RELS",
        "AUTHORED User->Post",
        "BOOKMARKED User->Post (id,indexed_at)",
        "FOLLOWS User->User (id,indexed_at)",
        "MENTIONED Post->User",
        "MUTED User->User (indexed_at)",
        "REPLIED Post->Post",
        "REPOSTED Post->Post",
        "TAGGED User->Post (id,indexed_at,label)",
        "TAGGED User->User (id,indexed_at,label)",
      ].join("\n"),
    );
    expect(JSON.parse(s.json).labels).toEqual(["File", "Post", "User"]);
  });
});

describe("schema health snapshot", () => {
  it("reports golden source and counts", () => {
    resetScoutSchemaCacheForTests();
    const h = schemaHealthSnapshot();
    expect(h.source).toBe("golden");
    expect(h.labels).toEqual(["File", "Post", "User"]);
    expect(h.relationshipTypes).toEqual(
      ["AUTHORED", "BOOKMARKED", "FOLLOWS", "MENTIONED", "MUTED", "REPLIED", "REPOSTED", "TAGGED"].sort(),
    );
    expect(h.propertyCounts.nodes).toBe(3);
    expect(h.propertyCounts.relationships).toBe(9);
    expect(h.fetched_at).toMatch(/^\d{4}-/);
  });

  it("parseScoutGraph rejects a malformed payload", () => {
    expect(() => parseScoutGraph({ nodes: [] })).toThrow();
  });

  it("setActiveScoutSchemaForTests switches source", () => {
    const golden = loadGoldenScoutGraph();
    setActiveScoutSchemaForTests(golden, "live");
    expect(schemaHealthSnapshot().source).toBe("live");
  });
});
