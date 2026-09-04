import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SEARCH_WEB_TOOL_NAME,
  createSearchWebTool,
  searchWebParameters,
} from "@pubky/bot-kit";

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "search-web.fixture.json"), "utf8"),
) as {
  name: string;
  description: string;
  parameters: unknown;
};

type ZodLike = {
  _def: {
    typeName: string;
    shape?: unknown;
    checks?: Array<{ kind: string; value?: number }>;
    values?: string[];
    innerType?: unknown;
  };
};

/** Same walker used to record the pre-move fixture from `src/web/tools.ts`. */
function jsonSchema(schema: ZodLike): unknown {
  const def = schema._def;
  const typeName = def.typeName;
  if (typeName === "ZodObject") {
    const raw = def.shape;
    const shape = (typeof raw === "function" ? (raw as () => Record<string, ZodLike>)() : raw) as Record<
      string,
      ZodLike
    >;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      let cur = v;
      let optional = false;
      while (cur._def.typeName === "ZodOptional" || cur._def.typeName === "ZodDefault") {
        if (cur._def.typeName === "ZodOptional") optional = true;
        cur = cur._def.innerType as ZodLike;
      }
      properties[k] = jsonSchema(cur);
      if (!optional) required.push(k);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
  if (typeName === "ZodString") {
    const out: Record<string, unknown> = { type: "string" };
    for (const c of def.checks ?? []) {
      if (c.kind === "min") out.minLength = c.value;
      if (c.kind === "max") out.maxLength = c.value;
    }
    return out;
  }
  if (typeName === "ZodNumber") {
    const out: Record<string, unknown> = { type: "number" };
    for (const c of def.checks ?? []) {
      if (c.kind === "int") out.type = "integer";
      if (c.kind === "min") out.minimum = c.value;
      if (c.kind === "max") out.maximum = c.value;
    }
    return out;
  }
  if (typeName === "ZodEnum") {
    return { type: "string", enum: [...(def.values ?? [])] };
  }
  throw new Error("unsupported " + typeName);
}

describe("search_web tool definition byte-identity vs pre-move fixture", () => {
  it("name, description, and parameter JSON schema match the recorded pre-move catalog", () => {
    const tool = createSearchWebTool({
      cfg: { webProvider: "moonshot", webTimeoutMs: 1, webPerMentionCap: 1, webDailyCeiling: 1, model: "kimi-k3" },
      storeSwitchOn: async () => false,
    });
    expect({
      name: SEARCH_WEB_TOOL_NAME,
      description: tool.description,
      parameters: jsonSchema(searchWebParameters),
    }).toEqual(FIXTURE);
  });
});
