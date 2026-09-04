import { buildScoutSystemAddendum } from "../bot-kit/scout/addendum.js";

/** Jeb supplies the interpretation sentence; Kit does not bake a bot name. */
export const SCOUT_SYSTEM_ADDENDUM = buildScoutSystemAddendum(
  "Mark interpretations as Jeb's, not the graph's.",
);

export function formatScoutEvidenceBlock(payloads: unknown[]): string {
  const lines: string[] = [];
  for (const p of payloads) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.provenance !== "scout") continue;
    const tool = String(o.tool ?? "scout");
    const truncated = o.truncated === true ? " truncated=true" : "";
    lines.push(`[${tool}${truncated}]`);
    if (Array.isArray(o.posts)) {
      for (const post of o.posts.slice(0, 12)) {
        if (!post || typeof post !== "object") continue;
        const r = post as Record<string, unknown>;
        const uri = String(r.uri ?? "");
        const author = String(r.author_id ?? "");
        const claims = formatClaims(r.claims);
        lines.push(`- ${uri} author=${author}${claims}`);
      }
    }
    if (Array.isArray(o.tag_claims)) {
      lines.push(formatClaims(o.tag_claims, true));
    }
    if (Array.isArray(o.claims)) {
      lines.push(formatClaims(o.claims, true));
      if (graphIsEmpty(o.claims)) {
        lines.push("- asker's 1–2 hop follow graph is empty for this claim (new user or no neighbourhood claimants)");
      }
    }
    if (Array.isArray(o.clusters)) {
      for (const c of o.clusters.slice(0, 8)) {
        if (!c || typeof c !== "object") continue;
        const r = c as Record<string, unknown>;
        lines.push(
          `- cluster label=${String(r.label)} authors=${arr(r.author_ids).slice(0, 8).join(",")} posts=${arr(r.evidence_uris).slice(0, 4).join(" ")}`,
        );
      }
    }
    if (Array.isArray(o.topics)) {
      for (const t of o.topics.slice(0, 10)) {
        if (!t || typeof t !== "object") continue;
        const r = t as Record<string, unknown>;
        lines.push(
          `- tag ${String(r.label)} distinct_taggers=${String(r.distinct_taggers)} prior=${String(r.prior_distinct_taggers)} delta=${String(r.delta)}`,
        );
      }
    }
    if (typeof o.pubky === "string" && typeof o.posts === "number") {
      lines.push(
        `- identity ${o.pubky} posts=${o.posts} followers=${String(o.followers)} following=${String(o.following)}`,
      );
    }
  }
  if (!lines.length) return "";
  return `Scout evidence (claims, not facts):\n${lines.join("\n")}`;
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function graphIsEmpty(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return true;
  return raw.every((c) => {
    if (!c || typeof c !== "object") return true;
    const g = (c as { graph_count?: unknown }).graph_count;
    return g === undefined || g === null || Number(g) === 0;
  });
}

function formatClaims(raw: unknown, header = false): string {
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const bits = raw.slice(0, 8).map((c) => {
    if (!c || typeof c !== "object") return "";
    const r = c as Record<string, unknown>;
    const ids = arr(r.claimant_ids).slice(0, 8);
    const self = r.self_claim === true ? " self_claim" : "";
    const label = String(r.label);
    if (r.global_count !== undefined || r.graph_count !== undefined) {
      return `'${label}': everyone: ${String(r.global_count ?? 0)} taggers; within 2 follows of you: ${String(r.graph_count ?? 0)}${ids.length ? ` (${ids.join(",")}${ids.length ? "…" : ""})` : ""}`;
    }
    return `${String(r.count ?? 0)} claimants tagged '${label}' (${ids.join(",")}${ids.length ? "…" : ""})${self}`;
  });
  const body = bits.filter(Boolean).join("; ");
  return header ? `- ${body}` : ` claims: ${body}`;
}

export function scoutEvidenceBundle(payloads: unknown[]): Record<string, unknown> {
  return {
    kind: "scout",
    items: payloads.filter((p) => p && typeof p === "object" && (p as { provenance?: string }).provenance === "scout"),
  };
}
