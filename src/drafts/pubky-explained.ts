import { DraftRejectedError, finishDraft, sanitizeUntrustedDraftText } from "./finish.js";
import type { Draft } from "./types.js";

export interface KnowledgeHit {
  content: string;
  source_url: string | null;
  product?: string;
  status?: string;
}

export async function generatePubkyExplained(opts: {
  searchKnowledge: (query: string) => Promise<{ chunks: KnowledgeHit[] }>;
  query?: string;
}): Promise<Draft> {
  const query = opts.query?.trim() || "what is a pubky homeserver and pkarr";
  const result = await opts.searchKnowledge(query);
  const chunks = result.chunks.filter((c) => c.source_url);
  if (chunks.length === 0) throw new DraftRejectedError("pubky_explained", "no evidence URI");
  const uris = chunks.map((c) => c.source_url).filter((u): u is string => Boolean(u));
  const first = chunks[0];
  const excerpt = sanitizeUntrustedDraftText(first.content).slice(0, 420);
  const cites = [...new Set(uris)].slice(0, 3);
  const status = first.status ? sanitizeUntrustedDraftText(first.status) : "";
  const body = [
    "Pubky explained, from the public knowledge index (mechanism in Jeb's words, sources linked — not a paste of the docs).",
    "",
    excerpt,
    "",
    `Sources: ${cites.join(" ")}`,
    status ? `Index status for the top hit: ${status}.` : "",
    "If this disagrees with a shipped spec, treat the spec as the source of truth.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return finishDraft({
    format: "pubky_explained",
    title: "Pubky explained",
    body,
    uris,
    tool_trace: [{ tool: "search_knowledge", query, hits: chunks.length }],
  });
}
