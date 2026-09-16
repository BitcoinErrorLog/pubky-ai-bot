import { createHash } from "node:crypto";
import { parsePubchiAnswerV1, type AskTarget, type PubchiAnswerV1, type TenantV1 } from "../pubchi-schemas/index.js";
import { InjectionDetector, normalizeForMatching } from "../bot-kit/security/injection-detector.js";
import { MAX_OPEN_TAGS, preferExistingTags } from "../bot-kit/tags/policy.js";
import { type PostView, type UserDetails } from "../bot-kit/types.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { Nexus } from "../bot-kit/nexus/nexus.js";
import { canonicalJson } from "../pubchi-schemas/canonical.js";
import { evaluateC5Candidate, taintField, type TaintedField } from "./tags-policy.js";
import { log } from "../bot-kit/log.js";

const Z32 = "[ybndrfg8ejkmcpqxot1uwisza345h769]{52}";
const TARGET_POST = new RegExp(`^pubky://(${Z32})/pub/pubky\\.app/posts/([A-Z0-9]{13})$`);
const TARGET_PROFILE = new RegExp(`^pubky://(${Z32})/pub/pubky\\.app/profile\\.json$`);
const C5_PHRASE = /^(?:suggest|recommend)(?: up to \d+)? tags? for this (post|user)[?!.]*$/i;

export type C5Target = { kind: "post"; uri: string; author: string; postId: string } | { kind: "user"; uri: string; pubky: string };
export type C5Nexus = Pick<Nexus, "post" | "userDetails" | "userTags" | "hotTags" | "searchTags">;
export type C5Scout = {
  scout_get_thread: { execute(args: { uri: string; depth?: number; include_profiles?: boolean }): Promise<unknown> };
  get_identity_summary: { execute(args: { pubky: string; time_range?: { since?: number; until?: number } }): Promise<unknown> };
};
type C5TagField = TaintedField & { taggers: string[]; claimant_count: number; source: "target" | "thread" | "other" };
export type C5ScoutThreadResult = {
  tags: C5TagField[];
  participants: Array<{ pubky: string; author_name: TaintedField }>;
  posts: Array<{ content: TaintedField; author_name: TaintedField }>;
};

export function c5QuestionKind(question: string): "post" | "user" | null {
  return C5_PHRASE.exec(question.trim())?.[1].toLowerCase() as "post" | "user" | undefined ?? null;
}

export function parseTarget(target: AskTarget, bot: string): C5Target | null {
  const uri = target.uri.trim();
  const post = TARGET_POST.exec(uri);
  if (post && target.kind === "post" && post[1] !== bot) return { kind: "post", uri, author: post[1], postId: post[2] };
  const profile = TARGET_PROFILE.exec(uri);
  if (profile && target.kind === "user") return { kind: "user", uri, pubky: profile[1] };
  return null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function tagsOf(value: unknown, sourceUri: string, fieldPath: string, source: C5TagField["source"] = "other"): C5TagField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ ...taintField(item, sourceUri, fieldPath), taggers: [], claimant_count: 0, source }];
    if (item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string") {
      const row = item as { label: string; taggers?: unknown; claimant_ids?: unknown; claimant_count?: unknown };
      const taggers = Array.isArray(row.taggers) ? row.taggers : Array.isArray(row.claimant_ids) ? row.claimant_ids : [];
      return [{
        ...taintField(row.label, sourceUri, fieldPath),
        taggers: taggers.filter((tagger): tagger is string => typeof tagger === "string"),
        claimant_count: typeof row.claimant_count === "number" ? row.claimant_count : taggers.length,
        source,
      }];
    }
    return [];
  });
}

function sourceTags(value: unknown, sourceUri: string, fieldPath: string): C5TagField[] {
  if (Array.isArray(value)) return tagsOf(value, sourceUri, fieldPath);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...tagsOf(record.tags, sourceUri, `${fieldPath}.tags`),
    ...tagsOf(record.claims, sourceUri, `${fieldPath}.claims`),
    ...tagsOf(record.tag_claims, sourceUri, `${fieldPath}.tag_claims`),
  ];
}

export function parseScoutThread(value: unknown, targetUri: string): C5ScoutThreadResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as { posts?: unknown }).posts)) return { tags: [], participants: [], posts: [] };
  const tags: C5TagField[] = [];
  const participants: Array<{ pubky: string; author_name: TaintedField }> = [];
  const posts: Array<{ content: TaintedField; author_name: TaintedField }> = [];
  for (const [index, post] of (value as { posts: unknown[] }).posts.entries()) {
    if (!post || typeof post !== "object") continue;
    const row = post as Record<string, unknown>;
    const sourceUri = typeof row.uri === "string" ? row.uri : targetUri;
    tags.push(...tagsOf(row.claims, sourceUri, `scout.posts[${index}].claims`, "thread"));
    const authorName = taintField(row.author_name, sourceUri, `scout.posts[${index}].author_name`);
    posts.push({ content: taintField(row.content, sourceUri, `scout.posts[${index}].content`), author_name: authorName });
    if (typeof row.author_id === "string") {
      participants.push({
        pubky: row.author_id,
        author_name: authorName,
      });
    }
  }
  return { tags, participants, posts };
}

function userSnapshot(value: unknown): UserDetails | null {
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  return {
    id: typeof user.id === "string" ? user.id : "",
    name: typeof user.name === "string" ? user.name : "",
    bio: typeof user.bio === "string" ? user.bio : null,
    handle: typeof user.handle === "string" ? user.handle : undefined,
  } as UserDetails;
}

function snapshot(target: C5Target, post: PostView | null, user: UserDetails | null): unknown {
  return target.kind === "post"
    ? { kind: "post", uri: target.uri, author: post?.details.author ?? target.author, content: post?.details.content ?? "", post_kind: post?.details.kind ?? "" }
    : { kind: "user", uri: target.uri, pubky: target.pubky, name: user?.name ?? "", bio: user?.bio ?? null };
}

function personTokenFields(value: unknown, sourceUri: string, fieldPath: string): TaintedField[] {
  if (typeof value !== "string") return [];
  const field = taintField(value, sourceUri, fieldPath);
  if (field.tainted) return [field];
  const normalized = normalizeForMatching(field.value);
  const tokens = normalized.split(/\s+/u).filter((token) => token.length >= 2);
  return [field, ...tokens.map((token) => ({ ...field, value: token }))];
}

function personTokensFor(target: C5Target, post: PostView | null, user: UserDetails | null, thread: C5ScoutThreadResult): string[] {
  const fields: TaintedField[] = [
    { value: target.kind === "post" ? target.author : target.pubky, source_uri: target.uri, field_path: "target.pubky", tainted: false },
    ...personTokenFields(post?.details.author_name, target.uri, "target.author_name"),
    ...personTokenFields(user?.name, target.uri, "target.name"),
    ...personTokenFields(user?.handle, target.uri, "target.handle"),
    ...thread.participants.flatMap((participant) => [
      { value: participant.pubky, source_uri: participant.author_name.source_uri, field_path: "participant.pubky", tainted: false },
      participant.author_name,
      ...personTokenFields(participant.author_name.value, participant.author_name.source_uri, participant.author_name.field_path),
    ]),
  ];
  return fields.flatMap((field) => {
    // Names remain rejection-only inputs even when tainted; they never enter candidates or brain context.
    if (!field.value) return [];
    const normalized = normalizeForMatching(field.value);
    return normalized ? [normalized, ...(normalized.startsWith("@") ? [normalized.slice(1)] : [`@${normalized}`])] : [];
  });
}

export async function runTagSuggestions(input: {
  tenant: TenantV1;
  target: C5Target;
  nexus: C5Nexus;
  scout?: C5Scout;
  brain?: Brain;
  scoutBudget?: { reserve(owner: string, queries: number, now?: Date): Promise<boolean> };
  signer?: string;
  now: number;
  runId: string;
}): Promise<{ ok: true; result: PubchiAnswerV1; settlementTokens: number } | { ok: false; code: "UPSTREAM_UNAVAILABLE"; stage: "upstream"; cause: string; settlementTokens: number }> {
  const started = performance.now();
  const { target, nexus } = input;
  let post: PostView | null = null;
  let user: UserDetails | null = null;
  let targetTags: unknown = [];
  try {
    if (target.kind === "post") {
      [post, user] = await Promise.all([
        nexus.post(target.uri),
        nexus.userDetails(target.author).then(userSnapshot).catch(() => null),
      ]);
    } else {
      const [rawUser, tags] = await Promise.all([nexus.userDetails(target.pubky), nexus.userTags(target.pubky)]);
      user = userSnapshot(rawUser);
      targetTags = tags;
    }
  } catch {
    return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: "c5_target_read", settlementTokens: 1 };
  }
  const projection = snapshot(target, post, user);
  const targetAvailable = target.kind === "post" ? post !== null : user !== null;
  const snapshotHash = targetAvailable ? sha256(projection) : null;
  if (snapshotHash === null) {
    return { ok: true, result: buildAnswer(input, target, null, [], true), settlementTokens: 1 };
  }
  const baseTags = target.kind === "post"
    ? tagsOf(post?.tags, target.uri, "target.tags", "target")
    : tagsOf(targetTags, target.uri, "target.tags", "target");
  // scout_get_thread calls client.query at tools.ts:424-434; get_identity_summary at :481-507.
  const scoutQueries = target.kind === "post" ? 2 : 4;
  const scoutAvailable = Boolean(input.scout);
  const scoutBudget = input.scoutBudget;
  const scoutAllowed = scoutAvailable && scoutBudget !== undefined && await scoutBudget.reserve(input.tenant.owner, scoutQueries, new Date(input.now > 100_000_000_000 ? input.now : input.now * 1000));
  const seed = baseTags.find((tag) => !tag.tainted)?.value;
  const optional: Array<{ source: string; request: Promise<unknown> }> = [
    ...(target.kind === "post" ? [{ source: "Nexus user tags", request: nexus.userTags(target.author) }] : []),
    ...(scoutAllowed && target.kind === "post" ? [{ source: "Scout thread", request: input.scout!.scout_get_thread.execute({ uri: target.uri, depth: 2 }) }] : []),
    ...(scoutAllowed && target.kind === "user" ? [{ source: "Scout identity", request: input.scout!.get_identity_summary.execute({ pubky: target.pubky, time_range: { until: input.now > 100_000_000_000 ? input.now : input.now * 1000 } }) }] : []),
    { source: "Nexus hot tags", request: nexus.hotTags(40) },
    ...(seed ? [{ source: "Nexus tag search", request: nexus.searchTags(seed, 15) }] : []),
  ];
  const legStarted = performance.now();
  const global = await Promise.allSettled(optional.map((item) => item.request));
  const legMs = Math.max(1, Math.round(performance.now() - legStarted));
  const unavailableOptionalSources = global.filter((item) => item.status === "rejected").length;
  const legTruncated = global.some((item, index) =>
    item.status === "fulfilled"
    && optional[index]?.source.startsWith("Scout")
    && Boolean((item.value as { truncated?: unknown } | null)?.truncated),
  );
  const scoutResults = global.flatMap((item, index) => item.status === "fulfilled" && optional[index]?.source === "Scout thread"
    ? [parseScoutThread(item.value, target.uri)]
    : []);
  const rawPool = [
    ...baseTags,
    ...scoutResults.flatMap((result) => result.tags),
    ...global.flatMap((item, index) => item.status === "fulfilled" && optional[index]?.source !== "Scout thread" ? sourceTags(item.value, target.uri, "optional") : []),
  ];
  const pool = rawPool.map((field, index) => ({ field, index, label: preferExistingTags([field.value], baseTags.map((tag) => tag.value))[0] ?? field.value }));
  const personTokens = personTokensFor(target, post, user, scoutResults[0] ?? { tags: [], participants: [], posts: [] });
  const cleanTargetContent = target.kind === "post" && post ? taintField(post.details.content, target.uri, "target.content") : null;
  const threadFrequency = new Map<string, number>();
  for (const item of pool.filter((item) => item.field.source === "thread")) {
    const key = normalizeForMatching(item.label);
    threadFrequency.set(key, (threadFrequency.get(key) ?? 0) + 1);
  }
  pool.sort((a, b) =>
    Number(b.field.source === "target") - Number(a.field.source === "target") ||
    Number(Boolean(cleanTargetContent && !cleanTargetContent.tainted && normalizeForMatching(cleanTargetContent.value).includes(normalizeForMatching(b.label)))) - Number(Boolean(cleanTargetContent && !cleanTargetContent.tainted && normalizeForMatching(cleanTargetContent.value).includes(normalizeForMatching(a.label)))) ||
    (threadFrequency.get(normalizeForMatching(b.label)) ?? 0) - (threadFrequency.get(normalizeForMatching(a.label)) ?? 0) ||
    b.field.claimant_count - a.field.claimant_count ||
    a.label.localeCompare(b.label, "en-US") ||
    a.index - b.index,
  );
  const candidates: Array<{ label: string; rationale: string; evidence: string[]; already_applied: boolean; source: "vocab" | "open" }> = [];
  const rejectionCounts: Record<string, number> = {};
  for (const { field, label } of pool) {
    const accepted = evaluateC5Candidate({
      raw: label,
      evidence: [field],
      already_applied: baseTags.some((tag) => tag.value.toLowerCase() === field.value.toLowerCase() && tag.taggers.includes(input.tenant.owner)),
    }, personTokens, new Set(candidates.map((candidate) => candidate.label)));
    if (!accepted.accepted) {
      rejectionCounts[accepted.code] = (rejectionCounts[accepted.code] ?? 0) + 1;
      continue;
    }
    candidates.push({
      label: accepted.label,
      rationale: "Matches an existing public tag on the target.",
      evidence: accepted.evidence,
      already_applied: accepted.already_applied,
      source: "vocab",
    });
    if (candidates.length >= MAX_OPEN_TAGS) break;
  }
  let brainTokens = 0;
  if (candidates.length < MAX_OPEN_TAGS && input.brain) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_200);
    const messages = [
      { role: "system" as const, content: "Suggest safe lowercase hyphenated tags as JSON {\"items\":[{\"label\":string,\"rationale\":string,\"evidence_indexes\":[number]}]}. Do not name people or identifiers." },
      {
        role: "user" as const,
        content: JSON.stringify({
          target_kind: target.kind,
          target_content: target.kind === "post" && post
            ? (() => {
                const content = taintField(post.details.content, target.uri, "target.content");
                return content.tainted ? undefined : content.value.slice(0, 6_000);
              })()
            : undefined,
          existing_labels: candidates.map((candidate) => candidate.label),
          vocabulary: pool.filter(({ field }) => !field.tainted).map(({ label }) => label).slice(0, 40),
        }),
      },
    ];
    try {
      const generated = await Promise.race([
        input.brain.generate({ messages, temperature: input.brain.temperature, abortSignal: controller.signal, maxOutputTokens: 300 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException("C5 brain timeout", "TimeoutError")), 1_200)),
      ]);
      const usage = generated.usage;
      brainTokens = usage?.promptTokens && usage?.completionTokens
        ? usage.promptTokens + usage.completionTokens
        : usage?.totalTokens ?? 1;
      const parsed = JSON.parse(generated.text) as { items?: Array<{ label?: unknown; rationale?: unknown; evidence_indexes?: unknown }> };
      for (const item of parsed.items ?? []) {
        if (candidates.length >= MAX_OPEN_TAGS || typeof item.label !== "string" || typeof item.rationale !== "string") continue;
        if (!Array.isArray(item.evidence_indexes)) continue;
        const label = item.label;
        const rationale = item.rationale;
        if (Array.from(rationale).length > 120) continue;
        if (!item.evidence_indexes.every((index) => index === 0)) continue;
        const accepted = evaluateC5Candidate({
          raw: label,
          evidence: [taintField(target.uri, target.uri, "target.uri")],
          rationale: taintField(rationale, target.uri, "brain.rationale"),
          already_applied: baseTags.some((tag) => tag.value.toLowerCase() === label.toLowerCase() && tag.taggers.includes(input.tenant.owner)),
        }, personTokens, new Set(candidates.map((candidate) => candidate.label)));
        if (!accepted.accepted) {
          rejectionCounts[accepted.code] = (rejectionCounts[accepted.code] ?? 0) + 1;
          continue;
        }
        candidates.push({
          label: accepted.label,
          rationale,
          evidence: accepted.evidence,
          already_applied: accepted.already_applied,
          source: "open",
        });
      }
    } catch {
      brainTokens = 0;
    } finally {
      clearTimeout(timeout);
    }
  }
  const suggestions = candidates.sort((a, b) => a.label.localeCompare(b.label, "en-US"));
  const fulfilled = global.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  const rows = fulfilled.reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : Array.isArray((value as { posts?: unknown[] } | null)?.posts) ? (value as { posts: unknown[] }).posts.length : 1), 0);
  const bytes = fulfilled.reduce<number>((count, value) => count + Buffer.byteLength(JSON.stringify(value)), 0);
  log.info({
    event: "pubchi_c5_tags",
    owner_hash: sha256(input.tenant.owner),
    signer_hash: sha256(input.signer ?? input.tenant.owner),
    target_uri_hash: sha256(target.uri),
    attempted_tools: optional.length + 1,
    completed_tools: global.filter((item) => item.status === "fulfilled").length,
    leg_ms: legMs,
    leg_rows: rows,
    leg_bytes: bytes,
    leg_truncated: legTruncated,
    rejection_counts: rejectionCounts,
    candidate_source: suggestions.map((item) => item.source),
    brain_tokens: brainTokens,
    total_ms: Math.max(1, Math.round(performance.now() - started)),
  }, "pubchi C5 tag suggestions");
  return {
    ok: true,
    result: buildAnswer(
      input,
      target,
      snapshotHash,
      suggestions,
      !scoutAllowed || unavailableOptionalSources > 0 || legTruncated,
      unavailableOptionalSources,
      target.kind === "post" ? ["get_post", ...optional.map((item) => item.source)] : ["get_user", "get_user_tags", ...optional.map((item) => item.source)],
    ),
    settlementTokens: Math.max(1, brainTokens),
  };
}

function buildAnswer(
  input: { tenant: TenantV1; now: number; runId: string },
  target: C5Target,
  snapshotHash: string | null,
  suggestions: NonNullable<PubchiAnswerV1["tag_suggestions"]>,
  partial: boolean,
  unavailableOptionalSources = 0,
  tools: string[] = [],
): PubchiAnswerV1 {
  const result = {
    schema: "pubchi-answer" as const, version: 1 as const, bot: input.tenant.bot, owner: input.tenant.owner,
    generated_at: input.now, run_id: input.runId, purpose: "ask" as const, question: `Suggest tags for this ${target.kind}`,
    summary: partial
      ? `Partial: ${unavailableOptionalSources || 1} optional sources were unavailable.`
      : suggestions.length ? `${suggestions.length} suggestions from ${tools.length} public sources.` : "No safe tag suggestions were found.",
    evidence: [...new Map(
      suggestions.flatMap((suggestion) => suggestion.evidence.map((uri) => [
        `${suggestion.label}:${uri}`,
        { kind: "claim" as const, label: suggestion.label, uri, claimants: [], claimant_count: 0, in_your_graph: null },
      ])),
    ).values()],
    sources: [], tool_trace_summary: { tools, call_count: tools.length, truncated: partial },
    policy_version: 1 as const, section: "tag_suggestions" as const,
    target: { kind: target.kind, uri: target.uri, snapshot_sha256: snapshotHash }, tag_suggestions: suggestions,
    scope: { time: null, graph: { kind: "whole_graph" as const }, filters: [`target:${target.kind}`], complete: !partial }, basis: "graph" as const,
  };
  const parsed = parsePubchiAnswerV1(result);
  if (!parsed.ok) throw new Error("C5 answer failed schema validation");
  return parsed.value;
}
