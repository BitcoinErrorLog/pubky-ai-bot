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
  { ok: true; planned: NlqPlannedCall; confidence: number; consumedTokens?: number } |
  { ok: false; consumedTokens?: number };

const EXCLUDED = new Set<AllowedTool>(["query_graph", "get_what_did_i_miss"]);

function plannerFailure(consumedTokens: number): ModelPlannerResult {
  const result = { ok: false } as ModelPlannerResult;
  Object.defineProperty(result, "consumedTokens", { value: consumedTokens, enumerable: false });
  return result;
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

function schemaType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.join("|")})`;
  if (typeof schema.const === "string") return `literal(${schema.const})`;
  return typeof schema.type === "string" ? schema.type : "unknown";
}

function compatibilityMetadata(name: string, schema: Record<string, unknown>): string {
  const firstEnum = Object.values(schema.properties ?? {}).find(
    (value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).enum)),
  );
  return JSON.stringify({ name, ...(firstEnum ? { enum: firstEnum.enum } : {}) });
}

export function renderPubchiToolCatalog(tools: ModelPlannerTools): string {
  return Object.entries(tools)
    .filter(([name]) => !EXCLUDED.has(name as AllowedTool))
    .map(([name, tool]) =>
      `${compatibilityMetadata(name, schemaFor(tool?.parameters))} ${name}: ${tool?.description ?? "No description."} params(${Object.entries(schemaFor(tool?.parameters).properties ?? {})
        .map(([key, value]) => `${key}:${schemaType(value as Record<string, unknown>)}`)
        .join(",")})`,
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
  if (!opts.brain) return plannerFailure(0);
  const catalog = renderPubchiToolCatalog(opts.tools);
  const catalogNames = new Set(
    Object.keys(opts.tools).filter(
      (name) => !EXCLUDED.has(name as AllowedTool),
    ),
  );
  let generated: Awaited<ReturnType<Brain["generate"]>>;
  let consumedTokens = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) return plannerFailure(0);
    opts.abortSignal.addEventListener("abort", abort, { once: true });
  }
  try {
    const generation = opts.brain.generate({
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
      abortSignal: controller.signal,
      maxOutputTokens: 200,
    });
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("planner timeout"));
      }, 4_000);
    });
    const aborted = opts.abortSignal
      ? new Promise<never>((_, reject) => {
          if (opts.abortSignal?.aborted) reject(new Error("planner aborted"));
          else opts.abortSignal?.addEventListener("abort", () => reject(new Error("planner aborted")), { once: true });
        })
      : undefined;
    generated = await Promise.race([generation, deadline, ...(aborted ? [aborted] : [])]);
    consumedTokens = generated.usage?.totalTokens ?? 0;
  } catch {
    return plannerFailure(consumedTokens);
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.abortSignal?.removeEventListener("abort", abort);
  }
  const raw = firstJsonObject(String(generated.text));
  if (!raw) return plannerFailure(consumedTokens);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return plannerFailure(consumedTokens);
  }
  if (!isRecord(value)) return plannerFailure(consumedTokens);
  if (value.tool === null) return plannerFailure(consumedTokens);
  if (typeof value.tool !== "string" || !catalogNames.has(value.tool))
    return plannerFailure(consumedTokens);
  if (
    !isRecord(value.args) ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return plannerFailure(consumedTokens);
  }
  const tool = opts.tools[value.tool as AllowedTool];
  if (!tool || !hasOnlySchemaKeys(value.args, schemaFor(tool.parameters)))
    return plannerFailure(consumedTokens);
  const parsed = tool.parameters.safeParse(value.args);
  if (!parsed.success || !isRecord(parsed.data)) return plannerFailure(consumedTokens);
  const result = {
    ok: true as const,
    planned: { tool: value.tool as AllowedTool, args: parsed.data },
    confidence: value.confidence,
  };
  Object.defineProperty(result, "consumedTokens", { value: consumedTokens, enumerable: false });
  return result;
}
