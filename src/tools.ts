import { z } from "zod";

export { createScoutTools } from "./scout/tools.js";

export { searchWebParameters, createSearchWebTool, shouldRegisterSearchWeb } from "./web/tools.js";

export { assertNexusUrl, parseUserPk, clampLimit, nexusTools } from "./bot-kit/nexus/tools.js";

export const searchKnowledgeParameters = z.object({
  query: z.string().min(1),
  product: z.string().optional(),
  status: z.string().optional(),
  k: z.number().int().positive().max(20).optional(),
});
