# Ticket 11 report — voice, continuation, compact composition, bot profile

Stage 1 week 4, ticket 11 (plan §4.5, rules R1–R5, R10).
Working tree: `/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb`, branch `stage1/extract`.

## Test counts

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm test` (unit + DB + eval gate) | **133 passed, 1 skipped** (19 files; baseline before ticket: 95 passed) |
| `npm run eval:voice` (offline) | 32 items, 0 escapes, 0 missing required, 3 linter violations caught |
| staging contract (`jeb-contract`) | **19/19 in 110.35 s** |

New/changed test files: `src/voice.test.ts` (14), `src/compose.test.ts` (11),
`src/continuation.test.ts` (6), `src/profile.test.ts` (5), `src/policy.test.ts`
(+2), `src/context.test.ts` (+1).

## Voice eval table (offline composition path)

```
# Voice eval — offline composition path (32 items)

linter violations caught and fixed: 3
forbidden-pattern escapes after linting: 0
missing required patterns after linting: 0

| Rule | Violations | Items |
| --- | --- | --- |
| (none) | 0 | - |

(live model pass skipped: JEB_MODEL_API_KEY not set)
```

The 3 caught violations are the deliberately flawed drafts (two
"Great question!"/"Sure!" openers and one stacked opener), stripped by
`src/voice.ts` before the forbidden-pattern check. Live model pass runs
automatically when `JEB_MODEL_API_KEY` is present and reports the same
per-rule table without failing the run.

## Behavior fixed in the existing continuation path

1. **`parent_post_uri` was ignored.** `mentionKey` accepted reply
   notifications but never looked at the parent; a malformed parent URI
   sailed through. It is now parsed and validated (canonical post URI or the
   notification is dropped), and surfaced as `parentUri` for the reason step.
2. **Replier automation was never checked.** `answerMention` hardcoded
   `authorIsBot: false`, so a reply from a self-declared bot would have been
   answered, inviting bot loops around the thread cap. The reason step now
   fetches the replier's profile and skips when the name/bio declares
   bot/automation (word-boundary heuristic, so a display name like
   "OtherBot" is not a declaration) or the id is in `JEB_KNOWN_BOTS`.
3. **Jeb's own turns were unmarked in context.** `assemblePrompt` rendered
   every ancestor as an identical user line, so the model could not tell its
   own earlier replies from the user's. Bot-authored turns are now marked
   `assistant Jeb` and the prompt header states the whole chain is one
   conversation.
4. **Hard mid-word truncation.** `composeReply` sliced at exactly 2000
   chars with no continuation hint. Non-deep overflow now truncates at a
   sentence boundary and ends with `(ask for \`deep\` for more)`; `deep`
   yields ONE `kind: long` post (≤ 50000) instead of a chain.
5. **Mode parsing was keyword-only and lacked `pubky_only`.** Natural
   phrasings ("keep it short", "go deep", "sources please", "just the Pubky
   part") are now accepted; `pubky_only` adds a system-prompt addendum
   restricting answers to Pubky-network tools and sources.

The loop guard itself (`botRepliesInChain` + `JEB_MAX_REPLIES_PER_THREAD`,
DB cross-check via `publishedInThread`) already worked and is unchanged; it
now also covers the reply-notification continuation path by test.

## Deliverables map

- `docs/voice.md` — voice spec, 15 paired positive/negative examples covering
  all required scenarios.
- `src/voice.ts` + `src/voice.test.ts` — deterministic linter; violations
  recorded in `evidence.voice_violations` (migration `040_voice.sql`).
- `eval/voice/voice-core.yaml` (32 items) + `scripts/eval-voice.ts`
  (`npm run eval:voice`).
- `src/modes.ts`, `src/compose.ts`, `src/answer.ts`, `src/context.ts`,
  `src/reason.ts`, `src/policy.ts`, `src/config.ts`, `src/types.ts`,
  `src/db.ts` — composition, continuation, guards.
- `src/profile.ts` + `scripts/profile.ts` (`npm run profile:publish`,
  `--dry-run`) — transparent bot profile via `PubkySpecsBuilder.createUser`;
  gated by replies/global switches; refuses `JEB_CONTRACT_MODE=1`. **Not run
  against staging** (no bot identity decided yet).
- `docs/intro-post.md` — "How I work" post: short (973 chars) + `kind: long`
  version. Text only, not published.
