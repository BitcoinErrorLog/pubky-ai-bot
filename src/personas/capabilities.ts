import { NEXUS_READ, SCOUT_TOOLS, type AllowedTool } from "../intent.js";
import type { CapabilityId, PersonaPack } from "./schema.js";

export type PersonaToolName = AllowedTool | "search_knowledge";

export type CapabilitySurface =
  | "model_tool"
  | "reason_workflow"
  | "response_metadata";

export interface CapabilityDefinition {
  id: CapabilityId;
  surface: CapabilitySurface;
  tools: readonly PersonaToolName[];
  description: string;
}

const typedScoutTools = SCOUT_TOOLS.filter((tool) => tool !== "query_graph");

export const CAPABILITY_CATALOGUE: Readonly<Record<CapabilityId, CapabilityDefinition>> = {
  nexus_read: {
    id: "nexus_read",
    surface: "model_tool",
    tools: NEXUS_READ,
    description: "Read bounded public posts, threads, profiles, tags, and replies from Nexus.",
  },
  scout_graph: {
    id: "scout_graph",
    surface: "model_tool",
    tools: typedScoutTools,
    description: "Use typed, read-only Scout graph tools.",
  },
  knowledge_global: {
    id: "knowledge_global",
    surface: "model_tool",
    tools: ["search_knowledge"],
    description: "Search the explicitly mounted global public knowledge namespace.",
  },
  web_search: {
    id: "web_search",
    surface: "model_tool",
    tools: ["search_web"],
    description: "Search or fetch bounded public web evidence under metered policy.",
  },
  image_read: {
    id: "image_read",
    surface: "reason_workflow",
    tools: [],
    description: "Include bounded public images in the reason model input.",
  },
  tags: {
    id: "tags",
    surface: "response_metadata",
    tools: [],
    description: "Suggest and publish policy-valid reply and interaction tags.",
  },
  translate: {
    id: "translate",
    surface: "reason_workflow",
    tools: [],
    description: "Apply the bounded translation intent and response contract.",
  },
  evidence_map: {
    id: "evidence_map",
    surface: "reason_workflow",
    tools: [],
    description: "Compose evidence maps from enabled read capabilities.",
  },
};

export const CAPABILITY_RUNTIME_CONSUMERS: Readonly<Record<CapabilityId, readonly string[]>> = {
  nexus_read: ["answer.tool_schema_intersection", "answer.execution_assert"],
  scout_graph: ["answer.tool_schema_intersection", "answer.execution_assert"],
  knowledge_global: ["answer.global_knowledge_registration", "knowledge.global_path_exclusion"],
  web_search: ["answer.tool_schema_intersection", "answer.execution_assert"],
  image_read: ["answer.images_enabled_gate"],
  tags: ["reason.tags_enabled_gate"],
  translate: ["answer.workflow_capability_gate"],
  evidence_map: ["answer.workflow_capability_gate"],
};

export interface ResolvedCapabilities {
  enabled: ReadonlySet<CapabilityId>;
  tools: ReadonlySet<PersonaToolName>;
}

/**
 * Manifest allowlists are deny-by-default. Deployment availability can only
 * remove capabilities; it cannot grant one.
 */
export function resolveCapabilities(
  pack: Pick<PersonaPack, "capabilities">,
  deploymentAvailable: ReadonlySet<CapabilityId> = new Set(Object.keys(CAPABILITY_CATALOGUE) as CapabilityId[]),
): ResolvedCapabilities {
  const enabled = new Set(
    pack.capabilities.allow.filter((id) => deploymentAvailable.has(id)),
  );
  const tools = new Set<PersonaToolName>();
  for (const id of enabled) {
    for (const tool of CAPABILITY_CATALOGUE[id].tools) tools.add(tool);
  }
  return { enabled, tools };
}

export function capabilityDefinition(id: CapabilityId): CapabilityDefinition {
  return CAPABILITY_CATALOGUE[id];
}

export function selectPersonaToolNames(
  intentTools: ReadonlySet<string>,
  availableTools: readonly string[],
  capabilities: ResolvedCapabilities,
): string[] {
  return availableTools.filter(
    (tool) =>
      capabilities.tools.has(tool as PersonaToolName) &&
      (intentTools.has(tool) || tool === "search_knowledge"),
  );
}

export function assertPersonaToolExecution(tool: string, capabilities: ResolvedCapabilities): void {
  if (!capabilities.tools.has(tool as PersonaToolName)) {
    throw new Error(`persona capability denied tool execution: ${tool}`);
  }
}
