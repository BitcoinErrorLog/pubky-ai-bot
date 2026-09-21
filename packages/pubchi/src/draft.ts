import { createHash } from "node:crypto";
import {
  C6_LONG_CONTENT_MAX,
  C6_RATIONALE_MAX,
  C6_SHORT_CONTENT_MAX,
  C6_TAG_MAX,
  parsePubchiAnswerV1,
  PUBKY_APP_POST_URI,
  type PubchiAnswerV1,
  type PubchiCitation,
  type PubchiDraftPost,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { canonicalJson } from "../pubchi-schemas/canonical.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { RemoteKnowledgeClient } from "../bot-kit/knowledge/remote-client.js";
import { InjectionDetector } from "../bot-kit/security/injection-detector.js";
import { scanForSecrets } from "../bot-kit/security/secret-scrub.js";
import { log } from "../bot-kit/log.js";
import type { ServiceErrorCode } from "./codes.js";

const C5_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DRAFT_POST_PHRASE = /\b(?:draft|write|compose)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:short\s+|long\s+|new\s+)?post\b/i;
const HELP_ME_POST = /\bhelp\s+me\s+(?:to\s+)?post\s+(?:about|on|saying)\b/i;
const detector = new InjectionDetector();

export type DraftAskOutcome =
  | { ok: true; result: PubchiAnswerV1; settlementTokens: number }
  | { ok: false; code: ServiceErrorCode; stage: "query" | "upstream"; cause: string; settlementTokens?: number };

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function codePointSlice(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

function isC5Label(value: string): boolean {
  return C5_LABEL.test(value) && value.length <= 20 && value.split("-").length <= 3;
}

function screened(text: string): boolean {
  return detector.detect(text).detected || !scanForSecrets(text).clean;
}

export function isDraftPostQuestion(question: string): boolean {
  const trimmed = question.trim();
  return DRAFT_POST_PHRASE.test(trimmed) || HELP_ME_POST.test(trimmed);
}

function topicFrom(question: string): string {
  const about = question.match(/\b(?:about|on|saying)\s+(.+)$/i);
  const topic = about?.[1]?.trim() ?? question.trim();
  return codePointSlice(topic.replace(/[?!.]+$/g, "").trim() || question, 300);
}

function parentUriFrom(question: string, proposed?: unknown): string | undefined {
  if (typeof proposed === "string" && PUBKY_APP_POST_URI.test(proposed.trim())) return proposed.trim();
  const match = PUBKY_APP_POST_URI.exec(question);
  return match?.[0];
}

function parseBrainDraft(text: string): {
  content?: unknown;
  kind?: unknown;
  rationale?: unknown;
  tags?: unknown;
  parent_uri?: unknown;
} | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const label = item.normalize("NFKC").toLowerCase().trim();
    if (!isC5Label(label) || seen.has(label) || screened(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= C6_TAG_MAX) break;
  }
  return labels;
}

function citationTitle(value: string): string {
  const trimmed = value.trim() || "Source";
  return codePointSlice(trimmed, 160);
}

async function optionalCitations(input: {
  owner: string;
  topic: string;
  knowledge?: RemoteKnowledgeClient;
  knowledgeBudget?: { allow(owner: string): Promise<boolean> };
  webSearch?: { search(query: string, k?: number): Promise<unknown> };
}): Promise<{ citations: PubchiCitation[]; tools: string[]; truncated: boolean }> {
  const citations: PubchiCitation[] = [];
  const tools: string[] = [];
  let truncated = false;
  if (input.knowledge && input.knowledgeBudget) {
    try {
      const allowed = await input.knowledgeBudget.allow(input.owner);
      if (allowed) {
        tools.push("knowledge");
        const payload = await input.knowledge.search(input.topic, 3);
        for (const chunk of payload.chunks.slice(0, 3)) {
          if (!chunk.url.startsWith("https://")) continue;
          citations.push({
            kind: "knowledge",
            title: citationTitle(chunk.title),
            url: chunk.url,
            source_id: chunk.source_id,
            corpus_version: chunk.corpus_version,
            snippet: codePointSlice(chunk.snippet, 240),
          });
        }
        truncated = truncated || payload.truncated;
      }
    } catch {
      truncated = true;
    }
  }
  if (input.webSearch) {
    try {
      tools.push("web");
      const payload = await input.webSearch.search(input.topic, 3);
      const results = payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)
        ? (payload as { results: Array<{ title?: unknown; url?: unknown; snippet?: unknown }> }).results
        : [];
      for (const result of results.slice(0, 3)) {
        if (typeof result.url !== "string" || !result.url.startsWith("https://")) continue;
        citations.push({
          kind: "web",
          title: citationTitle(typeof result.title === "string" ? result.title : result.url),
          url: result.url,
          snippet: typeof result.snippet === "string" ? codePointSlice(result.snippet, 240) : undefined,
        });
      }
    } catch {
      truncated = true;
    }
  }
  return { citations: citations.slice(0, 8), tools, truncated };
}

export async function runDraftPost(input: {
  tenant: TenantV1;
  question: string;
  now: number;
  runId: string;
  brain?: Brain;
  knowledge?: RemoteKnowledgeClient;
  knowledgeBudget?: { allow(owner: string): Promise<boolean> };
  webSearch?: { search(query: string, k?: number): Promise<unknown> };
  signer?: string;
}): Promise<DraftAskOutcome> {
  const started = performance.now();
  if (!input.brain) {
    return { ok: false, code: "BRAIN_UNAVAILABLE", stage: "upstream", cause: "C6_BRAIN_REQUIRED", settlementTokens: 1 };
  }
  const topic = topicFrom(input.question);
  const extras = await optionalCitations({
    owner: input.tenant.owner,
    topic,
    knowledge: input.knowledge,
    knowledgeBudget: input.knowledgeBudget,
    webSearch: input.webSearch,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_200);
  let brainTokens = 0;
  let generatedText = "";
  try {
    const generated = await Promise.race([
      input.brain.generate({
        messages: [
          {
            role: "system",
            content: 'Draft a Pubky post as JSON {"content":string,"kind":"short"|"long","rationale":string,"tags"?:string[]}. Do not publish. No attachments. content is plain body text. rationale is 1-120 code points.',
          },
          {
            role: "user",
            content: JSON.stringify({
              question: input.question,
              topic,
              knowledge: extras.citations.filter((item) => item.kind === "knowledge").map((item) => item.snippet).filter(Boolean),
              web: extras.citations.filter((item) => item.kind === "web").map((item) => item.snippet).filter(Boolean),
            }),
          },
        ],
        temperature: input.brain.temperature,
        abortSignal: controller.signal,
        maxOutputTokens: 800,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException("C6 brain timeout", "TimeoutError")), 1_200)),
    ]);
    const usage = generated.usage;
    brainTokens = usage?.promptTokens && usage?.completionTokens
      ? usage.promptTokens + usage.completionTokens
      : usage?.totalTokens ?? 1;
    generatedText = generated.text;
  } catch {
    return { ok: false, code: "BRAIN_UNAVAILABLE", stage: "upstream", cause: "C6_BRAIN_UNAVAILABLE", settlementTokens: 1 };
  } finally {
    clearTimeout(timeout);
  }
  const parsed = parseBrainDraft(generatedText);
  if (!parsed || typeof parsed.content !== "string" || typeof parsed.rationale !== "string") {
    return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: "C6_SCREENED", settlementTokens: Math.max(1, brainTokens) };
  }
  const wantsLong = parsed.kind === "long" || /\blong\b|\barticle\b/i.test(input.question);
  let kind: PubchiDraftPost["kind"] = wantsLong ? "long" : "short";
  let content = parsed.content;
  let max = kind === "long" ? C6_LONG_CONTENT_MAX : C6_SHORT_CONTENT_MAX;
  if (Array.from(content).length > C6_SHORT_CONTENT_MAX && Array.from(content).length <= C6_LONG_CONTENT_MAX) {
    kind = "long";
    max = C6_LONG_CONTENT_MAX;
  }
  content = codePointSlice(content, max);
  const rationale = codePointSlice(parsed.rationale.trim() || "Drafted from the asked topic.", C6_RATIONALE_MAX);
  if (!content.trim() || screened(content) || screened(rationale)) {
    return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: "C6_SCREENED", settlementTokens: Math.max(1, brainTokens) };
  }
  const ownerProfile = `pubky://${input.tenant.owner}/pub/pubky.app/profile.json`;
  const parentUri = parentUriFrom(input.question, parsed.parent_uri);
  const draftEvidence = [...new Set([ownerProfile, ...(parentUri ? [parentUri] : [])])].slice(0, 8);
  const tags = uniqueLabels(parsed.tags);
  const draft: PubchiDraftPost = {
    content,
    kind,
    rationale,
    evidence: draftEvidence,
    ...(tags.length ? { tags } : {}),
    ...(parentUri ? { parent_uri: parentUri } : {}),
  };
  const evidence = draftEvidence.map((uri) => ({
    kind: uri.includes("/posts/") ? "post" as const : "user" as const,
    label: uri.includes("/posts/") ? "Parent post" : "Owner profile",
    uri,
    claimants: [] as string[],
    claimant_count: 0,
    in_your_graph: true as boolean | null,
  }));
  const tools = ["brain", ...extras.tools].slice(0, 16);
  const result = {
    schema: "pubchi-answer" as const,
    version: 1 as const,
    bot: input.tenant.bot,
    owner: input.tenant.owner,
    generated_at: input.now,
    run_id: input.runId,
    purpose: "ask" as const,
    question: input.question,
    summary: kind === "long"
      ? "A longer post you can publish as yourself."
      : "A short post you can publish as yourself.",
    evidence,
    sources: [] as string[],
    tool_trace_summary: { tools, call_count: tools.length, truncated: extras.truncated },
    policy_version: 1 as const,
    section: "draft_post" as const,
    draft_post: draft,
    scope: {
      time: null,
      graph: { kind: "owner_network" as const, hops: 1 as const },
      filters: ["draft_post"],
      complete: !extras.truncated,
    },
    basis: extras.citations.length ? "mixed" as const : "graph" as const,
    ...(extras.citations.length ? { citations: extras.citations } : {}),
  };
  const parsedAnswer = parsePubchiAnswerV1(result);
  log.info({
    event: "pubchi_c6_draft",
    owner_hash: sha256(input.tenant.owner),
    signer_hash: sha256(input.signer ?? input.tenant.owner),
    kind,
    tag_count: tags.length,
    has_parent: Boolean(parentUri),
    citation_count: extras.citations.length,
    brain_tokens: brainTokens,
    total_ms: Math.max(1, Math.round(performance.now() - started)),
  }, "pubchi C6 draft post");
  if (!parsedAnswer.ok) {
    return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: "C6_ANSWER_INVALID", settlementTokens: Math.max(1, brainTokens) };
  }
  if (parsedAnswer.value.section === "tag_suggestions" || parsedAnswer.value.tag_suggestions || parsedAnswer.value.target) {
    return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: "C6_C5_EXCLUSION", settlementTokens: Math.max(1, brainTokens) };
  }
  return { ok: true, result: parsedAnswer.value, settlementTokens: Math.max(1, brainTokens) };
}
