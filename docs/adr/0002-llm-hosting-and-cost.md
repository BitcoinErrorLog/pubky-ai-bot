# ADR 0002: LLM hosting and cost

**Status:** Proposed — John accepts  
**Date:** 2026-09-04  
**Open question:** Robots §13 Q1 (`/Volumes/vibedrive/vibes-dev/Synonym/articles/pubky/rise-of-the-robots.md`, §13 item 1); plan §6.5 (`jeb_rise_of_the_robots_9c1e4b27.plan.md:289-291`).

## Context

Jeb already calls an OpenAI-compatible chat API from the **reason** process only. Code default model id is `gpt-4o-mini` if `JEB_MODEL` is unset (`src/config.ts:159-161`). Production/staging documentation pins Moonshot **kimi-k3** at `JEB_MODEL_BASE_URL=https://api.moonshot.ai/v1`, which rejects any temperature other than `1` (`README.md:25`; `.env.example:26`). The same Moonshot credentials power built-in `$web_search` when `JEB_WEB_PROVIDER=moonshot` (default) (`README.md:27`; plan `jeb_rise_of_the_robots_9c1e4b27.plan.md:199`).

Token ceilings are code defaults, not a measured invoice:

| Quantity | Value | Source |
| --- | --- | --- |
| Global UTC-day token ceiling | **5_000_000** (`JEB_DAILY_TOKEN_BUDGET`) | `docs/limits.md:10`; `src/config.ts:166` |
| Per-asker UTC-day ceiling | **600_000** (`JEB_USER_DAILY_TOKEN_BUDGET`) | `docs/limits.md:11`; `src/config.ts:167` |
| Pre-spend estimate | p50 of `token_usage.total_tokens` over 7 days, **fallback 20_000** tokens/answer | `docs/limits.md:10`; `src/policy.ts:185-198` (`TYPICAL_ANSWER_TOKENS_FALLBACK`) |
| Tool-loop steps | **4** (`JEB_TOOL_MAX_STEPS`) | `docs/limits.md:15`; `src/config.ts:191` |
| Model call timeout | **30_000 ms** | `docs/limits.md:12` |
| Answer wall clock | **180_000 ms** | `docs/limits.md:13` |
| Ceiling cost at Kimi K3 list pricing | **≈ $20–25/day** if the 5M global budget is fully spent | plan `jeb_rise_of_the_robots_9c1e4b27.plan.md:350` |

`docs/limits.md` does **not** contain a measured production `$/day` or a measured tokens/answer from live `token_usage`. The 20_000 figure is the **fallback** when p50 is unavailable. Knowledge embeddings are local `Xenova/bge-small-en-v1.5` by default (first download ~141 MiB; `docs/knowledge.md:17`); `JEB_EMBED_PROVIDER=openai-compatible` ships corpus text to an external endpoint (`docs/kimi-audit-stage1.md:804`).

Trust split: `JEB_MODEL_API_KEY` is on the reason allowlist only; ingest never receives it; publisher never needs it (`src/keys.ts:105-142,144`; `docs/secrets-hardening-report.md:16-29`). Extraction-class mentions spend **zero** model tokens (`docs/secrets-hardening-report.md:94-97`). Kill switch `generation` stops claims within the 60 s drill window (`docs/killswitch-drill.md:31-32,209-218`). Retrieval quality on the public corpus is **91.1%** answerable top-5 (`docs/evaluation.md:58-60`); that gate is independent of which chat model answers.

Tether/QVAC local-model interest is noted as an open product choice for Pubchi, not a Stage 1 measurement (`jeb_rise_of_the_robots_9c1e4b27.plan.md:289-291,376-378`).

## Options

- **A — Synonym-hosted API (current).** Operator-chosen OpenAI-compatible endpoint (Moonshot kimi-k3 today). One key, one budget table, one kill switch.
- **B — User-selected providers.** Each Pubchi (and later Jeb forks) picks OpenAI / Anthropic / Groq / OpenRouter / self-hosted base URL. Quality and data-flow become per-user.
- **C — Local / QVAC-style models.** Inference on user or Synonym hardware; no third-party prompt egress.

## Scored matrix

Scores 1–5; weighted points are `score × weight` (maximum 500).

| Criterion | Weight | A — Synonym-hosted API | B — User-selected providers | C — Local / QVAC |
|---|---:|---|---|---|
| Time to operate Jeb now | 20 | **5 → 100.** Reason already loads `JEB_MODEL_*` (`src/keys.ts:111-116`); contract 19/19 with canned or live model (`docs/stage1-week2-report.md:38-50`). | **2 → 40.** Requires per-user secret storage and a provider matrix Jeb does not have; Pubchi is Stage 4 (`jeb_rise_of_the_robots_9c1e4b27.plan.md:297-323`). | **1 → 20.** No local chat runtime in this repo; embeddings-only local path (`docs/knowledge.md:17`). |
| Cost predictability | 20 | **4 → 80.** Hard 5M/600k token ceilings and 20k fallback (`docs/limits.md:10-11`). Dollar bound is the plan’s **$20–25/day at ceiling**, not a billed measurement (`jeb_rise_of_the_robots_9c1e4b27.plan.md:350`). | **2 → 40.** Cost moves with user provider and traffic; Jeb’s public-good budget cannot be a single number. | **3 → 60.** Capex/ops instead of API; no Stage 1 cost series. |
| Privacy / data flow | 15 | **3 → 45.** Public thread text leaves Synonym to Moonshot. Documented understatement risk on the KB Jeb page (`jeb_rise_of_the_robots_9c1e4b27.plan.md:378`). Outbound gate still blocks secrets (`docs/secrets-hardening-report.md:31-86`). | **4 → 60.** User can choose a provider they trust, or local; Synonym still must not hold the user’s root key (`jeb_rise_of_the_robots_9c1e4b27.plan.md:301-305`). | **5 → 75.** No third-party prompt egress if the model is local. Unproven for Jeb’s tool loop. |
| Quality / evalability | 15 | **4 → 60.** One model for `eval:answers` (`docs/evaluation.md:126-133`); voice eval 32/32 offline (`docs/stage1-week2-report.md:86`). | **2 → 30.** Quality becomes N providers; the 200-question set is one-model (`docs/evaluation.md:34-52`). | **2 → 30.** No measured answer quality for a local chat model in these docs. |
| Operational control | 15 | **5 → 75.** Generation/web switches measured (`docs/killswitch-drill.md:209-218`); reason cannot sign (`src/keys.ts:29-37`). | **2 → 30.** Kill switch cannot stop a user’s off-box model. | **3 → 45.** Hardware ops; no drill evidence. |
| Fit for Pubchi later | 15 | **3 → 45.** Plan default for Pubchi inference is Synonym-hosted with user-selectable providers as exit (`jeb_rise_of_the_robots_9c1e4b27.plan.md:321`). | **5 → 75.** Matches sovereignty in Robots §13 Q1 and plan §7.2 provider choice in config. | **4 → 60.** Matches Tether/QVAC interest; blocked on a measured local stack. |
| **Total** | **100** | **405/500 = 81/100** | **275/500 = 55/100** | **290/500 = 58/100** |

## Decision

**Jeb now: Option A.** Keep a Synonym-operated OpenAI-compatible endpoint (Moonshot kimi-k3 in current ops docs). Keep token ceilings at 5M global / 600k per user until `token_usage` p50 is published. Do not treat `$20–25/day` as measured spend; it is the plan’s ceiling conversion at Kimi K3 list pricing.

**Pubchi later: A as default, B as the required exit.** User-selected `base_url` + key in bot config on the user’s homeserver (`jeb_rise_of_the_robots_9c1e4b27.plan.md:311,321`). Do not put the user’s root key on a Synonym model host.

**Option C:** not for Jeb until a local model passes the same eval gates (`docs/evaluation.md:133`) and the tool loop under `JEB_MODEL_TIMEOUT_MS` / `JEB_ANSWER_BUDGET_MS`. Revisit for Pubchi if QVAC or equivalent is actually runnable.

## Consequences

- Reason remains the only process with `JEB_MODEL_API_KEY` (`src/keys.ts:105-142`).
- Publish Paykit top-ups against the **token** budget, not an unverified dollar meter (`jeb_rise_of_the_robots_9c1e4b27.plan.md:350`).
- Document third-party prompt egress on the public Jeb page (plan item 378).
- Local embeddings stay the default knowledge path (`docs/knowledge.md:17`).

## What would change our mind

- A production `token_usage` export showing p50 tokens/answer and billed `$/day` that makes the 5M ceiling unsustainable, or a cheaper equal-quality endpoint.
- A local/QVAC runtime that matches ≥95% material-claim review on the 200-question set (`docs/evaluation.md:133`) inside the 180 s answer budget.
- A legal/Tether requirement that Jeb prompts must not leave Synonym hardware.
- Pubchi shipping before a Synonym-hosted default is staffed — then B becomes the Jeb-shaped Kit default too.
