import type { PolicySummary } from "./policy-summary.js";
import type { DashboardFacts, DashboardWindow } from "./reporting.js";

export function parseSince(raw: string | undefined, now = new Date()): DashboardWindow {
  const v = (raw ?? "24h").trim();
  const rel = /^(\d+)(h|d)$/i.exec(v);
  if (rel?.[1] && rel[2]) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return { since: new Date(now.getTime() - ms), label: v };
  }
  const iso = Date.parse(v);
  if (!Number.isFinite(iso)) {
    throw new Error(`invalid --since ${v}; use 24h, 7d, or an ISO timestamp`);
  }
  return { since: new Date(iso), label: v };
}

export function parseDashboardArgv(argv: string[]): {
  sinceRaw: string | undefined;
  json: boolean;
  markdownFile: string | undefined;
} {
  let sinceRaw: string | undefined;
  let json = false;
  let markdownFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--json") json = true;
    else if (a === "--since" && argv[i + 1]) {
      sinceRaw = argv[++i];
    } else if (a.startsWith("--since=")) sinceRaw = a.slice("--since=".length);
    else if (a === "--markdown-file" && argv[i + 1]) {
      markdownFile = argv[++i];
    } else if (a.startsWith("--markdown-file=")) markdownFile = a.slice("--markdown-file=".length);
  }
  return { sinceRaw, json, markdownFile };
}

function mdTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

export function formatDashboardMarkdown(facts: DashboardFacts, policy: PolicySummary): string {
  const lines: string[] = [];
  lines.push(`# Jeb evidence dashboard`);
  lines.push("");
  lines.push(`Window: \`${facts.window.label}\` (since ${facts.window.since.toISOString()}).`);
  lines.push("");
  lines.push("## Effective policy limits");
  lines.push("");
  lines.push(
    mdTable(
      ["limit", "value"],
      [
        ["maxRepliesPerThread", String(policy.maxRepliesPerThread)],
        ["maxTurnsPerUserPerThread", String(policy.maxTurnsPerUserPerThread)],
        ["maxPerUserPerHour", String(policy.maxPerUserPerHour)],
        ["dailyTokenBudget", String(policy.dailyTokenBudget)],
        ["userDailyTokenBudget", String(policy.userDailyTokenBudget)],
        ["modelTimeoutMs", String(policy.modelTimeoutMs)],
        ["answerBudgetMs", String(policy.answerBudgetMs)],
        ["replyDeadlineMs", String(policy.replyDeadlineMs)],
        ["pollMs", String(policy.pollMs)],
        ["knownBotsCount", String(policy.knownBotsCount)],
        ["blocklistCount", String(policy.blocklistCount)],
      ],
    ),
  );
  lines.push("");
  lines.push("## Mentions");
  lines.push("");
  lines.push(
    mdTable(
      ["metric", "count"],
      [
        ["received", String(facts.mentionsReceived)],
        ["published", String(facts.published)],
        ["failed", String(facts.failed)],
      ],
    ),
  );
  lines.push("");
  lines.push("### Skipped by reason");
  lines.push("");
  if (facts.skippedByReason.length === 0) lines.push("None.");
  else {
    lines.push(mdTable(["reason", "count"], facts.skippedByReason.map((r) => [r.reason, String(r.count)])));
  }
  lines.push("");
  lines.push("### Fallback by reason");
  lines.push("");
  if (facts.fallbackByReason.length === 0) lines.push("None.");
  else {
    lines.push(mdTable(["reason", "count"], facts.fallbackByReason.map((r) => [r.reason, String(r.count)])));
  }
  lines.push("");
  lines.push("## Reply latency");
  lines.push("");
  lines.push(
    "p50/p95 of `publish_requests.updated_at - handled_mentions.created_at` for published mentions with a published publish request (milliseconds).",
  );
  lines.push("");
  lines.push(
    mdTable(
      ["stat", "ms"],
      [
        ["p50", facts.latencyMs.p50 === null ? "n/a" : String(Math.round(facts.latencyMs.p50))],
        ["p95", facts.latencyMs.p95 === null ? "n/a" : String(Math.round(facts.latencyMs.p95))],
        ["sampleSize", String(facts.latencyMs.sampleSize)],
      ],
    ),
  );
  lines.push("");
  lines.push("## Tool usage");
  lines.push("");
  if (facts.toolUsage.length === 0) lines.push("No tool calls in evidence.tool_trace for this window.");
  else lines.push(mdTable(["tool", "count"], facts.toolUsage.map((t) => [t.tool, String(t.count)])));
  lines.push("");
  lines.push(
    mdTable(
      ["failures", "count"],
      [
        ["scout_queries ok=false", String(facts.scoutFailures)],
        ["web_queries ok=false", String(facts.webSearchFailures)],
      ],
    ),
  );
  lines.push("");
  lines.push("## Token spend");
  lines.push("");
  lines.push(
    `Today (UTC) global spend: **${facts.todayGlobalTokens}** / **${facts.dailyTokenBudget}** (\`JEB_DAILY_TOKEN_BUDGET\`). Per-user ceiling: **${facts.userDailyTokenBudget}** (\`JEB_USER_DAILY_TOKEN_BUDGET\`).`,
  );
  lines.push("");
  if (facts.topSpendersToday.length === 0) lines.push("No token_usage rows today.");
  else {
    lines.push("### Top spenders today");
    lines.push("");
    lines.push(
      mdTable(
        ["public_key", "tokens"],
        facts.topSpendersToday.map((t) => [t.publicKey, String(t.totalTokens)]),
      ),
    );
  }
  lines.push("");
  if (facts.tokenByModel.length === 0) lines.push("No token_usage rows in this window.");
  else {
    lines.push("### By model");
    lines.push("");
    lines.push(mdTable(["model", "tokens"], facts.tokenByModel.map((t) => [t.model, String(t.totalTokens)])));
  }
  lines.push("");
  if (facts.tokenByDay.length > 0) {
    lines.push("### By day (UTC)");
    lines.push("");
    lines.push(
      mdTable(
        ["day", "tokens", "vs daily budget"],
        facts.tokenByDay.map((t) => [
          t.day,
          String(t.totalTokens),
          `${((t.totalTokens / facts.dailyTokenBudget) * 100).toFixed(1)}%`,
        ]),
      ),
    );
    lines.push("");
  }
  lines.push("## Security");
  lines.push("");
  lines.push(facts.securityNote);
  lines.push("");
  lines.push(`Declined-category replies (evidence.intent = decline): **${facts.securityDeclinedReplies}**.`);
  lines.push("");
  lines.push("## Kill switches");
  lines.push("");
  lines.push(
    mdTable(
      ["flag", "value"],
      [
        ["kill_switch.disabled", String(facts.killSwitch.killSwitchDisabled)],
        ["JEB_DISABLED", String(facts.killSwitch.envDisabled)],
        ["JEB_SWITCH_GLOBAL", String(facts.killSwitch.envGlobal)],
      ],
    ),
  );
  lines.push("");
  lines.push(
    mdTable(
      ["switch", "postgres on", "env on"],
      facts.killSwitch.switches.map((s) => [s.name, String(s.on), String(s.envOn)]),
    ),
  );
  lines.push("");
  lines.push("");
  lines.push("## Correction loop");
  lines.push("");
  lines.push(
    "Published answers = `handled_mentions` with status `published`, no `skip_reason`, and a `reply_uri`. Accepted mentions = status other than `skipped`. Correction rate = corrections / published answers. Repeat rate = authors with ≥2 published answers / authors with ≥1 published answer. Successful-answer rate = published answers / accepted mentions. Cost uses 7-day token_usage at `JEB_MODEL_PRICE_PER_MTOK_IN` / `_OUT` (unsplit totals priced as output).",
  );
  lines.push("");
  const fmtRate = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const fmtUsd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(4)}`);
  lines.push(
    mdTable(
      ["window", "published", "accepted", "corrections", "correction rate", "unique invokers", "repeat authors", "repeat rate", "success rate"],
      [
        [
          "7d",
          String(facts.correctionLoop.d7.publishedAnswers),
          String(facts.correctionLoop.d7.acceptedMentions),
          String(facts.correctionLoop.d7.corrections),
          fmtRate(facts.correctionLoop.d7.correctionRate),
          String(facts.correctionLoop.d7.uniqueInvokers),
          String(facts.correctionLoop.d7.repeatAuthors),
          fmtRate(facts.correctionLoop.d7.repeatRate),
          fmtRate(facts.correctionLoop.d7.successfulAnswerRate),
        ],
        [
          "30d",
          String(facts.correctionLoop.d30.publishedAnswers),
          String(facts.correctionLoop.d30.acceptedMentions),
          String(facts.correctionLoop.d30.corrections),
          fmtRate(facts.correctionLoop.d30.correctionRate),
          String(facts.correctionLoop.d30.uniqueInvokers),
          String(facts.correctionLoop.d30.repeatAuthors),
          fmtRate(facts.correctionLoop.d30.repeatRate),
          fmtRate(facts.correctionLoop.d30.successfulAnswerRate),
        ],
      ],
    ),
  );
  lines.push("");
  lines.push("### Evidence-bundle latency");
  lines.push("");
  lines.push("p50/p95 of `evidence.latency_ms` for published answers with a latency sample.");
  lines.push("");
  lines.push(
    mdTable(
      ["stat", "ms"],
      [
        ["p50", facts.evidenceLatencyMs.p50 === null ? "n/a" : String(Math.round(facts.evidenceLatencyMs.p50))],
        ["p95", facts.evidenceLatencyMs.p95 === null ? "n/a" : String(Math.round(facts.evidenceLatencyMs.p95))],
        ["sampleSize", String(facts.evidenceLatencyMs.sampleSize)],
      ],
    ),
  );
  lines.push("");
  lines.push("### Cost (7d, list price)");
  lines.push("");
  lines.push(
    mdTable(
      ["metric", "value"],
      [
        ["USD / 1M in", String(facts.cost.priceIn)],
        ["USD / 1M out", String(facts.cost.priceOut)],
        ["USD per successful answer", fmtUsd(facts.cost.usdSuccessfulAnswers)],
        ["USD per repeat user", fmtUsd(facts.cost.usdPerRepeatUser)],
        ["successful answers (7d)", String(facts.cost.successfulAnswers)],
        ["repeat users (7d)", String(facts.cost.repeatUsers)],
      ],
    ),
  );
  lines.push("");
  lines.push("### Requests by intent");
  lines.push("");
  if (facts.requestsByIntent.length === 0) lines.push("None.");
  else lines.push(mdTable(["intent", "count"], facts.requestsByIntent.map((r) => [r.intent, String(r.count)])));
  lines.push("");
  lines.push("### Requests by Scout tool");
  lines.push("");
  if (facts.requestsByScoutTool.length === 0) lines.push("None.");
  else lines.push(mdTable(["tool", "count"], facts.requestsByScoutTool.map((r) => [r.tool, String(r.count)])));
  lines.push("");
  lines.push("### Jeb account (Nexus)");
  lines.push("");
  if (!facts.jebAccount) lines.push("Not fetched (set `JEB_BOT_PK`).");
  else {
    const a = facts.jebAccount;
    lines.push(
      mdTable(
        ["metric", "value"],
        [
          ["followers", a.follows === null ? "n/a" : String(a.follows)],
          ["following", a.following === null ? "n/a" : String(a.following)],
          ["muted/blocked", a.muted === null ? "n/a" : String(a.muted)],
          ["tags", a.tags.length === 0 ? "none" : a.tags.map((t) => `${t.label}:${t.count}`).join(", ")],
        ],
      ),
    );
  }
  lines.push("");
  lines.push("## User opt-outs");
  lines.push("");
  lines.push(
    `Active opt-outs (count only; keys are not listed here): **${facts.activeOptouts}**. Operator list: \`--role optouts\`.`,
  );
  lines.push("");
  lines.push("## Top 10 askers");
  lines.push("");
  if (facts.topAskers.length === 0) lines.push("None.");
  else lines.push(mdTable(["author", "mentions"], facts.topAskers.map((a) => [a.author, String(a.count)])));
  lines.push("");
  lines.push("## Corrections");
  lines.push("");
  if (facts.corrections.length === 0) lines.push("None.");
  else {
    lines.push(
      mdTable(
        ["id", "reply_uri", "reason", "by", "exported"],
        facts.corrections.map((c) => [
          String(c.id),
          c.reply_uri,
          c.reason.replace(/\|/g, "\\|"),
          c.corrected_by,
          c.exported_at ? "yes" : "no",
        ]),
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function dashboardJson(facts: DashboardFacts, policy: PolicySummary): unknown {
  return {
    policy,
    latencyTimestamps: {
      start: "handled_mentions.created_at",
      end: "publish_requests.updated_at where status = published",
    },
    ...facts,
    corrections: facts.corrections.map((c) => ({
      ...c,
      created_at: c.created_at.toISOString(),
      exported_at: c.exported_at ? c.exported_at.toISOString() : null,
    })),
  };
}
