import { err, type ParseResult } from "./codes.js";
import { parseCommonEnvelopeV1 } from "./envelope.js";
import { parseFeedProposalV1 } from "./feed.js";
import { parseManifestV1 } from "./manifest.js";
import { parseQueryResultV1 } from "./query.js";
import { parseRequestBindingV1, parseRequestObjectV1 } from "./request.js";
import { parseOwnerBindingV1, parseTenantV1 } from "./tenant.js";

export function parseBySchema(input: unknown): ParseResult<unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return err("SCHEMA_INVALID");
  }
  const schema = (input as { schema?: unknown }).schema;
  switch (schema) {
    case "pubchi-tenant":
      return parseTenantV1(input);
    case "pubchi-owner-binding":
      return parseOwnerBindingV1(input);
    case "pubchi-request":
      return parseRequestBindingV1(input);
    case "pubchi-request-object":
      return parseRequestObjectV1(input);
    case "pubchi-feed-proposal":
      return parseFeedProposalV1(input);
    case "pubchi-query-result":
      return parseQueryResultV1(input);
    case "pubchi-manifest":
      return parseManifestV1(input);
    case "pubchi-config":
    case "pubchi-envelope":
      return parseCommonEnvelopeV1(input);
    default:
      return err("SCHEMA_INVALID");
  }
}
