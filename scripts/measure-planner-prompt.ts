import { configFromProcessEnv } from "../src/config.js";
import { Nexus } from "../packages/bot-kit/src/nexus/nexus.js";
import { nexusTools } from "../packages/bot-kit/src/nexus/tools.js";
import { renderPlannerPrompt, SYSTEM_POLICY } from "../packages/bot-kit/src/nlq/conversational-planner.js";
import { createScoutTools } from "../packages/bot-kit/src/scout/tools.js";
import { ScoutClient } from "../packages/bot-kit/src/scout/client.js";
import { refreshScoutSchema, getScoutSchemaSource } from "../packages/bot-kit/src/scout/schema-cache.js";

const cfg = configFromProcessEnv({ requireSecret: false, role: "pubchi" });
const scout = new ScoutClient(cfg);
const refreshed = await refreshScoutSchema(scout);
if (!refreshed.ok || getScoutSchemaSource() !== "live") {
  throw new Error("live Scout schema is required for this measurement");
}

const tools = {
  ...createScoutTools({
    cfg,
    pool: undefined as never,
    storeSwitchOn: async () => false,
    client: scout,
  }),
  ...(cfg.nexusUrl ? nexusTools(new Nexus(cfg.nexusUrl)) : {}),
};

function estimate(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function block(prompt: string, start: string, end?: string): string {
  const startAt = prompt.indexOf(start);
  if (startAt < 0) return "";
  const contentStart = startAt + start.length;
  const endAt = end ? prompt.indexOf(end, contentStart) : prompt.length;
  return prompt.slice(contentStart, endAt < 0 ? prompt.length : endAt).trim();
}

function measure(question: string): void {
  const prompt = renderPlannerPrompt({
    question,
    tools,
    nowMs: Date.parse("2026-09-10T00:00:00Z"),
  });
  const outputContract = block(prompt, "SYSTEM POLICY", "TOOL CATALOG");
  const catalog = block(prompt, "TOOL CATALOG", "LIVE SCOUT SCHEMA");
  const schema = block(prompt, "LIVE SCOUT SCHEMA", "DEFAULTS");
  const defaults = block(prompt, "DEFAULTS", "OWNER CONTEXT");
  const owner = block(prompt, "OWNER CONTEXT", "CONVERSATION WINDOW");
  const conversation = block(prompt, "CONVERSATION WINDOW", "QUESTION");
  const questionBlock = block(prompt, "QUESTION");
  const blocks = {
    policy: SYSTEM_POLICY,
    "output contract/examples": outputContract,
    "tool catalog": catalog,
    "schema summary": schema,
    defaults,
    "owner context slot": owner,
    "conversation window slot": conversation,
    question: questionBlock,
  };
  console.log(`QUESTION ${JSON.stringify(question)}`);
  for (const [name, value] of Object.entries(blocks)) {
    console.log(`${name}\tchars=${value.length}\ttokens≈${estimate(value)}`);
  }
  console.log(`USER_PROMPT\tchars=${prompt.length}\ttokens≈${estimate(prompt)}`);
  console.log(`MODEL_TOTAL\tchars=${SYSTEM_POLICY.length + prompt.length}\ttokens≈${estimate(SYSTEM_POLICY) + estimate(prompt)}`);
}

console.log(`SCOUT_SCHEMA source=${getScoutSchemaSource()} refreshed=${refreshed.ok}`);
measure("how are you?");
measure("Who are the most tagged users this week?");
