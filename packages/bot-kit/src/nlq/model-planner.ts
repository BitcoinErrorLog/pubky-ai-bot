import type { Brain } from "../brain/types.js";
import type { AllowedTool } from "./intent.js";
import type { NlqPlannedCall } from "./types.js";

type ToolDefinition = {
  description?: string;
  parameters: {
    safeParse: (value: unknown) => { success: boolean; data?: unknown };
  };
};

export type ModelPlannerTools = Partial<Record<AllowedTool, ToolDefinition>>;

export type ModelPlannerResult =
  { ok: true; planned: NlqPlannedCall; confidence: number } | { ok: false };

const EXCLUDED = new Set<AllowedTool>(["query_graph"]);

export function isWeakTopicRoute(
  question: string,
  planned: NlqPlannedCall[],
): boolean {
  if (!planned.some((call) => "topic" in call.args)) return false;
  return /\b(?:about|on|topic)\s+[a-zA-Z0-9_-]{2,40}\b/i.test(question);
}

function schemaFor(parameters: unknown): Record<string, unknown> {
  const schema = parameters as {
    _def?: {
      typeName?: string;
      shape?: (() => Record<string, unknown>) | Record<string, unknown>;
      innerType?: unknown;
      values?: string[];
      checks?: Array<{ kind?: string; value?: number }>;
      value?: unknown;
    };
  };
  const def = schema?._def;
  if (!def?.typeName) return {};
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault")
    return schemaFor(def.innerType);
  if (def.typeName === "ZodObject") {
    const raw = typeof def.shape === "function" ? def.shape() : def.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(raw ?? {})) {
      properties[key] = schemaFor(child);
      const childType = (child as { _def?: { typeName?: string } })._def
        ?.typeName;
      if (childType !== "ZodOptional" && childType !== "ZodDefault")
        required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
  }
  if (def.typeName === "ZodString") return { type: "string" };
  if (def.typeName === "ZodNumber") {
    const out: Record<string, unknown> = { type: "number" };
    for (const check of def.checks ?? []) {
      if (check.kind === "int") out.type = "integer";
      if (check.kind === "min") out.minimum = check.value;
      if (check.kind === "max") out.maximum = check.value;
    }
    return out;
  }
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodEnum")
    return { type: "string", enum: def.values ?? [] };
  if (def.typeName === "ZodLiteral") return { const: def.value };
  return {};
}

export function renderPubchiToolCatalog(tools: ModelPlannerTools): string {
  return Object.entries(tools)
    .filter(([name]) => !EXCLUDED.has(name as AllowedTool))
    .map(([name, tool]) =>
      JSON.stringify({
        name,
        purpose: tool?.description ?? "",
        args: schemaFor(tool?.parameters),
      }),
    )
    .join("\n");
}

function firstJsonObject(text: string): string | null {
  const source = text.trim();
  if (!source.startsWith("{") || !source.endsWith("}")) return null;
  return source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlySchemaKeys(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): boolean {
  const properties = schema.properties;
  if (!isRecord(properties)) return false;
  return Object.keys(args).every((key) => key in properties);
}

export async function modelPlanPubchi(opts: {
  brain?: Brain;
  question: string;
  tools: ModelPlannerTools;
  screenQuestion?: (question: string) => string;
  abortSignal?: AbortSignal;
}): Promise<ModelPlannerResult> {
  if (!opts.brain) return { ok: false };
  const catalog = renderPubchiToolCatalog(opts.tools);
  const catalogNames = new Set(
    Object.keys(opts.tools).filter(
      (name) => !EXCLUDED.has(name as AllowedTool),
    ),
  );
  let generated: Awaited<ReturnType<Brain["generate"]>>;
  try {
    generated = await opts.brain.generate({
      messages: [
        {
          role: "system",
          content:
            'Return exactly JSON: {"tool":"<catalog name>","args":{},"confidence":0..1} or {"tool":null}. Choose exactly one catalog tool that answers the question from graph data. Never choose query_graph. Unknown or unsupported questions return {"tool":null}.',
        },
        {
          role: "user",
          content: JSON.stringify({
            question: opts.screenQuestion?.(opts.question) ?? opts.question,
            catalog,
          }),
        },
      ],
      temperature: opts.brain.temperature,
      abortSignal: opts.abortSignal ?? AbortSignal.timeout(4_000),
      maxOutputTokens: 200,
    });
  } catch {
    return { ok: false };
  }
  const raw = firstJsonObject(String(generated.text));
  if (!raw) return { ok: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!isRecord(value)) return { ok: false };
  if (value.tool === null) return { ok: false };
  if (typeof value.tool !== "string" || !catalogNames.has(value.tool))
    return { ok: false };
  if (
    !isRecord(value.args) ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return { ok: false };
  }
  const tool = opts.tools[value.tool as AllowedTool];
  if (!tool || !hasOnlySchemaKeys(value.args, schemaFor(tool.parameters)))
    return { ok: false };
  const parsed = tool.parameters.safeParse(value.args);
  if (!parsed.success || !isRecord(parsed.data)) return { ok: false };
  return {
    ok: true,
    planned: { tool: value.tool as AllowedTool, args: parsed.data },
    confidence: value.confidence,
  };
}
