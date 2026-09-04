import { assertOutboundClean } from "./outbound-gate.js";
import { assertUploadBytesClean as kitAssertUploadBytesClean } from "./bot-kit/publish/upload.js";

export {
  MAX_ATTACHMENT_BYTES,
  detectImageContentType,
  isKnownImageType,
  assertUploadSize,
  planFileUpload,
  jsonRecord,
  type ImageContentType,
  type FileUploadPlan,
  type AssertOutboundClean,
} from "./bot-kit/publish/upload.js";

export function assertUploadBytesClean(bytes: Uint8Array, opts?: { env?: NodeJS.ProcessEnv }): void {
  kitAssertUploadBytesClean(bytes, assertOutboundClean, opts);
}
