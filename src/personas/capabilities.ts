import { NEXUS_READ, SCOUT_TOOLS, type AllowedTool } from "../intent.js";
import type { CapabilityId, PersonaManifest } from "./schema.js";

export type PersonaToolName = AllowedTool | "search_knowledge" | "search_persona_knowledge";

export type CapabilitySurface =
  | "model_tool"
  | "reason_workflow"
  | "publisher_write"
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
  raw_scout_query: {
    id: "raw_scout_query",
    surface: "model_tool",
    tools: ["query_graph"],
    description: "Use the separately guarded raw Scout query escape hatch.",
  },
  knowledge_global: {
    id: "knowledge_global",
    surface: "model_tool",
    tools: ["search_knowledge"],
    description: "Search the explicitly mounted global public knowledge namespace.",
  },
  knowledge_persona: {
    id: "knowledge_persona",
    surface: "model_tool",
    tools: ["search_persona_knowledge"],
    description: "Search the selected persona corpus namespace and version.",
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
  code_review: {
    id: "code_review",
    surface: "reason_workflow",
    tools: [],
    description: "Review a bounded public diff with commit citations and no execution.",
  },
  ux_critique: {
    id: "ux_critique",
    surface: "reason_workflow",
    tools: [],
    description: "Apply the structured usability and accessibility critique contract.",
  },
  coaching_plan: {
    id: "coaching_plan",
    surface: "reason_workflow",
    tools: [],
    description: "Compose a bounded goal, options, and commitment plan without private memory.",
  },
  steelman_debate: {
    id: "steelman_debate",
    surface: "reason_workflow",
    tools: [],
    description: "Build a claim map, strongest countercase, and falsifier under civility policy.",
  },
  source_authentication: {
    id: "source_authentication",
    surface: "reason_workflow",
    tools: [],
    description: "Classify source date, rights, and primary-versus-secondary provenance.",
  },
  simulation: {
    id: "simulation",
    surface: "reason_workflow",
    tools: [],
    description: "Run an approved deterministic calculator after its separate threat model.",
  },
  standalone_publish: {
    id: "standalone_publish",
    surface: "publisher_write",
    tools: [],
    description: "Publish without a triggering mention; denied for user personas in Phase 1.",
  },
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
  manifest: Pick<PersonaManifest, "capabilities">,
  deploymentAvailable: ReadonlySet<CapabilityId> = new Set(Object.keys(CAPABILITY_CATALOGUE) as CapabilityId[]),
): ResolvedCapabilities {
  const enabled = new Set(
    manifest.capabilities.allow.filter((id) => deploymentAvailable.has(id)),
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
      (intentTools.has(tool) || tool === "search_knowledge" || tool === "search_persona_knowledge"),
  );
}

export function assertPersonaToolExecution(tool: string, capabilities: ResolvedCapabilities): void {
  if (!capabilities.tools.has(tool as PersonaToolName)) {
    throw new Error(`persona capability denied tool execution: ${tool}`);
  }
}
